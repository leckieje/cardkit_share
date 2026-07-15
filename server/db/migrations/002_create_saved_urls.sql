CREATE TABLE IF NOT EXISTS saved_urls (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  mode        TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_urls_created ON saved_urls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_urls_project ON saved_urls (project_id);
