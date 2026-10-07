const express = require('express');
const router = express.Router();
const { nanoid } = require('nanoid');
const { Storage } = require('@google-cloud/storage');

const BUCKET = process.env.GCS_BUCKET || 'dj-newsroom-stag-shared';
const PREFIX = process.env.GCS_PREFIX || 'jon_leckie';
const EXAMPLES_DIR = `${PREFIX}/card-examples`;

const storage = new Storage();
const bucket = storage.bucket(BUCKET);

function exampleBlob(id) {
  return bucket.file(`${EXAMPLES_DIR}/${id}.json`);
}

async function loadAllExamples() {
  const [files] = await bucket.getFiles({ prefix: `${EXAMPLES_DIR}/` });
  const examples = [];
  for (const file of files) {
    try {
      const [content] = await file.download();
      examples.push(JSON.parse(content.toString()));
    } catch (e) { /* skip malformed */ }
  }
  examples.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return examples;
}

// GET /api/card-examples — list all (metadata only, no full state)
router.get('/', async (req, res, next) => {
  try {
    const examples = await loadAllExamples();
    const meta = examples.map(ex => ({
      id: ex.id,
      card_text: ex.card_text,
      period: ex.period,
      period_label: ex.period_label,
      is_selected: ex.is_selected || false,
      created_at: ex.created_at,
    }));
    res.json(meta);
  } catch (err) { next(err); }
});

// GET /api/card-examples/active — returns the 5 active examples for prompt injection
router.get('/active', async (req, res, next) => {
  try {
    const examples = await loadAllExamples();
    const selected = examples.filter(ex => ex.is_selected);
    const unselected = examples.filter(ex => !ex.is_selected);

    // Selected first, then most recent to fill to 5
    const active = selected.slice(0, 5);
    let remaining = 5 - active.length;
    if (remaining > 0) {
      active.push(...unselected.slice(0, remaining));
    }

    const result = active.map(ex => ({
      id: ex.id,
      card_text: ex.card_text,
      period: ex.period,
      period_label: ex.period_label,
      is_selected: ex.is_selected || false,
    }));
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/card-examples — create a new example
router.post('/', async (req, res, next) => {
  try {
    const { card_text, period, state, period_label } = req.body;
    if (!card_text || typeof card_text !== 'object') {
      return res.status(400).json({ error: 'card_text is required' });
    }

    const id = nanoid(8);
    const example = {
      id,
      card_text,
      period: period || {},
      state: state || {},
      period_label: period_label || '',
      is_selected: false,
      created_at: new Date().toISOString(),
    };

    await exampleBlob(id).save(JSON.stringify(example), {
      contentType: 'application/json',
    });

    const { state: _, ...meta } = example;
    res.status(201).json(meta);
  } catch (err) { next(err); }
});

// PUT /api/card-examples/:id/select — toggle is_selected
router.put('/:id/select', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const blob = exampleBlob(id);
    const [exists] = await blob.exists();
    if (!exists) {
      return res.status(404).json({ error: 'Example not found' });
    }

    const [content] = await blob.download();
    const example = JSON.parse(content.toString());
    const newSelected = !example.is_selected;

    // If selecting, check how many are already selected
    if (newSelected) {
      const all = await loadAllExamples();
      const selectedCount = all.filter(ex => ex.is_selected && ex.id !== id).length;
      if (selectedCount >= 5) {
        return res.status(400).json({ error: 'Maximum 5 examples can be selected. Deselect one first.' });
      }
    }

    example.is_selected = newSelected;
    await blob.save(JSON.stringify(example), { contentType: 'application/json' });

    res.json({ id: example.id, is_selected: example.is_selected });
  } catch (err) { next(err); }
});

// GET /api/card-examples/:id — load full example (including state)
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const blob = exampleBlob(id);
    const [exists] = await blob.exists();
    if (!exists) {
      return res.status(404).json({ error: 'Example not found' });
    }

    const [content] = await blob.download();
    res.json(JSON.parse(content.toString()));
  } catch (err) { next(err); }
});

// DELETE /api/card-examples/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    await exampleBlob(id).delete({ ignoreNotFound: true });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
