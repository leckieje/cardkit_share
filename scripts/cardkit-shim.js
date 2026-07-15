/**
 * cardkit-shim.js
 *
 * Adds persistent, shareable projects to CardKit without modifying the
 * pre-built AngularJS bundles. Injected into index.html after scripts.js.
 *
 * Responsibilities:
 *  - Detect a project ID in the URL hash query param (?p=id)
 *  - After Angular bootstraps, fetch the saved state and hydrate the scope
 *  - Watch scope changes and debounce-save to /api/projects
 *  - Update the URL to /#/mode?p=id after the first save via $location
 *  - Expose window.cardkitShim.share() for the Share button
 */
(function () {
  'use strict';

  var PROJECT_PARAM = 'p'; // query param used to carry the project ID
  var API_BASE = '/api';
  // Fields to capture per SVG element — only plain user-editable data, not functions.
  var ELEMENT_FIELDS = [
    'value', 'fontSize', 'fill', 'opacity', 'src', 'display',
    'suffix', 'x', 'y', 'width', 'dragLockX', 'dragLockY', 'transform',
  ];
  // Debounce delay in ms. Longer when the project contains a base64 image.
  var DEBOUNCE_SHORT = 2000;
  var DEBOUNCE_LONG  = 4000;

  var projectId      = null;
  var saveTimer      = null;
  var hydrating      = false;
  var initialized    = false;
  var watchTeardowns = [];   // deregister functions from previous route's $watch calls
  var watchedMode    = null; // the mode name for which watches are currently active
  var startTime      = Date.now(); // used to ignore stale $stateChangeSuccess events
  var $location      = null;       // Angular $location service, set after bootstrap

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getProjectIdFromUrl() {
    // $location (Angular) puts search params inside the hash in hashbang mode,
    // e.g. /#/wsjpro?p=xxx. Parse them from the hash manually since
    // window.location.search won't see them.
    var hash = window.location.hash; // e.g. '#/wsjpro?p=xxx'
    var qIdx = hash.indexOf('?');
    if (qIdx !== -1) {
      var hashParams = new URLSearchParams(hash.slice(qIdx + 1));
      var id = hashParams.get(PROJECT_PARAM);
      if (id) return id;
    }
    // Fallback: real query string (for legacy /project/:id style links)
    var params = new URLSearchParams(window.location.search);
    return params.get(PROJECT_PARAM) || null;
  }

  // Returns the active controller's $scope (child scope of the ui-view element).
  function getControllerScope() {
    var uiView = document.querySelector('[ui-view]');
    if (!uiView || !uiView.firstElementChild) return null;
    return angular.element(uiView.firstElementChild).scope();  // eslint-disable-line no-undef
  }

  // ── Status indicator ──────────────────────────────────────────────────────

  var indicator = null;
  var indicatorTimer = null;

  function showStatus(status) {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'ck-save-indicator';
      indicator.style.cssText = [
        'position:fixed', 'bottom:14px', 'right:18px', 'padding:5px 11px',
        'border-radius:4px', 'font:12px/1.4 sans-serif', 'z-index:9999',
        'transition:opacity 0.4s', 'pointer-events:none', 'opacity:0',
      ].join(';');
      document.body.appendChild(indicator);
    }
    clearTimeout(indicatorTimer);
    var styles = {
      saving: ['Saving\u2026',         '#555',    '#f0f0f0'],
      saved:  ['Saved',               '#2a7a2a',  '#e8f5e9'],
      copied: ['Link copied!',        '#1a5276',  '#d6eaf8'],
      error:  ['Save failed',         '#c0392b',  '#fde8e8'],
    };
    var s = styles[status] || styles.saving;
    indicator.textContent  = s[0];
    indicator.style.color  = s[1];
    indicator.style.background = s[2];
    indicator.style.opacity = '1';
    if (status === 'saved' || status === 'copied') {
      indicatorTimer = setTimeout(function () { indicator.style.opacity = '0'; }, 2500);
    }
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  // Only serialize a field if it is a plain scalar (string, number, boolean).
  // Function-valued fields are computed from theme/config at runtime and must
  // not be serialized — calling them bare (outside Angular's digest) can throw,
  // and storing their output would overwrite dynamic config on hydration.
  function isScalar(v) {
    var t = typeof v;
    return t === 'string' || t === 'number' || t === 'boolean';
  }

  function serializeScope(scope) {
    var elements = [];
    var resolvedEls = getResolvedElements(scope);
    resolvedEls.forEach(function (el) {
      var snap = { name: el.name };
      ELEMENT_FIELDS.forEach(function (k) {
        var v = el[k];
        if (isScalar(v)) snap[k] = v;
      });
      elements.push(snap);
    });
    return {
      themeName: scope.theme ? scope.theme.name  : null,
      colorName: scope.color ? scope.color.name  : null,
      size: scope.size ? {
        name:   scope.size.name,
        width:  isScalar(scope.size.width)  ? scope.size.width  : null,
        height: isScalar(scope.size.height) ? scope.size.height : null,
        locked: scope.size.locked,
      } : null,
      elements: elements,
      svgTransforms: getSvgTransforms(),
    };
  }

  // Read drag transforms from SVG DOM — returns {name: transformString} for
  // elements that have been dragged (non-identity matrix transform).
  function getSvgTransforms() {
    var svg = document.querySelector('svg');
    if (!svg) return {};
    var result = {};
    var els = svg.querySelectorAll('[name][transform]');
    els.forEach(function (el) {
      var name = el.getAttribute('name');
      var t = el.getAttribute('transform');
      if (name && t && t !== 'matrix(1,0,0,1,0,0)') {
        result[name] = t;
      }
    });
    return result;
  }

  // Apply saved transforms back to SVG DOM elements by name.
  // Polls until the SVG is rendered, then sets transform attributes.
  function applySvgTransforms(transforms) {
    if (!transforms || !Object.keys(transforms).length) return;
    var attempts = 0;
    var interval = setInterval(function () {
      attempts++;
      var svg = document.querySelector('svg');
      if (!svg) { if (attempts > 40) clearInterval(interval); return; }
      var applied = 0;
      Object.keys(transforms).forEach(function (name) {
        var el = svg.querySelector('[name="' + name + '"]');
        if (el) {
          el.setAttribute('transform', transforms[name]);
          applied++;
        }
      });
      if (applied === Object.keys(transforms).length || attempts > 40) {
        clearInterval(interval);
      }
    }, 50);
  }

  function hasImage(state) {
    return state.elements && state.elements.some(function (el) {
      return el.src && el.src.indexOf('data:') === 0;
    });
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  // Wait until ng-repeat child scopes exist and ng-init has resolved
  // element.value from a function to a string, then call cb(scope).
  // Polls every 50ms, gives up after 3s.
  function waitForChildScopes(scope, cb) {
    var attempts = 0;
    var interval = setInterval(function () {
      attempts++;
      var childScopes = getElementScopes(scope);
      // Check that at least one child scope has a scalar value (ng-init has run)
      var ready = childScopes.length > 0 && childScopes.some(function (child) {
        return child.element && isScalar(child.element.value);
      });
      if (ready) {
        clearInterval(interval);
        cb(scope);
      } else if (attempts > 60) { // give up after 3s
        clearInterval(interval);
        cb(scope); // hydrate anyway
      }
    }, 50);
  }

  function hydrateScope(scope, state) {
    hydrating = true;
    try {
      // Theme
      if (state.themeName && scope.config && scope.config.themes) {
        var t = findByName(scope.config.themes, state.themeName);
        if (t) scope.theme = t;
      }
      // Color (only BigNumber / Stock modes expose scope.config.colors)
      if (state.colorName && scope.config && scope.config.colors) {
        var c = findByName(scope.config.colors, state.colorName);
        if (c) scope.color = c;
      }
      // Size
      if (state.size && scope.config && scope.config.sizes) {
        var sz = findByName(scope.config.sizes, state.size.name);
        if (sz) {
          scope.size = sz;
          if (state.size.width  != null) scope.size.width  = state.size.width;
          if (state.size.height != null) scope.size.height = state.size.height;
          if (state.size.locked != null) scope.size.locked = state.size.locked;
        }
      }
      // SVG elements — write to both the raw config array AND any ng-repeat
      // child scopes that have already resolved the function-valued fields via
      // ng-init. Writing only to one or the other is insufficient.
      if (state.elements && scope.config && scope.config.svg) {
        var liveEls = scope.config.svg.elements;

        // Build child-scope map (name → child scope's element reference).
        var childMap = {};
        getElementScopes(scope).forEach(function (child) {
          if (child.element && child.element.name) {
            childMap[child.element.name] = child.element;
          }
        });

        state.elements.forEach(function (saved) {
          var raw = findByName(liveEls, saved.name);
          if (raw) {
            ELEMENT_FIELDS.forEach(function (k) {
              // Only restore plain scalar values — never overwrite functions or
              // objects that the controller uses to compute derived properties.
              if (isScalar(saved[k])) raw[k] = saved[k];
            });
          }
          var child = childMap[saved.name];
          if (child) {
            ELEMENT_FIELDS.forEach(function (k) {
              if (isScalar(saved[k])) child[k] = saved[k];
            });
          }
        });
      }
      // Trigger re-render via existing controller watches
      scope.$broadcast('changeTheme');
      scope.$broadcast('changeSize');
      scope.$apply();
      // Restore SVG drag transforms after the SVG re-renders.
      // Must happen after $apply so Snap.svg has redrawn the elements.
      if (state.svgTransforms) {
        applySvgTransforms(state.svgTransforms);
      }
    } finally {
      hydrating = false;
    }
  }

  function findByName(arr, name) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].name === name) return arr[i];
    }
    return null;
  }

  // ── URL management ────────────────────────────────────────────────────────

  // Keep the URL in sync with the current projectId whenever it changes.
  // Called after every successful save so the address bar always shows the
  // shareable link, even if something else (e.g. the hash router) rewrote it.
  function updateUrl() {
    if (!projectId || !$location) return;
    var current = $location.search()[PROJECT_PARAM];
    if (current !== projectId) {
      $location.search(PROJECT_PARAM, projectId).replace();
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  function saveProject(scope, modeName) {
    if (hydrating) return;
    var state = serializeScope(scope);
    var delay = hasImage(state) ? DEBOUNCE_LONG : DEBOUNCE_SHORT;

    showStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (!projectId) {
        // First save: create a new project and rewrite the URL.
        fetch(API_BASE + '/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: modeName, state: state }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (data) {
            projectId = data.id;
            updateUrl();
            showStatus('saved');
          })
          .catch(function () { showStatus('error'); });
      } else {
        fetch(API_BASE + '/projects/' + projectId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: modeName, state: state }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function () {
            updateUrl();
            showStatus('saved');
          })
          .catch(function ()  { showStatus('error'); });
      }
    }, delay);
  }

  // ── Watch scope ───────────────────────────────────────────────────────────

  function teardownWatches() {
    watchTeardowns.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
    watchTeardowns = [];
  }

  // Recursively collect all descendant scopes that own an 'element' key
  // (i.e. ng-repeat scopes for config.svg.elements iterations).
  function getElementScopes(parentScope) {
    var results = [];
    function walk(s) {
      var child = s.$$childHead;
      while (child) {
        if (child.hasOwnProperty('element') && child.element && child.element.name) {
          results.push(child);
        }
        walk(child);
        child = child.$$nextSibling;
      }
    }
    walk(parentScope);
    return results;
  }

  function watchScope(scope, modeName) {
    teardownWatches();
    watchedMode = modeName;

    function onChange(nv, ov) {
      if (nv !== ov && !hydrating) {
        saveProject(scope, modeName);
      }
    }

    // Watch top-level controller scope properties (theme, color, size).
    watchTeardowns.push(scope.$watch('theme.name',  onChange));
    watchTeardowns.push(scope.$watch('color.name',  onChange));
    watchTeardowns.push(scope.$watch('size.name',   onChange));
    watchTeardowns.push(scope.$watch('size.width',  onChange));
    watchTeardowns.push(scope.$watch('size.height', onChange));

    // Watch element fields using function-form $watch on the controller scope.
    // This is more reliable than watching on child scopes, because ng-repeat
    // child scopes can be re-created on digest and drop their watchers.
    // We close over each element object reference directly.
    var els = scope.config && scope.config.svg && scope.config.svg.elements;
    if (els) {
      els.forEach(function (el) {
        ELEMENT_FIELDS.forEach(function (k) {
          watchTeardowns.push(scope.$watch(
            function () { return el[k]; },
            onChange
          ));
        });
      });
    }

    // Watch SVG transform attributes for drag position changes.
    // Snap.svg updates these directly in the DOM without touching Angular scope.
    var svgObserver = null;
    var dragSaveTimer = null;
    var svg = document.querySelector('svg');
    if (svg && window.MutationObserver) {
      svgObserver = new MutationObserver(function (mutations) {
        if (hydrating) return;
        var hasDrag = mutations.some(function (m) {
          return m.type === 'attributes' && m.attributeName === 'transform' &&
                 m.target.getAttribute('name');
        });
        if (hasDrag) {
          clearTimeout(dragSaveTimer);
          dragSaveTimer = setTimeout(function () {
            saveProject(scope, modeName);
          }, DEBOUNCE_SHORT);
        }
      });
      svgObserver.observe(svg, { subtree: true, attributes: true, attributeFilter: ['transform'] });
      watchTeardowns.push(function () {
        svgObserver.disconnect();
        clearTimeout(dragSaveTimer);
      });
    }
  }

  // Serialize from child scopes where ng-repeat placed the resolved values,
  // falling back to the raw config element if no child scope has it.
  function getResolvedElements(scope) {
    var rawEls = scope.config && scope.config.svg && scope.config.svg.elements;
    if (!rawEls) return [];

    // Build a map from element name → child scope's element (has resolved values).
    var childMap = {};
    getElementScopes(scope).forEach(function (child) {
      if (child.element && child.element.name) {
        childMap[child.element.name] = child.element;
      }
    });

    return rawEls.map(function (rawEl) {
      // Prefer the child-scope copy (has ng-init resolved scalars).
      return childMap[rawEl.name] || rawEl;
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  function waitForAngular(cb) {
    var attempts = 0;
    var interval = setInterval(function () {
      attempts++;
      var body = document.body || document.querySelector('[ng-app]');
      if (!body) return;
      try {
        var injector = angular.element(body).injector();  // eslint-disable-line no-undef
        if (injector) {
          clearInterval(interval);
          cb(injector);
        }
      } catch (e) { /* angular not ready yet */ }
      if (attempts > 200) clearInterval(interval); // give up after 10s
    }, 50);
  }

  projectId = getProjectIdFromUrl();

  waitForAngular(function (injector) {
    var rootScope = injector.get('$rootScope');
    var $state = injector.get('$state');
    $location = injector.get('$location');

    // Force default route to wsjpro (the bundle defaults to /watermark which no longer exists)
    var DEFAULT_MODE = 'wsjpro';
    setTimeout(function () {
      var cur = $state.current && $state.current.name;
      if (cur && cur !== DEFAULT_MODE && !projectId) {
        $state.go(DEFAULT_MODE);
      }
    }, 0);

    // $stateChangeSuccess may have already fired before we registered the listener
    // (the shim loads after the bundles and Angular bootstraps synchronously).
    // Check if a state is already active and attach watches immediately.
    setTimeout(function () {
      var currentName = $state.current && $state.current.name;
      if (currentName && !initialized) {
        var scope = getControllerScope();
        if (scope) {
          if (projectId) {
            initialized = true;
            fetch(API_BASE + '/projects/' + projectId)
              .then(function (r) {
                if (!r.ok) throw new Error('not found');
                return r.json();
              })
              .then(function (project) {
                if (project.mode !== currentName) {
                  window.__ckPendingState = project.state;
                  rootScope.$state.go(project.mode);
                  return;
                }
                waitForChildScopes(scope, function () {
                  hydrateScope(scope, project.state);
                  watchScope(scope, currentName);
                });
              })
              .catch(function () {
                watchScope(scope, currentName);
              });
          } else {
            initialized = true;
            watchScope(scope, currentName);
          }
        }
      }
    }, 150);

    rootScope.$on('$stateChangeSuccess', function (event, toState) {
      var modeName = toState.name;
      var age = Date.now() - startTime;

      // Yield one tick so ng-init in the view template can resolve function-
      // valued element properties (e.g. element.value = element.value()) to
      // plain strings before we attempt to read or write them.
      setTimeout(function () {
        var scope = getControllerScope();
        if (!scope) return;

        if (!initialized && projectId) {
          // Page load with a project ID in the URL: fetch and hydrate.
          initialized = true;
          fetch(API_BASE + '/projects/' + projectId)
            .then(function (r) {
              if (!r.ok) throw new Error('not found');
              return r.json();
            })
            .then(function (project) {
              if (project.mode !== modeName) {
                window.__ckPendingState = project.state;
                rootScope.$state.go(project.mode);
                return;
              }
              // Wait for ng-repeat + ng-init to finish rendering child scopes
              // before hydrating. ng-init runs element.value=element.value() which
              // would overwrite our hydrated values if we write too early.
              waitForChildScopes(scope, function () {
                hydrateScope(scope, project.state);
                watchScope(scope, modeName);
              });
            })
            .catch(function () {
              watchScope(scope, modeName);
            });

        } else if (window.__ckPendingState) {
          // We navigated to the saved mode; now hydrate.
          var pending = window.__ckPendingState;
          delete window.__ckPendingState;
          initialized = true;
          setTimeout(function () {
            var s = getControllerScope();
            if (s) {
              waitForChildScopes(s, function () {
                hydrateScope(s, pending);
                watchScope(s, modeName);
              });
            }
          }, 0);

        } else if (modeName !== watchedMode) {
          // Re-attach watches on genuine user navigation to a different mode.
          // Ignore $stateChangeSuccess events that fire during the initial load
          // sequence (within 300ms of page load) — these are transient route
          // transitions (e.g. '' → 'watermark' → 'wsjpro') and must not override
          // the mode the 150ms fallback already established.
          // NOTE: age is captured in the outer closure at the time the event fired,
          // not recomputed here (setTimeout delay would make it always > 300ms).
          if (age > 300) {
            watchScope(scope, modeName);
          }
        }
      }, 0);
    });
  });

  // ── Public API ────────────────────────────────────────────────────────────

  window.cardkitShim = {
    /** Copy the current project URL to the clipboard. */
    share: function () {
      var url = window.location.href;
      if (!projectId) {
        // No project saved yet — force an immediate save then copy.
        var scope = getControllerScope();
        if (scope) {
          clearTimeout(saveTimer);
          saveProject(scope, 'unknown');
        }
        setTimeout(function () { copyToClipboard(window.location.href); }, 500);
        return;
      }
      copyToClipboard(url);
    },
    /** Hydrate the current card with a state object (used by the future AI endpoint). */
    hydrate: function (state) {
      var scope = getControllerScope();
      if (scope) hydrateScope(scope, state);
    },
  };

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showStatus('copied');
      }).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showStatus('copied'); } catch (e) { /* silent */ }
    document.body.removeChild(ta);
  }

  // ── Google Sheets Data Table ───────────────────────────────────────────────

  var DEFAULT_SPREADSHEET = '1q_Cbi9mF2mPYCcgeihes7uxQ1lw3Iq67RFznZuwUz0w';
  var DEFAULT_SHEET = 'RESULT_ADDONS';
  var PAGE_SIZE = 50;

  // Column indices from the raw sheet (0-based): a=0, Deal Code=1, Updated WSJ PE Firm Name=5, Platform Co.=9, Co. Acquire=10, Sector=11, Story URL=12
  var DISPLAY_COLUMNS = [
    { idx: 0,  label: 'Date' },
    { idx: 1,  label: 'Deal Code', linkIdx: 12 },
    { idx: 5,  label: 'PE Firm-WSJ' },
    { idx: 9,  label: 'Platform Co.' },
    { idx: 10, label: 'Co. Acquire' },
    { idx: 11, label: 'Sector' },
  ];

  var tableData = { headers: [], rows: [], sortedRows: [] };
  var currentPage = 0;

  function initSheetsTable() {
    var container = document.getElementById('ck-table-wrapper');
    if (!container) return;

    var statusEl = document.getElementById('ck-table-status');
    if (statusEl) statusEl.textContent = 'Loading recent data…';

    var range = "'" + DEFAULT_SHEET + "'";
    var baseUrl = API_BASE + '/sheets/raw?spreadsheet=' + encodeURIComponent(DEFAULT_SPREADSHEET) +
              '&range=' + encodeURIComponent(range);

    // Compute cutoff: first day of last full month
    var now = new Date();
    var lastMonth = now.getMonth(); // 0-based current month; last full = current - 1
    var cutoffYear = now.getFullYear();
    if (lastMonth === 0) { lastMonth = 12; cutoffYear--; }
    var cutoffDate = (lastMonth < 10 ? '0' : '') + lastMonth + '/01/' + cutoffYear;

    // Phase 1: load recent data (last full month + current partial)
    fetch(baseUrl + '&after=' + encodeURIComponent(cutoffDate))
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Request failed'); });
        return r.json();
      })
      .then(function (data) {
        tableData.headers = data.headers || [];
        tableData.rows = data.rows || [];
        sortByDateDesc();
        currentPage = 0;
        if (statusEl) statusEl.textContent = tableData.rows.length + ' rows loaded (recent). Loading full dataset…';
        initStats();
        renderTable();

        // Phase 2: load all data in background
        return fetch(baseUrl);
      })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Request failed'); });
        return r.json();
      })
      .then(function (data) {
        tableData.headers = data.headers || [];
        tableData.rows = data.rows || [];
        sortByDateDesc();
        currentPage = 0;
        if (statusEl) statusEl.textContent = tableData.rows.length + ' rows loaded.';
        initStats();
        renderTable();
        var updatedEl = document.getElementById('ck-table-updated');
        if (updatedEl && data.synced_at) {
          var d = new Date(data.synced_at);
          updatedEl.textContent = 'Last updated: ' + d.toLocaleString('en-US', {
            timeZone: 'America/New_York', month: 'short', day: 'numeric',
            year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
          });
        }
      })
      .catch(function (err) {
        if (statusEl) {
          statusEl.textContent = 'Failed: ' + (err.message || 'Unknown error');
          statusEl.style.color = '#a94442';
        }
      });
  }

  function sortByDateDesc() {
    var dateCol = 0; // Column A is the date

    tableData.sortedRows = tableData.rows.slice().sort(function (a, b) {
      var aVal = a[dateCol] || '';
      var bVal = b[dateCol] || '';
      var aDate = new Date(aVal);
      var bDate = new Date(bVal);
      if (!isNaN(aDate) && !isNaN(bDate)) return bDate - aDate;
      return bVal > aVal ? -1 : aVal > bVal ? 1 : 0;
    });
  }

  // ── Summary Stats ───────────────────────────────────────────────────────

  function getEstHour(date) {
    // Get the current hour in US Eastern time (handles DST via toLocaleString)
    var str = date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    return parseInt(str);
  }

  function getDefaultHalf() {
    // Default to full previous month until 3pm EST on the 15th of the current month,
    // then switch to first half of the current month.
    var now = new Date();
    var estHour = getEstHour(now);
    var day = now.getDate();
    if (day > 15 || (day === 15 && estHour >= 15)) {
      return 'first';
    }
    return 'full';
  }

  function getAvailableMonths() {
    var months = {};
    tableData.rows.forEach(function (row) {
      var d = new Date(row[0]);
      if (!isNaN(d)) {
        var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        months[key] = true;
      }
    });
    return Object.keys(months).sort().reverse();
  }

  function getLastFullMonth(half) {
    // For "first": current month becomes available at 3pm EST on the 14th.
    // For "full": previous month (current month is never fully complete mid-month).
    var now = new Date();
    var estHour = getEstHour(now);
    var y = now.getFullYear();
    var m = now.getMonth() + 1; // 1-based current month
    var day = now.getDate();

    if (half === 'first') {
      // 1st half of current month available after 3pm EST on the 15th
      if (day > 15 || (day === 15 && estHour >= 15)) {
        return y + '-' + String(m).padStart(2, '0');
      }
      // Otherwise previous month's 1st half
      if (m === 1) { m = 12; y--; } else { m--; }
      return y + '-' + String(m).padStart(2, '0');
    }

    // Full month: always default to previous month
    if (m === 1) { m = 12; y--; } else { m--; }
    return y + '-' + String(m).padStart(2, '0');
  }

  function getAvailableQuarters() {
    var quarters = {};
    tableData.rows.forEach(function (row) {
      var d = new Date(row[0]);
      if (!isNaN(d)) {
        var q = Math.ceil((d.getMonth() + 1) / 3);
        var key = d.getFullYear() + '-Q' + q;
        quarters[key] = true;
      }
    });
    return Object.keys(quarters).sort().reverse();
  }

  function getLastFullQuarter() {
    // A quarter is "complete" after 3pm EST on its last day.
    var now = new Date();
    var estHour = getEstHour(now);
    var y = now.getFullYear();
    var m = now.getMonth() + 1;
    var day = now.getDate();
    var currentQ = Math.ceil(m / 3);
    var lastMonthOfQ = currentQ * 3;
    var lastDayOfQ = new Date(y, lastMonthOfQ, 0).getDate();

    if (m === lastMonthOfQ && day === lastDayOfQ && estHour >= 15) {
      // Current quarter just closed
      return y + '-Q' + currentQ;
    }
    // Otherwise previous quarter
    var prevQ = currentQ - 1;
    var prevY = y;
    if (prevQ === 0) { prevQ = 4; prevY--; }
    return prevY + '-Q' + prevQ;
  }

  function getSelectedPeriodType() {
    var radio = document.querySelector('input[name="ck-period-type"]:checked');
    return radio ? radio.value : 'month';
  }

  function computeQuarterStats(year, quarter) {
    var startMonth = (quarter - 1) * 3 + 1;
    var endMonth = quarter * 3;
    var filtered = tableData.rows.filter(function (row) {
      var d = new Date(row[0]);
      if (isNaN(d)) return false;
      var m = d.getMonth() + 1;
      return d.getFullYear() === year && m >= startMonth && m <= endMonth;
    });

    var dealCodes = {};
    var peFirms = {};
    var platforms = {};
    filtered.forEach(function (row) {
      var dealCode = row[1] != null ? String(row[1]) : '';
      var peFirm = row[5] != null ? String(row[5]).trim() : '';
      var platform = row[9] != null ? String(row[9]).trim() : '';
      if (dealCode) dealCodes[dealCode] = true;
      if (peFirm) peFirms[peFirm] = true;
      if (platform) platforms[platform] = true;
    });

    return {
      deals: Object.keys(dealCodes).length,
      firms: Object.keys(peFirms).length,
      platforms: Object.keys(platforms).length,
    };
  }

  function initStats() {
    var monthSelect = document.getElementById('ck-stats-month');
    var quarterSelect = document.getElementById('ck-stats-quarter');
    if (!monthSelect) return;

    var months = getAvailableMonths();
    var defaultHalf = getDefaultHalf();
    var lastFull = getLastFullMonth(defaultHalf);

    monthSelect.innerHTML = '';
    months.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m;
      var parts = m.split('-');
      var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      opt.textContent = monthNames[parseInt(parts[1]) - 1] + ' ' + parts[0];
      if (m === lastFull) opt.selected = true;
      monthSelect.appendChild(opt);
    });

    if (months.indexOf(lastFull) === -1 && months.length) {
      monthSelect.value = months[0];
    }

    // Populate quarter dropdown
    if (quarterSelect) {
      var quarters = getAvailableQuarters();
      var lastFullQ = getLastFullQuarter();
      quarterSelect.innerHTML = '';
      quarters.forEach(function (q) {
        var opt = document.createElement('option');
        opt.value = q;
        opt.textContent = q.replace('-', ' ');
        if (q === lastFullQ) opt.selected = true;
        quarterSelect.appendChild(opt);
      });
      if (quarters.indexOf(lastFullQ) === -1 && quarters.length) {
        quarterSelect.value = quarters[0];
      }
      quarterSelect.addEventListener('change', computeStats);
    }

    // Set default half based on 3pm EST cutoff on the 15th
    var halfRadio = document.querySelector('input[name="ck-half"][value="' + defaultHalf + '"]');
    if (halfRadio) halfRadio.checked = true;

    monthSelect.addEventListener('change', computeStats);
    document.querySelectorAll('input[name="ck-half"]').forEach(function (r) {
      r.addEventListener('change', computeStats);
    });

    // Period type toggle
    document.querySelectorAll('input[name="ck-period-type"]').forEach(function (r) {
      r.addEventListener('change', function () {
        var monthControls = document.getElementById('ck-month-controls');
        var quarterControls = document.getElementById('ck-quarter-controls');
        if (getSelectedPeriodType() === 'quarter') {
          if (monthControls) monthControls.style.display = 'none';
          if (quarterControls) quarterControls.style.display = '';
        } else {
          if (monthControls) monthControls.style.display = '';
          if (quarterControls) quarterControls.style.display = 'none';
        }
        computeStats();
      });
    });

    computeStats();
  }

  function computePeriodStats(y, m, half) {
    var filtered = tableData.rows.filter(function (row) {
      var d = new Date(row[0]);
      if (isNaN(d)) return false;
      if (d.getFullYear() !== y || (d.getMonth() + 1) !== m) return false;
      var day = d.getDate();
      if (half === 'first' && day > 15) return false;
      if (half === 'second' && day <= 15) return false;
      return true;
    });

    var dealCodes = {};
    var peFirms = {};
    var platforms = {};
    filtered.forEach(function (row) {
      var dealCode = row[1] != null ? String(row[1]) : '';
      var peFirm = row[5] != null ? String(row[5]).trim() : '';
      var platform = row[9] != null ? String(row[9]).trim() : '';
      if (dealCode) dealCodes[dealCode] = true;
      if (peFirm) peFirms[peFirm] = true;
      if (platform) platforms[platform] = true;
    });

    return {
      deals: Object.keys(dealCodes).length,
      firms: Object.keys(peFirms).length,
      platforms: Object.keys(platforms).length,
    };
  }

  function ordinalSuffix(n) {
    var s = ['th','st','nd','rd'];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Returns per-year stats for the same month+half across all years in the dataset.
  function getMonthHistoricalStats(month, half) {
    var years = {};
    tableData.rows.forEach(function (row) {
      var d = new Date(row[0]);
      if (isNaN(d)) return;
      if ((d.getMonth() + 1) !== month) return;
      var day = d.getDate();
      if (half === 'first' && day > 15) return;
      if (half === 'second' && day <= 15) return;
      var y = d.getFullYear();
      if (!years[y]) years[y] = { dealCodes: {}, peFirms: {}, platforms: {} };
      var dealCode = row[1] != null ? String(row[1]) : '';
      var peFirm   = row[5] != null ? String(row[5]).trim() : '';
      var platform = row[9] != null ? String(row[9]).trim() : '';
      if (dealCode) years[y].dealCodes[dealCode] = true;
      if (peFirm)   years[y].peFirms[peFirm] = true;
      if (platform) years[y].platforms[platform] = true;
    });
    var result = {};
    Object.keys(years).forEach(function (y) {
      result[y] = {
        deals:     Object.keys(years[y].dealCodes).length,
        firms:     Object.keys(years[y].peFirms).length,
        platforms: Object.keys(years[y].platforms).length,
      };
    });
    return result;
  }

  // Returns per-year stats for the same quarter across all years.
  function getQuarterHistoricalStats(quarter) {
    var startMonth = (quarter - 1) * 3 + 1;
    var endMonth   = quarter * 3;
    var years = {};
    tableData.rows.forEach(function (row) {
      var d = new Date(row[0]);
      if (isNaN(d)) return;
      var m = d.getMonth() + 1;
      if (m < startMonth || m > endMonth) return;
      var y = d.getFullYear();
      if (!years[y]) years[y] = { dealCodes: {}, peFirms: {}, platforms: {} };
      var dealCode = row[1] != null ? String(row[1]) : '';
      var peFirm   = row[5] != null ? String(row[5]).trim() : '';
      var platform = row[9] != null ? String(row[9]).trim() : '';
      if (dealCode) years[y].dealCodes[dealCode] = true;
      if (peFirm)   years[y].peFirms[peFirm] = true;
      if (platform) years[y].platforms[platform] = true;
    });
    var result = {};
    Object.keys(years).forEach(function (y) {
      result[y] = {
        deals:     Object.keys(years[y].dealCodes).length,
        firms:     Object.keys(years[y].peFirms).length,
        platforms: Object.keys(years[y].platforms).length,
      };
    });
    return result;
  }

  // Returns rank label + comparison string for a given metric.
  function rankLabel(currentYear, currentVal, historicalStats, metric) {
    var sorted = Object.keys(historicalStats)
      .map(function (y) { return { year: parseInt(y), val: historicalStats[y][metric] }; })
      .sort(function (a, b) { return b.val - a.val || a.year - b.year; });

    var rank = 1;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].year === currentYear) break;
      if (sorted[i].val > currentVal) rank++;
    }

    var ordinal = ordinalSuffix(rank);
    var comp;
    if (rank === 1) {
      // Show 2nd place (previous record)
      var second = sorted.filter(function (x) { return x.year !== currentYear; })[0];
      comp = second ? '(prev: ' + second.year + ', ' + second.val + ')' : '';
    } else {
      // Show the #1 record
      var record = sorted[0];
      comp = '(record: ' + record.year + ', ' + record.val + ')';
    }
    return '<div style="font-size:10px;color:#666;margin-top:4px">Rank: ' + ordinal + ' ' + comp + '</div>';
  }

  function changeLabel(current, previous, label) {
    if (!previous) return '<span style="color:#999;font-size:10px">(' + label + ': n/a)</span>';
    var pct = Math.round(((current - previous) / previous) * 100);
    var color = pct > 0 ? '#3c763d' : pct < 0 ? '#a94442' : '#666';
    var arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→';
    return '<span style="color:' + color + ';font-size:10px">' + arrow + Math.abs(pct) + '% ' + label + '</span>';
  }

  function computeStats() {
    var summaryEl = document.getElementById('ck-stats-summary');
    if (!summaryEl) return;

    var periodType = getSelectedPeriodType();

    if (periodType === 'quarter') {
      computeStatsQuarter(summaryEl);
    } else {
      computeStatsMonth(summaryEl);
    }
  }

  function computeStatsMonth(summaryEl) {
    var monthSelect = document.getElementById('ck-stats-month');
    if (!monthSelect) return;

    var selectedMonth = monthSelect.value;
    var parts = selectedMonth.split('-');
    var year = parseInt(parts[0]);
    var month = parseInt(parts[1]);

    var halfRadio = document.querySelector('input[name="ck-half"]:checked');
    var half = halfRadio ? halfRadio.value : 'full';

    var filtered = tableData.rows.filter(function (row) {
      var d = new Date(row[0]);
      if (isNaN(d)) return false;
      if (d.getFullYear() !== year || (d.getMonth() + 1) !== month) return false;
      var day = d.getDate();
      if (half === 'first' && day > 15) return false;
      if (half === 'second' && day <= 15) return false;
      return true;
    });

    var dealCodes = {};
    var peFirms = {};
    var platforms = {};
    var sectors = {};

    filtered.forEach(function (row) {
      var dealCode = row[1] != null ? String(row[1]) : '';
      var peFirm = row[5] != null ? String(row[5]).trim() : '';
      var platform = row[9] != null ? String(row[9]).trim() : '';
      var sector = row[11] != null ? String(row[11]).trim() : '';

      if (dealCode) dealCodes[dealCode] = true;
      if (peFirm) peFirms[peFirm] = (peFirms[peFirm] || 0) + 1;
      if (platform) platforms[platform] = true;
      if (sector) sectors[sector] = (sectors[sector] || 0) + 1;
    });

    var totalDeals = Object.keys(dealCodes).length;
    var uniqueFirms = Object.keys(peFirms).length;
    var uniquePlatforms = Object.keys(platforms).length;

    var topSectors = Object.keys(sectors).map(function (k) { return { name: k, count: sectors[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);

    var topFirms = Object.keys(peFirms).map(function (k) { return { name: k, count: peFirms[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);

    var prevMonthYear = month === 1 ? year - 1 : year;
    var prevMonth = month === 1 ? 12 : month - 1;
    var yoyYear = year - 1;

    var momStats = computePeriodStats(prevMonthYear, prevMonth, half);
    var yoyStats = computePeriodStats(yoyYear, month, half);

    var historical = getMonthHistoricalStats(month, half);
    historical[year] = { deals: totalDeals, firms: uniqueFirms, platforms: uniquePlatforms };

    var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var label = monthNames[month - 1] + ' ' + year;
    if (half === 'first') label += ' (1st half)';

    var html = '<div style="margin-bottom:8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#666">' + escapeHtml(label) + '</div>';
    html += '<div style="display:flex;gap:12px;margin-bottom:10px">';
    html += '<div style="flex:1;text-align:center;padding:10px 8px;background:#fff;border:1px solid #dee2e6;border-radius:6px">';
    html += '<div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">' + totalDeals + '</div>';
    html += '<div style="font-size:10px;color:#666;margin:2px 0">Deals</div>';
    html += '<div>' + changeLabel(totalDeals, momStats.deals, 'MoM') + ' ' + changeLabel(totalDeals, yoyStats.deals, 'YoY') + '</div>';
    html += rankLabel(year, totalDeals, historical, 'deals');
    html += '</div>';
    html += '<div style="flex:1;text-align:center;padding:10px 8px;background:#fff;border:1px solid #dee2e6;border-radius:6px">';
    html += '<div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">' + uniqueFirms + '</div>';
    html += '<div style="font-size:10px;color:#666;margin:2px 0">PE Firms</div>';
    html += '<div>' + changeLabel(uniqueFirms, momStats.firms, 'MoM') + ' ' + changeLabel(uniqueFirms, yoyStats.firms, 'YoY') + '</div>';
    html += rankLabel(year, uniqueFirms, historical, 'firms');
    html += '</div>';
    html += '<div style="flex:1;text-align:center;padding:10px 8px;background:#fff;border:1px solid #dee2e6;border-radius:6px">';
    html += '<div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">' + uniquePlatforms + '</div>';
    html += '<div style="font-size:10px;color:#666;margin:2px 0">Platform Cos.</div>';
    html += '<div>' + changeLabel(uniquePlatforms, momStats.platforms, 'MoM') + ' ' + changeLabel(uniquePlatforms, yoyStats.platforms, 'YoY') + '</div>';
    html += rankLabel(year, uniquePlatforms, historical, 'platforms');
    html += '</div>';
    html += '</div>';

    if (topSectors.length) {
      html += '<div style="font-size:11px;margin-bottom:2px"><strong>Top sectors:</strong> ';
      html += topSectors.map(function (s) { return escapeHtml(s.name) + ' (' + s.count + ')'; }).join(', ');
      html += '</div>';
    }

    if (topFirms.length) {
      html += '<div style="font-size:11px"><strong>Most active firms:</strong> ';
      html += topFirms.map(function (f) { return escapeHtml(f.name) + ' (' + f.count + ')'; }).join(', ');
      html += '</div>';
    }

    summaryEl.innerHTML = html;
  }

  function computeStatsQuarter(summaryEl) {
    var quarterSelect = document.getElementById('ck-stats-quarter');
    if (!quarterSelect) return;

    var val = quarterSelect.value; // e.g. '2025-Q3'
    var parts = val.split('-Q');
    var year = parseInt(parts[0]);
    var quarter = parseInt(parts[1]);
    var startMonth = (quarter - 1) * 3 + 1;
    var endMonth = quarter * 3;

    var filtered = tableData.rows.filter(function (row) {
      var d = new Date(row[0]);
      if (isNaN(d)) return false;
      var m = d.getMonth() + 1;
      return d.getFullYear() === year && m >= startMonth && m <= endMonth;
    });

    var dealCodes = {};
    var peFirms = {};
    var platforms = {};
    var sectors = {};

    filtered.forEach(function (row) {
      var dealCode = row[1] != null ? String(row[1]) : '';
      var peFirm = row[5] != null ? String(row[5]).trim() : '';
      var platform = row[9] != null ? String(row[9]).trim() : '';
      var sector = row[11] != null ? String(row[11]).trim() : '';

      if (dealCode) dealCodes[dealCode] = true;
      if (peFirm) peFirms[peFirm] = (peFirms[peFirm] || 0) + 1;
      if (platform) platforms[platform] = true;
      if (sector) sectors[sector] = (sectors[sector] || 0) + 1;
    });

    var totalDeals = Object.keys(dealCodes).length;
    var uniqueFirms = Object.keys(peFirms).length;
    var uniquePlatforms = Object.keys(platforms).length;

    var topSectors = Object.keys(sectors).map(function (k) { return { name: k, count: sectors[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);

    var topFirms = Object.keys(peFirms).map(function (k) { return { name: k, count: peFirms[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);

    // QoQ: previous quarter
    var prevQ = quarter === 1 ? 4 : quarter - 1;
    var prevQYear = quarter === 1 ? year - 1 : year;
    var qoqStats = computeQuarterStats(prevQYear, prevQ);

    // YoY: same quarter last year
    var yoyStats = computeQuarterStats(year - 1, quarter);

    var historical = getQuarterHistoricalStats(quarter);
    historical[year] = { deals: totalDeals, firms: uniqueFirms, platforms: uniquePlatforms };

    var label = 'Q' + quarter + ' ' + year;

    var html = '<div style="margin-bottom:8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#666">' + escapeHtml(label) + '</div>';
    html += '<div style="display:flex;gap:12px;margin-bottom:10px">';
    html += '<div style="flex:1;text-align:center;padding:10px 8px;background:#fff;border:1px solid #dee2e6;border-radius:6px">';
    html += '<div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">' + totalDeals + '</div>';
    html += '<div style="font-size:10px;color:#666;margin:2px 0">Deals</div>';
    html += '<div>' + changeLabel(totalDeals, qoqStats.deals, 'QoQ') + ' ' + changeLabel(totalDeals, yoyStats.deals, 'YoY') + '</div>';
    html += rankLabel(year, totalDeals, historical, 'deals');
    html += '</div>';
    html += '<div style="flex:1;text-align:center;padding:10px 8px;background:#fff;border:1px solid #dee2e6;border-radius:6px">';
    html += '<div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">' + uniqueFirms + '</div>';
    html += '<div style="font-size:10px;color:#666;margin:2px 0">PE Firms</div>';
    html += '<div>' + changeLabel(uniqueFirms, qoqStats.firms, 'QoQ') + ' ' + changeLabel(uniqueFirms, yoyStats.firms, 'YoY') + '</div>';
    html += rankLabel(year, uniqueFirms, historical, 'firms');
    html += '</div>';
    html += '<div style="flex:1;text-align:center;padding:10px 8px;background:#fff;border:1px solid #dee2e6;border-radius:6px">';
    html += '<div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">' + uniquePlatforms + '</div>';
    html += '<div style="font-size:10px;color:#666;margin:2px 0">Platform Cos.</div>';
    html += '<div>' + changeLabel(uniquePlatforms, qoqStats.platforms, 'QoQ') + ' ' + changeLabel(uniquePlatforms, yoyStats.platforms, 'YoY') + '</div>';
    html += rankLabel(year, uniquePlatforms, historical, 'platforms');
    html += '</div>';
    html += '</div>';

    if (topSectors.length) {
      html += '<div style="font-size:11px;margin-bottom:2px"><strong>Top sectors:</strong> ';
      html += topSectors.map(function (s) { return escapeHtml(s.name) + ' (' + s.count + ')'; }).join(', ');
      html += '</div>';
    }

    if (topFirms.length) {
      html += '<div style="font-size:11px"><strong>Most active firms:</strong> ';
      html += topFirms.map(function (f) { return escapeHtml(f.name) + ' (' + f.count + ')'; }).join(', ');
      html += '</div>';
    }

    summaryEl.innerHTML = html;
  }

  function renderTable() {
    var container = document.getElementById('ck-table-wrapper');
    if (!container) return;

    var start = currentPage * PAGE_SIZE;
    var end = Math.min(start + PAGE_SIZE, tableData.sortedRows.length);
    var pageRows = tableData.sortedRows.slice(start, end);

    var html = '<table style="width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed">';
    html += '<thead><tr>';
    DISPLAY_COLUMNS.forEach(function (col) {
      html += '<th style="border:1px solid #ddd;padding:3px 5px;background:#f5f5f5;white-space:nowrap;position:sticky;top:0">' +
              escapeHtml(col.label) + '</th>';
    });
    html += '</tr></thead><tbody>';

    pageRows.forEach(function (row) {
      html += '<tr>';
      DISPLAY_COLUMNS.forEach(function (col) {
        var val = (row[col.idx] != null) ? String(row[col.idx]) : '';
        var tdStyle = 'border:1px solid #eee;padding:2px 5px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        if (col.linkIdx !== undefined) {
          var linkUrl = (row[col.linkIdx] != null) ? String(row[col.linkIdx]).trim() : '';
          if (linkUrl) {
            html += '<td style="' + tdStyle + '"><a href="' +
                    escapeHtml(linkUrl) + '" target="_blank" title="' + escapeHtml(val) + '">' + escapeHtml(val) + '</a></td>';
          } else {
            html += '<td style="' + tdStyle + '">' + escapeHtml(val) + '</td>';
          }
        } else {
          html += '<td style="' + tdStyle + '" title="' + escapeHtml(val) + '">' + escapeHtml(val) + '</td>';
        }
      });
      html += '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    renderPagination();
  }

  function renderPagination() {
    var pagEl = document.getElementById('ck-table-pagination');
    if (!pagEl) return;

    var totalPages = Math.ceil(tableData.sortedRows.length / PAGE_SIZE);
    if (totalPages <= 1) {
      pagEl.innerHTML = '';
      return;
    }

    var html = '';
    if (currentPage > 0) {
      html += '<button class="btn btn-xs btn-default" id="ck-page-prev">← Prev</button> ';
    }
    html += 'Page ' + (currentPage + 1) + ' of ' + totalPages +
            ' (' + tableData.sortedRows.length + ' rows) ';
    if (currentPage < totalPages - 1) {
      html += '<button class="btn btn-xs btn-default" id="ck-page-next">Next →</button>';
    }
    pagEl.innerHTML = html;

    var prevBtn = document.getElementById('ck-page-prev');
    var nextBtn = document.getElementById('ck-page-next');
    if (prevBtn) prevBtn.addEventListener('click', function () { currentPage--; renderTable(); });
    if (nextBtn) nextBtn.addEventListener('click', function () { currentPage++; renderTable(); });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── AI Features ──────────────────────────────────────────────────────────

  var CHAT_STORAGE_KEY = 'ck-ai-chat-history';
  var CHAT_MAX_MESSAGES = 50;
  var CHAT_HISTORY_WINDOW = 6; // messages sent to AI for context
  var chatHistory = [];

  function loadChatHistory() {
    try {
      var stored = localStorage.getItem(CHAT_STORAGE_KEY);
      if (!stored) return;
      var parsed = JSON.parse(stored);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.messages)) {
        chatHistory = parsed.messages;
      }
    } catch (e) { /* ignore corrupt data */ }
  }

  function saveChatHistory() {
    if (chatHistory.length > CHAT_MAX_MESSAGES) {
      chatHistory = chatHistory.slice(chatHistory.length - CHAT_MAX_MESSAGES);
    }
    try {
      var payload = JSON.stringify({ version: 1, messages: chatHistory });
      if (payload.length > 500000) {
        chatHistory = chatHistory.slice(Math.floor(chatHistory.length / 2));
        payload = JSON.stringify({ version: 1, messages: chatHistory });
      }
      localStorage.setItem(CHAT_STORAGE_KEY, payload);
    } catch (e) { /* quota exceeded — trim further */ }
  }

  function restoreChatMessages() {
    var messages = document.getElementById('ck-chat-messages');
    if (!messages || !chatHistory.length) return;
    chatHistory.forEach(function (msg) {
      var sender = msg.role === 'user' ? 'You' : 'AI';
      var div = document.createElement('div');
      div.style.marginBottom = '6px';
      div.style.padding = '4px 6px';
      div.style.background = msg.role === 'user' ? '#e8f4fd' : '#f9f9f9';
      div.style.borderRadius = '3px';
      div.innerHTML = '<strong>' + escapeHtml(sender) + ':</strong> ' + escapeHtml(msg.content);
      messages.appendChild(div);
    });
    messages.scrollTop = messages.scrollHeight;
  }

  function clearChatHistory() {
    chatHistory = [];
    localStorage.removeItem(CHAT_STORAGE_KEY);
    var messages = document.getElementById('ck-chat-messages');
    if (messages) messages.innerHTML = '';
  }

  function getRecentHistory() {
    return chatHistory.slice(-CHAT_HISTORY_WINDOW);
  }

  function getCurrentCardValues() {
    var scope = getControllerScope();
    if (!scope) return null;
    var els = scope.config && scope.config.svg && scope.config.svg.elements;
    if (!els) return null;
    var values = {};
    Object.keys(CARD_FIELD_TO_ELEMENT).forEach(function (field) {
      var el = findByName(els, CARD_FIELD_TO_ELEMENT[field]);
      if (el && el.value) values[field] = el.value;
    });
    return Object.keys(values).length ? values : null;
  }

  function getCardContext() {
    var periodType = getSelectedPeriodType();
    var ctx = { period_type: periodType };
    if (periodType === 'quarter') {
      var quarterSelect = document.getElementById('ck-stats-quarter');
      var val = quarterSelect ? quarterSelect.value : '';
      var qParts = val.split('-Q');
      ctx.year = parseInt(qParts[0]);
      ctx.quarter = parseInt(qParts[1]);
    } else {
      var monthSelect = document.getElementById('ck-stats-month');
      var halfRadio = document.querySelector('input[name="ck-half"]:checked');
      var selectedMonth = monthSelect ? monthSelect.value : '';
      var parts = selectedMonth.split('-');
      ctx.year = parseInt(parts[0]);
      ctx.month = parseInt(parts[1]);
      ctx.half = halfRadio ? halfRadio.value : 'full';
    }
    return ctx;
  }

  function initAI() {
    var autoBtn = document.getElementById('ck-ai-autocard');
    var chatSend = document.getElementById('ck-chat-send');
    var chatInput = document.getElementById('ck-chat-input');
    var chatClear = document.getElementById('ck-chat-clear');

    if (autoBtn) {
      autoBtn.addEventListener('click', handleAutoCard);
    }

    if (chatSend && chatInput) {
      chatSend.addEventListener('click', handleChat);
      chatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') handleChat();
      });
    }

    if (chatClear) {
      chatClear.addEventListener('click', clearChatHistory);
    }

    loadChatHistory();
    restoreChatMessages();
  }

  function handleAutoCard() {
    var statusEl = document.getElementById('ck-ai-autocard-status');
    var periodType = getSelectedPeriodType();

    if (!tableData.rows.length) {
      if (statusEl) statusEl.textContent = 'No data loaded.';
      return;
    }

    if (statusEl) {
      statusEl.textContent = 'Generating…';
      statusEl.style.color = '#333';
    }

    var payload;
    if (periodType === 'quarter') {
      var quarterSelect = document.getElementById('ck-stats-quarter');
      var val = quarterSelect ? quarterSelect.value : '';
      var qParts = val.split('-Q');
      var year = parseInt(qParts[0]);
      var quarter = parseInt(qParts[1]);
      var startMonth = (quarter - 1) * 3 + 1;
      var endMonth = quarter * 3;

      // Send rows for current quarter, previous quarter, and same quarter last year
      var relevantRows = tableData.rows.filter(function (row) {
        var d = new Date(row[0]);
        if (isNaN(d)) return false;
        var ry = d.getFullYear(), rm = d.getMonth() + 1;
        // Current quarter
        if (ry === year && rm >= startMonth && rm <= endMonth) return true;
        // Previous quarter
        var prevQ = quarter === 1 ? 4 : quarter - 1;
        var prevQYear = quarter === 1 ? year - 1 : year;
        var prevStart = (prevQ - 1) * 3 + 1;
        var prevEnd = prevQ * 3;
        if (ry === prevQYear && rm >= prevStart && rm <= prevEnd) return true;
        // Same quarter last year
        if (ry === year - 1 && rm >= startMonth && rm <= endMonth) return true;
        return false;
      });

      payload = {
        headers: tableData.headers,
        rows: relevantRows,
        year: year,
        quarter: quarter,
        period_type: 'quarter',
      };
    } else {
      var monthSelect = document.getElementById('ck-stats-month');
      var halfRadio = document.querySelector('input[name="ck-half"]:checked');
      var selectedMonth = monthSelect ? monthSelect.value : '';
      var parts = selectedMonth.split('-');
      var year = parseInt(parts[0]);
      var month = parseInt(parts[1]);
      var half = halfRadio ? halfRadio.value : 'full';

      var relevantRows = tableData.rows.filter(function (row) {
        var d = new Date(row[0]);
        if (isNaN(d)) return false;
        var ry = d.getFullYear(), rm = d.getMonth() + 1;
        if (ry === year && rm === month) return true;
        var pm = month === 1 ? 12 : month - 1;
        var py = month === 1 ? year - 1 : year;
        if (ry === py && rm === pm) return true;
        if (ry === year - 1 && rm === month) return true;
        return false;
      });

      payload = {
        headers: tableData.headers,
        rows: relevantRows,
        year: year,
        month: month,
        half: half,
        period_type: 'month',
      };
    }

    fetch(API_BASE + '/sheets/ai/auto-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Request failed'); });
        return r.json();
      })
      .then(function (card) {
        if (statusEl) {
          statusEl.textContent = 'Done!';
          statusEl.style.color = '#3c763d';
        }
        var stats = card._stats;
        delete card._stats;
        applyAutoCard(card);
        if (stats) verifyCardText(card, stats);
      })
      .catch(function (err) {
        if (statusEl) {
          statusEl.textContent = err.message || 'Failed';
          statusEl.style.color = '#a94442';
        }
      });
  }

  function verifyCardText(card, stats) {
    var issues = [];
    var expectedHed = (stats.yoy_pct >= 0 ? '+' : '') + stats.yoy_pct + '%';
    if (card.bigNumberHed && card.bigNumberHed !== expectedHed) {
      issues.push('bigNumberHed: got "' + card.bigNumberHed + '", expected "' + expectedHed + '"');
    }

    // Check deal count in line1/line2
    var text = (card.line1 || '') + ' ' + (card.line2 || '');
    var dealMatches = text.match(/\b(\d{2,4})\s+deals?\b/g);
    if (dealMatches) {
      var validCounts = [stats.deal_count, stats.yoy_deals, stats.mom_deals, stats.qoq_deals].filter(Boolean);
      dealMatches.forEach(function (m) {
        var num = parseInt(m);
        if (validCounts.indexOf(num) === -1) {
          issues.push('Deal count "' + num + '" not in computed data (' + validCounts.join(', ') + ')');
        }
      });
    }

    // Check firm names against top_firms
    if (stats.top_firms && card.line2) {
      var knownFirms = stats.top_firms.map(function (f) { return f[0].toLowerCase(); });
      stats.top_firms.forEach(function (f) {
        // no-op: we check if mentioned firms are known, not the other way around
      });
      // Simple heuristic: check if any capitalized multi-word phrase in line2 is NOT in top firms
      // This is best-effort; deep verification uses the /verify-card endpoint
    }

    var resultEl = document.getElementById('ck-verify-result');
    if (!resultEl) return;

    if (issues.length === 0) {
      resultEl.style.display = 'block';
      resultEl.style.color = '#3c763d';
      resultEl.innerHTML = '&#10003; Numbers verified against computed data';
    } else {
      resultEl.style.display = 'block';
      resultEl.style.color = '#a94442';
      resultEl.innerHTML = '&#9888; ' + issues.length + ' issue(s): ' + issues.map(function (i) {
        return '<div style="margin-top:2px">&bull; ' + escapeHtml(i) + '</div>';
      }).join('');
    }
  }

  var CARD_FIELD_TO_ELEMENT = {
    primary: 'Project',
    bigNumberHed: 'Big Number Hed',
    bigNumberDek: 'Big Number Dek',
    line1: 'Line 1',
    line2: 'Line 2',
  };

  function applyAutoCard(card) {
    var scope = getControllerScope();
    if (!scope) return;
    var els = scope.config && scope.config.svg && scope.config.svg.elements;
    if (!els) return;

    var childMap = {};
    getElementScopes(scope).forEach(function (child) {
      if (child.element && child.element.name) {
        childMap[child.element.name] = child.element;
      }
    });

    scope.$apply(function () {
      Object.keys(CARD_FIELD_TO_ELEMENT).forEach(function (field) {
        if (card[field] === undefined) return;
        var elName = CARD_FIELD_TO_ELEMENT[field];
        var el = findByName(els, elName);
        if (el) el.value = card[field];
        var childEl = childMap[elName];
        if (childEl) childEl.value = card[field];
      });
    });
  }

  function handleChat() {
    var input = document.getElementById('ck-chat-input');
    var messages = document.getElementById('ck-chat-messages');
    var question = input ? input.value.trim() : '';

    if (!question || !tableData.rows.length) return;

    // Show user message
    appendChatMessage('You', question);
    input.value = '';

    // Persist user message
    chatHistory.push({ role: 'user', content: question, ts: Date.now() });

    // Show loading
    var loadingEl = appendChatMessage('AI', 'Thinking…');

    var requestBody = {
      question: question,
      history: getRecentHistory().slice(0, -1), // exclude current question (already in `question`)
    };

    // Include card values and context for verification questions
    var cardValues = getCurrentCardValues();
    if (cardValues) {
      requestBody.card_values = cardValues;
      requestBody.card_context = getCardContext();
    }

    fetch(API_BASE + '/sheets/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Request failed'); });
        return r.json();
      })
      .then(function (data) {
        var answer = data.answer || 'No response.';
        loadingEl.innerHTML = '<strong>AI:</strong> ' + escapeHtml(answer);
        chatHistory.push({ role: 'assistant', content: answer, ts: Date.now() });
        saveChatHistory();
      })
      .catch(function (err) {
        loadingEl.innerHTML = '<strong>AI:</strong> <span style="color:#a94442">' + escapeHtml(err.message) + '</span>';
      });
  }

  function appendChatMessage(sender, text) {
    var messages = document.getElementById('ck-chat-messages');
    var div = document.createElement('div');
    div.style.marginBottom = '6px';
    div.style.padding = '4px 6px';
    div.style.background = sender === 'You' ? '#e8f4fd' : '#f9f9f9';
    div.style.borderRadius = '3px';
    div.innerHTML = '<strong>' + escapeHtml(sender) + ':</strong> ' + escapeHtml(text);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  // Fix defaults: Line 2 dragLockX unchecked, Project text, Big Number Dek blank
  function fixDefaults() {
    var scope = getControllerScope();
    if (!scope) return;
    var els = scope.config && scope.config.svg && scope.config.svg.elements;
    if (!els) return;

    var childMap = {};
    getElementScopes(scope).forEach(function (child) {
      if (child.element && child.element.name) {
        childMap[child.element.name] = child.element;
      }
    });

    scope.$apply(function () {
      // Line 2 dragLockX unchecked
      var line2 = childMap['Line 2'];
      if (line2 && line2.dragLockX) line2.dragLockX = false;

      // Project defaults to "Add-On Spotlight"
      var project = findByName(els, 'Project');
      var projectChild = childMap['Project'];
      if (project) project.value = 'Add-On Spotlight';
      if (projectChild) projectChild.value = 'Add-On Spotlight';

      // Big Number Dek defaults to blank
      var dek = findByName(els, 'Big Number Dek');
      var dekChild = childMap['Big Number Dek'];
      if (dek) dek.value = '';
      if (dekChild) dekChild.value = '';
    });
  }

  function reorderSidebar() {
    var aside = document.querySelector('aside.elements');
    if (!aside) return;

    var ORDER = ['Theme', 'Project', 'Big Number Hed', 'Line 1', 'Line 2', 'Big Number Dek', 'Credit', 'Logo', 'Size', 'Shadow'];

    aside.style.display = 'flex';
    aside.style.flexDirection = 'column';

    var panels = aside.querySelectorAll('.panel');
    panels.forEach(function (panel) {
      var heading = panel.querySelector('h3');
      if (!heading) return;
      // Extract text, ignoring child elements (icons)
      var name = '';
      heading.childNodes.forEach(function (node) {
        if (node.nodeType === 3) name += node.textContent;
      });
      name = name.trim();
      var idx = ORDER.indexOf(name);
      panel.style.order = idx >= 0 ? String(idx) : '99';
    });

    // Make wrapper div transparent to flex layout
    var ngRepeatWrapper = aside.querySelector(':scope > div[ng-if]');
    if (ngRepeatWrapper) {
      ngRepeatWrapper.style.display = 'contents';
    }
  }

  function setDefaultFilename() {
    var input = document.querySelector('.config-wrapper input[ng-model="theme.name"]');
    if (!input) return;
    var now = new Date();
    var yyyy = now.getFullYear();
    var mm = String(now.getMonth() + 1).padStart(2, '0');
    var dd = String(now.getDate()).padStart(2, '0');
    var filename = 'addon-card-' + yyyy + '-' + mm + '-' + dd;

    // Snapshot the original theme button labels before we overwrite theme.name
    var themeButtons = document.querySelectorAll('.btn-group label.btn-primary');
    var originalLabels = [];
    themeButtons.forEach(function (btn) {
      // Text is the last text node after the hidden radio input
      var text = '';
      btn.childNodes.forEach(function (node) {
        if (node.nodeType === 3) text += node.textContent;
      });
      originalLabels.push(text.trim());
    });

    // Update Angular scope (this also updates theme.name used for download filename)
    var scope = angular.element(input).scope();
    if (scope && scope.theme) {
      scope.$apply(function () { scope.theme.name = filename; });
    }

    // Restore theme button text labels
    themeButtons.forEach(function (btn, i) {
      if (!originalLabels[i]) return;
      btn.childNodes.forEach(function (node) {
        if (node.nodeType === 3 && node.textContent.trim()) {
          node.textContent = originalLabels[i];
        }
      });
    });
  }

  // Auto-load table once the view is rendered
  function fixImageEditor() {
    document.querySelectorAll('.fileInputWrapper .button').forEach(function (btn) {
      btn.childNodes.forEach(function (node) {
        if (node.nodeType === 3 && node.textContent.trim()) {
          node.textContent = 'Select an image';
        }
      });
    });
  }

  var sheetsInterval = setInterval(function () {
    if (document.getElementById('ck-table-wrapper')) {
      clearInterval(sheetsInterval);
      initSheetsTable();
      initAI();
      setTimeout(fixDefaults, 500);
      setTimeout(reorderSidebar, 600);
      setTimeout(fixImageEditor, 800);
      setTimeout(setDefaultFilename, 900);
    }
  }, 300);

})();
