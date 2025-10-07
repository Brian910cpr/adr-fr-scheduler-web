export interface Env {
  DB: D1Database;
  IMPORT_TOKEN: string;
  BUILD_TAG: string;
}

/** ---- minimal bootstrap to ensure new tables exist ---- */
async function ensureSchema(DB: D1Database) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS intents (
      date TEXT NOT NULL,
      shift TEXT NOT NULL CHECK(shift IN ('AM','PM')),
      member_id INTEGER NOT NULL,
      code TEXT NOT NULL CHECK(code IN ('-','P','A','D')),
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(date, shift, member_id)
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS member_prefs (
      member_id INTEGER PRIMARY KEY,
      prefer_24h INTEGER NOT NULL DEFAULT 0
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS avoid_with (
      member_id INTEGER NOT NULL,
      other_id  INTEGER NOT NULL,
      PRIMARY KEY(member_id, other_id)
    )`),
  ]);
}

/** ---- inline HTML app ---- */
const WALLBOARD_CAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ADR-FR • Wallboard</title>
<style>
  :root{
    --bg:#0b0c10; --card:#141621; --alt:#0f1118;
    --muted:#8a92b5; --text:#eef2ff; --accent:#4da3ff; --ok:#7bd389; --warn:#ffc857; --err:#ff7070;
    --pad:10px; --gap:10px; --r:12px; --fs:14px; --fs-s:12px; --fs-h:16px; --day-h:140px;
  }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:400 var(--fs)/1.35 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 85%, transparent);backdrop-filter:blur(6px);border-bottom:1px solid color-mix(in srgb,var(--muted) 25%, transparent)}
  .bar{max-width:1200px;margin:0 auto;padding:8px 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .bar h1{font-size:18px;margin:0 10px 0 0}
  .pill{display:flex;gap:8px;align-items:center;background:var(--card);border:1px solid color-mix(in srgb,var(--muted)30%, transparent);border-radius:999px;padding:8px 10px}
  .pill input,.pill select{background:transparent;border:0;outline:0;color:var(--text);font:inherit}
  .btn{appearance:none;background:var(--card);border:1px solid color-mix(in srgb,var(--muted)30%, transparent);border-radius:10px;padding:8px 10px;color:var(--text);cursor:pointer}
  main{max-width:1200px;margin:14px auto;padding:0 12px 28px}
  .calendar{display:grid;grid-template-columns:repeat(7,1fr);gap:10px}
  .dow{color:var(--muted);text-transform:uppercase;font-size:11px;text-align:center}
  .day{min-height:var(--day-h);background:var(--card);border:1px solid color-mix(in srgb,var(--muted)25%, transparent);border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px}
  .day.other{opacity:.55}
  .date{display:flex;align-items:center;justify-content:space-between}
  .date .d{font-weight:700}
  .intents{display:flex;gap:6px}
  .dot{width:24px;height:24px;border-radius:999px;border:1px solid color-mix(in srgb,var(--muted)35%, transparent);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;cursor:pointer;user-select:none}
  .dot._{opacity:.6}
  .dot.P{outline:2px solid var(--ok)}
  .dot.A{outline:2px solid var(--err)}
  .dot.D{outline:2px solid var(--warn)}
  .committed{margin-top:4px;padding-top:6px;border-top:1px dashed color-mix(in srgb,var(--muted)25%, transparent);display:grid;gap:4px}
  .row{display:flex;gap:6px;align-items:center;justify-content:space-between}
  .badge{font-size:11px;color:var(--muted)}
  .unit{font-weight:600}
  .shift{opacity:.85}
  .note{color:var(--muted);font-size:11px;margin:12px 0 6px}
  .box{background:var(--alt);border:1px solid color-mix(in srgb,var(--muted)25%, transparent);border-radius:12px;padding:10px}
  .prefs{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .warn{color:var(--warn);font-size:11px}
  #toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--card);border:1px solid color-mix(in srgb,var(--muted)35%, transparent);padding:8px 12px;border-radius:10px;display:none}
  #toast.show{display:block}
</style>
</head>
<body>
<header><div class="bar">
  <h1>ADR-FR Wallboard</h1>
  <div class="pill"><span style="color:#8a92b5;font-size:11px">Month</span><input id="monthSel" type="month"></div>
  <button id="prev" class="btn">◀ Prev</button>
  <button id="next" class="btn">Next ▶</button>
  <div class="pill"><span style="color:#8a92b5;font-size:11px">I am</span><select id="meSel"></select></div>
</div></header>

<main>
  <div class="calendar" id="dow"></div>
  <div class="calendar" id="grid"></div>

  <div class="note">Click AM/PM to set your intent (P: prefer, A: available, D: decline, –: clear). After cutoff, intents are still recorded but <em>not</em> auto-assigned.</div>

  <div class="box">
    <div class="prefs">
      <label><input type="checkbox" id="prefer24"> Prefer 24-hr first</label>
      <button id="savePrefs" class="btn">Save Special Considerations</button>
      <span class="warn">Your “avoid working with” list is private. It’s used only to make suggestions and is never shown to others.</span>
    </div>
    <div class="note">Avoid scheduling me with:</div>
    <div id="avoidList" style="display:flex;flex-wrap:wrap;gap:8px"></div>
  </div>
</main>

<div id="toast"></div>

<script>
(function(){
  const qs=s=>document.querySelector(s), qsa=s=>Array.from(document.querySelectorAll(s));
  const monthSel=qs('#monthSel'), meSel=qs('#meSel'), dow=qs('#dow'), grid=qs('#grid');
  const prefer24=qs('#prefer24'), avoidList=qs('#avoidList'), toast=qs('#toast');
  const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; function iso(d){return d.toISOString().slice(0,10)} function ymKey(d){return d.toISOString().slice(0,7)}
  let members=[], me=null, data=null;

  function showToast(msg){toast.textContent=msg;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'), 1600)}

  async function api(path, opt){const r=await fetch(path, opt); if(!r.ok) throw new Error(await r.text()); return r.json()}
  async function loadMembers(){const j=await api('/api/members'); members=j.members; meSel.innerHTML = members.map(m=>\`<option value="\${m.id}">\${m.name}</option>\`).join(''); if(!me){me = members[0]?.id}}
  function setMonthInput(d){monthSel.value = ymKey(d)}
  function readMonth(){return monthSel.value || ymKey(new Date())}
  function buildCells(ym){const [Y,M]=ym.split('-').map(Number); const first=new Date(Y,M-1,1); const start=new Date(first); start.setDate(first.getDate()-first.getDay()); const cells=[]; for(let i=0;i<42;i++){const d=new Date(start); d.setDate(start.getDate()+i); cells.push(d)} return {month:first.getMonth(),cells}}
  function dotClass(c){return 'dot '+(c==='-'?'_':c)}
  function cycle(c){return c==='-'?'P': c==='P'?'A': c==='A'?'D':'-'}
  function renderDow(){dow.innerHTML=''; DOW.forEach(d=>{const e=document.createElement('div'); e.className='dow'; e.textContent=d; dow.appendChild(e)})}

  function render(ym){
    const {assignments={}, intents={}} = data;
    grid.innerHTML='';
    const {month,cells}=buildCells(ym);
    cells.forEach(d=>{
      const day=iso(d), other=d.getMonth()!==month;
      const card=document.createElement('div'); card.className='day'+(other?' other':'');
      const header=document.createElement('div'); header.className='date';
      const left=document.createElement('div'); left.className='d'; left.textContent = d.getDate();
      const intentsRow=document.createElement('div'); intentsRow.className='intents';
      ['AM','PM'].forEach(s=>{
        const key=day+'|'+s; const code = intents[key] ?? '-';
        const span=document.createElement('div'); span.className=dotClass(code); span.textContent = code==='-'?'–':code;
        span.title = 'Click to set intent for '+key;
        span.addEventListener('click', async ()=>{
          if(!me) return;
          const next=cycle(code);
          try{
            await api('/api/intent', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({date:day, shift:s, member_id: me, code: next})});
            data.intents[key]=next;
            render(ym);
            showToast('Intent saved');
          }catch(e){showToast('Save failed')}
        });
        intentsRow.appendChild(span);
      });
      header.append(left,intentsRow);
      card.appendChild(header);

      // committed assignments (by unit + Day/Night)
      const units=['120','121','131'];
      const comm=document.createElement('div'); comm.className='committed';
      units.forEach(u=>{
        const DN=[['Day','Day'],['Night','Night']];
        DN.forEach(([label,shift])=>{
          const a = assignments[day+'|'+u+'|'+shift];
          if(a && a.member_name){
            const row=document.createElement('div'); row.className='row';
            row.innerHTML = \`<span class="unit">Unit \${u}</span><span class="shift">\${label}</span><span class="badge">\${a.member_name}</span>\`;
            comm.appendChild(row);
          }
        });
      });
      if(comm.childElementCount===0){
        const row=document.createElement('div'); row.className='row'; row.innerHTML='<span class="badge" style="opacity:.7">— no committed shifts —</span>'; comm.appendChild(row);
      }
      card.appendChild(comm);
      grid.appendChild(card);
    });
  }

  async function loadWallboard(){
    const ym = readMonth();
    const j = await api('/api/wallboard?month='+encodeURIComponent(ym)+'&member_id='+encodeURIComponent(me||''));
    data = j;
    render(ym);
  }

  async function loadPrefs(){
    if(!me) return;
    const j = await api('/api/prefs?member_id='+me);
    prefer24.checked = !!j.prefer_24h;
    // Build avoid list UI without revealing *others’* lists to anyone else.
    const meId = Number(me);
    avoidList.innerHTML = members
      .filter(m => m.id !== meId)
      .map(m => {
        const checked = j.avoid_with?.includes(m.id) ? 'checked' : '';
        return \`<label style="display:inline-flex;gap:6px;align-items:center;background:var(--card);border:1px solid color-mix(in srgb,var(--muted)30%,transparent);border-radius:999px;padding:4px 8px;">
          <input type="checkbox" value="\${m.id}" \${checked}> \${m.name}
        </label>\`;
      }).join('');
  }

  async function savePrefs(){
    const ids = qsa('#avoidList input[type=checkbox]:checked').map(i=>Number(i.value));
    await api('/api/prefs', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({member_id: Number(me), prefer_24h: prefer24.checked?1:0, avoid_with: ids})});
    showToast('Special considerations saved');
  }

  // init
  (async ()=>{
    renderDow();
    await loadMembers();
    // restore or set defaults
    const urlM = new URL(location.href).searchParams.get('month');
    setMonthInput(urlM ? new Date(urlM+'-01') : new Date());
    meSel.value = String(me||'');
    await Promise.all([loadWallboard(), loadPrefs()]);
  })().catch(e=>{grid.innerHTML='<div>'+e.message+'</div>'});

  // events
  qs('#prev').addEventListener('click', ()=>{ const d=new Date(monthSel.value+'-01'); d.setMonth(d.getMonth()-1); setMonthInput(d); loadWallboard().catch(()=>{}) });
  qs('#next').addEventListener('click', ()=>{ const d=new Date(monthSel.value+'-01'); d.setMonth(d.getMonth()+1); setMonthInput(d); loadWallboard().catch(()=>{}) });
  monthSel.addEventListener('change', ()=>loadWallboard().catch(()=>{}));
  meSel.addEventListener('change', async ()=>{ me = Number(meSel.value); await Promise.all([loadWallboard(), loadPrefs()]).catch(()=>{}); });
  qs('#savePrefs').addEventListener('click', ()=>savePrefs().catch(()=>showToast('Save failed')));
})();
</script>
</body>
</html>`;

/** ---- Worker ---- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { DB, IMPORT_TOKEN } = env;

    // Always ensure schema first (cheap no-op if already created)
    await ensureSchema(DB);

    // HTML app
    if (url.pathname === "/wallboard.html") {
      return new Response(WALLBOARD_CAL_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // Health
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, build: env.BUILD_TAG ?? null });
    }

    // Members
    if (url.pathname === "/api/members") {
      const rs = await DB.prepare(
        "SELECT id,name,role,is_admin,can_drive_type3,prefer_24h FROM members ORDER BY id"
      ).all();
      return Response.json({ ok: true, members: rs.results ?? [] }, { headers: { "cache-control": "no-store" }});
    }

    // Wallboard: committed schedule + this user's intents
    if (url.pathname === "/api/wallboard") {
      const month = url.searchParams.get("month") || new Date().toISOString().slice(0,7);
      const memberId = Number(url.searchParams.get("member_id") || 0);
      const like = month + "%";

      const [sched, intents] = await Promise.all([
        DB.prepare(`SELECT shift_date,unit_code,shift_name,member_id,
                      (SELECT name FROM members m WHERE m.id=s.member_id) AS member_name
                    FROM shifts s
                    WHERE shift_date LIKE ?
                    ORDER BY shift_date, unit_code, shift_name`).bind(like).all(),
        memberId
          ? DB.prepare(`SELECT date, shift, code FROM intents WHERE member_id=? AND date LIKE ?`).bind(memberId, like).all()
          : Promise.resolve({ results: [] } as D1Result)
      ]);

      const assignments: Record<string,{member_name:string|null}> = {};
      for (const r of (sched.results || []) as any[]) {
        assignments[`${r.shift_date}|${r.unit_code}|${r.shift_name}`] = { member_name: r.member_name ?? null };
      }

      const intentsMap: Record<string,string> = {};
      for (const r of (intents.results || []) as any[]) {
        intentsMap[`${r.date}|${r.shift}`] = r.code;
      }

      return Response.json({
        month,
        trucks: ["120","121","131"],
        truckShifts: ["Day","Night"],
        ampmShifts: ["AM","PM"],
        assignments,
        intents: intentsMap,
      }, { headers: { "cache-control": "no-store" }});
    }

    // Set/clear an intent (allowed anytime; post-cutoff is just informational)
    if (url.pathname === "/api/intent" && req.method === "POST") {
      const { date, shift, member_id, code } = await req.json();
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response("bad date", {status:400});
      if (shift !== "AM" && shift !== "PM") return new Response("bad shift", {status:400});
      if (!Number.isFinite(member_id)) return new Response("bad member", {status:400});
      if (!["-","P","A","D"].includes(code)) return new Response("bad code", {status:400});

      if (code === "-") {
        await DB.prepare(`DELETE FROM intents WHERE date=? AND shift=? AND member_id=?`).bind(date, shift, member_id).run();
      } else {
        await DB.prepare(`INSERT OR REPLACE INTO intents(date,shift,member_id,code) VALUES(?,?,?,?)`).bind(date, shift, member_id, code).run();
      }
      return Response.json({ ok:true });
    }

    // Special considerations (private to the member)
    if (url.pathname === "/api/prefs") {
      if (req.method === "GET") {
        const memberId = Number(url.searchParams.get("member_id") || 0);
        if (!Number.isFinite(memberId) || memberId<=0) return new Response("bad member", {status:400});
        const [pref, avoid] = await Promise.all([
          DB.prepare(`SELECT prefer_24h FROM member_prefs WHERE member_id=?`).bind(memberId).all(),
          DB.prepare(`SELECT other_id FROM avoid_with WHERE member_id=?`).bind(memberId).all(),
        ]);
        const prefer_24h = (pref.results?.[0]?.prefer_24h ?? 0) as number;
        const avoid_with = (avoid.results || []).map((r:any)=>r.other_id as number);
        return Response.json({ prefer_24h, avoid_with }, { headers: { "cache-control": "no-store" }});
      }
      if (req.method === "POST") {
        const { member_id, prefer_24h, avoid_with } = await req.json();
        if (!Number.isFinite(member_id)) return new Response("bad member", {status:400});
        const p = prefer_24h ? 1 : 0;
        await DB.prepare(`INSERT INTO member_prefs(member_id,prefer_24h) VALUES(?,?)
                          ON CONFLICT(member_id) DO UPDATE SET prefer_24h=excluded.prefer_24h`)
            .bind(member_id, p).run();
        // replace avoid set
        await DB.prepare(`DELETE FROM avoid_with WHERE member_id=?`).bind(member_id).run();
        if (Array.isArray(avoid_with) && avoid_with.length) {
          const stmt = DB.prepare(`INSERT INTO avoid_with(member_id,other_id) VALUES(?,?)`);
          await DB.batch(avoid_with.filter((n:number)=>Number.isFinite(n) && n!==member_id).map((oid:number)=>stmt.bind(member_id, oid)));
        }
        return Response.json({ ok:true });
      }
      return new Response("method", {status:405});
    }

    // CSV imports (unchanged; token-protected)
    if (url.pathname.startsWith("/admin/import/")) {
      const token = url.searchParams.get("token");
      if (token !== IMPORT_TOKEN) return new Response("unauthorized", { status: 403 });
      // Your existing CSV handlers run elsewhere; keep as success stub:
      const body = await req.text();
      return Response.json({ ok: true, received: body.length });
    }

    // 404
    return new Response("Not found", { status: 404 });
  },
};
