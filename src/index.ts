import { Hono } from 'hono'

type Env = { DB: D1Database }

// ---------- Time (America/New_York) ----------
const TZ = 'America/New_York'
function fmtTz(date: Date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
  const [y, m, d] = f.format(date).split('-')
  return { y, m, d, iso: `${y}-${m}-${d}` }
}
function todayISO() { return fmtTz(new Date()).iso }                  // 'YYYY-MM-DD' in EST/EDT
function isPastDate(iso: string) { return iso < todayISO() }
function assertMonth(ym?: string | null) {
  const re = /^\d{4}-(0[1-9]|1[0-2])$/
  if (ym && re.test(ym)) return ym
  const t = fmtTz(new Date()); return `${t.y}-${t.m}`
}
function daysInMonth(ym: string) { const [Y,M]=ym.split('-').map(n=>parseInt(n,10)); return new Date(Y,M,0).getDate() }
function isoDay(ym: string, d: number) { return `${ym}-${String(d).padStart(2,'0')}` }

// ---------- Domain ----------
type Intent = '-' | 'P' | 'A' | 'S'              // Empty, Preferred, Available, Stand-by
const UNITS = ['120','121','131'] as const
const SHIFTS = ['Day','Night'] as const

const app = new Hono<{ Bindings: Env }>()

// Root → new wallboard
app.get('/', c => c.redirect('/wallboard.html', 302))

// Probe so you know this file is live
app.get('/__who', c => c.text('LIVE: src/index.ts'))

// Health
app.get('/api/health', async (c) => {
  try {
    const probe = await c.env.DB.prepare('select 1 as ok').first()
    return c.json({ ok: true, db: probe ? 'up' : 'down', tz: 'America/New_York', today: todayISO() })
  } catch (e: any) {
    return c.json({ ok:false, error:String(e?.message ?? e) }, 500)
  }
})

// GET wallboard data
app.get('/api/wallboard', async (c) => {
  try {
    const month = assertMonth(c.req.query('month'))
    const start = `${month}-01`
    const endDays = daysInMonth(month)
    const end = isoDay(month, endDays)

    const { results } = await c.env.DB.prepare(`
      SELECT shift_date, unit_code, shift_name, intent
      FROM shifts
      WHERE shift_date >= ? AND shift_date <= ?
        AND unit_code IN ('120','121','131')
        AND shift_name IN ('Day','Night')
    `).bind(start, end).all<{shift_date:string,unit_code:string,shift_name:string,intent:string}>()

    const intents: Record<string, Intent> = {}
    for (const r of results) intents[`${r.shift_date}|${r.unit_code}|${r.shift_name}`] = (r.intent as Intent) ?? '-'

    return c.json({ month, days: endDays, units: UNITS, shifts: SHIFTS, intents, today: todayISO() })
  } catch (err:any) {
    return c.json({ ok:false, error:String(err?.message ?? err) }, 500)
  }
})

// POST commit (blocks past dates)
app.post('/api/intent', async (c) => {
  try {
    const body = await c.req.json().catch(()=>({}))
    const key = String((body as any).key || '')
    const value = String((body as any).value || '')
    const user = (body as any).user ? String((body as any).user) : null

    if (!/^\d{4}-\d{2}-\d{2}\|(120|121|131)\|(Day|Night)$/.test(key)) return c.json({ ok:false, error:'Bad key format' }, 400)
    if (!['-','P','A','S'].includes(value)) return c.json({ ok:false, error:'Bad value' }, 400)

    const [shift_date, unit_code, shift_name] = key.split('|')
    if (isPastDate(shift_date)) return c.json({ ok:false, error:'Locked: past dates cannot be edited (EST/EDT)' }, 403)

    await c.env.DB.prepare(`
      INSERT INTO shifts (shift_date, unit_code, shift_name, intent, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(shift_date, unit_code, shift_name)
      DO UPDATE SET intent=excluded.intent, updated_by=excluded.updated_by, updated_at=datetime('now')
    `).bind(shift_date, unit_code, shift_name, value, user).run()

    return c.json({ ok:true, key, value, committed_at:new Date().toISOString() })
  } catch (err:any) {
    return c.json({ ok:false, error:String(err?.message ?? err) }, 500)
  }
})

