// ══════════════════════════════════════════════════════════════════════════════
//  KIU CBE Programme Generator — Backend API Server v2.0
//  Four-Tier Course Classification + Shared Registry + Notifications
//  Deploy: Render.com | Model: meta-llama/llama-3.3-70b-instruct (OpenRouter)
//  Env: OPENROUTER_API_KEY
// ══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));

// ── File-based persistence ────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, def) {
  try {
    const p = path.join(DATA_DIR, file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : def;
  } catch(e) { return def; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); return true; }
  catch(e) { return false; }
}
function ts() { return new Date().toISOString(); }

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const registry  = readJSON('course_registry.json', []);
  const notifs    = readJSON('notifications.json', []);
  const ownership = readJSON('course_ownership.json', {});
  res.json({
    status: 'ok',
    model: 'meta-llama/llama-3.3-70b-instruct',
    provider: 'openrouter',
    stats: {
      totalCourses:   registry.length,
      notifications:  notifs.filter(n=>!n.read).length,
      ownedCourses:   Object.keys(ownership).length,
    }
  });
});

// ── AI Chat ───────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { prompt, system, maxTokens } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });
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
      const err = await response.text();
      return res.status(response.status).json({ error: err.slice(0,300) });
    }
    const data = await response.json();
    res.json({ content: data.choices?.[0]?.message?.content || '', model: data.model });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  FOUR-TIER COURSE REGISTRY
//  Tier 1 = UCC (University Common)
//  Tier 2 = SCC (School/College Shared)
//  Tier 3 = DSC (Department Shared)
//  Tier 4 = PROG (Programme-Specific)
// ════════════════════════════════════════════════════════════════════════════

// GET all registry entries (optionally filter by school/dept/tier)
app.get('/api/registry', (req, res) => {
  let reg = readJSON('course_registry.json', []);
  if (req.query.school) reg = reg.filter(r => r.school === req.query.school);
  if (req.query.dept)   reg = reg.filter(r => r.dept   === req.query.dept);
  if (req.query.tier)   reg = reg.filter(r => r.tier   === req.query.tier);
  res.json(reg);
});

// POST save/update courses from a programme
app.post('/api/registry', (req, res) => {
  const { programme, school, dept, courses, developer } = req.body;
  if (!courses || !Array.isArray(courses))
    return res.status(400).json({ error: 'courses array required' });

  let reg = readJSON('course_registry.json', []);
  const now = ts();
  let saved = 0, updated = 0;

  courses.forEach(c => {
    if (!c.code && !c.name) return;
    const key = (c.code || '').toUpperCase() + '|' + (c.name || '').toLowerCase().trim();
    const idx = reg.findIndex(r =>
      (r.code && r.code === c.code) ||
      (r.name && r.name.toLowerCase().trim() === (c.name||'').toLowerCase().trim() &&
       r.programme === programme)
    );
    const record = {
      ...c,
      programme: programme || '',
      school:    school    || c.school || '',
      dept:      dept      || c.dept   || '',
      tier:      c.tier    || 4,
      developer: developer || '',
      updatedAt: now,
    };
    if (idx >= 0) { reg[idx] = { ...reg[idx], ...record }; updated++; }
    else          { reg.push(record); saved++; }
  });

  writeJSON('course_registry.json', reg);
  res.json({ saved, updated, total: reg.length });
});

