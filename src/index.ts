// src/index.ts — ADR-FR Wallboard (full API + HTML + CSV imports)
import { Hono } from 'hono'

type Env = { DB: D1Database }

// ---------- Time helpers (America/New_York) ----------
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
// 0=Sun..6=Sat in Eastern time
function weekdayEST(iso: string) {
  const [Y, M, D] = iso.split('-').map(Number)
  const utc = new Date(Date.UTC(Y, M - 1, D))
  const localMs = new Date(utc.toLocaleString('en-US', { timeZone: TZ })).getTime()
  const offset = utc.getTime() - localMs
  const local = new Date(utc.getTime() - offset)
  return local.getDay()
}
function nextWeekdayISO(iso: string, targetDow: number) {
  let cur = iso
  for (let i = 0; i < 7; i++) { if (weekdayEST(cur) === targetDow) return cur; cur = addDaysISO(cur, 1) }
  return cur
}
// 3 weeks + next Thursday (Sun=0 → Thu=4)
function commitmentStartISO() { return nextWeekdayISO(addDaysISO(todayISO(), 21), 4) }
function assertMonth(ym?: string | null) {
  const re = /^\d{4}-(0[1-9]|1[0-2])$/
  if (ym && re.test(ym)) return ym
  const t = fmtTz(new Date()); return `${t.y}-${t.m}`
}
function daysInMonth(ym: string) { const [Y, M] = ym.split('-').map(Number); return new Date(Y, M, 0).getDate() }
function isoDay(ym: string, d: number) { return `${ym}-${String(d).padStart(2, '0')}` }

// ---------- Domain ----------
type Intent = '-' | 'P' | 'A' | 'S'
const UNITS = ['120', '121', '131'] as const
const TRUCK_SHIFTS = ['Day', 'Night'] as const
const AMPM_SHIFTS = ['AM', 'PM'] as const
const SENTINEL_UNIT = 'ALL'

const app = new Hono<{ Bindings: Env }>()

