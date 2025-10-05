// src/index.ts — ADR-FR Hybrid Wallboard v11 (full UI + data routes)
import { Hono } from 'hono'

type Env = { DB: D1Database }

// ============ Time helpers (America/New_York) ============
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
  // Create a Date for the given day at midnight UTC
  const utc = new Date(Date.UTC(Y, M - 1, D))
  // Convert to the same wall clock in Eastern time
  const offsetMs = utc.getTime() - new Date(utc.toLocaleString('en-US', { timeZone: TZ })).getTime()
  const local = new Date(utc.getTime() - offsetMs)
  // Return 0 (Sunday)–6 (Saturday)
  return local.getDay()
}
function nextWeekdayISO(iso: string, targetDow: number) {
  let cur = iso
  for (let i = 0; i < 7; i++) {
    if (weekdayEST(cur) === targetDow) return cur
    cur = addDaysISO(cur, 1)
  }
  return cur
}
function commitmentStartISO() { return nextWeekdayISO(addDaysISO(todayISO(), 21), 4) }
function isBefore(a: string, b: string) { return a < b }
function assertMonth(ym?: string | null) {
  const re = /^\d{4}-(0[1-9]|1[0-2])$/
  if (ym && re.test(ym)) return ym
  const t = fmtTz(new Date())
  return `${t.y}-${t.m}`
}
function daysInMonth(ym: string) {
  const [Y, M] = ym.split('-').map((x) => parseInt(x, 10))
  return new Date(Y, M, 0).getDate()
}
function isoDay(ym: string, d: number) { return `${ym}-${String(d).padStart(2, '0')}` }

// ============ Constants ============
type Intent = '-' | 'P' | 'A' | 'S'
const UNITS = ['120', '121', '131'] as const
const TRUCK_SHIFTS = ['Day', 'Night'] as const
const AMPM_SHIFTS = ['AM', 'PM'] as const
const SENTINEL_UNIT = 'ALL'

const app = new Hono<{ Bindings: Env }>()

// ============ Basic routes ============
app.get('/__who', (c) =>
  c.text('LIVE: src/index.ts (truck assignments before cutoff; AM/PM intents after)')
)

