const express = require('express');
const router = express.Router();
const db = require('../db/client');
const { nanoid } = require('nanoid');

// Allowlist of valid mode names to prevent arbitrary values entering the DB
const VALID_MODES = new Set([
  'watermark', 'big-number', 'stock', 'barrons', 'afterthebell',
  'mansion-global', 'marketwatch', 'moneyish', 'wsjpro', 'meme', 'homepage',
]);

function validateMode(mode) {
  return typeof mode === 'string' && VALID_MODES.has(mode);
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
    const result = await db.query(
      `INSERT INTO projects (id, mode, state, title)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, mode, created_at, updated_at, version`,
      [id, mode, JSON.stringify(state), String(title).slice(0, 200)]
    );
    const project = result.rows[0];
    res.status(201).json({ ...project, url: `/?p=${id}` });
  } catch (err) { next(err); }
});

// GET /api/projects — list recent projects (no state data)
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, title, mode, created_at, updated_at
       FROM projects
       ORDER BY updated_at DESC
       LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/projects/:id — load project
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }
    const result = await db.query(
      `SELECT id, title, mode, state, created_at, updated_at, version
       FROM projects WHERE id = $1`,
      [id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(result.rows[0]);
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

    const setClauses = ['state = $2'];
    const values = [id, JSON.stringify(state)];
    let idx = 3;

    if (mode !== undefined) {
      if (!validateMode(mode)) return res.status(400).json({ error: 'Invalid mode' });
      setClauses.push(`mode = $${idx++}`);
      values.push(mode);
    }
    if (title !== undefined) {
      setClauses.push(`title = $${idx++}`);
      values.push(String(title).slice(0, 200));
    }

    const result = await db.query(
      `UPDATE projects SET ${setClauses.join(', ')}
       WHERE id = $1
       RETURNING id, version, updated_at`,
      values
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/projects/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }
    await db.query('DELETE FROM projects WHERE id = $1', [id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
