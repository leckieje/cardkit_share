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

})();
