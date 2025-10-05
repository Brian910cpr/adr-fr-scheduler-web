// src/index.ts
import { Hono } from 'hono'

type Env = { DB: D1Database }

// ========= Time helpers (America/New_York) =========
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
// 0=Sun..6=Sat for EST/EDT
function weekdayEST(iso: string) {
  const [Y, M, D] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(Y, M - 1, D))
  // 'e' gives 1..7 (Mon..Sun). Convert to 0..6 with Sun=0
  const e = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'e' }).format(dt), 10)
  return e % 7
}
function nextWeekdayISO(iso: string, targetDow: number) {
  let cur = iso
  for (let i = 0; i < 7; i++) {
    if (weekdayEST(cur) === targetDow) return cur
    cur = addDaysISO(cur, 1)
  }
  return cur
}
/** Cutoff start = today + 21 days, then snap to next Thursday (Sun=0 → Thu=4) */
function commitmentStartISO() {
  return nextWeekdayISO(addDaysISO(todayISO(), 21), 4)
}
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

// ========= Domain =========
type Intent = '-' | 'P' | 'A' | 'S' // Empty, Preferred, Available, Stand-by
const UNITS = ['120', '121', '131'] as const
const TRUCK_SHIFTS = ['Day', 'Night'] as const  // read-only, pre-cutoff
const AMPM_SHIFTS = ['AM', 'PM'] as const       // editable, on/after cutoff
const SENTINEL_UNIT = 'ALL' // where we store AM/PM intents

const app = new Hono<{ Bindings: Env }>()

// Root → new wallboard
app.get('/', (c) => c.redirect('/wallboard.html', 302))

// Probe
app.get('/__who', (c) => c.text('LIVE: src/index.ts (truck assignments before cutoff; AM/PM intents after)'))

