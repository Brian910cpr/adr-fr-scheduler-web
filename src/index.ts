// src/index.ts — ADR-FR Wallboard API + UI (Cloudflare Workers + Hono + D1)
import { Hono } from 'hono'

type Env = { DB: D1Database; IMPORT_TOKEN?: string }

// ===== Time helpers (America/New_York) =====
const TZ = 'America/New_York'
function fmtTz(date: Date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
  const [y, m, d] = f.format(date).split('-')
  return { y, m, d, iso: `${y}-${m}-${d}` }
}
function todayISO() { return fmtTz(new Date()).iso }
function addDaysISO(iso: string, days: number) {
  const [Y, M, D] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(Y, M - 1, D + days))
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt)
}
function weekdayEST(iso: string) {
  const [Y, M, D] = iso.split('-').map(Number)
  const utc = new Date(Date.UTC(Y, M - 1, D))
  const local = new Date(utc.toLocaleString('en-US', { timeZone: TZ }))
  return local.getDay() // 0..6 (Sun..Sat)
}
function nextWeekdayISO(iso: string, targetDow: number) {
  let cur = iso
  for (let i = 0; i < 7; i++) { if (weekdayEST(cur) === targetDow) return cur; cur = addDaysISO(cur, 1) }
  return cur
}
// cutoff: today + 21 days, snapped to next Thursday (Sun=0 → Thu=4)
function commitmentStartISO() { return nextWeekdayISO(addDaysISO(todayISO(), 21), 4) }
function assertMonth(ym?: string | null) {
  const re = /^\d{4}-(0[1-9]|1[0-2])$/
  if (ym && re.test(ym)) return ym
  const t = fmtTz(new Date()); return `${t.y}-${t.m}`
}
function daysInMonth(ym: string) { const [Y, M] = ym.split('-').map(Number); return new Date(Y, M, 0).getDate() }
function isoDay(ym: string, d: number) { return `${ym}-${String(d).padStart(2, '0')}` }

// ===== Domain =====
type Role = 'MR' | 'NMD' | 'EMT' | 'AEMT'
type Intent = '-' | 'P' | 'A' | 'S'
const UNITS = ['120', '121', '131'] as const
const TRUCK_SHIFTS = ['Day', 'Night'] as const
const AMPM_SHIFTS = ['AM', 'PM'] as const
const SENTINEL_UNIT = 'ALL'
const isType3 = (u: string) => u === '121' || u === '131'

// ===== App =====
const app = new Hono<{ Bindings: Env }>()

// ===== Probes =====
app.get('/__who', (c) => c.text('LIVE: src/index.ts'))
app.get('/api/health', async (c) => {
  try {
    const probe = await c.env.DB.prepare('select 1 as ok').first()
    return c.json({ ok: true, db: probe ? 'up' : 'down', tz: TZ, today: todayISO(), cutoff: commitmentStartISO() })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ===== CSV utils =====
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let i = 0, field = '', row: string[] = [], inQuotes = false
  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { rows.push(row); row = [] }
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    } else {
      if (ch === '"') { inQuotes = true; i++; continue }
      if (ch === ',') { pushField(); i++; continue }
      if (ch === '\r') { i++; continue }
      if (ch === '\n') { pushField(); pushRow(); i++; continue }
      field += ch; i++; continue
    }
  }
  pushField(); if (row.length) pushRow()
  if (rows.length && rows[0].length) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '')
  return rows
}
const tokenOK = (c: any) => {
  const t = c.req.query('token') || c.req.header('x-import-token')
  return t && t === (c.env.IMPORT_TOKEN || '')
}