app.get('/api/health', async (c) => {
  try {
    const probe = await c.env.DB.prepare('select 1 as ok').first()
    return c.json({ ok: true, db: probe ? 'up' : 'down', tz: TZ, today: todayISO(), commitment_start: commitmentStartISO() })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ============ CSV import security ============
function requireToken(c: any) {
  const token = c.req.query('token') || c.req.header('x-import-token')
  const ok = token && token === (c.env as any).IMPORT_TOKEN
  return ok
}
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

// ============ CSV import endpoints ============
app.post('/admin/import/members', async (c) => {
  if (!requireToken(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  const text = await c.req.text()
  const rows = parseCSV(text)
  return c.json({ ok: true, rows: rows.length })
})
app.post('/admin/import/calendar', async (c) => {
  if (!requireToken(c)) return c.json({ ok: false, error: 'unauthorized' }, 401)
  const text = await c.req.text()
  const rows = parseCSV(text)
  return c.json({ ok: true, rows: rows.length })
})

// ============ API: WALLBOARD DATA ============
// Serve the live wallboard (inline HTML; no filesystem needed)
app.get('/', (c) => c.redirect('/wallboard.html', 302))

app.get('/wallboard.html', (c) => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ADR-FR — Live Wallboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;background:#0b1220;color:#e6edf3;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  header{padding:14px 16px;background:#121a2b;border-bottom:1px solid #24304c}
  h1{margin:0;font-size:22px}
  #meta{padding:10px 16px;color:#a3afd1;font-size:14px}
  .wrap{padding:0 16px 16px}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{border:1px solid #24304c;padding:6px 8px;text-align:center}
  th{background:#121a2b;position:sticky;top:0;z-index:1}
  .locked{background:#131a2a;color:#8892b0}
  .today{background:#20325a}
  .grid{overflow:auto;max-height:80vh;border:1px solid #24304c;border-radius:8px}
  .pill{display:inline-block;padding:2px 6px;border:1px solid #24304c;border-radius:999px;color:#a3afd1;font-size:12px;margin-left:6px}
</style>
</head>
<body>
<header><h1>ADR-FR Wallboard</h1></header>
<div id="meta">Loading…</div>
<div class="wrap">
  <div class="grid"><table id="truckTable"></table></div>
  <div style="height:10px"></div>
  <div class="grid"><table id="ampmTable"></table></div>
</div>

<script>
(async function(){
  const ym = new Date().toISOString().slice(0,7);
  const res = await fetch('/api/wallboard?month='+ym, {cache:'no-store'});
  if(!res.ok){ document.getElementById('meta').textContent = 'Failed to load wallboard ('+res.status+')'; return; }
  const d = await res.json();

  // meta
  document.getElementById('meta').textContent =
    'Month: '+d.month+'  |  Today: '+d.today+'  |  Cutoff: '+d.cutoff+'  |  Units: '+d.trucks.join(', ');

  // ----- TRUCK ASSIGNMENTS TABLE (read-only before cutoff) -----
  const tt = document.getElementById('truckTable');
  const head1 = document.createElement('tr');
  head1.innerHTML = '<th>Date</th>'+ d.trucks.map(u=>'<th>'+u+' Day</th><th>'+u+' Night</th>').join('');
  tt.appendChild(head1);

  for(let i=1;i<=d.days;i++){
    const iso = d.month + '-' + String(i).padStart(2,'0');
    const tr = document.createElement('tr');
    if(iso === d.today) tr.classList.add('today');
    if(iso < d.cutoff) tr.classList.add('locked');
    const tdDate = document.createElement('td');
    tdDate.textContent = iso;
    tr.appendChild(tdDate);

    for(const u of d.trucks){
      const kDay = iso+'|'+u+'|Day';
      const kNight = iso+'|'+u+'|Night';
      const dayName = (d.assignments[kDay] && d.assignments[kDay].member_name) || '—';
      const nightName = (d.assignments[kNight] && d.assignments[kNight].member_name) || '—';
      const td1 = document.createElement('td'); td1.textContent = dayName; tr.appendChild(td1);
      const td2 = document.createElement('td'); td2.textContent = nightName; tr.appendChild(td2);
    }
    tt.appendChild(tr);
  }

  // ----- AM/PM INTENTS TABLE (editable only on/after cutoff) -----
  const at = document.getElementById('ampmTable');
  const head2 = document.createElement('tr');
  head2.innerHTML = '<th>AM / PM</th>' + Array.from({length:d.days},(_,i)=>'<th>'+String(i+1).padStart(2,'0')+'</th>').join('');
  at.appendChild(head2);

  const shifts = d.ampmShifts || ['AM','PM'];
  const cycle = v => (v==='-'?'P': v==='P'?'A': v==='A'?'S':'-');

  for(const s of shifts){
    const tr = document.createElement('tr');
    const th = document.createElement('th'); th.textContent = s; tr.appendChild(th);

    for(let i=1;i<=d.days;i++){
      const iso = d.month + '-' + String(i).padStart(2,'0');
      const td = document.createElement('td');
      if(iso === d.today) td.classList.add('today');
      if(iso < d.cutoff) td.classList.add('locked');

      const key = iso+'|'+s;
      const btn = document.createElement('button');
      btn.textContent = d.intents[key] || '-';
      btn.style.cssText = 'background:#121a2b;color:#e6edf3;border:1px solid #24304c;border-radius:8px;padding:4px 8px;cursor:pointer;';
      if(iso < d.cutoff){ btn.disabled = true; btn.style.opacity = 0.5; }

      btn.addEventListener('click', async ()=>{
        const next = cycle(btn.textContent);
        btn.textContent = next;
        try{
          const r = await fetch('/api/intent', {
            method:'POST', headers:{'content-type':'application/json'},
            body: JSON.stringify({ key, value: next })
          });
          await r.json(); // ignore result; simple optimistic update
        }catch(e){}
      });

      td.appendChild(btn);
      tr.appendChild(td);
    }

    at.appendChild(tr);
  }
})();
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0'
    }
  })
})

export default app
