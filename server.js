// ══════════════════════════════════════════════════════════════════════════════
//  KIU CBE Programme Generator — Backend API v3.1
//  PostgreSQL 18 (Render managed DB) with graceful fallback
// ══════════════════════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '16mb' }));

// ── PostgreSQL setup ──────────────────────────────────────────────────────────
let pool = null;
let dbReady = false;

function initDB() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('⚠️  DATABASE_URL not set — running without database');
    return Promise.resolve(false);
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 600000,
      connectionTimeoutMillis: 10000,
    });

    // Auto-recover if pool crashes
pool.on('error', function(err) {
  console.error('Pool error:', err.message);
  pool = null; dbReady = false;
  setTimeout(initDB, 5000);
});

    return pool.query(`
      CREATE TABLE IF NOT EXISTS course_registry (
        id          SERIAL PRIMARY KEY,
        code        TEXT NOT NULL DEFAULT '',
        name        TEXT NOT NULL DEFAULT '',
        prefix      TEXT DEFAULT '',
        programme   TEXT DEFAULT '',
        school      TEXT DEFAULT '',
        dept        TEXT DEFAULT '',
        tier        INTEGER DEFAULT 4,
        dh          INTEGER DEFAULT 0,
        sh          INTEGER DEFAULT 0,
        ah          INTEGER DEFAULT 0,
        oh          INTEGER DEFAULT 0,
        type        TEXT DEFAULT 'lec',
        year_num    INTEGER DEFAULT 1,
        sem         TEXT DEFAULT '1',
        developer   TEXT DEFAULT '',
        owner_school TEXT DEFAULT '',
        owner_dept  TEXT DEFAULT '',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(code, programme)
      );
      CREATE TABLE IF NOT EXISTS programmes (
  id           BIGINT PRIMARY KEY,
  name         TEXT DEFAULT '',
  abbr         TEXT DEFAULT '',
  school       TEXT DEFAULT '',
  dept         TEXT DEFAULT '',
  meta         JSONB DEFAULT '{}',
  courses      JSONB DEFAULT '[]',
  section_done JSONB DEFAULT '{}',
  course_done  JSONB DEFAULT '{}',
  course_count INTEGER DEFAULT 0,
  section_content JSONB DEFAULT '{}',   -- ← ADD THIS LINE
  saved_at     TIMESTAMPTZ DEFAULT NOW()
);
-- ADD THIS LINE after the CREATE TABLE block:
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS section_content JSONB DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS course_details (
        id          SERIAL PRIMARY KEY,
        code        TEXT NOT NULL DEFAULT '',
        name        TEXT DEFAULT '',
        programme   TEXT DEFAULT '',
        school      TEXT DEFAULT '',
        dept        TEXT DEFAULT '',
        tier        INTEGER DEFAULT 4,
        content     TEXT DEFAULT '',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(code, programme)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id             BIGINT PRIMARY KEY,
        type           TEXT DEFAULT '',
        title          TEXT DEFAULT '',
        message        TEXT DEFAULT '',
        for_school     TEXT,
        for_dept       TEXT,
        from_school    TEXT,
        from_programme TEXT,
        developer      TEXT,
        is_read        BOOLEAN DEFAULT FALSE,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      -- Migrate: rename 'read' to 'is_read' if old column exists
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='notifications' AND column_name='read') THEN
          ALTER TABLE notifications RENAME COLUMN "read" TO is_read;
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS borrows (
        id               BIGINT PRIMARY KEY,
        course_code      TEXT DEFAULT '',
        course_name      TEXT DEFAULT '',
        borrower_prog    TEXT DEFAULT '',
        borrower_school  TEXT DEFAULT '',
        borrower_dept    TEXT DEFAULT '',
        owner_prog       TEXT DEFAULT '',
        owner_school     TEXT DEFAULT '',
        owner_dept       TEXT DEFAULT '',
        owner_code       TEXT DEFAULT '',
        developer        TEXT DEFAULT '',
        decision         TEXT DEFAULT '',
        position_adopted BOOLEAN DEFAULT FALSE,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_reg_name ON course_registry(lower(name));
      CREATE INDEX IF NOT EXISTS idx_reg_prog ON course_registry(programme);
      CREATE INDEX IF NOT EXISTS idx_notif_school ON notifications(for_school);
    `)
    .then(() => {
  dbReady = true;
  console.log('✅ PostgreSQL connected and tables ready');

  // Keep at least one connection alive every 4 minutes
  setInterval(async function() {
    try { await pool.query('SELECT 1'); }
    catch(e) { console.warn('DB keepalive failed, reinitialising...'); initDB(); }
  }, 4 * 60 * 1000);

  return true;
})
    .catch(e => {
      console.error('❌ DB init failed:', e.message);
      pool = null;
      return false;
    });
  } catch(e) {
    console.error('❌ pg module error:', e.message);
    return Promise.resolve(false);
  }
}

