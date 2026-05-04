'use strict';

const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const fetch      = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

// ── Initialise tables on startup ──────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS programmes (
        id         BIGINT PRIMARY KEY,
        name       TEXT,
        abbr       TEXT,
        school     TEXT,
        dept       TEXT,
        saved_at   TIMESTAMPTZ DEFAULT NOW(),
        data       JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS course_registry (
        code       TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        prefix     TEXT,
        type       TEXT,
        dh         INT DEFAULT 0,
        sh         INT DEFAULT 0,
        ah         INT DEFAULT 0,
        oh         INT DEFAULT 0,
        programme  TEXT,
        school     TEXT,
        dept       TEXT,
        level      INT DEFAULT 7,
        year       INT DEFAULT 1,
        sem        TEXT DEFAULT '1',
        tier       INT DEFAULT 4,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS course_details (
        code        TEXT PRIMARY KEY,
        name        TEXT,
        programme   TEXT,
        school      TEXT,
        dept        TEXT,
        tier        INT DEFAULT 4,
        detail_text TEXT,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id          SERIAL PRIMARY KEY,
        type        TEXT,
        title       TEXT,
        message     TEXT,
        for_school  TEXT,
        for_dept    TEXT,
        from_school TEXT,
        from_programme TEXT,
        developer   TEXT,
        is_read     BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS borrow_log (
        id                  SERIAL PRIMARY KEY,
        course_code         TEXT,
        course_name         TEXT,
        borrower_programme  TEXT,
        borrower_school     TEXT,
        borrower_dept       TEXT,
        owner_programme     TEXT,
        owner_school        TEXT,
        owner_dept          TEXT,
        owner_code          TEXT,
        developer           TEXT,
        decision            TEXT,
        position_adopted    BOOLEAN DEFAULT FALSE,
        logged_at           TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ownership (
        course_code    TEXT PRIMARY KEY,
        course_name    TEXT,
        owner_school   TEXT,
        owner_dept     TEXT,
        owner_programme TEXT,
        tier           INT DEFAULT 4,
        developer      TEXT,
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Database tables ready');
  } finally {
    client.release();
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'KIU CBE Backend', db: 'PostgreSQL' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ══════════════════════════════════════════════════════════════════════════════
//  AI CHAT PROXY
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  const { prompt, system, maxTokens } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not set' });

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://kiu.ac.ug',
        'X-Title':       'KIU CBE Generator',
      },
      body: JSON.stringify({
        model:      'meta-llama/llama-3.3-70b-instruct',
        max_tokens: maxTokens || 2000,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: err.slice(0, 300) });
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PROGRAMMES  —  full JSONB storage, nothing ever lost
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/programmes', async (req, res) => {
  const prog = req.body;
  if (!prog || !prog.id) return res.status(400).json({ error: 'Missing id' });

  const meta = prog.meta || {};
  try {
    await pool.query(`
      INSERT INTO programmes (id, name, abbr, school, dept, saved_at, data)
      VALUES ($1, $2, $3, $4, $5, NOW(), $6)
      ON CONFLICT (id) DO UPDATE
        SET name=$2, abbr=$3, school=$4, dept=$5, saved_at=NOW(), data=$6
    `, [
      prog.id,
      meta.name  || prog.name  || '',
      meta.abbr  || prog.abbr  || '',
      meta.school|| prog.school|| '',
      meta.dept  || prog.dept  || '',
      JSON.stringify(prog),
    ]);

    // Also upsert courses into registry
    if (prog.courses && prog.courses.length) {
      for (const c of prog.courses) {
        if (!c.code) continue;
        await pool.query(`
          INSERT INTO course_registry
            (code,name,prefix,type,dh,sh,ah,oh,programme,school,dept,level,year,sem,tier,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
          ON CONFLICT (code) DO UPDATE
            SET name=$2,prefix=$3,type=$4,dh=$5,sh=$6,ah=$7,oh=$8,
                programme=$9,school=$10,dept=$11,level=$12,year=$13,sem=$14,
                tier=$15,updated_at=NOW()
        `, [
          c.code, c.name||'', c.prefix||'', c.type||'lec',
          c.DH||0, c.SH||0, c.AH||0, c.OH||0,
          meta.name||'', meta.school||'', meta.dept||'',
          parseInt(meta.level)||7, c.year||1, c.sem||'1', c.tier||4,
        ]);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/programmes:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// List — returns summary list
app.get('/api/programmes', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, abbr, school, dept, saved_at,
              jsonb_array_length(COALESCE(data->'courses','[]'::jsonb)) AS course_count
       FROM programmes ORDER BY saved_at DESC`
    );
    res.json(result.rows.map(r => ({
      id:       Number(r.id),
      name:     r.name,
      abbr:     r.abbr,
      school:   r.school,
      dept:     r.dept,
      savedAt:  r.saved_at,
      meta:     { name:r.name, abbr:r.abbr, school:r.school, dept:r.dept },
      _courseCount: Number(r.course_count||0),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full programme by id
app.get('/api/programmes/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT data FROM programmes WHERE id=$1', [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0].data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete programme
app.delete('/api/programmes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM programmes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  COURSE REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/registry', async (req, res) => {
  const { programme, school, dept, courses } = req.body;
  if (!courses || !courses.length) return res.json({ ok: true, saved: 0 });

  let saved = 0;
  for (const c of courses) {
    if (!c.code) continue;
    try {
      await pool.query(`
        INSERT INTO course_registry
          (code,name,prefix,type,dh,sh,ah,oh,programme,school,dept,year,sem,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT (code) DO UPDATE
          SET name=$2,prefix=$3,type=$4,dh=$5,sh=$6,ah=$7,oh=$8,
              programme=$9,school=$10,dept=$11,year=$12,sem=$13,updated_at=NOW()
      `, [
        c.code, c.name||'', c.prefix||'', c.type||'lec',
        c.DH||0, c.SH||0, c.AH||0, c.OH||0,
        programme||'', school||'', dept||'',
        c.year||1, c.sem||'1',
      ]);
      saved++;
    } catch (e) { console.warn('registry upsert:', e.message); }
  }
  res.json({ ok: true, saved });
});

// Conflict check
app.post('/api/registry/check', async (req, res) => {
  const { name, code, school, dept, programme } = req.body;
  if (!name && !code) return res.json({ hasConflicts: false });

  try {
    const words  = (name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim().split(/\s+/).filter(w=>w.length>3);
    const likePat = words.slice(0,4).join('%');

    const result = await pool.query(`
      SELECT code,name,programme,school,dept,dh,sh,ah,oh,tier,year,sem
      FROM course_registry
      WHERE programme != $1
        AND (
          ($2 <> '' AND code = $2)
          OR ($3 <> '' AND LOWER(name) LIKE '%' || $3 || '%')
        )
      LIMIT 15
    `, [programme||'__none__', code||'', likePat]);

    if (!result.rows.length) return res.json({ hasConflicts: false });

    const conflicts = result.rows;
    const isCrossSchool = conflicts.some(r => r.school && r.school !== school);
    const isCrossDept   = conflicts.some(r => r.dept && r.dept !== dept && r.school === school);

    res.json({
      hasConflicts: true,
      isCrossSchool, isCrossDept,
      conflicts,
      suggestedTier: isCrossSchool ? 2 : isCrossDept ? 3 : 4,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Borrow log
app.post('/api/registry/borrow', async (req, res) => {
  const d = req.body;
  try {
    await pool.query(`
      INSERT INTO borrow_log
        (course_code,course_name,borrower_programme,borrower_school,borrower_dept,
         owner_programme,owner_school,owner_dept,owner_code,developer,decision,position_adopted)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      d.courseCode||'', d.courseName||'',
      d.borrowerProgramme||'', d.borrowerSchool||'', d.borrowerDept||'',
      d.ownerProgramme||'',    d.ownerSchool||'',    d.ownerDept||'',
      d.ownerCode||'',         d.developer||'',
      d.decision||'borrow',    !!d.positionAdopted,
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  COURSE DETAILS
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/course-detail', async (req, res) => {
  const { code, name, programme, school, dept, tier, text } = req.body;
  if (!code || !text) return res.status(400).json({ error: 'code and text required' });

  try {
    await pool.query(`
      INSERT INTO course_details (code,name,programme,school,dept,tier,detail_text,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (code) DO UPDATE
        SET name=$2,programme=$3,school=$4,dept=$5,tier=$6,detail_text=$7,updated_at=NOW()
    `, [code, name||'', programme||'', school||'', dept||'', tier||4, text]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/course-detail', async (req, res) => {
  const { code, name } = req.query;
  try {
    let result;
    if (code) {
      result = await pool.query(
        'SELECT * FROM course_details WHERE code=$1', [code]
      );
    } else if (name) {
      result = await pool.query(
        `SELECT * FROM course_details WHERE LOWER(name)=LOWER($1) LIMIT 1`, [name]
      );
    }
    if (!result || !result.rows.length) return res.status(404).json({ error: 'Not found' });
    const r = result.rows[0];
    res.json({
      code:       r.code,
      name:       r.name,
      programme:  r.programme,
      school:     r.school,
      dept:       r.dept,
      tier:       r.tier,
      text:       r.detail_text,
      updatedAt:  r.updated_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  AUDIT
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/audit', async (req, res) => {
  const filterCrossSchool = req.query.filter === 'cross';
  try {
    // Find course names that appear in more than one programme
    const result = await pool.query(`
      SELECT
        LOWER(TRIM(name)) AS name_key,
        name,
        COUNT(DISTINCT programme) AS prog_count,
        COUNT(DISTINCT school)    AS school_count,
        ARRAY_AGG(DISTINCT code ORDER BY code)    AS codes,
        ARRAY_AGG(DISTINCT school ORDER BY school) AS schools,
        ARRAY_AGG(DISTINCT tier)                  AS tiers,
        ARRAY_AGG(dh+sh+ah+oh)                    AS nhs,
        JSON_AGG(JSON_BUILD_OBJECT(
          'code',code,'name',name,'programme',programme,
          'school',school,'dept',dept,
          'DH',dh,'SH',sh,'AH',ah,'OH',oh,'tier',tier,'year',year,'sem',sem
        )) AS entries
      FROM course_registry
      GROUP BY LOWER(TRIM(name)), name
      HAVING COUNT(DISTINCT programme) > 1
        ${filterCrossSchool ? 'AND COUNT(DISTINCT school) > 1' : ''}
      ORDER BY COUNT(DISTINCT school) DESC, COUNT(DISTINCT programme) DESC
      LIMIT 100
    `);

    const registryCount = await pool.query('SELECT COUNT(*) FROM course_registry');

    const conflicts = result.rows.map(r => {
      const codes  = [...new Set(r.codes)];
      const nhs    = [...new Set(r.nhs.map(Number))];
      const tiers  = [...new Set(r.tiers.map(Number))];
      const schools= [...new Set(r.schools)];
      const hasCodeConflict = codes.length  > 1;
      const hasNHConflict   = nhs.length    > 1;
      const hasTierConflict = tiers.length  > 1;
      const isCrossSchool   = schools.length > 1;
      const severity = isCrossSchool && (hasCodeConflict || hasNHConflict) ? 'high'
                     : isCrossSchool || hasCodeConflict ? 'medium' : 'low';
      return {
        nameKey: r.name_key, name: r.name,
        codes, nhs, tiers, schools,
        hasCodeConflict, hasNHConflict, hasTierConflict, isCrossSchool,
        severity,
        entries: r.entries || [],
      };
    });

    const high   = conflicts.filter(c => c.severity==='high').length;
    const medium = conflicts.filter(c => c.severity==='medium').length;
    const low    = conflicts.filter(c => c.severity==='low').length;

    res.json({
      total:        conflicts.length,
      high, medium, low,
      registrySize: Number(registryCount.rows[0].count),
      conflicts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/audit/resolve', async (req, res) => {
  const { nameKey, canonicalCode, canonicalTier, canonicalDH, canonicalSH, canonicalAH, canonicalOH, resolver } = req.body;
  try {
    const result = await pool.query(`
      UPDATE course_registry
      SET code=$1, tier=$2, dh=$3, sh=$4, ah=$5, oh=$6, updated_at=NOW()
      WHERE LOWER(TRIM(name))=$7
    `, [canonicalCode, canonicalTier||4, canonicalDH||0, canonicalSH||0, canonicalAH||0, canonicalOH||0, nameKey]);

    // Notify all affected schools
    const affected = await pool.query(
      `SELECT DISTINCT school,dept FROM course_registry WHERE LOWER(TRIM(name))=$1`, [nameKey]
    );
    for (const row of affected.rows) {
      await pool.query(`
        INSERT INTO notifications
          (type,title,message,for_school,for_dept,from_school,is_read)
        VALUES ($1,$2,$3,$4,$5,$6,false)
      `, [
        'AUDIT_RESOLVE',
        `Registry conflict resolved: "${nameKey}"`,
        `The canonical code for "${nameKey}" has been set to ${canonicalCode} (${canonicalDH+canonicalSH+canonicalAH+canonicalOH} NH) by ${resolver||'Registry Admin'}. Please update your programme accordingly.`,
        row.school, row.dept, resolver||'Registry Admin',
      ]);
    }

    res.json({ ok: true, updated: result.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/notifications', async (req, res) => {
  const { school, dept } = req.query;
  if (!school) return res.json([]);
  try {
    const result = await pool.query(`
      SELECT id, type, title, message, for_school, for_dept,
             from_school, from_programme, is_read AS read, created_at AS timestamp
      FROM notifications
      WHERE for_school=$1 ${dept ? 'AND (for_dept=$2 OR for_dept IS NULL)' : ''}
      ORDER BY created_at DESC
      LIMIT 50
    `, dept ? [school, dept] : [school]);
    res.json(result.rows.map(r => ({ ...r, id: Number(r.id) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notifications', async (req, res) => {
  const d = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO notifications
        (type,title,message,for_school,for_dept,from_school,from_programme,developer,is_read)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
      RETURNING id
    `, [
      d.type||'INFO', d.title||'', d.message||'',
      d.forSchool||d.for_school||'', d.forDept||d.for_dept||'',
      d.fromSchool||d.from_school||'',
      d.fromProgramme||d.from_programme||'',
      d.developer||'',
    ]);
    res.json({ ok: true, id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/notifications/read-all', async (req, res) => {
  const { school, dept } = req.body;
  try {
    await pool.query(
      'UPDATE notifications SET is_read=true WHERE for_school=$1 AND (for_dept=$2 OR for_dept IS NULL)',
      [school||'', dept||'']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  OWNERSHIP
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/ownership', async (req, res) => {
  const d = req.body;
  try {
    await pool.query(`
      INSERT INTO ownership (course_code,course_name,owner_school,owner_dept,owner_programme,tier,developer,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (course_code) DO UPDATE
        SET course_name=$2,owner_school=$3,owner_dept=$4,owner_programme=$5,
            tier=$6,developer=$7,updated_at=NOW()
    `, [d.courseCode||'', d.courseName||'', d.ownerSchool||'', d.ownerDept||'',
        d.ownerProgramme||'', d.tier||4, d.developer||'']);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
initDB()
  .then(() => app.listen(PORT, () => console.log(`KIU Backend running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
