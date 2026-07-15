const express = require('express');
const router = express.Router();
const { nanoid } = require('nanoid');
const { Storage } = require('@google-cloud/storage');

const BUCKET = process.env.GCS_BUCKET || 'dj-newsroom-stag-shared';
const PREFIX = process.env.GCS_PREFIX || 'jon_leckie';
const PROJECTS_DIR = `${PREFIX}/projects`;

const storage = new Storage();
const bucket = storage.bucket(BUCKET);

const VALID_MODES = new Set(['wsjpro']);

function validateMode(mode) {
  return typeof mode === 'string' && VALID_MODES.has(mode);
}

function projectBlob(id) {
  return bucket.file(`${PROJECTS_DIR}/${id}.json`);
}

// POST /api/projects — create new project
router.post('/', async (req, res, next) => {
  try {
    const { mode, state, title = '' } = req.body;
    if (!validateMode(mode)) {
      return res.status(400).json({ error: 'Invalid or missing mode' });
    }
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'state must be an object' });
    }
    const id = nanoid(8);
    const now = new Date().toISOString();
    const project = {
      id,
      title: String(title).slice(0, 200),
      mode,
      state,
      created_at: now,
      updated_at: now,
      version: 1,
    };

    await projectBlob(id).save(JSON.stringify(project), {
      contentType: 'application/json',
    });

    const { state: _, ...meta } = project;
    res.status(201).json({ ...meta, url: `/?p=${id}` });
  } catch (err) { next(err); }
});

// GET /api/projects — list recent projects (no state data)
router.get('/', async (req, res, next) => {
  try {
    const [files] = await bucket.getFiles({ prefix: `${PROJECTS_DIR}/` });
    const projects = [];

    for (const file of files) {
      try {
        const [content] = await file.download();
        const data = JSON.parse(content.toString());
        projects.push({
          id: data.id,
          title: data.title || '',
          mode: data.mode,
          created_at: data.created_at,
          updated_at: data.updated_at,
        });
      } catch (e) { /* skip malformed files */ }
    }

    projects.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    res.json(projects.slice(0, 50));
  } catch (err) { next(err); }
});

// GET /api/projects/urls — fetch all saved project URLs (must be before /:id)
router.get('/urls', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const [files] = await bucket.getFiles({ prefix: `${PROJECTS_DIR}/` });
    const urls = [];

    for (const file of files) {
      try {
        const [content] = await file.download();
        const data = JSON.parse(content.toString());
        urls.push({
          project_id: data.id,
          url: `/?p=${data.id}`,
          mode: data.mode,
          title: data.title || '',
          created_at: data.created_at,
          project_updated_at: data.updated_at,
        });
      } catch (e) { /* skip */ }
    }

    urls.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json(urls.slice(0, limit));
  } catch (err) { next(err); }
});

// GET /api/projects/:id — load project
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    const blob = projectBlob(id);
    const [exists] = await blob.exists();
    if (!exists) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const [content] = await blob.download();
    const project = JSON.parse(content.toString());
    res.json(project);
  } catch (err) { next(err); }
});

// PUT /api/projects/:id — save/update project
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }
    const { mode, state, title } = req.body;
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'state must be an object' });
    }

    const blob = projectBlob(id);
    const [exists] = await blob.exists();

    let project;
    if (exists) {
      const [content] = await blob.download();
      project = JSON.parse(content.toString());
      project.state = state;
      project.updated_at = new Date().toISOString();
      project.version = (project.version || 0) + 1;
      if (mode !== undefined && validateMode(mode)) project.mode = mode;
      if (title !== undefined) project.title = String(title).slice(0, 200);
    } else {
      const now = new Date().toISOString();
      project = { id, mode: mode || 'wsjpro', state, title: title || '', created_at: now, updated_at: now, version: 1 };
    }

    await blob.save(JSON.stringify(project), { contentType: 'application/json' });
    res.json({ id: project.id, version: project.version, updated_at: project.updated_at });
  } catch (err) { next(err); }
});

// DELETE /api/projects/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }
    await projectBlob(id).delete({ ignoreNotFound: true });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