// ── DB query helper with error handling ───────────────────────────────────────
async function q(sql, params) {
  if (!pool) throw new Error('Database not connected. Check DATABASE_URL on Render.');
  return pool.query(sql, params);
}

// ── Convert registry DB row → API object ─────────────────────────────────────
function toReg(r) {
  return {
    code: r.code, name: r.name, prefix: r.prefix,
    programme: r.programme, school: r.school, dept: r.dept,
    tier: r.tier, DH: r.dh, SH: r.sh, AH: r.ah, OH: r.oh,
    type: r.type, year: r.year_num, sem: r.sem,
    developer: r.developer, ownerSchool: r.owner_school,
    ownerDept: r.owner_dept, updatedAt: r.updated_at,
  };
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  if (!dbReady) {
    return res.json({
      status: 'ok-no-db',
      db: 'not connected',
      message: 'DATABASE_URL not set or DB connection failed',
      env: { DATABASE_URL: !!process.env.DATABASE_URL, OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY }
    });
  }
  try {
    const [rc, nc, pc] = await Promise.all([
      q('SELECT COUNT(*) FROM course_registry'),
      q('SELECT COUNT(*) FROM notifications WHERE is_read=false'),
      q('SELECT COUNT(*) FROM programmes'),
    ]);
    res.json({
      status: 'ok', db: 'postgresql-18',
      stats: {
        totalCourses:  parseInt(rc.rows[0].count),
        notifications: parseInt(nc.rows[0].count),
        programmes:    parseInt(pc.rows[0].count),
      }
    });
  } catch(e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ── AI Chat ───────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { prompt, system, maxTokens } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not set on server' });
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
    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: errText.slice(0, 300) });
    }
    const data = await r.json();
    res.json({ content: data.choices?.[0]?.message?.content || '', model: data.model });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  COURSE REGISTRY
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/registry', async (req, res) => {
  try {
    let sql = 'SELECT * FROM course_registry WHERE 1=1';
    const params = [];
    if (req.query.school) { params.push(req.query.school); sql += ` AND school=$${params.length}`; }
    if (req.query.dept)   { params.push(req.query.dept);   sql += ` AND dept=$${params.length}`; }
    if (req.query.tier)   { params.push(parseInt(req.query.tier)); sql += ` AND tier=$${params.length}`; }
    sql += ' ORDER BY updated_at DESC LIMIT 1000';
    const result = await q(sql, params);
    res.json(result.rows.map(toReg));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/registry', async (req, res) => {
  const { programme, school, dept, courses, developer } = req.body;
  if (!courses || !Array.isArray(courses)) return res.status(400).json({ error: 'courses array required' });
  let saved = 0, updated = 0;
  for (const c of courses) {
    if (!c.code && !c.name) continue;
    try {
      const r = await q(
        `INSERT INTO course_registry
           (code,name,prefix,programme,school,dept,tier,dh,sh,ah,oh,type,year_num,sem,developer,owner_school,owner_dept)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT(code,programme) DO UPDATE SET
           name=$2,prefix=$3,school=$5,dept=$6,tier=$7,dh=$8,sh=$9,
           ah=$10,oh=$11,type=$12,year_num=$13,sem=$14,developer=$15,
           owner_school=$16,owner_dept=$17,updated_at=NOW()
         RETURNING (xmax=0) AS inserted`,
        [c.code||'', c.name||'', c.prefix||'',
         programme||'', school||c.school||'', dept||c.dept||'',
         c.tier||4, c.DH||0, c.SH||0, c.AH||0, c.OH||0,
         c.type||'lec', c.year||1, c.sem||'1',
         developer||'', c.ownerSchool||'', c.ownerDept||'']
      );
      if (r.rows[0]?.inserted) saved++; else updated++;
    } catch(e) { console.warn('Registry row error:', e.message); }
  }
  res.json({ saved, updated });
});

