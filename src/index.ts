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
app.get('/wallboard.html', (c) => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ADR FR — Live Wallboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{background:#0b1220;color:#e6edf3;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:20px}
h1{margin:0 0 10px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #24304c;padding:6px;text-align:center;min-width:60px}
th{background:#121a2b;position:sticky;top:0}
.locked{background:#131a2a}
.today{background:#20325a}
.P{background:#1fbf6a;color:#000}
.A{background:#86d18f;color:#000}
.S{background:#f0b44c;color:#000}
.-{background:#d14b4b;color:#fff}
.bubble{width:12px;height:12px;border-radius:50%;border:1px solid #aaa;display:inline-block;margin-left:4px}
.filled{background:#86d18f;border-color:#86d18f}
</style>
</head>
<body>
<h1>ADR-FR Wallboard</h1>
<div id="meta"></div>
<table id="grid"></table>
<script>
async function load(){
  const r=await fetch('/api/wallboard?month=${new Date().toISOString().slice(0,7)}');
  const j=await r.json();
  document.getElementById('meta').textContent='Month '+j.month+' | Today '+j.today+' | Cutoff '+j.cutoff;
  const t=document.getElementById('grid');
  const header=['Shift'].concat(Array.from({length:j.days},(_,i)=>String(i+1).padStart(2,'0')));
  const trh=document.createElement('tr');
  for(const h of header){const th=document.createElement('th');th.textContent=h;trh.appendChild(th)}
  t.appendChild(trh);
  const shifts=j.ampmShifts;
  for(const s of shifts){
    const tr=document.createElement('tr');
    const th=document.createElement('th');th.textContent=s;tr.appendChild(th);
    for(let d=1;d<=j.days;d++){
      const iso=j.month+'-'+String(d).padStart(2,'0');
      const td=document.createElement('td');
      if(iso===j.today)td.classList.add('today');
      if(iso<j.cutoff)td.classList.add('locked');
      const btn=document.createElement('button');
      btn.textContent=j.intents[iso+'|'+s]||'-';
      btn.className=btn.textContent;
      const bubble=document.createElement('span');bubble.className='bubble'+(btn.textContent!=='-'?' filled':'');
      btn.onclick=()=>{
        if(iso<j.cutoff)return;
        const order=['-','P','A','S'];let idx=order.indexOf(btn.textContent);btn.textContent=order[(idx+1)%4];
        btn.className=btn.textContent;
        fetch('/api/intent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:iso+'|'+s,value:btn.textContent})});
        if(btn.textContent==='-')bubble.classList.remove('filled');else bubble.classList.add('filled');
      };
      td.appendChild(btn);td.appendChild(bubble);tr.appendChild(td);
    }
    t.appendChild(tr);
  }
}
load();
</script>
</body></html>`;
  return new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});
});

export default app