// ===== IMPORT: Members =====
app.post('/admin/import/members', async (c) => {
  if (!tokenOK(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  try {
    const csv = await c.req.text()
    const rows = parseCSV(csv)
    const [h, ...data] = rows
    const headIndex = (aliases: string[]) => (h || []).findIndex(x => aliases.some(a => (x || '').trim().toLowerCase() === a))
    const asBool = (v: any) => ['1', 'true', 't', 'yes', 'y'].includes(String(v ?? '').trim().toLowerCase()) ? 1 : 0
    const normRole = (v: string | null) => {
      const s = String(v || '').trim().toUpperCase()
      return (['MR', 'NMD', 'EMT', 'AEMT'] as const).includes(s as any) ? (s as Role) : null
    }

    const iName = headIndex(['name', 'full_name', 'full name'])
    if (iName < 0) return c.json({ ok: false, error: 'CSV must include header "name" (or full_name)' }, 400)
    const iRole = headIndex(['role', 'cert_level', 'cert level'])
    const iEmail = headIndex(['email', 'e-mail'])
    const iPhone = headIndex(['phone', 'tel', 'telephone'])
    const iExt = headIndex(['external_id', 'external id', 'member_number', 'member number'])
    const iAdmin = headIndex(['is_admin', 'admin'])
    const iT3 = headIndex(['can_drive_type3', 'type3_driver', 'type 3 driver'])
    const iP24 = headIndex(['prefer_24h', 'prefer24', 'prefer 24h'])

    let upserted = 0, skipped = 0
    for (const r of data) {
      const name = (r[iName] || '').trim(); if (!name) { skipped++; continue }
      const role = iRole >= 0 ? normRole(r[iRole] || null) : null
      const email = iEmail >= 0 ? (r[iEmail] || '').trim() : null
      const phone = iPhone >= 0 ? (r[iPhone] || '').trim() : null
      const extId = iExt >= 0 ? (r[iExt] || '').trim() : null
      const is_admin = iAdmin >= 0 ? asBool(r[iAdmin]) : 0
      const can_drive_type3 = iT3 >= 0 ? asBool(r[iT3]) : 0
      const prefer_24h = iP24 >= 0 ? asBool(r[iP24]) : 0

      await c.env.DB.prepare(`
        INSERT INTO members (name, role, email, phone, external_id, is_admin, can_drive_type3, prefer_24h, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET
          role=COALESCE(excluded.role, role),
          email=COALESCE(excluded.email, email),
          phone=COALESCE(excluded.phone, phone),
          external_id=COALESCE(excluded.external_id, external_id),
          is_admin=excluded.is_admin,
          can_drive_type3=excluded.can_drive_type3,
          prefer_24h=excluded.prefer_24h,
          updated_at=datetime('now')
      `).bind(name, role, email, phone, extId, is_admin, can_drive_type3, prefer_24h).run()
      upserted++
    }
    return c.json({ ok: true, upserted, skipped })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ===== IMPORT: Calendar (assignments Day/Night + intents AM/PM) =====
app.post('/admin/import/calendar', async (c) => {
  if (!tokenOK(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  try {
    const csv = await c.req.text()
    const rows = parseCSV(csv)
    const [h, ...data] = rows
    const headIndex = (aliases: string[]) => (h || []).findIndex(x => aliases.some(a => (x || '').trim().toLowerCase() === a))

    const iDate = headIndex(['shift_date', 'date'])
    const iUnit = headIndex(['unit_code', 'unit', 'truck'])
    const iShift = headIndex(['shift_name', 'shift'])
    const iMName = headIndex(['member_name', 'assigned', 'staff', 'name'])
    const iMid = headIndex(['member_id', 'member id', 'id'])
    const iIntent = headIndex(['intent', 'status'])

    if (iDate < 0 || iUnit < 0 || iShift < 0)
      return c.json({ ok: false, error: 'CSV needs shift_date, unit_code, shift_name' }, 400)

    const resolveMember = async (name: string | null) => {
      if (!name) return null
      const q = await c.env.DB.prepare(`SELECT id FROM members WHERE lower(trim(name)) = lower(trim(?))`).bind(name).first<{ id: number }>()
      return q?.id ? String(q.id) : null
    }

    let upserted = 0, skipped = 0, missingMembers: string[] = []
    for (const r of data) {
      const d = (r[iDate] || '').trim()
      const u = (r[iUnit] || '').trim()
      const s = (r[iShift] || '').trim()
      if (!d || !u || !s) { skipped++; continue }

      let memberId = (iMid >= 0 && r[iMid]) ? String(r[iMid]).trim() : null
      const memberName = (iMName >= 0 && r[iMName]) ? String(r[iMName]).trim() : null
      if (!memberId && memberName) {
        memberId = await resolveMember(memberName)
        if (!memberId) missingMembers.push(memberName)
      }

      let intent = (iIntent >= 0 && r[iIntent]) ? String(r[iIntent]).trim() : null
      if (intent == null || intent === '') intent = '-' // satisfy NOT NULL DEFAULT '-'

      await c.env.DB.prepare(`
        INSERT INTO shifts (shift_date, unit_code, shift_name, member_id, intent, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(shift_date, unit_code, shift_name)
        DO UPDATE SET member_id=COALESCE(excluded.member_id, member_id),
                      intent=COALESCE(excluded.intent, intent),
                      updated_at=datetime('now')
      `).bind(d, u, s, memberId, intent).run()
      upserted++
    }
    return c.json({ ok: true, upserted, skipped, missingMembers })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ===== Data feeds =====
app.get('/api/members', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id,name,role,is_admin,can_drive_type3,prefer_24h FROM members ORDER BY name`
  ).all()
  return c.json({ ok: true, members: r.results ?? [] })
})

app.get('/api/wallboard', async (c) => {
  try {
    const month = assertMonth(c.req.query('month'))
    const start = `${month}-01`
    const dcount = daysInMonth(month)
    const end = isoDay(month, dcount)
    const cutoff = commitmentStartISO()

    // Day/Night assignments
    let rows: Array<{ shift_date: string; unit_code: string; shift_name: string; member_name: string | null }> = []
    try {
      const q = `
        SELECT s.shift_date, s.unit_code, s.shift_name, m.name AS member_name
        FROM shifts s
        LEFT JOIN members m ON m.id = s.member_id
        WHERE s.shift_date >= ? AND s.shift_date <= ?
          AND s.unit_code IN ('120','121','131')
          AND s.shift_name IN ('Day','Night')
        ORDER BY s.shift_date, s.unit_code, s.shift_name`
      const r = await c.env.DB.prepare(q).bind(start, end).all<typeof rows[0]>()
      rows = r.results ?? []
    } catch {
      const q = `
        SELECT shift_date, unit_code, shift_name, NULL AS member_name
        FROM shifts
        WHERE shift_date >= ? AND shift_date <= ?
          AND unit_code IN ('120','121','131')
          AND shift_name IN ('Day','Night')`
      const r = await c.env.DB.prepare(q).bind(start, end).all<typeof rows[0]>()
      rows = r.results ?? []
    }
    const assignments: Record<string, { member_name: string | null }> = {}
    for (const r of rows) assignments[`${r.shift_date}|${r.unit_code}|${r.shift_name}`] = { member_name: r.member_name }

    // AM/PM intents
    const ires = await c.env.DB.prepare(
      `SELECT shift_date, shift_name, intent
       FROM shifts
       WHERE shift_date >= ? AND shift_date <= ?
         AND unit_code = 'ALL'
         AND shift_name IN ('AM','PM')`
    ).bind(start, end).all<{ shift_date: string; shift_name: 'AM' | 'PM'; intent: string }>()
    const intents: Record<string, Intent> = {}
    for (const r of ires.results ?? []) intents[`${r.shift_date}|${r.shift_name}`] = (r.intent as Intent) ?? '-'

    return c.json({
      month, days: dcount, cutoff, today: todayISO(),
      trucks: UNITS, truckShifts: TRUCK_SHIFTS, ampmShifts: AMPM_SHIFTS,
      assignments, intents
    })
  } catch (err: any) {
    return c.json({ ok: false, error: String(err?.message ?? err) }, 500)
  }
})

// ===== Save intent (AM/PM) =====
app.post('/api/intent', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const key = String((body as any).key || '')
    const value = String((body as any).value || '')
    const user = (body as any).user ? String((body as any).user) : null

    if (!/^\d{4}-\d{2}-\d{2}\|(AM|PM)$/.test(key)) return c.json({ ok: false, error: 'Bad key' }, 400)
    if (!['-', 'P', 'A', 'S'].includes(value)) return c.json({ ok: false, error: 'Bad value' }, 400)

    const [shift_date, shift_name] = key.split('|')
    const cutoff = commitmentStartISO()
    if (shift_date < cutoff) return c.json({ ok: false, error: `Locked until ${cutoff}` }, 403)

    await c.env.DB.prepare(`
      INSERT INTO shifts (shift_date, unit_code, shift_name, intent, updated_by, updated_at)
      VALUES (?, 'ALL', ?, ?, ?, datetime('now'))
      ON CONFLICT(shift_date, unit_code, shift_name)
      DO UPDATE SET intent=excluded.intent,
                    updated_by=excluded.updated_by,
                    updated_at=datetime('now')
    `).bind(shift_date, shift_name, value, user).run()

    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ===== Assignment preview (read-only suggestion) =====
app.post('/api/assign/preview', async (c) => {
  try {
    const { date, prefer24First = false, avoid = [] } = await c.req.json()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return c.json({ ok: false, error: 'Bad date (YYYY-MM-DD)' }, 400)
    }

    // roster
    const mr = await c.env.DB.prepare(
      `SELECT id,name,role,can_drive_type3,prefer_24h FROM members`
    ).all<{ id: number; name: string; role: Role | null; can_drive_type3: number; prefer_24h: number }>()
    const members = (mr.results ?? []).map(m => ({ ...m, role: (m.role ?? 'NMD') as Role }))
    const avoidSet = new Set((avoid as any[]).map(v => String(v)))

    // intents today (AM/PM) + next-day AM (for PM→next-AM 24h)
    const nextDate = addDaysISO(String(date), 1)
    const baseQ = `
      SELECT s.shift_name, s.intent, m.id AS member_id, m.name, m.role, m.can_drive_type3, m.prefer_24h
      FROM shifts s JOIN members m ON 1=1
      WHERE s.unit_code='ALL'
    `
    const cur = await c.env.DB.prepare(baseQ + ` AND s.shift_date=? AND s.shift_name IN ('AM','PM')`)
      .bind(date).all<{ shift_name: 'AM' | 'PM'; intent: string; member_id: number; name: string; role: any; can_drive_type3: number; prefer_24h: number }>()
    const nxt = await c.env.DB.prepare(baseQ + ` AND s.shift_date=? AND s.shift_name='AM'`)
      .bind(nextDate).all<{ shift_name: 'AM'; intent: string; member_id: number; name: string; role: any; can_drive_type3: number; prefer_24h: number }>()

    const weight = (v: string) => v === 'P' ? 3 : v === 'A' ? 2 : v === 'S' ? 1 : 0
    const byAM = new Map<string, number>(), byPM = new Map<string, number>(), byNextAM = new Map<string, number>()
    for (const r of (cur.results ?? [])) (r.shift_name === 'AM' ? byAM : byPM).set(String(r.member_id), weight(r.intent || '-'))
    for (const r of (nxt.results ?? [])) byNextAM.set(String(r.member_id), weight(r.intent || '-'))

    const prefer24Eligible = new Set<string>()
    if (prefer24First) for (const id of byPM.keys())
      if ((byAM.get(id) ?? 0) > 0 || (byNextAM.get(id) ?? 0) > 0) prefer24Eligible.add(id)

    const score = (m: any) => {
      const amW = byAM.get(String(m.id)) ?? 0
      const pmW = byPM.get(String(m.id)) ?? 0
      const base = Math.max(amW, pmW)
      const bonus = (prefer24First && m.prefer_24h === 1 && prefer24Eligible.has(String(m.id))) ? 100 : 0
      return base + bonus
    }

    function choose(unit: '120' | '121' | '131') {
      const usable = members.filter(m => !avoidSet.has(String(m.id))).sort((a, b) => score(b) - score(a))
      const aemt = usable.filter(m => m.role === 'AEMT')
      const emt = usable.filter(m => m.role === 'EMT')
      const attendant = (aemt[0] ?? emt[0]) ?? null
      if (!attendant) return { driver: null, attendant: null, note: `No attendant for ${unit}` }
      const rest = usable.filter(m => m.id !== attendant.id)
      const driver = isType3(unit) ? (rest.find(m => m.can_drive_type3 === 1) ?? null) : (rest[0] ?? null)
      return { driver, attendant }
    }

    const proposals = (['120', '121', '131'] as const).map(u => ({ unit: u, Day: choose(u), Night: choose(u) }))
    return c.json({ ok: true, date, proposals })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ===== HTML UI =====
app.get('/', (c) => c.redirect('/wallboard.html', 302))
app.get('/wallboard.html', (c) => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ADR FR — Wallboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b1220;color:#e6edf3;margin:0;padding:16px}
h1{margin:0 0 8px 0}
.card{background:#111a2e;border:1px solid #24304c;border-radius:12px;padding:12px;margin-top:16px}
.note{font-size:12px;color:#a3afd1}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #24304c;padding:6px 8px;text-align:center}
th{background:#121a2b;position:sticky;top:0;z-index:1}
.today{background:#20325a}
.btn{background:#121a2b;color:#e6edf3;border:1px solid #24304c;border-radius:8px;padding:4px 8px;cursor:pointer}
.small{font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid #24304c;background:#1b2440;color:#e6edf3;cursor:pointer}
pre{background:#0002;padding:10px;border-radius:8px;overflow:auto;white-space:pre-wrap}
#previewOut{max-height:320px;overflow:auto}
#previewBtn[disabled]{opacity:.6;cursor:progress}
</style>
</head>
<body>
<h1>Wallboard</h1>
<div id="meta">Loading…</div>
<div id="err" style="color:#f39b9b"></div>

<div class="card">
  <h3>Truck Assignments (read-only before cutoff)</h3>
  <table id="truck"></table>

  <h3>AM / PM Intents (editable dates only)</h3>
  <table id="ampm"></table>
</div>

<div class="card" id="assignTools">
  <h3>Special selection considerations</h3>
  <label><input type="checkbox" id="prefer24"> Prefer 24-hr first</label>
  <div class="note">Counts AM+PM same day, or PM→next-day AM, only if member has “Prefer 24-hr”.</div>
  <h4 style="margin-top:10px">Avoid shifts with:</h4>
  <ul id="avoidList" style="max-height:200px;overflow:auto;padding-left:0"></ul>
  <button class="small" id="previewBtn">Preview Assignments</button>
  <div class="note" id="previewNote"></div>
  <pre id="previewOut"></pre>
</div>

<script>
(async()=>{
  const meta=document.getElementById('meta');
  const err=document.getElementById('err');
  const T=document.getElementById('truck');
  const A=document.getElementById('ampm');

  const ym=new Date().toISOString().slice(0,7);
  const url='/api/wallboard?month='+ym;
  const res=await fetch(url,{cache:'no-store'});
  if(!res.ok){
    meta.textContent='';
    err.textContent='Failed to load wallboard ('+res.status+').';
    return;
  }
  const data=await res.json();
  meta.textContent='Month '+data.month+' — Today '+data.today+' — Cutoff '+data.cutoff;

  // ===== Trucks (pre-cutoff only) =====
  T.innerHTML='';
  const head=document.createElement('tr');
  head.innerHTML='<th>Date</th>'+data.trucks.map(u=>'<th>'+u+' Day</th><th>'+u+' Night</th>').join('');
  T.appendChild(head);
  for(let i=1;i<=data.days;i++){
    const iso=data.month+'-'+String(i).padStart(2,'0');
    if(iso>=data.cutoff) continue; // hide on/after cutoff
    const tr=document.createElement('tr');
    if(iso===data.today) tr.classList.add('today');
    tr.innerHTML='<td>'+iso+'</td>'+data.trucks.map(u=>{
      const k1=iso+'|'+u+'|Day', k2=iso+'|'+u+'|Night';
      const v1=(data.assignments[k1]&&data.assignments[k1].member_name)||'—';
      const v2=(data.assignments[k2]&&data.assignments[k2].member_name)||'—';
      return '<td>'+v1+'</td><td>'+v2+'</td>';
    }).join('');
    T.appendChild(tr);
  }

  // ===== AM/PM (editable only, starts at cutoff) =====
  A.innerHTML='';
  const cutoffMonth=data.cutoff.slice(0,7);
  let startDay=1;
  if(data.month===cutoffMonth) startDay=parseInt(data.cutoff.slice(8,10),10);
  else if(data.month<cutoffMonth) startDay=data.days+1;
  if(startDay>data.days){
    A.innerHTML='<tr><td style="padding:8px;color:#a3afd1">No editable dates in this month.</td></tr>';
  }else{
    const h2=document.createElement('tr');
    h2.innerHTML='<th>Shift</th>'+Array.from({length:data.days-startDay+1},(_,i)=>'<th>'+String(startDay+i).padStart(2,'0')+'</th>').join('');
    A.appendChild(h2);

    const cycle=v=>v==='-'?'P':v==='P'?'A':v==='A'?'S':'-';
    for(const s of (data.ampmShifts||['AM','PM'])){
      const tr=document.createElement('tr'); tr.innerHTML='<th>'+s+'</th>';
      for(let i=startDay;i<=data.days;i++){
        const iso=data.month+'-'+String(i).padStart(2,'0');
        const td=document.createElement('td'); if(iso===data.today) td.classList.add('today');
        const key=iso+'|'+s;
        const btn=document.createElement('button'); btn.className='btn'; btn.textContent=data.intents[key]||'-';
        btn.onclick=async()=>{
          const next=cycle(btn.textContent); btn.textContent=next;
          try{
            await fetch('/api/intent', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ key, value: next }) });
          }catch(e){}
        };
        td.appendChild(btn); tr.appendChild(td);
      }
      A.appendChild(tr);
    }
  }

  // ===== Assignment Preview wiring (robust + no double-click) =====
  const avoidList  = document.getElementById('avoidList');
  const prefer24   = document.getElementById('prefer24');
  const previewBtn = document.getElementById('previewBtn');
  const previewOut = document.getElementById('previewOut');
  const previewNote= document.getElementById('previewNote');

  (async()=>{
    const r=await fetch('/api/members');
    const j=r.ok?await r.json():{members:[]};
    (j.members||[]).forEach(m=>{
      const id='m_'+m.id;
      const li=document.createElement('li');
      li.style.listStyle='none';
      li.innerHTML =
        '<input type="checkbox" id="'+id+'"> '+
        '<label for="'+id+'" style="cursor:pointer">'+
        m.name+' <span class="note">('+(m.role||'')+(m.can_drive_type3?', T3':'')+(m.prefer_24h?', 24h':'')+')</span></label>';
      avoidList.appendChild(li);
    });
  })();

  function firstEditableISO(){
    const cm = data.cutoff.slice(0,7);
    let start = 1;
    if(data.month===cm) start = parseInt(data.cutoff.slice(8,10),10);
    else if(data.month<cm) start = data.days + 1;
    const day = Math.min(start, data.days);
    return data.month+'-'+String(day).padStart(2,'0');
  }

  previewBtn.onclick = async ()=>{
    if (previewBtn.disabled) return;
    previewBtn.disabled = true;
    previewNote.textContent = 'Working…';
    previewOut.textContent = '';

    const date = firstEditableISO();
    const avoid = Array.from(avoidList.querySelectorAll('input[type="checkbox"]:checked')).map(cb=>cb.id.replace('m_',''));
    const body = { date, prefer24First: !!prefer24.checked, avoid };

    try{
      const res = await fetch('/api/assign/preview', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      const raw = await res.text();
      if(!res.ok){
        previewNote.textContent = 'Preview error: '+res.status;
        previewOut.textContent = raw;
        return;
      }
      try{
        const out = JSON.parse(raw);
        previewNote.textContent = out.ok ? 'Preview ready.' : ('Preview error: ' + (out.error || 'unknown'));
        previewOut.textContent = JSON.stringify(out, null, 2);
      }catch{
        previewNote.textContent = 'Preview returned non-JSON (showing raw):';
        previewOut.textContent = raw;
      }
    }catch(e){
      previewNote.textContent = 'Network error: ' + e;
    }finally{
      previewBtn.disabled = false;
    }
  };
})();
<\/script>
</body>
</html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
})

export default app