// UI: minimalist grid (4-state + commit bubble + rollups) — no-cache
app.get('/wallboard.html', (c) => {
  const t = fmtTz(new Date())
  const TODAY = `${t.y}-${t.m}-${t.d}`
  const THIS_MONTH = `${t.y}-${t.m}`
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ADR FR — Wallboard (EST)</title>
<style>
:root{--bg:#0b1220;--fg:#e6edf3;--muted:#a3afd1;--card:#0f172a;--line:#24304c;--green:#1fbf6a;--ygreen:#86d18f;--amber:#f0b44c;--red:#d14b4b;--today:#20325a;--pending:#6ea8fe}
html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{padding:16px;display:flex;flex-direction:column;gap:12px}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
select,button,input{background:#121a2b;color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.grid{overflow:auto;border:1px solid var(--line);border-radius:16px;background:var(--card)}
table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%}
th,td{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:8px 10px;white-space:nowrap}
th:first-child,td:first-child{border-left:1px solid var(--line)} tr:first-child th{border-top:1px solid var(--line)}
th{position:sticky;top:0;background:#121a2b} .rowhead{position:sticky;left:0;background:#121a2b;font-weight:600}
.cell{display:flex;align-items:center;justify-content:center;gap:10px;min-width:86px}
.pill{font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.btn{cursor:pointer;font-size:16px;line-height:1;border-radius:8px;padding:6px 10px;border:1px solid transparent}
.btn.P{color:var(--green)} .btn.A{color:var(--ygreen)} .btn.S{color:var(--amber)} .btn.-{color:var(--red)}
.btn.pending{outline:2px solid var(--pending);outline-offset:2px} .btn.lock{opacity:.45;cursor:not-allowed}
.bubble{width:14px;height:14px;border-radius:50%;border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1;color:#0b1220;background:transparent;transition:background .15s,border-color .15s}
.bubble.pending{border-color:var(--pending)} .bubble.filled{background:var(--ygreen);border-color:var(--ygreen)} .bubble.filled::after{content:'✓'}
.dayHeader.red{box-shadow:inset 0 -3px 0 var(--red)} .dayHeader.amber{box-shadow:inset 0 -3px 0 var(--amber)} .dayHeader.green{box-shadow:inset 0 -3px 0 var(--green)}
.todayCol{background:var(--today)} .status{font-size:12px;color:var(--muted)} .legend{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
</style>
</head><body>
<div class="wrap">
  <div class="controls">
    <div><label>Month:</label><select id="month"></select><button id="jumpToday">Today</button></div>
    <label>Who’s updating?</label><input id="who" placeholder="optional name/initials"/>
    <span class="legend">
      <span><b class="btn P">P</b> Preferred</span>
      <span><b class="btn A">A</b> Available</span>
      <span><b class="btn S">S</b> Stand-by</span>
      <span><b class="btn -">–</b> Empty</span>
      <span><span class="bubble filled"></span> saved</span>
    </span>
    <span id="saveStatus" class="status"></span>
  </div>
  <div id="board" class="grid"></div>
</div>
<script>
const TZ='${TZ}', TODAY='${TODAY}', THIS_MONTH='${THIS_MONTH}';
const monthSel=document.getElementById('month'), board=document.getElementById('board'), who=document.getElementById('who'), saveStatus=document.getElementById('saveStatus'), jumpTodayBtn=document.getElementById('jumpToday');
let timers=new Map();

(function initMonth(){
  const [y,m]=THIS_MONTH.split('-').map(Number), months=[];
  for(let off=-1;off<=1;off++){const d=new Date(Date.UTC(y,m-1+off,1));
    const yy=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric'}).format(d);
    const mm=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,month:'2-digit'}).format(d);
    months.push(yy+'-'+mm);}
  for(const v of months){const o=document.createElement('option');o.value=v;o.textContent=v;monthSel.appendChild(o)}
  monthSel.value=THIS_MONTH;
})();

const cycle=v=>v==='-'?'P':(v==='P'?'A':(v==='A'?'S':'-'));
const sev=v=>v==='-'?3:(v==='S'?2:(v==='A'?1:0));
const clsFor=v=>'btn '+v;
const worst=a=>a.reduce((x,y)=>Math.max(x,y),0);

async function fetchBoard(ym){const r=await fetch('/api/wallboard?month='+encodeURIComponent(ym),{cache:'no-store'}); if(!r.ok) throw new Error('load'); return await r.json()}

function scrollToToday(){const th=document.querySelector('th[data-date="'+TODAY+'"]'); if(!th) return; const rect=th.getBoundingClientRect(), grid=board.getBoundingClientRect(); board.scrollLeft+=(rect.left-grid.left)-120}

function render(data){
  const {month,days,units,shifts,intents}=data;
  const dates=[...Array(days)].map((_,i)=>month+'-'+String(i+1).padStart(2,'0'));
  const isThisMonth=(month===THIS_MONTH);
  const table=document.createElement('table');
  const trh=document.createElement('tr'); const corner=document.createElement('th'); corner.className='rowhead'; corner.textContent='Unit / Shift'; trh.appendChild(corner);
  const dayHeaders=[]; for(const d of dates){const th=document.createElement('th'); th.textContent=d.slice(-2); th.title=d; th.dataset.date=d; th.classList.add('dayHeader'); if(d===TODAY) th.classList.add('todayCol'); dayHeaders.push(th); trh.appendChild(th)} table.appendChild(trh);
  const daySev=new Array(dates.length).fill(0);

  for(const unit of units){ for(const shift of shifts){
    const tr=document.createElement('tr'); const head=document.createElement('th'); head.className='rowhead'; head.innerHTML=unit+' · <span class="pill">'+shift+'</span>'; tr.appendChild(head);
    for(let idx=0; idx<dates.length; idx++){
      const d=dates[idx]; const td=document.createElement('td'); if(d===TODAY) td.classList.add('todayCol');
      const cell=document.createElement('div'); cell.className='cell';
      const k=d+'|'+unit+'|'+shift; const init=intents[k] ?? '-';
      const btn=document.createElement('button'); btn.className=clsFor(init); btn.textContent=init; btn.dataset.key=k;
      const bubble=document.createElement('span'); bubble.className='bubble'+(init!=='-'?' filled':'');
      const locked=d<TODAY;
      if(locked){btn.classList.add('lock'); btn.disabled=true}
      else{
        btn.addEventListener('click', ()=>{
          const next=cycle(btn.textContent||'-'); btn.textContent=next; btn.className=clsFor(next)+' pending'; bubble.classList.remove('filled'); bubble.classList.add('pending'); saveStatus.textContent='Pending…';
          if(timers.has(k)) clearTimeout(timers.get(k));
          const to=setTimeout(async ()=>{
            try{
              const res=await fetch('/api/intent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,value:btn.textContent,user:who.value||undefined})});
              const j=await res.json();
              if(res.ok){
                btn.classList.remove('pending'); bubble.classList.remove('pending'); if(btn.textContent!=='-') bubble.classList.add('filled'); else bubble.classList.remove('filled');
                saveStatus.textContent='Saved '+new Date().toLocaleTimeString();
                const colBtns=table.querySelectorAll('td:nth-child('+(idx+2)+') .btn');
                const s=worst(Array.from(colBtns).map(el=>({'-':3,S:2,A:1,P:0}[el.textContent]??0))); daySev[idx]=s; updateDayHeaderColor(idx);
              }else{
                btn.classList.remove('pending'); bubble.classList.remove('pending'); saveStatus.textContent='Error: '+(j.error||'commit failed')
              }
            }catch(e){ btn.classList.remove('pending'); bubble.classList.remove('pending'); saveStatus.textContent='Network error' }
            finally{ timers.delete(k) }
          },3000);
          timers.set(k, to);
        })
      }
      daySev[idx]=Math.max(daySev[idx], ({'-':3,S:2,A:1,P:0}[init]??0));
      cell.appendChild(btn); cell.appendChild(bubble); td.appendChild(cell); tr.appendChild(td);
    }
    table.appendChild(tr);
  }}
  board.innerHTML=''; board.appendChild(table);

  function updateDayHeaderColor(i){const th=dayHeaders[i]; th.classList.remove('red','amber','green'); if(daySev[i]>=3) th.classList.add('red'); else if(daySev[i]===2) th.classList.add('amber'); else th.classList.add('green')}
  for(let i=0;i<daySev.length;i++) updateDayHeaderColor(i);
  if(isThisMonth) requestAnimationFrame(scrollToToday);
}

async function load(){ render(await fetchBoard(monthSel.value)) }
monthSel.addEventListener('change', load); jumpTodayBtn.addEventListener('click', ()=>{ monthSel.value=THIS_MONTH; load() }); load();
</script>
</body></html>`
  return new Response(html, { headers: { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store, max-age=0' } })
})

export default app
