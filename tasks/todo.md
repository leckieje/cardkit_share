# Feature: Period Type Expansion + Dynamic Card Examples

## Feature 1: YTD + Custom Range Period Types

- [x] 1a. HTML — Add YTD/Custom radio buttons + control containers to `views/wsjpro.html`
- [x] 1b. Frontend stats — Add `computeStatsYtd()`, `computeStatsCustom()`, wire `initStats()` dispatch
- [x] 1c. Frontend auto-card — Add ytd/custom branches to `handleAutoCard()` and `getCardContext()`
- [x] 1d. Backend — Add filter/summary functions, auto-card handlers, verify, chat support in `ai.py`

## Feature 2: Dynamic Card Examples with History

- [x] 2a. Card examples API — Create `server/routes/card-examples.js` with GCS CRUD
- [x] 2b. Mount route — Add `/api/card-examples` to `server/index.js`
- [x] 2c. Dynamic prompt examples — Replace hardcoded examples in `ai.py` with dynamic fetch
- [x] 2d. Frontend history tab — Add `initHistory()`, `renderHistoryTab()`, save-as-example flow
- [x] 2e. HTML — Add history tab toggle + container to `views/wsjpro.html`

## Review

### Feature 1 Changes

**`views/wsjpro.html`**: Added YTD and Custom radio buttons to period type selector. Added `#ck-ytd-controls` (month dropdown) and `#ck-custom-controls` (from/to date pickers) spans, hidden by default.

**`scripts/cardkit-shim.js`**:
- `initStats()` — Populates YTD month dropdown, wires change listeners for new controls, extends period-type toggle to show/hide all 4 control sets.
- `computeStats()` — Dispatches to `computeStatsYtd()` or `computeStatsCustom()` for new period types.
- `computeStatsYtd()` — Filters Jan 1 through selected month. YoY = same window last year. PoP = through previous month. Uses unique deal code counting pattern. Historical ranking across all years.
- `computeStatsCustom()` — Filters by date picker range. YoY = shift both dates back 1 year. Uses unique deal code counting.
- `filterRowsByDateRange()`, `computeRangeStats()`, `getYtdHistoricalStats()` — Shared helpers.
- `handleAutoCard()` — Added ytd/custom payload branches. YTD sends `{year, through_month, period_type: 'ytd'}`. Custom sends `{start_date, end_date, period_type: 'custom'}` with MM/DD/YYYY dates.
- `getCardContext()` — Added ytd/custom branches for chat context.
- `verifyCardText()` — Added `pop_deals` to valid counts list.
- `handleChat()` — Now sends `period_context` so backend can filter by active period type.

**`sheets-service/ai.py`**:
- `filter_rows_by_ytd()`, `filter_rows_by_date_range()` — New date filter functions.
- `compute_ytd_summary()`, `compute_range_summary()` — Same pattern as existing compute_period_summary, returns (summary_text, deal_count) with unique deal code counting.
- `compute_historical_ytd()` — Per-year deal counts for Jan–throughMonth.
- `auto_card_ytd()` — Full card generation with verified facts, YoY, PoP, sector changes, top firms, _stats dict.
- `auto_card_custom()` — Full card generation with verified facts, YoY, sector changes, top firms, _stats dict.
- `auto_card()` dispatch — Added ytd/custom routing.
- `verify_card()` — Added ytd/custom branches for ground truth verification.
- `build_verify_context()` — Added ytd/custom branches for chat-based verification.
- `chat()` — Reads `period_context` from request; falls back to it when question doesn't mention a date (for YTD/custom periods).

### Feature 2 Changes

**`server/routes/card-examples.js`** (new file): GCS-backed CRUD API at `jon_leckie/card-examples/{id}.json`. Routes: GET / (list), GET /active (5 active for prompt), POST / (create), PUT /:id/select (toggle), GET /:id (full), DELETE /:id. ID validation with regex, max 5 selected enforced.

**`server/index.js`**: Mounted `/api/card-examples` route.

**`sheets-service/ai.py`**:
- `FALLBACK_EXAMPLES_MONTHLY`, `FALLBACK_EXAMPLES_QUARTERLY` — Hardcoded examples extracted into constants for fallback.
- `get_example_cards()` — Fetches active examples from Node server with 60s cache, formats for prompt. Falls back to None on failure.
- All 4 `auto_card*()` functions now use `get_example_cards() or FALLBACK_*` instead of inline hardcoded examples.

**`scripts/cardkit-shim.js`**:
- `initViewTabs()` — Tab switching between Data and Card History views.
- `loadCardHistory()`, `renderHistoryTab()` — Fetches and renders card example list with select/load/delete buttons.
- `promptSaveExample()` — After auto-card generation, shows "Save as example" / "Skip" buttons.
- `buildPeriodLabel()` — Generates human-readable period label for all period types.

**`views/wsjpro.html`**: Added Data/History tab toggle (`#ck-view-tabs`), wrapped data section in `#ck-data-container`, added `#ck-history-container`.

---

## Previous Fix: Sector/Firm Count Discrepancy

### Problem
For first half of September 2026:
- Frontend "Top sectors" + manual table count: Industrial Goods = 56, Health Care = 40
- AI chat (from monthly aggregates): Industrial Goods = 48, Health Care = 33

### Root Cause
Frontend `computeStatsMonth()` and `computeStatsQuarter()` counted rows for sectors/firms instead of unique deal codes.

### Fix
Changed to `sectorDeals[sector][dealCode] = true` and `firmDeals[peFirm][dealCode] = true` pattern in both functions.
