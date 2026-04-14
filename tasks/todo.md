# CardKit: Persistent + Shareable Projects

## Plan

Add a Node/Express backend with PostgreSQL to persist card state and enable shareable project links. A thin JavaScript shim injected into `index.html` intercepts AngularJS scope changes, debounce-saves to the API, and hydrates state on load. No changes to the pre-built JS bundles.

## Checklist

- [x] Create `tasks/todo.md`
- [x] `server/package.json`
- [x] `server/db/migrations/001_create_projects.sql`
- [x] `server/db/client.js`
- [x] `server/middleware/errorHandler.js`
- [x] `server/routes/projects.js`
- [x] `server/routes/ai.js` (stub for future Claude suggestions)
- [x] `server/index.js`
- [x] `server/.env.example`
- [x] `scripts/cardkit-shim.js`
- [x] Add shim `<script>` tag to `index.html`
- [x] Add Share button to `index.html` nav
- [x] `render.yaml`

## Review

### What was added

**`server/`** — Node/Express backend (new directory):
- `index.js`: Serves static CardKit files and the `/api` routes. Catch-all sends `index.html` for `/project/:id` URLs.
- `routes/projects.js`: Full CRUD for projects (`POST`, `GET /:id`, `PUT /:id`, `DELETE /:id`, `GET /`). Input is validated; mode names are allowlisted.
- `routes/ai.js`: Stub `POST /api/ai/suggest` returning 501, ready for Claude integration.
- `db/client.js`: PostgreSQL connection pool via `pg`.
- `db/migrations/001_create_projects.sql`: `projects` table with `id TEXT`, `mode TEXT`, `state JSONB`, `title`, `version`, and timestamps. Auto-updating `updated_at` trigger.
- `middleware/errorHandler.js`: Hides stack traces in production.
- `.env.example`: Template for required environment variables.

**`scripts/cardkit-shim.js`** — AngularJS interception layer (new file):
- Polls for Angular's injector, then listens on `$rootScope.$on('$stateChangeSuccess')`.
- On load with a project ID in the URL: fetches state, navigates to the saved mode if needed, hydrates the controller's `$scope`.
- Watches individual scope properties (theme, color, size, element fields) and debounce-saves on any change (2s normally, 4s when a base64 image is present).
- First save creates a new project and rewrites the URL to `/project/:id` via `history.replaceState`.
- Exposes `window.cardkitShim.share()` (copy URL) and `window.cardkitShim.hydrate(state)` (for future AI use).
- Fixed bottom-right status indicator: Saving… / Saved / Save failed / Link copied!

**`index.html`** — two additions:
- `<script src="scripts/cardkit-shim.js">` after the app bundles.
- Share button in the nav.

**`render.yaml`** — one-command deployment to Render with a free Postgres database.

### How to run locally

```bash
# 1. Create the database
createdb cardkit
psql cardkit -f server/db/migrations/001_create_projects.sql

# 2. Configure environment
cd server
cp .env.example .env
# Edit .env: set DATABASE_URL=postgresql://localhost/cardkit

# 3. Install dependencies and start
npm install
npm run dev

# App at http://localhost:3000
```

### Share URL flow

1. User opens `http://localhost:3000`, edits a card — URL becomes `/project/abc12345#/watermark`
2. User clicks Share or copies the URL
3. Collaborator opens that URL on any machine — sees the same card, fully editable
