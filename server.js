// ══════════════════════════════════════════════════════════════════════════════
//  KIU CBE Programme Generator — Backend API v2.2
//  Four-Tier Course Classification + Smart Registry + Full Notifications
//  Deploy: Render.com | Model: meta-llama/llama-3.3-70b-instruct via OpenRouter
//  Required env: OPENROUTER_API_KEY
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

const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, def) {
  try { const p=path.join(DATA_DIR,file); return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):def; }
  catch(e){ return def; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(path.join(DATA_DIR,file), JSON.stringify(data,null,2)); return true; }
  catch(e){ return false; }
}
const ts = () => new Date().toISOString();

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const reg   = readJSON('course_registry.json',[]);
  const notif = readJSON('notifications.json',[]);
  res.json({ status:'ok', model:'meta-llama/llama-3.3-70b-instruct', provider:'openrouter',
    stats:{ courses:reg.length, unread:notif.filter(n=>!n.read).length } });
});

// ── AI Chat ────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { prompt, system, maxTokens } = req.body;
  if (!prompt) return res.status(400).json({ error:'prompt required' });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error:'OPENROUTER_API_KEY not configured' });
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+apiKey,
        'HTTP-Referer':'https://kiu.ac.ug', 'X-Title':'KIU CBE Programme Generator' },
      body: JSON.stringify({ model:'meta-llama/llama-3.3-70b-instruct',
        max_tokens:maxTokens||4000, temperature:0.7,
        messages:[{role:'system',content:system||'You are a helpful assistant.'},
                  {role:'user',content:prompt}] })
    });
    if (!r.ok) { const e=await r.text(); return res.status(r.status).json({error:e.slice(0,300)}); }
    const d = await r.json();
    res.json({ content:d.choices?.[0]?.message?.content||'', model:d.model });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Course Registry ────────────────────────────────────────────────────────────
app.get('/api/registry', (req, res) => {
  let reg = readJSON('course_registry.json',[]);
  if (req.query.school) reg = reg.filter(r=>r.school===req.query.school);
  if (req.query.dept)   reg = reg.filter(r=>r.dept===req.query.dept);
  if (req.query.tier)   reg = reg.filter(r=>r.tier===parseInt(req.query.tier));
  res.json(reg);
});

app.post('/api/registry', (req, res) => {
  const { programme, school, dept, courses, developer } = req.body;
  if (!Array.isArray(courses)) return res.status(400).json({error:'courses array required'});
  let reg = readJSON('course_registry.json',[]);
  const now = ts(); let saved=0, updated=0;
  courses.forEach(c => {
    if (!c.code && !c.name) return;
    const idx = reg.findIndex(r =>
      (r.code && c.code && r.code===c.code && r.programme===programme) ||
      (r.name && c.name && r.name.toLowerCase().trim()===c.name.toLowerCase().trim() && r.programme===programme)
    );
    const rec = {...c, programme:programme||'', school:school||c.school||'',
      dept:dept||c.dept||'', tier:c.tier||4, developer:developer||'', updatedAt:now };
    if (idx>=0){ reg[idx]={...reg[idx],...rec}; updated++; }
    else { reg.push(rec); saved++; }
  });
  writeJSON('course_registry.json', reg);
  res.json({ saved, updated, total:reg.length });
});