// Health
app.get('/api/health', async (c) => {
  try {
    const probe = await c.env.DB.prepare('select 1 as ok').first()
    return c.json({ ok: true, db: probe ? 'up' : 'down', tz: TZ, today: todayISO(), commitment_start: commitmentStartISO() })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

/**
 * GET /api/wallboard?month=YYYY-MM
 * Returns:
 *  {
 *    month, days,
 *    cutoff, today,
 *    trucks: ['120','121','131'],
 *    truckShifts: ['Day','Night'],
 *    ampmShifts: ['AM','PM'],
 *    assignments: { "YYYY-MM-DD|120|Day": { member_name?: string } , ... }   // before cutoff
 *    intents:     { "YYYY-MM-DD|AM": '-'|'P'|'A'|'S', ... }                  // on/after cutoff
 *  }
 */
app.get('/api/wallboard', async (c) => {
  try {
    const month = assertMonth(c.req.query('month'))
    const start = `${month}-01`
    const dcount = daysInMonth(month)
    const end = isoDay(month, dcount)
    const cutoff = commitmentStartISO()

    // ---- Read current truck assignments (read-only zone) ----
    // Try join with members; if table doesn't exist, fall back without names.
    let assignmentsRows: Array<{ shift_date: string; unit_code: string; shift_name: string; member_name: string | null }> = []
    try {
      const q = `
        SELECT s.shift_date, s.unit_code, s.shift_name, m.name AS member_name
        FROM shifts s
        LEFT JOIN members m ON m.id = s.member_id
        WHERE s.shift_date >= ? AND s.shift_date <= ?
          AND s.unit_code IN ('120','121','131')
          AND s.shift_name IN ('Day','Night')
      `
      const r = await c.env.DB.prepare(q).bind(start, end).all<typeof assignmentsRows[0]>()
      assignmentsRows = r.results ?? []
    } catch {
      const q2 = `
        SELECT shift_date, unit_code, shift_name, NULL AS member_name
        FROM shifts
        WHERE shift_date >= ? AND shift_date <= ?
          AND unit_code IN ('120','121','131')
          AND shift_name IN ('Day','Night')
      `
      const r2 = await c.env.DB.prepare(q2).bind(start, end).all<typeof assignmentsRows[0]>()
      assignmentsRows = r2.results ?? []
    }

    const assignments: Record<string, { member_name: string | null }> = {}
    for (const row of assignmentsRows) {
      assignments[`${row.shift_date}|${row.unit_code}|${row.shift_name}`] = { member_name: row.member_name }
    }

    // ---- Read AM/PM intents (editable zone) ----
    const intentsRows = await c.env.DB.prepare(
      `
      SELECT shift_date, shift_name, intent
      FROM shifts
      WHERE shift_date >= ? AND shift_date <= ?
        AND unit_code = ?
        AND shift_name IN ('AM','PM')
      `
    ).bind(start, end, SENTINEL_UNIT).all<{ shift_date: string; shift_name: string; intent: string }>()
    const intents: Record<string, Intent> = {}
    for (const r of intentsRows.results ?? []) intents[`${r.shift_date}|${r.shift_name}`] = (r.intent as Intent) ?? '-'

    return c.json({
      month, days: dcount, cutoff, today: todayISO(),
      trucks: UNITS, truckShifts: TRUCK_SHIFTS, ampmShifts: AMPM_SHIFTS,
      assignments,
      intents,
    })
  } catch (err: any) {
    return c.json({ ok: false, error: String(err?.message ?? err) }, 500)
  }
})

// POST commit (blocks before cutoff)
app.post('/api/intent', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const key = String((body as any).key || '')
    const value = String((body as any).value || '')
    const user = (body as any).user ? String((body as any).user) : null

    if (!/^\d{4}-\d{2}-\d{2}\|(AM|PM)$/.test(key)) return c.json({ ok: false, error: 'Bad key format' }, 400)
    if (!['-', 'P', 'A', 'S'].includes(value)) return c.json({ ok: false, error: 'Bad value' }, 400)

    const [shift_date, shift_name] = key.split('|')
    const cutoff = commitmentStartISO()
    if (isBefore(shift_date, cutoff)) return c.json({ ok: false, error: `Locked until ${cutoff} (3w+Thu)` }, 403)

    await c.env.DB.prepare(`
      INSERT INTO shifts (shift_date, unit_code, shift_name, intent, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(shift_date, unit_code, shift_name)
      DO UPDATE SET intent=excluded.intent, updated_by=excluded.updated_by, updated_at=datetime('now')
    `).bind(shift_date, SENTINEL_UNIT, shift_name, value, user).run()

    return c.json({ ok: true, key, value, committed_at: new Date().toISOString(), cutoff })
  } catch (err: any) {
    return c.json({ ok: false, error: String(err?.message ?? err) }, 500)
  }
})

// UI: before cutoff = read-only trucks; after = AM/PM intents
app.get('/wallboard.html', (c) => {
  const t = fmtTz(new Date())
  const TODAY = `${t.y}-${t.m}-${t.d}`
  const CUTOFF = commitmentStartISO()
  const THIS_MONTH = `${t.y}-${t.m}`

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ADR FR — Wallboard (EST)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --bg:#0b1220; --fg:#e6edf3; --muted:#a3afd1; --card:#0f172a; --line:#24304c;
  --green:#1fbf6a; --ygreen:#86d18f; --amber:#f0b44c; --red:#d14b4b;
  --today:#20325a; --pending:#6ea8fe; --locked:#131a2a
}
html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{padding:16px;display:flex;flex-direction:column;gap:12px}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
select,button,input{background:#121a2b;color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.grid{overflow:auto;border:1px solid var(--line);border-radius:16px;background:var(--card)}
table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%}
th,td{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:8px 10px;white-space:nowrap}
th:first-child,td:first-child{border-left:1px solid var(--line)} tr:first-child th{border-top:1px solid var(--line)}
th{position:sticky;top:0;background:#121a2b} .rowhead{position:sticky;left:0;background:#121a2b;font-weight:600}
.cell{display:flex;align-items:center;justify-content:center;gap:10px;min-width:120px}
.pill{font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.btn{cursor:pointer;font-size:16px;line-height:1;border-radius:8px;padding:6px 10px;border:1px solid transparent}
.btn.P{color:var(--green)} .btn.A{color:var(--ygreen)} .btn.S{color:var(--amber)} .btn.-{color:var(--red)}
.btn.pending{outline:2px solid var(--pending);outline-offset:2px} .btn.lock{opacity:.45;cursor:not-allowed}
.bubble{width:14px;height:14px;border-radius:50%;border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1;color:#0b1220;background:transparent;transition:background .15s,border-color .15s}
.bubble.pending{border-color:var(--pending)} .bubble.filled{background:var(--ygreen);border-color:var(--ygreen)} .bubble.filled::after{content:'✓'}
.dayHeader.red{box-shadow:inset 0 -3px 0 var(--red)} .dayHeader.amber{box-shadow:inset 0 -3px 0 var(--amber)} .dayHeader.green{box-shadow:inset 0 -3px 0 var(--green)}
.todayCol{background:var(--today)} .lockedCol{background:var(--locked)}
.status{font-size:12px;color:var(--muted)} .legend{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.name{font-size:14px;color:#cfd8ea}
.sub{font-size:11px;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <div class="controls">
    <div>
      <label>Month:</label>
      <select id="month"></select>
      <button id="jumpCutoff" title="Jump to first editable day">Jump to Open Window</button>
    </div>
    <label>Who’s updating?</label>
    <input id="who" placeholder="optional name/initials"/>
    <span class="legend">
      <span><b class="btn P">P</b> Preferred</span>
      <span><b class="btn A">A</b> Available</span>
      <span><b class="btn S">S</b> Stand-by</span>
      <span><b class="btn -">–</b> Empty</span>
      <span><span class="bubble filled"></span> saved</span>
      <span>⛔ locked before <b id="cutoffLbl"></b></span>
    </span>
    <span id="saveStatus" class="status"></span>
  </div>
  <div id="board" class="grid"></div>
</div>
<script>
const TZ='${TZ}', TODAY='${TODAY}', CUTOFF='${CUTOFF}', THIS_MONTH='${THIS_MONTH}';
document.getElementById('cutoffLbl').textContent = CUTOFF;

const monthSel=document.getElementById('month'), board=document.getElementById('board'), who=document.getElementById('who'), saveStatus=document.getElementById('saveStatus'), jumpCutoffBtn=document.getElementById('jumpCutoff');
let timers=new Map()

;(function initMonth(){
  const [y,m]=THIS_MONTH.split('-').map(Number)
  const months=[]
  for(let off=-1;off<=1;off++){
    const d=new Date(Date.UTC(y,m-1+off,1))
    const yy=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric'}).format(d)
    const mm=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,month:'2-digit'}).format(d)
    months.push(yy+'-'+mm)
  }
  for(const v of months){const o=document.createElement('option'); o.value=v; o.textContent=v; monthSel.appendChild(o)}
  // default to month containing cutoff
  monthSel.value = CUTOFF.slice(0,7)
})()

const cycle=v=>v==='-'?'P':(v==='P'?'A':(v==='A'?'S':'-'))
const sev=v=>v==='-'?3:(v==='S'?2:(v==='A'?1:0))
const clsFor=v=>'btn '+v
const worst=a=>a.reduce((x,y)=>Math.max(x,y),0)

async function fetchBoard(ym){
  const r=await fetch('/api/wallboard?month='+encodeURIComponent(ym), {cache:'no-store'})
  if(!r.ok) throw new Error('load')
  return await r.json()
}

function scrollToDate(iso){
  const th=document.querySelector('th[data-date="'+iso+'"]')
  if(!th) return
  const rect=th.getBoundingClientRect(), grid=board.getBoundingClientRect()
  board.scrollLeft+=(rect.left-grid.left)-120
}

function render(data){
  const { month, days, cutoff, today, trucks, truckShifts, ampmShifts, assignments, intents } = data
  const dates=[...Array(days)].map((_,i)=> month+'-'+String(i+1).padStart(2,'0'))
  const isCutoffMonth = (month === CUTOFF.slice(0,7))

  const table=document.createElement('table')

  // Header row
  const trh=document.createElement('tr')
  const corner=document.createElement('th'); corner.className='rowhead'; corner.textContent='Shift'; trh.appendChild(corner)
  const dayHeaders=[]
  for(const d of dates){
    const th=document.createElement('th'); th.textContent=d.slice(-2); th.title=d; th.dataset.date=d; th.classList.add('dayHeader')
    if (d === today) th.classList.add('todayCol')
    if (d < CUTOFF) th.classList.add('lockedCol')
    dayHeaders.push(th); trh.appendChild(th)
  }
  table.appendChild(trh)

  const daySev=new Array(dates.length).fill(0)

  // ----- PRE-CUTOFF (read-only trucks) -----
  for (const unit of trucks){
    for (const shift of truckShifts){
      const tr=document.createElement('tr')
      const head=document.createElement('th'); head.className='rowhead'; head.innerHTML=unit+' · <span class="pill">'+shift+'</span>'; tr.appendChild(head)

      for(let idx=0; idx<dates.length; idx++){
        const d=dates[idx]
        const td=document.createElement('td'); if (d === today) td.classList.add('todayCol'); if (d < CUTOFF) td.classList.add('lockedCol')
        const cell=document.createElement('div'); cell.className='cell'
        const k=d+'|'+unit+'|'+shift
        const a=assignments[k]
        const name=document.createElement('div'); name.className='name'; name.textContent=a?.member_name || '—'
        const sub=document.createElement('div'); sub.className='sub'; sub.textContent='assigned'
        cell.appendChild(name); cell.appendChild(sub); td.appendChild(cell); tr.appendChild(td)
      }
      table.appendChild(tr)
    }
  }

  // ----- POST-CUTOFF (editable AM/PM) -----
  for (const s of ampmShifts){
    const tr=document.createElement('tr')
    const head=document.createElement('th'); head.className='rowhead'; head.innerHTML='<span class="pill">'+s+'</span>'; tr.appendChild(head)

    for(let idx=0; idx<dates.length; idx++){
      const d=dates[idx]
      const td=document.createElement('td'); if (d === today) td.classList.add('todayCol'); if (d < CUTOFF) td.classList.add('lockedCol')
      const cell=document.createElement('div'); cell.className='cell'
      const k=d+'|'+s
      const init=intents[k] ?? '-'

      const btn=document.createElement('button'); btn.className=clsFor(init); btn.textContent=init; btn.dataset.key=k
      const bubble=document.createElement('span'); bubble.className='bubble'+(init!=='-'?' filled':'')
      const locked = d < CUTOFF

      if (locked) { btn.classList.add('lock'); btn.disabled = true }
      else {
        btn.addEventListener('click', ()=>{
          const next=cycle(btn.textContent||'-'); btn.textContent=next; btn.className=clsFor(next)+' pending'
          bubble.classList.remove('filled'); bubble.classList.add('pending'); saveStatus.textContent='Pending…'
          if (timers.has(k)) clearTimeout(timers.get(k))
          const to=setTimeout(async ()=>{
            try{
              const res=await fetch('/api/intent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,value:btn.textContent,user:who.value||undefined})})
              const j=await res.json()
              if(res.ok){
                btn.classList.remove('pending'); bubble.classList.remove('pending'); if(btn.textContent!=='-') bubble.classList.add('filled'); else bubble.classList.remove('filled')
                saveStatus.textContent='Saved '+new Date().toLocaleTimeString()
                // rollup severity for this day across the two AM/PM rows only affects post-cutoff columns
                const colBtns=table.querySelectorAll('tr:has(.pill) ~ tr td:nth-child('+(idx+2)+') .btn') // AM/PM rows
                const s = Array.from(colBtns).map(el=>({'-':3,S:2,A:1,P:0}[el.textContent]??0)).reduce((a,b)=>Math.max(a,b),0)
                daySev[idx] = Math.max(daySev[idx], s); updateDayHeaderColor(idx)
              } else {
                btn.classList.remove('pending'); bubble.classList.remove('pending'); saveStatus.textContent='Error: '+(j.error||'commit failed')
              }
            }catch(e){ btn.classList.remove('pending'); bubble.classList.remove('pending'); saveStatus.textContent='Network error' }
            finally{ timers.delete(k) }
          }, 3000)
          timers.set(k, to)
        })
      }

      daySev[idx] = Math.max(daySev[idx], ({'-':3,S:2,A:1,P:0}[init]??0))
      cell.appendChild(btn); cell.appendChild(bubble); td.appendChild(cell); tr.appendChild(td)
    }
    table.appendChild(tr)
  }

  board.innerHTML=''; board.appendChild(table)

  function updateDayHeaderColor(i){
    const th=dayHeaders[i]; th.classList.remove('red','amber','green')
    if (dates[i] < CUTOFF) {
      // pre-cutoff: use green if there is at least one assignment row per unit/shift
      th.classList.add('green') // simple pass/fail; adjust if you want stricter checks
    } else {
      // post-cutoff: base on intents (worst wins)
      if (daySev[i] >= 3) th.classList.add('red')
      else if (daySev[i] === 2) th.classList.add('amber')
      else th.classList.add('green')
    }
  }
  for (let i=0;i<dates.length;i++) updateDayHeaderColor(i)

  if (isCutoffMonth) requestAnimationFrame(()=>scrollToDate(CUTOFF))
}

async function load(){ render(await fetchBoard(monthSel.value)) }
monthSel.addEventListener('change', load)
jumpCutoffBtn.addEventListener('click', ()=>{ monthSel.value = CUTOFF.slice(0,7); load() })
load()
</script>
</body>
</html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' } })
})

export default app
