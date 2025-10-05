// src/index.ts — minimal, working wallboard (API + HTML in one file)
import { Hono } from 'hono'

type Env = { DB: D1Database }

// ---------- Time / month helpers (America/New_York) ----------
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
  // 0=Sun..6=Sat *in Eastern time*
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
function commitmentStartISO() { return nextWeekdayISO(addDaysISO(todayISO(), 21), 4) } // 3w + Thu
function assertMonth(ym?: string | null) {
  const re = /^\d{4}-(0[1-9]|1[0-2])$/
  if (ym && re.test(ym)) return ym
  const t = fmtTz(new Date()); return `${t.y}-${t.m}`
}
function daysInMonth(ym: string) { const [Y, M] = ym.split('-').map(Number); return new Date(Y, M, 0).getDate() }
function isoDay(ym: string, d: number) { return `${ym}-${String(d).padStart(2, '0')}` }

// ---------- constants ----------
type Intent = '-' | 'P' | 'A' | 'S'
const UNITS = ['120', '121', '131'] as const
const TRUCK_SHIFTS = ['Day', 'Night'] as const
const AMPM_SHIFTS = ['AM', 'PM'] as const
const SENTINEL_UNIT = 'ALL'

const app = new Hono<{ Bindings: Env }>()

// ---------- probes ----------
app.get('/__who', (c) => c.json({ entry: 'src/index.ts', now: new Date().toISOString() }))
app.get('/api/health', async (c) => {
  try {
    const probe = await c.env.DB.prepare('select 1 as ok').first()
    return c.json({ ok: true, db: probe ? 'up' : 'down', tz: TZ, today: todayISO(), cutoff: commitmentStartISO() })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ---------- API: wallboard data ----------
app.get('/api/wallboard', async (c) => {
  try {
    const month = assertMonth(c.req.query('month'))
    const start = `${month}-01`
    const dcount = daysInMonth(month)
    const end = isoDay(month, dcount)
    const cutoff = commitmentStartISO()

    // Truck assignments (read-only zone)
    let rows: Array<{ shift_date: string; unit_code: string; shift_name: string; member_name: string | null }> = []
    try {
      const q = `
        SELECT s.shift_date, s.unit_code, s.shift_name, m.name AS member_name
        FROM shifts s
        LEFT JOIN members m ON m.id = s.member_id
        WHERE s.shift_date >= ? AND s.shift_date <= ?
          AND s.unit_code IN ('120','121','131')
          AND s.shift_name IN ('Day','Night')
      `
      const r = await c.env.DB.prepare(q).bind(start, end).all<typeof rows[0]>()
      rows = r.results ?? []
    } catch {
      const q2 = `
        SELECT shift_date, unit_code, shift_name, NULL AS member_name
        FROM shifts
        WHERE shift_date >= ? AND shift_date <= ?
          AND unit_code IN ('120','121','131')
          AND shift_name IN ('Day','Night')
      `
      const r2 = await c.env.DB.prepare(q2).bind(start, end).all<typeof rows[0]>()
      rows = r2.results ?? []
    }
    const assignments: Record<string, { member_name: string | null }> = {}
    for (const r of rows) assignments[`${r.shift_date}|${r.unit_code}|${r.shift_name}`] = { member_name: r.member_name }

    // AM/PM intents (editable zone)
    const ires = await c.env.DB.prepare(`
      SELECT shift_date, shift_name, intent
      FROM shifts
      WHERE shift_date >= ? AND shift_date <= ?
        AND unit_code = ?
        AND shift_name IN ('AM','PM')
    `).bind(start, end, SENTINEL_UNIT).all<{ shift_date: string; shift_name: string; intent: string }>()

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

// ---------- API: save intent (blocks before cutoff) ----------
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
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(shift_date, unit_code, shift_name)
      DO UPDATE SET intent=excluded.intent, updated_by=excluded.updated_by, updated_at=datetime('now')
    `).bind(shift_date, SENTINEL_UNIT, shift_name, value, user).run()

    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ---------- HTML: presentable wallboard ----------
app.get('/', (c) => c.redirect('/wallboard.html', 302))
app.get('/wallboard.html', (c) => {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ADR-FR — Live Wallboard</title>
<style>
body{margin:0;background:#0b1220;color:#e6edf3;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
header{padding:14px 16px;background:#121a2b;border-bottom:1px solid #24304c}
h1{margin:0;font-size:22px} #meta{padding:10px 16px;color:#a3afd1;font-size:14px}
.grid{padding:0 16px 16px} table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #24304c;padding:6px 8px;text-align:center}
th{background:#121a2b;position:sticky;top:0;z-index:1}
.locked{background:#131a2a;color:#8892b0} .today{background:#20325a}
.btn{background:#121a2b;color:#e6edf3;border:1px solid #24304c;border-radius:8px;padding:4px 8px;cursor:pointer}
.btn:disabled{opacity:.5;cursor:not-allowed}
</style></head>
<body>
<header><h1>ADR-FR Wallboard</h1></header>
<div id="meta">Loading…</div>
<div class="grid"><h3>Truck Assignments (read-only pre-cutoff)</h3><table id="truck"></table></div>
<div class="grid"><h3>AM / PM Intents (editable on/after cutoff)</h3><table id="ampm"></table></div>
<script>
(async function(){
  const ym = new Date().toISOString().slice(0,7)
  const res = await fetch('/api/wallboard?month='+ym, {cache:'no-store'})
  if(!res.ok){ document.getElementById('meta').textContent='Failed to load wallboard ('+res.status+')'; return }
  const d = await res.json()
  document.getElementById('meta').textContent = 'Month '+d.month+'  |  Today '+d.today+'  |  Cutoff '+d.cutoff

  // --- trucks table ---
  const T=document.getElementById('truck')
  const head=document.createElement('tr'); head.innerHTML='<th>Date</th>'+d.trucks.map(u=>'<th>'+u+' Day</th><th>'+u+' Night</th>').join(''); T.appendChild(head)
  for(let i=1;i<=d.days;i++){
    const iso=d.month+'-'+String(i).padStart(2,'0')
    const tr=document.createElement('tr'); if(iso===d.today) tr.classList.add('today'); if(iso<d.cutoff) tr.classList.add('locked')
    tr.innerHTML='<td>'+iso+'</td>'
      + d.trucks.map(u=>{
          const k1=iso+'|'+u+'|Day', k2=iso+'|'+u+'|Night'
          const v1=(d.assignments[k1]&&d.assignments[k1].member_name)||'—'
          const v2=(d.assignments[k2]&&d.assignments[k2].member_name)||'—'
          return '<td>'+v1+'</td><td>'+v2+'</td>'
        }).join('')
    T.appendChild(tr)
  }

  // --- am/pm table ---
  const cycle=v=>v==='-'?'P':v==='P'?'A':v==='A'?'S':'-'
  const A=document.getElementById('ampm')
  const h2=document.createElement('tr'); h2.innerHTML='<th>Shift</th>'+Array.from({length:d.days},(_,i)=>'<th>'+String(i+1).padStart(2,'0')+'</th>').join(''); A.appendChild(h2)

  for(const s of (d.ampmShifts||['AM','PM'])){
    const tr=document.createElement('tr'); tr.innerHTML='<th>'+s+'</th>'
    for(let i=1;i<=d.days;i++){
      const iso=d.month+'-'+String(i).padStart(2,'0')
      const td=document.createElement('td'); if(iso===d.today) td.classList.add('today'); if(iso<d.cutoff) td.classList.add('locked')
      const key=iso+'|'+s; const btn=document.createElement('button'); btn.className='btn'; btn.textContent=d.intents[key]||'-'
      if(iso<d.cutoff) btn.disabled=true
      btn.onclick=async ()=>{
        const next=cycle(btn.textContent); btn.textContent=next
        try{ await fetch('/api/intent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,value:next})}) }catch(e){}
      }
      td.appendChild(btn); tr.appendChild(td)
    }
    A.appendChild(tr)
  }
})();
</script>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age:0' } })
})

export default app