// POST check for cross-school/dept conflicts (similarity detection)
app.post('/api/registry/check', (req, res) => {
  const { name, code, school, dept, programme } = req.body;
  if (!name && !code) return res.status(400).json({ error: 'name or code required' });

  const reg = readJSON('course_registry.json', []);
  const nameLower = (name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();

  // Exact code match
  const codeMatches = code
    ? reg.filter(r => r.code && r.code.toUpperCase() === code.toUpperCase() && r.programme !== programme)
    : [];

  // Name similarity (word overlap)
  const nameWords = nameLower.split(/\s+/).filter(w => w.length > 3);
  const nameMatches = nameWords.length > 0
    ? reg.filter(r => {
        if (r.programme === programme) return false;
        const rName = (r.name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'');
        const rWords = rName.split(/\s+/).filter(w => w.length > 3);
        const common = nameWords.filter(w => rWords.includes(w));
        return common.length >= Math.min(2, nameWords.length);
      })
    : [];

  // Deduplicate
  const seen = new Set();
  const conflicts = [...codeMatches, ...nameMatches].filter(r => {
    const k = (r.code||'') + '|' + (r.name||'') + '|' + r.programme;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // Group by school ownership
  const isCrossSchool = conflicts.some(r => r.school && r.school !== school);
  const isCrossDept   = conflicts.some(r => r.dept && r.dept !== dept && r.school === school);

  res.json({
    hasConflicts:   conflicts.length > 0,
    isCrossSchool,
    isCrossDept,
    conflicts:      conflicts.slice(0, 10),
    suggestedTier:  isCrossSchool ? 2 : isCrossDept ? 3 : 4,
  });
});

// POST record a borrowing decision
app.post('/api/registry/borrow', (req, res) => {
  const { courseCode, courseName, borrowerProgramme, borrowerSchool, borrowerDept,
          ownerProgramme, ownerSchool, ownerDept, ownerCode, developer, decision } = req.body;
  let borrows = readJSON('borrows.json', []);
  borrows.push({
    id: Date.now(),
    courseCode, courseName,
    borrower: { programme: borrowerProgramme, school: borrowerSchool, dept: borrowerDept, developer },
    owner:    { programme: ownerProgramme,    school: ownerSchool,    dept: ownerDept,    code: ownerCode },
    decision, // 'borrow' | 'new' | 'reclassify'
    timestamp: ts(),
  });
  writeJSON('borrows.json', borrows);

  // Create notification for the owner
  if (decision === 'borrow' || decision === 'reclassify') {
    let notifs = readJSON('notifications.json', []);
    notifs.unshift({
      id: Date.now(),
      type: decision === 'borrow' ? 'BORROW' : 'RECLASSIFY',
      title: decision === 'borrow'
        ? `"${courseName}" borrowed by ${borrowerSchool}`
        : `"${courseName}" reclassification requested`,
      message: decision === 'borrow'
        ? `${borrowerProgramme} (${borrowerSchool} / ${borrowerDept}) is using your course "${courseName}" (${ownerCode || courseCode}). The original owner is ${ownerSchool} / ${ownerDept}.`
        : `${borrowerProgramme} has requested that "${courseName}" be reclassified to a higher tier (T${ownerSchool===borrowerSchool?'3 Dept-Shared':'2 School-Shared'}). Original owner: ${ownerSchool} / ${ownerDept}.`,
      forSchool: ownerSchool,
      forDept:   ownerDept,
      fromSchool: borrowerSchool,
      fromProgramme: borrowerProgramme,
      developer,
      read: false,
      timestamp: ts(),
    });
    writeJSON('notifications.json', notifs);
  }

  res.json({ saved: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════

// GET notifications (optionally filtered by school/dept)
app.get('/api/notifications', (req, res) => {
  let notifs = readJSON('notifications.json', []);
  if (req.query.school) notifs = notifs.filter(n => !n.forSchool || n.forSchool === req.query.school);
  if (req.query.dept)   notifs = notifs.filter(n => !n.forDept   || n.forDept   === req.query.dept);
  res.json(notifs.slice(0, 50)); // latest 50
});

// PATCH mark notification as read
app.patch('/api/notifications/:id/read', (req, res) => {
  let notifs = readJSON('notifications.json', []);
  const id = parseInt(req.params.id);
  notifs = notifs.map(n => n.id === id ? { ...n, read: true } : n);
  writeJSON('notifications.json', notifs);
  res.json({ ok: true });
});

// PATCH mark all notifications as read for a school
app.patch('/api/notifications/read-all', (req, res) => {
  const { school, dept } = req.body;
  let notifs = readJSON('notifications.json', []);
  notifs = notifs.map(n => {
    if (!school || !n.forSchool || n.forSchool === school) return { ...n, read: true };
    return n;
  });
  writeJSON('notifications.json', notifs);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  COURSE OWNERSHIP
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/ownership', (req, res) => {
  res.json(readJSON('course_ownership.json', {}));
});

app.post('/api/ownership', (req, res) => {
  const { courseCode, courseName, ownerSchool, ownerDept, ownerProgramme, tier, developer } = req.body;
  const key = (courseCode||courseName||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if (!key) return res.status(400).json({ error: 'courseCode or courseName required' });
  let ownership = readJSON('course_ownership.json', {});
  ownership[key] = { courseCode, courseName, ownerSchool, ownerDept, ownerProgramme, tier, developer, updatedAt: ts() };
  writeJSON('course_ownership.json', ownership);
  res.json({ saved: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  COURSE DETAILS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/course-detail', (req, res) => {
  const { code, name } = req.query;
  const details = readJSON('course_details.json', []);
  const match = details.find(d =>
    (code && d.code === code) ||
    (name && (d.name||'').toLowerCase() === (name||'').toLowerCase())
  );
  if (match) res.json(match);
  else res.status(404).json({ error: 'not found' });
});

app.post('/api/course-detail', (req, res) => {
  const { code, name, programme, school, dept, tier, text } = req.body;
  if (!code || !text) return res.status(400).json({ error: 'code and text required' });
  let details = readJSON('course_details.json', []);
  const idx = details.findIndex(d => d.code === code && d.programme === programme);
  const record = { code, name, programme, school, dept, tier: tier||4, text, updatedAt: ts() };
  if (idx >= 0) details[idx] = record; else details.push(record);
  writeJSON('course_details.json', details);
  res.json({ saved: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  PROGRAMMES
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/programmes', (req, res) => {
  const progs = readJSON('programmes.json', []);
  res.json(progs.map(p => ({
    id: p.id, name: p.meta?.name, abbr: p.meta?.abbr,
    school: p.meta?.school, dept: p.meta?.dept,
    savedAt: p.savedAt, courseCount: (p.courses||[]).length
  })));
});

app.post('/api/programmes', (req, res) => {
  const prog = req.body;
  if (!prog?.id) return res.status(400).json({ error: 'id required' });
  let progs = readJSON('programmes.json', []);
  const idx = progs.findIndex(p => p.id === prog.id);
  if (idx >= 0) progs[idx] = prog; else progs.push(prog);
  writeJSON('programmes.json', progs);
  res.json({ saved: true, total: progs.length });
});

// ════════════════════════════════════════════════════════════════════════════
//  INSTITUTIONAL COURSE CATALOGUE (read-only summary)
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/catalogue', (req, res) => {
  const reg    = readJSON('course_registry.json', []);
  const borrow = readJSON('borrows.json', []);
  const own    = readJSON('course_ownership.json', {});

  // Group by tier
  const byTier = { 1:[], 2:[], 3:[], 4:[] };
  reg.forEach(c => { const t = c.tier||4; if (byTier[t]) byTier[t].push(c); });

  // Build borrowing map: courseCode → [borrowers]
  const borrowMap = {};
  borrow.forEach(b => {
    const k = b.courseCode || b.courseName;
    if (!borrowMap[k]) borrowMap[k] = [];
    borrowMap[k].push(b.borrower);
  });

  res.json({ byTier, borrowMap, ownershipCount: Object.keys(own).length, total: reg.length });
});

app.listen(PORT, () => console.log('KIU CBE API v2.0 running on port', PORT));
