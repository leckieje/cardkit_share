# Enhanced Data Table: Expandable, Filterable, Searchable

## Context

The data table currently shows 50 rows at a time in a fixed 400px-tall scrollable container with Prev/Next pagination. There's no way to filter by time period, column values, or search for text. Users need these features to manually verify data that the AI references in generated card text.

## Files to Modify

- `scripts/cardkit-shim.js` — all table logic lives here (render, pagination, data)
- `views/wsjpro.html` — add filter/search controls HTML

## Checklist

### 1. Expandable Table (rows-per-page dropdown)

- [ ] Replace the fixed `PAGE_SIZE = 50` with a dropdown selector offering: 50, 100, 200, All
- [ ] Add the dropdown next to the existing pagination controls
- [ ] When selection changes: update `PAGE_SIZE`, reset `currentPage = 0`, re-render table
- [ ] "All" option removes pagination entirely and shows every row
- [ ] Keep the `max-height: 400px` on `#ck-table-wrapper` (scrollable) regardless of row count

### 2. Filter Controls (above the table)

- [ ] Add a filter bar div (`#ck-table-filters`) between `#ck-stats-summary` and `#ck-table-wrapper`
- [ ] **Date range**: Two date inputs (from/to) filtering on column 0 (Date)
- [ ] **PE Firm**: Dropdown populated from unique values in column 5
- [ ] **Sector**: Dropdown populated from unique values in column 11
- [ ] **Platform Co.**: Dropdown populated from unique values in column 9
- [ ] A "Clear Filters" button to reset all filters
- [ ] Filters combine with AND logic
- [ ] When any filter changes: recompute `tableData.sortedRows`, reset `currentPage = 0`, re-render

### 3. Text Search

- [ ] Add a text input ("Search deals...") in the filter bar
- [ ] Searches across ALL displayed columns (Date, Deal Code, PE Firm, Platform, Co. Acquire, Sector)
- [ ] Case-insensitive substring match
- [ ] Combines with dropdown filters (AND logic)
- [ ] Debounced (300ms) to avoid re-rendering on every keystroke

### 4. Core Implementation

- [ ] Add `getFilteredRows()` function that:
  1. Starts with `tableData.rows`
  2. Applies date range filter (if set)
  3. Applies each dropdown filter (if set)
  4. Applies text search (if non-empty)
  5. Sorts by date desc
  6. Stores result in `tableData.sortedRows`
- [ ] Add `initFilters()` function called after data loads (extracts unique sorted values for dropdowns)
- [ ] Wire up event listeners on all filter inputs to call `getFilteredRows()` then `renderTable()` + `renderPagination()`

### 5. HTML Layout (`views/wsjpro.html`)

- [ ] Add `#ck-table-filters` div just before `#ck-table-wrapper`:
  - Row 1: Text search input + rows-per-page dropdown
  - Row 2: Date From, Date To, PE Firm dropdown, Sector dropdown, Platform dropdown, Clear button
- [ ] Style inline (matching existing `font-size:11px` table aesthetic)

## Existing Code to Reuse

- `sortByDateDesc()` (~line 711) — currently sorts all rows; call at end of `getFilteredRows()`
- `renderTable()` (~line 1257) — already paginates from `tableData.sortedRows`
- `renderPagination()` (~line 1299) — already shows total count and Prev/Next
- `DISPLAY_COLUMNS` (~line 634) — column indices `[0, 1, 5, 9, 10, 11]` for search matching
- `escapeHtml()` (~line 1326) — for safe rendering of user-entered search text
- Column index reference: Date(0), Deal Code(1), PE Firm-WSJ(5), Platform Co.(9), Co. Acquire(10), Sector(11)

## Verification

1. Load the app → table appears at normal height with 50 rows (default dropdown selection)
2. Change rows-per-page to 200 → table shows 200 rows, still scrollable within the container
3. Select "All" → all rows visible, no pagination buttons
4. Select a sector from dropdown → table shows only matching rows, pagination updates count
5. Type a firm name in search → table filters in real-time (after 300ms debounce)
6. Set date range → only rows in that range appear
7. Combine filters (sector + search + date) → AND logic applies correctly
8. Click "Clear Filters" → all filters reset, full dataset shows again
9. Change rows-per-page while filters active → correct filtered subset still displays

## Security Notes

- All filter inputs rendered via `escapeHtml()` — no XSS risk
- No server calls needed — all filtering is client-side on already-loaded data
- No credentials or secrets involved