// ── Smart Conflict Check ───────────────────────────────────────────────────────
// Rules:
//   1. Never flag same-programme courses
//   2. Exact code match across programmes = conflict
//   3. Name similarity: ≥75% of significant words match (≥3 words min)
//   4. Subject-specific stopwords excluded from matching
app.post('/api/registry/check', (req, res) => {
  const { name, code, school, dept, programme, year, sem } = req.body;
  if (!name && !code) return res.status(400).json({error:'name or code required'});

  const reg = readJSON('course_registry.json',[]);

  // Stopwords that should not count toward similarity
  const STOPWORDS = new Set(['introduction','advanced','basic','applied','principles',
    'theory','practical','fundamentals','analysis','design','systems','methods',
    'techniques','concepts','overview']);

  const cleanName = (n) => (n||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
  const sigWords  = (n) => cleanName(n).split(/\s+/).filter(w=>w.length>3&&!STOPWORDS.has(w));

  const nameWords = sigWords(name);
  const nameLower = cleanName(name);

  // Exact code match (excluding same programme)
  const codeMatches = code
    ? reg.filter(r => r.code && r.code.toUpperCase()===code.toUpperCase() && r.programme!==programme)
    : [];

  // STRICT name similarity
  const nameMatches = nameWords.length >= 2
    ? reg.filter(r => {
        if (r.programme===programme) return false; // exclude same programme
        const rSig = sigWords(r.name);
        if (rSig.length < 2) return false;
        const common = nameWords.filter(w => rSig.includes(w));
        // Require at least 75% match AND minimum 2 significant words
        const threshold = Math.max(2, Math.ceil(Math.min(nameWords.length, rSig.length) * 0.75));
        // Also require the course names to share the LAST significant word (most distinctive)
        const lastName = nameWords[nameWords.length-1];
        const rLastName = rSig[rSig.length-1];
        const lastWordMatch = lastName && rLastName && (lastName===rLastName ||
          lastName.startsWith(rLastName.slice(0,4)) || rLastName.startsWith(lastName.slice(0,4)));
        return common.length >= threshold && lastWordMatch;
      })
    : [];

  const seen = new Set();
  const conflicts = [...codeMatches,...nameMatches].filter(r=>{
    const k=(r.code||'')+'|'+(r.name||'')+'|'+r.programme;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  const isCrossSchool = conflicts.some(r=>r.school&&r.school!==school);
  const isCrossDept   = conflicts.some(r=>r.dept&&r.dept!==dept&&r.school===school);

  res.json({
    hasConflicts:    conflicts.length > 0,
    isCrossSchool, isCrossDept,
    conflicts:       conflicts.slice(0,10).map(r=>({
      ...r, year:r.year||null, sem:r.sem||null,
      DH:r.DH||0, SH:r.SH||0, AH:r.AH||0, OH:r.OH||0, type:r.type||'lec'
    })),
    suggestedTier:   isCrossSchool ? 2 : isCrossDept ? 3 : 4,
    positionMismatch:conflicts.some(r=>r.year&&(r.year!==parseInt(year)||String(r.sem)!==String(sem))),
  });
});

// ── Borrow Decision ────────────────────────────────────────────────────────────
app.post('/api/registry/borrow', (req, res) => {
  const { courseCode, courseName, borrowerProgramme, borrowerSchool, borrowerDept,
          ownerProgramme, ownerSchool, ownerDept, ownerCode, developer,
          decision, positionAdopted } = req.body;
  let borrows = readJSON('borrows.json',[]);
  borrows.push({ id:Date.now(), courseCode, courseName,
    borrower:{ programme:borrowerProgramme, school:borrowerSchool, dept:borrowerDept, developer },
    owner:{ programme:ownerProgramme, school:ownerSchool, dept:ownerDept, code:ownerCode },
    decision, positionAdopted:positionAdopted||false, timestamp:ts() });
  writeJSON('borrows.json', borrows);
  if (decision==='borrow'||decision==='reclassify') {
    let notifs = readJSON('notifications.json',[]);
    const type = decision==='borrow'?'BORROW':'RECLASSIFY';
    const title = decision==='borrow'
      ? '"'+courseName+'" borrowed by '+borrowerSchool
      : '"'+courseName+'" reclassification requested';
    const msg = decision==='borrow'
      ? borrowerProgramme+' ('+borrowerSchool+' / '+borrowerDept+') is using "'+courseName
        +'" ('+ownerCode+') owned by '+ownerSchool+' / '+ownerDept+'.'
        +(positionAdopted?' Canonical year/semester position adopted.':' Borrower kept their own position.')
      : borrowerProgramme+' requests "'+courseName+'" be reclassified to a higher shared tier.';
    notifs.unshift({ id:Date.now(), type, title, message:msg,
      forSchool:ownerSchool, forDept:ownerDept,
      fromSchool:borrowerSchool, fromProgramme:borrowerProgramme,
      developer, read:false, timestamp:ts() });
    writeJSON('notifications.json', notifs);
  }
  res.json({ saved:true });
});

// ── Notifications ──────────────────────────────────────────────────────────────
app.get('/api/notifications', (req, res) => {
  let n = readJSON('notifications.json',[]);
  if (req.query.school) n = n.filter(x=>!x.forSchool||x.forSchool===req.query.school);
  if (req.query.dept)   n = n.filter(x=>!x.forDept||x.forDept===req.query.dept);
  res.json(n.slice(0,50));
});

// POST — create a new notification (e.g. when shared content is generated)
app.post('/api/notifications', (req, res) => {
  const notif = req.body;
  if (!notif||!notif.title) return res.status(400).json({error:'title required'});
  let notifs = readJSON('notifications.json',[]);
  notifs.unshift({ id:Date.now(), read:false, timestamp:ts(), ...notif });
  writeJSON('notifications.json', notifs);
  res.json({ saved:true });
});

app.patch('/api/notifications/:id/read', (req, res) => {
  let n = readJSON('notifications.json',[]);
  n = n.map(x=>x.id===parseInt(req.params.id)?{...x,read:true}:x);
  writeJSON('notifications.json',n); res.json({ok:true});
});

app.patch('/api/notifications/read-all', (req, res) => {
  const { school } = req.body;
  let n = readJSON('notifications.json',[]);
  n = n.map(x=>(!school||!x.forSchool||x.forSchool===school)?{...x,read:true}:x);
  writeJSON('notifications.json',n); res.json({ok:true});
});

// ── Ownership ──────────────────────────────────────────────────────────────────
app.get('/api/ownership', (req, res) => res.json(readJSON('course_ownership.json',{})));
app.post('/api/ownership', (req, res) => {
  const { courseCode, courseName, ownerSchool, ownerDept, ownerProgramme, tier, developer } = req.body;
  const key = (courseCode||courseName||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if (!key) return res.status(400).json({error:'courseCode or courseName required'});
  let o = readJSON('course_ownership.json',{});
  o[key] = { courseCode,courseName,ownerSchool,ownerDept,ownerProgramme,tier,developer,updatedAt:ts() };
  writeJSON('course_ownership.json',o); res.json({saved:true});
});

// ── Course Details ─────────────────────────────────────────────────────────────
app.get('/api/course-detail', (req, res) => {
  const { code, name } = req.query;
  const d = readJSON('course_details.json',[]);
  const m = d.find(x=>(code&&x.code===code)||(name&&(x.name||'').toLowerCase()===(name||'').toLowerCase()));
  if (m) res.json(m); else res.status(404).json({error:'not found'});
});

app.post('/api/course-detail', (req, res) => {
  const { code, name, programme, school, dept, tier, text } = req.body;
  if (!code||!text) return res.status(400).json({error:'code and text required'});
  let d = readJSON('course_details.json',[]);
  const i = d.findIndex(x=>x.code===code&&x.programme===programme);
  const r = { code,name,programme,school,dept,tier:tier||4,text,updatedAt:ts() };
  if (i>=0) d[i]=r; else d.push(r);
  writeJSON('course_details.json',d); res.json({saved:true});
});

// ── Programmes ─────────────────────────────────────────────────────────────────
app.get('/api/programmes', (req, res) => {
  const p = readJSON('programmes.json',[]);
  res.json(p.map(x=>({ id:x.id, name:x.meta?.name, abbr:x.meta?.abbr,
    school:x.meta?.school, dept:x.meta?.dept, savedAt:x.savedAt,
    courseCount:(x.courses||[]).length })));
});
app.post('/api/programmes', (req, res) => {
  const p = req.body;
  if (!p?.id) return res.status(400).json({error:'id required'});
  let progs = readJSON('programmes.json',[]);
  const i = progs.findIndex(x=>x.id===p.id);
  if (i>=0) progs[i]=p; else progs.push(p);
  writeJSON('programmes.json',progs); res.json({saved:true,total:progs.length});
});

// ── Catalogue ──────────────────────────────────────────────────────────────────
app.get('/api/catalogue', (req, res) => {
  const reg    = readJSON('course_registry.json',[]);
  const borrow = readJSON('borrows.json',[]);
  const byTier = {1:[],2:[],3:[],4:[]};
  reg.forEach(c=>{ const t=c.tier||4; if(byTier[t]) byTier[t].push(c); });
  const borrowMap = {};
  borrow.forEach(b=>{ const k=b.courseCode||b.courseName;
    if (!borrowMap[k]) borrowMap[k]=[];
    borrowMap[k].push(b.borrower); });
  res.json({ byTier, borrowMap, total:reg.length });
});

app.listen(PORT, () => console.log('KIU CBE API v2.2 on port', PORT));