app.post('/api/registry/check', async (req, res) => {
  const { name, code, school, dept, programme, year, sem } = req.body;
  if (!name && !code) return res.status(400).json({ error: 'name or code required' });
  try {
    const nameLower = (name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
    const nameWords = nameLower.split(/\s+/).filter(w => w.length > 3);
    const threshold = nameWords.length <= 3 ? nameWords.length : Math.ceil(nameWords.length * 0.65);

    let candidates = [];
    if (code) {
      const r = await q(
        'SELECT * FROM course_registry WHERE upper(code)=upper($1) AND programme!=$2',
        [code, programme||'']
      );
      candidates = r.rows;
    }
    if (nameWords.length > 0) {
      const r = await q(
        'SELECT * FROM course_registry WHERE programme!=$1 AND lower(name) LIKE $2',
        [programme||'', '%' + nameWords[0] + '%']
      );
      const filtered = r.rows.filter(row => {
        const rW = (row.name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').split(/\s+/).filter(w=>w.length>3);
        return nameWords.filter(w=>rW.includes(w)).length >= threshold;
      });
      const seen = new Set(candidates.map(c=>c.id));
      filtered.forEach(r => { if (!seen.has(r.id)) { seen.add(r.id); candidates.push(r); } });
    }
    if (!candidates.length) return res.json({ hasConflicts: false, conflicts: [] });

    const mapped = candidates.slice(0,10).map(toReg);
    const isCrossSchool = mapped.some(r => r.school && r.school !== school);
    const isCrossDept   = mapped.some(r => r.dept && r.dept !== dept && r.school === school);
    res.json({
      hasConflicts: true, isCrossSchool, isCrossDept, conflicts: mapped,
      suggestedTier: isCrossSchool ? 2 : isCrossDept ? 3 : 4,
      positionMismatch: mapped.some(r => (r.year && r.year !== year) || (r.sem && r.sem !== sem))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/registry/borrow', async (req, res) => {
  const { courseCode,courseName,borrowerProgramme,borrowerSchool,borrowerDept,
    ownerProgramme,ownerSchool,ownerDept,ownerCode,developer,decision,positionAdopted } = req.body;
  try {
    await q(
      `INSERT INTO borrows (id,course_code,course_name,borrower_prog,borrower_school,borrower_dept,
       owner_prog,owner_school,owner_dept,owner_code,developer,decision,position_adopted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT DO NOTHING`,
      [Date.now(),courseCode||'',courseName||'',borrowerProgramme||'',
       borrowerSchool||'',borrowerDept||'',ownerProgramme||'',
       ownerSchool||'',ownerDept||'',ownerCode||'',developer||'',
       decision||'borrow',!!positionAdopted]
    );
    if (decision==='borrow'||decision==='reclassify') {
      const msg = decision==='borrow'
        ? `${borrowerProgramme} is using "${courseName}" (${ownerCode||''}) from ${ownerSchool}/${ownerDept}.${positionAdopted?' Position adopted.':''}`
        : `${borrowerProgramme} requested reclassification of "${courseName}".`;
      await q(
        `INSERT INTO notifications (id,type,title,message,for_school,for_dept,from_school,from_programme,developer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [Date.now(), decision==='borrow'?'BORROW':'RECLASSIFY',
         `"${courseName}" ${decision==='borrow'?'borrowed by':'reclassification from'} ${borrowerSchool}`,
         msg, ownerSchool||null, ownerDept||null,
         borrowerSchool||null, borrowerProgramme||null, developer||null]
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
    let sql = 'SELECT * FROM notifications WHERE 1=1';
    const params = [];
    if (req.query.school) {
      params.push(req.query.school);
      sql += ` AND (for_school IS NULL OR for_school=$${params.length})`;
    }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    const r = await q(sql, params);
    res.json(r.rows.map(n => ({
      id:n.id, type:n.type, title:n.title, message:n.message,
      forSchool:n.for_school, forDept:n.for_dept, fromSchool:n.from_school,
      fromProgramme:n.from_programme, developer:n.developer,
      read:n.is_read, timestamp:n.created_at
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notifications', async (req, res) => {
  const { type,title,message,forSchool,forDept,fromSchool,fromProgramme,developer } = req.body;
  try {
    await q(
      `INSERT INTO notifications (id,type,title,message,for_school,for_dept,from_school,from_programme,developer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [Date.now(),type||'',title||'',message||'',
       forSchool||null,forDept||null,fromSchool||null,fromProgramme||null,developer||null]
    );
    res.json({ saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    await q('UPDATE notifications SET is_read=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/notifications/read-all', async (req, res) => {
  try {
    const { school } = req.body || {};
    if (school) await q('UPDATE notifications SET is_read=true WHERE for_school=$1 OR for_school IS NULL',[school]);
    else        await q('UPDATE notifications SET is_read=true');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  COURSE DETAILS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/course-detail', async (req, res) => {
  const { code, name } = req.query;
  try {
    const sql = code
      ? 'SELECT * FROM course_details WHERE code=$1 ORDER BY updated_at DESC LIMIT 1'
      : 'SELECT * FROM course_details WHERE lower(name)=lower($1) ORDER BY updated_at DESC LIMIT 1';
    const r = await q(sql, [code||name]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const d = r.rows[0];
    res.json({ code:d.code, name:d.name, programme:d.programme, school:d.school,
               dept:d.dept, tier:d.tier, text:d.content, updatedAt:d.updated_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/course-detail', async (req, res) => {
  const { code, name, programme, school, dept, tier, text } = req.body;
  if (!code||!text) return res.status(400).json({ error: 'code and text required' });
  try {
    await q(
      `INSERT INTO course_details (code,name,programme,school,dept,tier,content,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT(code,programme) DO UPDATE SET
         name=$2,school=$4,dept=$5,tier=$6,content=$7,updated_at=NOW()`,
      [code,name||'',programme||'',school||'',dept||'',tier||4,text]
    );
    res.json({ saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  PROGRAMMES
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/programmes', async (req, res) => {
  try {
    const r = await q(
      'SELECT id,name,abbr,school,dept,meta,courses,section_done,course_done,course_count,section_content,saved_at FROM programmes ORDER BY saved_at DESC'
    );
    res.json(r.rows.map(p => ({
      id:p.id, name:p.name, abbr:p.abbr, school:p.school, dept:p.dept,
      meta:p.meta, courses:p.courses, sectionDone:p.section_done,
      courseDone:p.course_done, courseCount:p.course_count, 
      savedAt:p.saved_at,
      sectionContent: p.section_content || {}   // ← ADD THIS
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/programmes/:id', async (req, res) => {
  try {
    const r = await q('SELECT * FROM programmes WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const p = r.rows[0];
    res.json({ 
      id:p.id, name:p.name, abbr:p.abbr, school:p.school, dept:p.dept,
      meta:p.meta, courses:p.courses, sectionDone:p.section_done,
      courseDone:p.course_done, courseCount:p.course_count, 
      savedAt:p.saved_at,
      sectionContent: p.section_content || {}   // ← ADD THIS
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/programmes', async (req, res) => {
  const p = req.body;
  if (!p?.id) return res.status(400).json({ error: 'id required' });
  const meta    = p.meta || {};
  const courses = p.courses || [];
  const sectionContent = p.sectionContent || {};
  try {
    await q(
      `INSERT INTO programmes 
         (id,name,abbr,school,dept,meta,courses,section_done,course_done,course_count,section_content,saved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(id) DO UPDATE SET
         name=$2,abbr=$3,school=$4,dept=$5,meta=$6,courses=$7,
         section_done=$8,course_done=$9,course_count=$10,section_content=$11,saved_at=$12`,
      [String(p.id), meta.name||p.name||'', meta.abbr||p.abbr||'',
       meta.school||p.school||'', meta.dept||p.dept||'',
       JSON.stringify(meta), JSON.stringify(courses),
       JSON.stringify(p.sectionDone||{}), JSON.stringify(p.courseDone||{}),
       p.courseCount||courses.length,
       JSON.stringify(sectionContent),
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
    const reg = (await q('SELECT * FROM course_registry')).rows;
    const byName = {};
    reg.forEach(c => {
      const key = (c.name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
      if (!key || key.length < 4) return;
      if (!byName[key]) byName[key] = [];
      byName[key].push(toReg(c));
    });
    const conflicts = [];
    Object.entries(byName).forEach(([nameKey, entries]) => {
      if (entries.length < 2) return;
      const codes   = [...new Set(entries.map(e=>e.code).filter(Boolean))];
      const nhs     = [...new Set(entries.map(e=>(e.DH||0)+(e.SH||0)+(e.AH||0)+(e.OH||0)).filter(v=>v>0))];
      const tiers   = [...new Set(entries.map(e=>e.tier||4))];
      const schools = [...new Set(entries.map(e=>e.school).filter(Boolean))];
      const progs   = [...new Set(entries.map(e=>e.programme).filter(Boolean))];
      const isCrossSchool=schools.length>1, hasCodeConflict=codes.length>1;
      const hasNHConflict=nhs.length>1, hasTierConflict=tiers.length>1;
      if (filter==='cross' && !isCrossSchool) return;
      if (!hasCodeConflict && !hasNHConflict && !hasTierConflict && progs.length<2) return;
      conflicts.push({
        name:entries[0].name||nameKey, nameKey,
        severity:isCrossSchool?'high':hasCodeConflict||hasNHConflict?'medium':'low',
        isCrossSchool, isCrossDept:!isCrossSchool&&progs.length>1,
        hasCodeConflict, hasNHConflict, hasTierConflict,
        codes, nhs, tiers, schools, programmes:progs, entries:entries.slice(0,10)
      });
    });
    conflicts.sort((a,b)=>{ const s={high:0,medium:1,low:2}; return (s[a.severity]||2)-(s[b.severity]||2); });
    res.json({ total:conflicts.length,
      high:conflicts.filter(c=>c.severity==='high').length,
      medium:conflicts.filter(c=>c.severity==='medium').length,
      low:conflicts.filter(c=>c.severity==='low').length,
      registrySize:reg.length, conflicts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/audit/resolve', async (req, res) => {
  const { nameKey,canonicalCode,canonicalTier,canonicalDH,canonicalSH,canonicalAH,canonicalOH,resolver } = req.body;
  if (!nameKey) return res.status(400).json({ error: 'nameKey required' });
  try {
    const result = await q(
      `UPDATE course_registry SET code=$1,tier=$2,dh=$3,sh=$4,ah=$5,oh=$6,updated_at=NOW()
       WHERE lower(regexp_replace(name,'[^a-zA-Z0-9 ]','','g'))=lower($7)`,
      [canonicalCode,canonicalTier||4,canonicalDH||0,canonicalSH||0,
       canonicalAH||0,canonicalOH||0,nameKey]
    );
    const nh=(canonicalDH||0)+(canonicalSH||0)+(canonicalAH||0)+(canonicalOH||0);
    await q(
      `INSERT INTO notifications (id,type,title,message) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [Date.now(),'AUDIT_RESOLVED',`Registry resolved: "${nameKey}"`,
       `Canonical values set: code=${canonicalCode}, ${nh} NH. Update your programme to match.`]
    );
    res.json({ updated:result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  CATALOGUE (summary)
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/catalogue', async (req, res) => {
  try {
    const r = await q('SELECT tier, COUNT(*) as cnt FROM course_registry GROUP BY tier');
    const byTier = {1:0,2:0,3:0,4:0};
    r.rows.forEach(row => { byTier[row.tier] = parseInt(row.cnt); });
    const total = (await q('SELECT COUNT(*) FROM course_registry')).rows[0].count;
    res.json({ byTier, total: parseInt(total) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`KIU CBE API v3.1 listening on port ${PORT}`);
  console.log(`DATABASE_URL: ${process.env.DATABASE_URL ? 'SET ✅' : 'NOT SET ⚠️'}`);
  console.log(`OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? 'SET ✅' : 'NOT SET ⚠️'}`);
  initDB();
});

// ── Ownership endpoint (used by app for T2/T3 course ownership) ───────────────
app.get('/api/ownership', async (req, res) => {
  try {
    const r = await q(
      'SELECT code, name, school AS "ownerSchool", dept AS "ownerDept", programme AS "ownerProgramme", tier, developer, updated_at AS "updatedAt" FROM course_registry WHERE tier < 4 ORDER BY tier, name'
    );
    // Return as object keyed by normalised name
    const result = {};
    r.rows.forEach(row => {
      const key = (row.code || row.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      result[key] = row;
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ownership', async (req, res) => {
  const { courseCode, courseName, ownerSchool, ownerDept, ownerProgramme, tier, developer } = req.body;
  try {
    await q(
      `UPDATE course_registry SET tier=$1, owner_school=$2, owner_dept=$3, updated_at=NOW()
       WHERE code=$4 OR lower(name)=lower($5)`,
      [tier || 3, ownerSchool || '', ownerDept || '', courseCode || '', courseName || '']
    );
    res.json({ saved: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
