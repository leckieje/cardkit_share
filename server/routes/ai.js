const express = require('express');
const router = express.Router();

// POST /api/ai/suggest
//
// Future implementation: accepts a CSV payload + natural language prompt,
// loads mode configs and themes as context, optionally attaches reference
// PNG images, and calls the Claude API (with prompt caching on the static
// context) to return a suggested card state.
//
// Expected request body:
//   { csvData: string, prompt: string, mode?: string, projectId?: string }
//
// Expected response:
//   { suggestion: { mode, state }, explanation: string }
//
// The client applies the suggestion by calling cardkitShim.hydrate(state).

router.post('/suggest', async (req, res) => {
  res.status(501).json({ error: 'AI suggestions not yet implemented' });
});

module.exports = router;