// ---------- Probes ----------
app.get('/__who', (c) => c.json({ entry: 'src/index.ts', now: new Date().toISOString() }))
app.get('/api/health', async (c) => {
  try {
    const probe = await c.env.DB.prepare('select 1 as ok').first()
    return c.json({ ok: true, db: probe ? 'up' : 'down', tz: TZ, today: todayISO(), cutoff: commitmentStartISO() })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ---------- CSV utils ----------
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
function tokenOK(c: any) {
  const token = c.req.query('token') || c.req.header('x-import-token')
  return token && token === (c.env as any).IMPORT_TOKEN
}

// ---------- IMPORT: Members ----------
app.post('/admin/import/members', async (c) => {
  if (!tokenOK(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  const csv = await c.req.text()
  const rows = parseCSV(csv)
  const [h, ...data] = rows
  const idx = (k: string) => (h || []).findIndex(x => (x || '').trim().toLowerCase() === k)
  const iName = idx('name'), iRole = idx('role'), iEmail = idx('email'), iPhone = idx('phone'), iExt = idx('external_id')
  if (iName < 0) return c.json({ ok: false, error: 'CSV must include header "name"' }, 400)
  let upserted = 0, skipped = 0
  for (const r of data) {
    const name = (r[iName] || '').trim()
    if (!name) { skipped++; continue }
    const role = (iRole >= 0 ? (r[iRole] || '').trim() : null)
    const email = (iEmail >= 0 ? (r[iEmail] || '').trim() : null)
    const phone = (iPhone >= 0 ? (r[iPhone] || '').trim() : null)
    const extId = (iExt >= 0 ? (r[iExt] || '').trim() : null)
    await c.env.DB.prepare(`
      INSERT INTO members (name, role, email, phone, external_id, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name)
      DO UPDATE SET role=COALESCE(excluded.role, role),
                    email=COALESCE(excluded.email, email),
                    phone=COALESCE(excluded.phone, phone),
                    external_id=COALESCE(excluded.external_id, external_id),
                    updated_at=datetime('now')
    `).bind(name, role, email, phone, extId).run()
    upserted++
  }
  return c.json({ ok: true, upserted, skipped })
})

// ---------- IMPORT: Calendar (assignments + intents) ----------
app.post('/admin/import/calendar', async (c) => {
  if (!tokenOK(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  const csv = await c.req.text()
  const rows = parseCSV(csv)
  const [h, ...data] = rows
  const idx = (k: string) => (h || []).findIndex(x => (x || '').trim().toLowerCase() === k)
  const iDate = idx('shift_date')
  const iUnit = idx('unit_code')
  const iShift = idx('shift_name')
  const iMName = idx('member_name')
  const iMid = idx('member_id')
  const iIntent = idx('intent')
  if (iDate < 0 || iUnit < 0 || iShift < 0) {
    return c.json({ ok: false, error: 'CSV needs shift_date, unit_code, shift_name' }, 400)
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
      const q = await c.env.DB.prepare(`SELECT id FROM members WHERE name = ?`).bind(memberName).first<{ id: number }>()
      if (q?.id) memberId = String(q.id); else missingMembers.push(memberName)
    }
    const intent = (iIntent >= 0 && r[iIntent]) ? String(r[iIntent]).trim() : null

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
})

// ---------- API: Wallboard data ----------
// ---------- HTML UI (robust, with diagnostics + editable-only AM/PM) ----------
app.get('/wallboard.html', (c) => {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ADR-FR — Live Wallboard</title>
<style>
body{margin:0;background:#0b1220;color:#e6edf3;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
header{padding:14px 16px;background:#121a2b;border-bottom:1px solid #24304c}
h1{margin:0;font-size:22px}
#meta{padding:10px 16px;color:#a3afd1;font-size:14px}
.grid{padding:0 16px 16px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #24304c;padding:6px 8px;text-align:center}
th{background:#121a2b;position:sticky;top:0;z-index:1}
.locked{background:#131a2a;color:#8892b0}
.today{background:#20325a}
.btn{background:#121a2b;color:#e6edf3;border:1px solid #24304c;border-radius:8px;padding:4px 8px;cursor:pointer}
.btn:disabled{opacity:.5;cursor:not-allowed}
#err{margin:10px 16px;color:#f39b9b}
#raw{display:none;margin:12px 16px 0;background:#121a2b;color:#86d18f;padding:10px;border-radius:8px;white-space:pre;overflow:auto;max-height:35vh}
.controls{padding:0 16px 12px;display:flex;gap:8px;align-items:center}
button.small{font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid #24304c;background:#1b2440;color:#e6edf3;cursor:pointer}
</style></head>
<body>
<header><h1>ADR-FR Wallboard</h1></header>
<div id="meta">Loading…</div>
<div id="err"></div>
<div class="controls">
  <button id="reload" class="small">Reload</button>
  <button id="toggleRaw" class="small">Show raw data</button>
</div>
<pre id="raw"></pre>
<div class="grid"><h3>Truck Assignments (read-only before cutoff)</h3><table id="truck"></table></div>
<div class="grid"><h3>AM / PM Intents (editable dates only)</h3><table id="ampm"></table></div>

<script>
(async function boot(){
  const meta = document.getElementById('meta');
  const err = document.getElementById('err');
  const raw = document.getElementById('raw');
  const btnReload = document.getElementById('reload');
  const btnRaw = document.getElementById('toggleRaw');

  btnReload.onclick = () => location.reload();
  btnRaw.onclick = () => { raw.style.display = raw.style.display==='none'?'block':'none'; btnRaw.textContent = (raw.style.display==='none'?'Show':'Hide')+' raw data' };

  try {
    const ym = new Date().toISOString().slice(0,7);
    const url = '/api/wallboard?month='+ym;
    const res = await fetch(url, { cache:'no-store' });
    if (!res.ok) {
      meta.textContent = '';
      err.textContent = 'Failed to load wallboard ('+res.status+').';
      return;
    }
    const d = await res.json();
    raw.textContent = JSON.stringify(d, null, 2);
    meta.textContent = 'Month '+d.month+'  |  Today '+d.today+'  |  Cutoff '+d.cutoff;

    // ---- TRUCKS (read-only) ----
    const T=document.getElementById('truck');
    T.innerHTML='';
    const thead=document.createElement('tr');
    thead.innerHTML='<th>Date</th>'+d.trucks.map(u=>'<th>'+u+' Day</th><th>'+u+' Night</th>').join('');
    T.appendChild(thead);

    for(let i=1;i<=d.days;i++){
      const iso=d.month+'-'+String(i).padStart(2,'0');
      const tr=document.createElement('tr');
      if(iso===d.today) tr.classList.add('today');
      if(iso<d.cutoff) tr.classList.add('locked');
      tr.innerHTML='<td>'+iso+'</td>' + d.trucks.map(u=>{
        const k1=iso+'|'+u+'|Day', k2=iso+'|'+u+'|Night';
        const v1=(d.assignments[k1]&&d.assignments[k1].member_name)||'—';
        const v2=(d.assignments[k2]&&d.assignments[k2].member_name)||'—';
        return '<td>'+v1+'</td><td>'+v2+'</td>';
      }).join('');
      T.appendChild(tr);
    }

    // ---- AM/PM (editable-only columns) ----
    const A=document.getElementById('ampm');
    A.innerHTML='';
    const cycle=v=>v==='-'?'P':v==='P'?'A':v==='A'?'S':'-';

    // find first editable day for this month
    const cutoffMonth=d.cutoff.slice(0,7);
    let startDay=1;
    if (d.month===cutoffMonth) startDay=parseInt(d.cutoff.slice(8,10),10);
    else if (d.month<cutoffMonth) startDay=d.days+1; // nothing editable
    else startDay=1;

    if (startDay>d.days) {
      const msg=document.createElement('tr');
      msg.innerHTML='<td style="padding:10px;color:#a3afd1">No editable dates in this month.</td>';
      A.appendChild(msg);
      return;
    }

    const h2=document.createElement('tr');
    h2.innerHTML='<th>Shift</th>'+Array.from({length:d.days-startDay+1},(_,i)=>'<th>'+String(startDay+i).padStart(2,'0')+'</th>').join('');
    A.appendChild(h2);

    for (const s of (d.ampmShifts||['AM','PM'])) {
      const tr=document.createElement('tr'); tr.innerHTML='<th>'+s+'</th>';
      for(let i=startDay;i<=d.days;i++){
        const iso=d.month+'-'+String(i).padStart(2,'0');
        const td=document.createElement('td');
        if(iso===d.today) td.classList.add('today'); // pre-cutoff excluded by startDay

        const key=iso+'|'+s;
        const btn=document.createElement('button');
        btn.className='btn'; btn.textContent=d.intents[key]||'-';

        btn.onclick=async ()=>{
          const next=cycle(btn.textContent); btn.textContent=next;
          try {
            await fetch('/api/intent', {
              method:'POST',
              headers:{'content-type':'application/json'},
              body: JSON.stringify({ key, value: next })
            });
          } catch (_) {}
        };

        td.appendChild(btn); tr.appendChild(td);
      }
      A.appendChild(tr);
    }
  } catch (e) {
    document.getElementById('meta').textContent='';
    document.getElementById('err').textContent='Script error: '+(e&&e.message?e.message:String(e));
  }
})();
</script>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
})


export default app
