// CORS helper (simple)
function cors(c) {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Content-Type, X-Import-Token');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

router.options('/api/availability', c => { cors(c); return c.text('', 204); });

router.post('/api/availability', async (c) => {
  cors(c);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }

  const { user_id, date, half, state, note = '' } = body || {};
  if (!user_id || !date || !half || !state) {
    return c.json({ error: 'missing fields' }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'bad date' }, 400);
  }
  if (!['AM','PM'].includes(half)) {
    return c.json({ error: 'bad half' }, 400);
  }
  if (!['prefer','available','no','unset'].includes(state)) {
    return c.json({ error: 'bad state' }, 400);
  }

  // If “unset”, delete row; otherwise upsert
  const db = c.env.DB;
  const now = Math.floor(Date.now()/1000);

  if (state === 'unset') {
    await db.prepare(
      `DELETE FROM sc_availability WHERE user_id=? AND date=? AND half=?`
    ).bind(user_id, date, half).run();
    return c.json({ ok: true, cleared: true });
  }

  await db.prepare(
    `INSERT INTO sc_availability (user_id, date, half, state, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date, half)
     DO UPDATE SET state=excluded.state, note=excluded.note, updated_at=excluded.updated_at`
  ).bind(user_id, date, half, state, note, now).run();

  return c.json({ ok: true });
});
