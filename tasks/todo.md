# Enhanced Data Table: Expandable, Filterable, Searchable

## Plan

Add filtering, search, and row-count controls to the data table so users can manually verify data referenced by AI-generated card text. All changes are client-side only (no backend modifications needed).

## Checklist

### 1. Add filter bar HTML to `views/wsjpro.html`
- [x] Insert `#ck-table-filters` div between `#ck-stats-summary` and `#ck-ai-chat`
- [x] Row 1: text search input + rows-per-page dropdown (50/100/200/All)
- [x] Row 2: Date From input, Date To input, PE Firm dropdown, Sector dropdown, Platform Co. dropdown, Clear Filters button
- [x] Style inline to match existing 11-12px table aesthetic

### 2. Add `getFilteredRows()` function in `cardkit-shim.js`
- [x] Starts with `tableData.rows`
- [x] Applies date range filter (column 0) if from/to values set
- [x] Applies PE Firm dropdown filter (column 5) if selected
- [x] Applies Sector dropdown filter (column 11) if selected
- [x] Applies Platform Co. dropdown filter (column 9) if selected
- [x] Applies text search (case-insensitive substring across all DISPLAY_COLUMNS)
- [x] Calls `sortByDateDesc()` equivalent on filtered subset
- [x] Stores result in `tableData.sortedRows`

### 3. Add `initFilters()` function in `cardkit-shim.js`
- [x] Called after full data loads (end of Phase 2 in `initSheetsTable`)
- [x] Extracts unique sorted values from columns 5, 9, 11 for dropdown population
- [x] Renders `<option>` elements into each dropdown
- [x] Wires up `change` event listeners on all filter controls
- [x] Wires up debounced (300ms) `input` listener on text search
- [x] Each listener calls `getFilteredRows()`, resets `currentPage = 0`, then `renderTable()`

### 4. Rows-per-page dropdown
- [x] Replace fixed `PAGE_SIZE = 50` with a mutable `pageSize` variable (default 50)
- [x] Dropdown options: 50, 100, 200, All
- [x] "All" sets `pageSize` to `tableData.sortedRows.length`
- [x] On change: update `pageSize`, reset `currentPage = 0`, re-render
- [x] Update `renderTable()` and `renderPagination()` to use `pageSize` instead of `PAGE_SIZE`

### 5. Clear Filters button
- [x] Resets all dropdowns to empty/default, clears date inputs, clears search input
- [x] Calls `getFilteredRows()` → `renderTable()`

### 6. Test and verify
- [x] Table loads normally at 10 rows (default)
- [x] Rows-per-page dropdown works (10/20/50/100/All)
- [x] Each column filter narrows the results
- [x] Multiple filters combine with AND logic
- [x] Text search filters in real-time with debounce
- [x] Date range filtering works correctly
- [x] Clear Filters resets everything
- [x] Pagination updates correctly when filters are active

## Review

Fixed two bugs (date filter showing 11 rows instead of 19, dropdown truncating "Information Technology") and added enhancements:
- Added `input` event listener on date fields for Chrome reliability
- Called `getFilteredRows()` after Phase 2 data loads instead of `renderTable()`
- Removed max-height from table wrapper; pagination controls visibility
- Dropdowns dynamically narrow to available values when filters are active
- Column headers show unique counts (deals, firms, platforms, etc.)
- Entries count shown next to filters; pagination shows range/total with commas
- Row selector options: 10 (default), 20, 50, 100, All
- Table and filters wrapped in a bordered box
