// ══════════════════════════════════════════════════════════════════════════════
//  KIU CBE Programme Generator — Backend API Server
//  Deploy to Render: https://render.com
//  Environment variables required:
//    OPENROUTER_API_KEY = your OpenRouter API key (openrouter.ai/keys)
//    PORT               = set by Render automatically
// ══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// ── Simple file-based store (persists on Render disk if disk is enabled) ──────
const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, defaultVal) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return defaultVal;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) { return defaultVal; }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
    return true;
  } catch(e) { return false; }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: 'meta-llama/llama-3.3-70b-instruct', provider: 'openrouter' });
});

// ── AI Chat endpoint (proxies to OpenRouter · meta-llama/llama-3.3-70b-instruct) ─
app.post('/api/chat', async (req, res) => {
  const { prompt, system, maxTokens } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not set on server' });

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'HTTP-Referer': 'https://kiu.ac.ug',
        'X-Title': 'KIU CBE Programme Generator'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-instruct',
        max_tokens: maxTokens || 4000,
        temperature: 0.7,
        messages: [
          { role: 'system', content: system || 'You are a helpful assistant.' },
          { role: 'user',   content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText.slice(0, 300) });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    res.json({ content, model: data.model, tokens: data.usage });

  } catch(e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Course Registry: GET all courses ─────────────────────────────────────────
app.get('/api/registry', (req, res) => {
  const registry = readJSON('course_registry.json', []);
  res.json(registry);
});

// ── Course Registry: POST save courses from a programme ───────────────────────
app.post('/api/registry', (req, res) => {
  const { programme, school, dept, courses } = req.body;
  if (!courses || !Array.isArray(courses)) return res.status(400).json({ error: 'courses array required' });

  let registry = readJSON('course_registry.json', []);
  const timestamp = Date.now();

  courses.forEach(function(c) {
    if (!c.code) return;
    const existing = registry.findIndex(function(r) { return r.code === c.code && r.programme === programme; });
    const record = Object.assign({}, c, { programme, school, dept, updatedAt: timestamp });
    if (existing >= 0) registry[existing] = record;
    else registry.push(record);
  });

  writeJSON('course_registry.json', registry);
  res.json({ saved: courses.length, total: registry.length });
});

// ── Course Detail: GET ────────────────────────────────────────────────────────
app.get('/api/course-detail', (req, res) => {
  const { code, name } = req.query;
  const details = readJSON('course_details.json', []);
  const match = details.find(function(d) {
    return d.code === code ||
      ((d.name||'').toLowerCase() === (name||'').toLowerCase());
  });
  if (match) res.json(match);
  else res.status(404).json({ error: 'not found' });
});

// ── Course Detail: POST save ──────────────────────────────────────────────────
app.post('/api/course-detail', (req, res) => {
  const { code, name, programme, text } = req.body;
  if (!code || !text) return res.status(400).json({ error: 'code and text required' });

  let details = readJSON('course_details.json', []);
  const existing = details.findIndex(function(d) { return d.code === code && d.programme === programme; });
  const record = { code, name, programme, text, updatedAt: Date.now() };
  if (existing >= 0) details[existing] = record;
  else details.push(record);
  writeJSON('course_details.json', details);
  res.json({ saved: true });
});

// ── Programmes: GET all ───────────────────────────────────────────────────────
app.get('/api/programmes', (req, res) => {
  const progs = readJSON('programmes.json', []);
  // Return summaries only (not full content)
  res.json(progs.map(function(p) {
    return { id: p.id, name: p.meta?.name, abbr: p.meta?.abbr,
             school: p.meta?.school, savedAt: p.savedAt,
             courseCount: (p.courses||[]).length };
  }));
});

// ── Programmes: POST save ─────────────────────────────────────────────────────
app.post('/api/programmes', (req, res) => {
  const prog = req.body;
  if (!prog || !prog.id) return res.status(400).json({ error: 'programme with id required' });

  let progs = readJSON('programmes.json', []);
  const idx = progs.findIndex(function(p) { return p.id === prog.id; });
  if (idx >= 0) progs[idx] = prog;
  else progs.push(prog);
  writeJSON('programmes.json', progs);
  res.json({ saved: true, total: progs.length });
});

app.listen(PORT, () => {
  console.log('KIU CBE API server running on port', PORT);
});
