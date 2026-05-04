// ══════════════════════════════════════════════════════════════════════════════
//  KIU CBE Programme Generator — Backend API v3.0
//  PostgreSQL 18 persistent storage (Render managed DB)
//  Four-Tier Course Classification + Shared Registry + Notifications
// ══════════════════════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '16mb' }));

// ── PostgreSQL connection ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Initialise tables on startup ──────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS course_registry (
        id          SERIAL PRIMARY KEY,
        code        TEXT,
        name        TEXT,
        prefix      TEXT,
        programme   TEXT,
        school      TEXT,
        dept        TEXT,
        tier        INTEGER DEFAULT 4,
        dh          INTEGER DEFAULT 0,
        sh          INTEGER DEFAULT 0,
        ah          INTEGER DEFAULT 0,
        oh          INTEGER DEFAULT 0,
        type        TEXT DEFAULT 'lec',
        year        INTEGER,
        sem         TEXT,
        developer   TEXT,
        owner_school TEXT,
        owner_dept   TEXT,
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(code, programme)
      );

      CREATE TABLE IF NOT EXISTS programmes (
        id          BIGINT PRIMARY KEY,
        name        TEXT,
        abbr        TEXT,
        school      TEXT,
        dept        TEXT,
        meta        JSONB,
        courses     JSONB,
        section_done JSONB,
        course_done  JSONB,
        course_count INTEGER DEFAULT 0,
        saved_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS course_details (
        id          SERIAL PRIMARY KEY,
        code        TEXT,
        name        TEXT,
        programme   TEXT,
        school      TEXT,
        dept        TEXT,
        tier        INTEGER DEFAULT 4,
        content     TEXT,
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(code, programme)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id          BIGINT PRIMARY KEY,
        type        TEXT,
        title       TEXT,
        message     TEXT,
        for_school  TEXT,
        for_dept    TEXT,
        from_school TEXT,
        from_programme TEXT,
        developer   TEXT,
        read        BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS borrows (
        id              BIGINT PRIMARY KEY,
        course_code     TEXT,
        course_name     TEXT,
        borrower_prog   TEXT,
        borrower_school TEXT,
        borrower_dept   TEXT,
        owner_prog      TEXT,
        owner_school    TEXT,
        owner_dept      TEXT,
        owner_code      TEXT,
        developer       TEXT,
        decision        TEXT,
        position_adopted BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_registry_name ON course_registry(lower(name));
      CREATE INDEX IF NOT EXISTS idx_registry_prog ON course_registry(programme);
      CREATE INDEX IF NOT EXISTS idx_notifs_school ON notifications(for_school);
      CREATE INDEX IF NOT EXISTS idx_notifs_read   ON notifications(read);
    `);
    console.log('✅ PostgreSQL tables ready');
  } catch(e) {
    console.error('DB init error:', e.message);
  } finally {
    client.release();
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const r  = await pool.query('SELECT COUNT(*) FROM course_registry');
    const n  = await pool.query('SELECT COUNT(*) FROM notifications WHERE read=false');
    const p  = await pool.query('SELECT COUNT(*) FROM programmes');
    res.json({
      status: 'ok', db: 'postgresql',
      stats: {
        totalCourses:  parseInt(r.rows[0].count),
        notifications: parseInt(n.rows[0].count),
        programmes:    parseInt(p.rows[0].count),
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AI Chat ───────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { prompt, system, maxTokens } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not set' });
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
    if (!r.ok) return res.status(r.status).json({ error: (await r.text()).slice(0,300) });
    const data = await r.json();
    res.json({ content: data.choices?.[0]?.message?.content || '', model: data.model });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  COURSE REGISTRY
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/registry', async (req, res) => {
  try {
    let q = 'SELECT * FROM course_registry WHERE 1=1';
    const params = [];
    if (req.query.school) { params.push(req.query.school); q += ` AND school=$${params.length}`; }
    if (req.query.dept)   { params.push(req.query.dept);   q += ` AND dept=$${params.length}`; }
    if (req.query.tier)   { params.push(parseInt(req.query.tier)); q += ` AND tier=$${params.length}`; }
    q += ' ORDER BY updated_at DESC LIMIT 500';
    const result = await pool.query(q, params);
    res.json(result.rows.map(toRegistry));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/registry', async (req, res) => {
  const { programme, school, dept, courses, developer } = req.body;
  if (!courses || !Array.isArray(courses)) return res.status(400).json({ error: 'courses array required' });
  let saved = 0, updated = 0;
  for (const c of courses) {
    if (!c.code && !c.name) continue;
    try {
      const r = await pool.query(
        `INSERT INTO course_registry (code,name,prefix,programme,school,dept,tier,dh,sh,ah,oh,type,year,sem,developer,owner_school,owner_dept,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
         ON CONFLICT(code,programme) DO UPDATE SET
           name=$2,prefix=$3,school=$5,dept=$6,tier=$7,dh=$8,sh=$9,ah=$10,oh=$11,
           type=$12,year=$13,sem=$14,developer=$15,owner_school=$16,owner_dept=$17,updated_at=NOW()
         RETURNING (xmax=0) AS inserted`,
        [c.code||'', c.name||'', c.prefix||'', programme||'', school||c.school||'',
         dept||c.dept||'', c.tier||4, c.DH||0, c.SH||0, c.AH||0, c.OH||0,
         c.type||'lec', c.year||1, c.sem||'1', developer||'',
         c.ownerSchool||'', c.ownerDept||'']
      );
      if (r.rows[0]?.inserted) saved++; else updated++;
    } catch(e) { console.warn('Registry insert:', e.message); }
  }
  res.json({ saved, updated });
});

// ── Conflict check ────────────────────────────────────────────────────────────
app.post('/api/registry/check', async (req, res) => {
  const { name, code, school, dept, programme, year, sem } = req.body;
  if (!name && !code) return res.status(400).json({ error: 'name or code required' });

  try {
    const nameLower  = (name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
    const nameWords  = nameLower.split(/\s+/).filter(w => w.length > 3);
    const threshold  = nameWords.length <= 3 ? nameWords.length : Math.ceil(nameWords.length * 0.65);

    // Find candidates by trigram similarity (PostgreSQL similarity)
    let candidates = [];
    if (code) {
      const r = await pool.query(
        `SELECT * FROM course_registry WHERE upper(code)=upper($1) AND programme!=$2`,
        [code, programme||'']
      );
      candidates = r.rows;
    }
    // Also name-based search
    if (nameWords.length > 0) {
      const r = await pool.query(
        `SELECT * FROM course_registry WHERE programme!=$1 AND lower(name) LIKE $2`,
        [programme||'', '%' + nameWords[0] + '%']
      );
      // Filter by word overlap
      const filtered = r.rows.filter(row => {
        const rName  = (row.name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'');
        const rWords = rName.split(/\s+/).filter(w => w.length > 3);
        const common = nameWords.filter(w => rWords.includes(w));
        return common.length >= threshold;
      });
      // Merge unique
      const seen = new Set(candidates.map(c => c.id));
      filtered.forEach(r => { if (!seen.has(r.id)) { seen.add(r.id); candidates.push(r); } });
    }

    if (!candidates.length) return res.json({ hasConflicts: false, conflicts: [] });

    const mapped = candidates.slice(0,10).map(toRegistry);
    const isCrossSchool = mapped.some(r => r.school && r.school !== school);
    const isCrossDept   = mapped.some(r => r.dept && r.dept !== dept && r.school === school);
    res.json({
      hasConflicts: true, isCrossSchool, isCrossDept,
      conflicts: mapped, suggestedTier: isCrossSchool ? 2 : isCrossDept ? 3 : 4,
      positionMismatch: mapped.some(r => r.year && r.year !== year || r.sem && r.sem !== sem)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Borrow ────────────────────────────────────────────────────────────────────
app.post('/api/registry/borrow', async (req, res) => {
  const { courseCode,courseName,borrowerProgramme,borrowerSchool,borrowerDept,
    ownerProgramme,ownerSchool,ownerDept,ownerCode,developer,decision,positionAdopted } = req.body;
  try {
    await pool.query(
      `INSERT INTO borrows (id,course_code,course_name,borrower_prog,borrower_school,borrower_dept,
       owner_prog,owner_school,owner_dept,owner_code,developer,decision,position_adopted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [Date.now(),courseCode,courseName,borrowerProgramme,borrowerSchool,borrowerDept,
       ownerProgramme,ownerSchool,ownerDept,ownerCode,developer,decision,!!positionAdopted]
    );
    if (decision==='borrow'||decision==='reclassify') {
      const msg = decision==='borrow'
        ? `${borrowerProgramme} is using "${courseName}" (${ownerCode}) from ${ownerSchool}/${ownerDept}.${positionAdopted?' Position adopted.':''}`
        : `${borrowerProgramme} requested reclassification of "${courseName}".`;
      await pool.query(
        `INSERT INTO notifications (id,type,title,message,for_school,for_dept,from_school,from_programme,developer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [Date.now(),decision==='borrow'?'BORROW':'RECLASSIFY',
         decision==='borrow'?`"${courseName}" borrowed by ${borrowerSchool}`:`"${courseName}" reclassification requested`,
         msg,ownerSchool,ownerDept,borrowerSchool,borrowerProgramme,developer]
      );
    }
    res.json({ saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/notifications', async (req, res) => {
  try {
    let q = 'SELECT * FROM notifications WHERE 1=1';
    const params = [];
    if (req.query.school) { params.push(req.query.school); q += ` AND (for_school IS NULL OR for_school=$${params.length})`; }
    q += ' ORDER BY created_at DESC LIMIT 50';
    const r = await pool.query(q, params);
    res.json(r.rows.map(n => ({
      id:n.id, type:n.type, title:n.title, message:n.message,
      forSchool:n.for_school, forDept:n.for_dept, fromSchool:n.from_school,
      fromProgramme:n.from_programme, developer:n.developer,
      read:n.read, timestamp:n.created_at
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notifications', async (req, res) => {
  const { type,title,message,forSchool,forDept,fromSchool,fromProgramme,developer } = req.body;
  try {
    await pool.query(
      `INSERT INTO notifications (id,type,title,message,for_school,for_dept,from_school,from_programme,developer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [Date.now(),type,title,message,forSchool||null,forDept||null,fromSchool||null,fromProgramme||null,developer||null]
    );
    res.json({ saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/notifications/read-all', async (req, res) => {
  try {
    const { school } = req.body;
    if (school) await pool.query('UPDATE notifications SET read=true WHERE for_school=$1 OR for_school IS NULL', [school]);
    else        await pool.query('UPDATE notifications SET read=true');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  COURSE DETAILS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/course-detail', async (req, res) => {
  const { code, name } = req.query;
  try {
    const q = code
      ? 'SELECT * FROM course_details WHERE code=$1 ORDER BY updated_at DESC LIMIT 1'
      : 'SELECT * FROM course_details WHERE lower(name)=lower($1) ORDER BY updated_at DESC LIMIT 1';
    const r = await pool.query(q, [code||name]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const d = r.rows[0];
    res.json({ code:d.code, name:d.name, programme:d.programme, school:d.school,
               dept:d.dept, tier:d.tier, text:d.content, updatedAt:d.updated_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/course-detail', async (req, res) => {
  const { code, name, programme, school, dept, tier, text } = req.body;
  if (!code || !text) return res.status(400).json({ error: 'code and text required' });
  try {
    await pool.query(
      `INSERT INTO course_details (code,name,programme,school,dept,tier,content,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT(code,programme) DO UPDATE SET name=$2,school=$4,dept=$5,tier=$6,content=$7,updated_at=NOW()`,
      [code, name||'', programme||'', school||'', dept||'', tier||4, text]
    );
    res.json({ saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  PROGRAMMES
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/programmes', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,abbr,school,dept,meta,courses,section_done,course_done,course_count,saved_at FROM programmes ORDER BY saved_at DESC');
    res.json(r.rows.map(p => ({
      id: p.id, name: p.name, abbr: p.abbr, school: p.school, dept: p.dept,
      meta: p.meta, courses: p.courses, sectionDone: p.section_done,
      courseDone: p.course_done, courseCount: p.course_count, savedAt: p.saved_at
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/programmes/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM programmes WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const p = r.rows[0];
    res.json({ id:p.id, name:p.name, abbr:p.abbr, school:p.school, dept:p.dept,
               meta:p.meta, courses:p.courses, sectionDone:p.section_done,
               courseDone:p.course_done, courseCount:p.course_count, savedAt:p.saved_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/programmes', async (req, res) => {
  const p = req.body;
  if (!p?.id) return res.status(400).json({ error: 'id required' });
  const meta    = p.meta || {};
  const courses = p.courses || [];
  try {
    await pool.query(
      `INSERT INTO programmes (id,name,abbr,school,dept,meta,courses,section_done,course_done,course_count,saved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(id) DO UPDATE SET
         name=$2,abbr=$3,school=$4,dept=$5,meta=$6,courses=$7,
         section_done=$8,course_done=$9,course_count=$10,saved_at=$11`,
      [p.id, meta.name||p.name||'', meta.abbr||p.abbr||'',
       meta.school||p.school||'', meta.dept||p.dept||'',
       JSON.stringify(meta), JSON.stringify(courses),
       JSON.stringify(p.sectionDone||{}), JSON.stringify(p.courseDone||{}),
       p.courseCount||courses.length,
       p.savedAt ? new Date(p.savedAt) : new Date()]
    );
    res.json({ saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  REGISTRY AUDIT
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/audit', async (req, res) => {
  const filter = req.query.filter;
  try {
    const reg = (await pool.query('SELECT * FROM course_registry')).rows;

    const byName = {};
    reg.forEach(c => {
      const key = (c.name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
      if (!key || key.length < 4) return;
      if (!byName[key]) byName[key] = [];
      byName[key].push(toRegistry(c));
    });

    const conflicts = [];
    Object.entries(byName).forEach(([nameKey, entries]) => {
      if (entries.length < 2) return;
      const codes   = [...new Set(entries.map(e=>e.code).filter(Boolean))];
      const nhs     = [...new Set(entries.map(e=>(e.DH||0)+(e.SH||0)+(e.AH||0)+(e.OH||0)).filter(v=>v>0))];
      const tiers   = [...new Set(entries.map(e=>e.tier||4))];
      const schools = [...new Set(entries.map(e=>e.school).filter(Boolean))];
      const progs   = [...new Set(entries.map(e=>e.programme).filter(Boolean))];

      const isCrossSchool   = schools.length > 1;
      const hasCodeConflict = codes.length > 1;
      const hasNHConflict   = nhs.length > 1;
      const hasTierConflict = tiers.length > 1;

      if (filter==='cross' && !isCrossSchool) return;
      if (!hasCodeConflict && !hasNHConflict && !hasTierConflict && progs.length < 2) return;

      conflicts.push({
        name: entries[0].name||nameKey, nameKey,
        severity: isCrossSchool?'high':hasCodeConflict||hasNHConflict?'medium':'low',
        isCrossSchool, isCrossDept: !isCrossSchool && progs.length>1,
        hasCodeConflict, hasNHConflict, hasTierConflict,
        codes, nhs, tiers, schools, programmes: progs, entries: entries.slice(0,10),
      });
    });

    conflicts.sort((a,b) => { const s={high:0,medium:1,low:2}; return (s[a.severity]||2)-(s[b.severity]||2); });
    res.json({ total:conflicts.length, high:conflicts.filter(c=>c.severity==='high').length,
      medium:conflicts.filter(c=>c.severity==='medium').length, low:conflicts.filter(c=>c.severity==='low').length,
      registrySize:reg.length, conflicts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/audit/resolve', async (req, res) => {
  const { nameKey, canonicalCode, canonicalTier, canonicalDH, canonicalSH, canonicalAH, canonicalOH, resolver } = req.body;
  if (!nameKey) return res.status(400).json({ error: 'nameKey required' });
  try {
    const result = await pool.query(
      `UPDATE course_registry SET code=$1, tier=$2, dh=$3, sh=$4, ah=$5, oh=$6, updated_at=NOW()
       WHERE lower(regexp_replace(name,'[^a-z0-9 ]','','g')) = $7`,
      [canonicalCode, canonicalTier||4, canonicalDH||0, canonicalSH||0, canonicalAH||0, canonicalOH||0, nameKey]
    );
    // Notify
    const nh = (canonicalDH||0)+(canonicalSH||0)+(canonicalAH||0)+(canonicalOH||0);
    await pool.query(
      `INSERT INTO notifications (id,type,title,message) VALUES ($1,$2,$3,$4)`,
      [Date.now(),'AUDIT_RESOLVED',`Registry resolved: "${nameKey}"`,
       `Canonical values set: code=${canonicalCode}, ${nh} NH. Update your programme to match.`]
    );
    res.json({ updated: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helper: convert DB row to API format ──────────────────────────────────────
function toRegistry(r) {
  return { code:r.code, name:r.name, prefix:r.prefix, programme:r.programme,
    school:r.school, dept:r.dept, tier:r.tier, DH:r.dh, SH:r.sh, AH:r.ah, OH:r.oh,
    type:r.type, year:r.year, sem:r.sem, developer:r.developer,
    ownerSchool:r.owner_school, ownerDept:r.owner_dept, updatedAt:r.updated_at };
}

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`KIU CBE API v3.0 (PostgreSQL) on port ${PORT}`));
}).catch(e => {
  console.error('Failed to init DB:', e);
  process.exit(1);
});
