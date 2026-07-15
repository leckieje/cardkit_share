const express = require('express');
const router = express.Router();

const SHEETS_SERVICE_URL = process.env.SHEETS_SERVICE_URL || 'http://127.0.0.1:5050';

router.get('/raw', async (req, res, next) => {
  try {
    const { spreadsheet, range } = req.query;
    if (!spreadsheet || !range) {
      return res.status(400).json({ error: 'spreadsheet and range query params required' });
    }

    const url = new URL('/raw', SHEETS_SERVICE_URL);
    url.searchParams.set('spreadsheet', spreadsheet);
    url.searchParams.set('range', range);

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Sheets service timeout' });
    }
    if (err.cause && err.cause.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Sheets service unavailable — is it running?' });
    }
    next(err);
  }
});

router.get('/list', async (req, res, next) => {
  try {
    const { spreadsheet } = req.query;
    if (!spreadsheet) {
      return res.status(400).json({ error: 'spreadsheet query param required' });
    }

    const url = new URL('/sheets', SHEETS_SERVICE_URL);
    url.searchParams.set('spreadsheet', spreadsheet);

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Sheets service timeout' });
    }
    if (err.cause && err.cause.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Sheets service unavailable — is it running?' });
    }
    next(err);
  }
});

router.get('/read', async (req, res, next) => {
  try {
    const { spreadsheet, range } = req.query;
    if (!spreadsheet || !range) {
      return res.status(400).json({ error: 'spreadsheet and range query params required' });
    }

    const url = new URL('/read', SHEETS_SERVICE_URL);
    url.searchParams.set('spreadsheet', spreadsheet);
    url.searchParams.set('range', range);

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Sheets service timeout' });
    }
    if (err.cause && err.cause.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Sheets service unavailable — is it running?' });
    }
    next(err);
  }
});

router.post('/ai/auto-card', async (req, res, next) => {
  try {
    const response = await fetch(SHEETS_SERVICE_URL + '/ai/auto-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'AI request timeout' });
    if (err.cause && err.cause.code === 'ECONNREFUSED') return res.status(503).json({ error: 'Sheets service unavailable' });
    next(err);
  }
});

router.post('/ai/chat', async (req, res, next) => {
  try {
    const response = await fetch(SHEETS_SERVICE_URL + '/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'AI request timeout' });
    if (err.cause && err.cause.code === 'ECONNREFUSED') return res.status(503).json({ error: 'Sheets service unavailable' });
    next(err);
  }
});

router.post('/ai/verify-card', async (req, res, next) => {
  try {
    const response = await fetch(SHEETS_SERVICE_URL + '/ai/verify-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'Verification request timeout' });
    if (err.cause && err.cause.code === 'ECONNREFUSED') return res.status(503).json({ error: 'Sheets service unavailable' });
    next(err);
  }
});

module.exports = router;
