export interface Env {
  DB: D1Database;
  IMPORT_TOKEN: string;
  BUILD_TAG: string;
}

const WALLBOARD_CAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ADR-FR • Wallboard Calendar</title>
<style>
  :root{--bg:#0b0c10;--card:#121319;--muted:#8187a2;--text:#e9ecf1;--accent:#4da3ff;--accent2:#7bd389;--warn:#ffc857;--danger:#ff7070;--gap:8px;--pad:8px;--radius:10px;--fs-xxs:11px;--fs-xs:12px;--fs:14px;--fs-h:16px;--day-min:112px}
  body{margin:0;background:var(--bg);color:var(--text);font:400 var(--fs)/1.35 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  header{position:sticky;top:0;z-index:5;backdrop-filter:blur(6px);background:color-mix(in srgb,var(--bg)82%,transparent);border-bottom:1px solid color-mix(in srgb,var(--muted)22%,transparent)}
  .bar{max-width:1200px;margin:0 auto;padding:10px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .bar h1{font-size:18px;margin:0 6px 0 0}.sp{flex:1}
  .pill{display:inline-flex;align-items:center;gap:8px;padding:8px 10px;border-radius:999px;background:var(--card);border:1px solid color-mix(in srgb,var(--muted)25%,transparent)}
  .pill input,.pill select{background:transparent;border:none;color:var(--text);font:inherit;outline:none}
  .btn{appearance:none;border:1px solid color-mix(in srgb,var(--muted)25%,transparent);background:var(--card);color:var(--text);padding:8px 10px;border-radius:10px;cursor:pointer}
  .legend{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px}
  .dot{width:20px;height:20px;border-radius:999px;border:1px solid color-mix(in srgb,var(--muted)25%,transparent);display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:10px;cursor:pointer}
  .dot.P{outline:2px solid var(--accent2)}.dot.A{outline:2px solid var(--danger)}.dot.D{outline:2px solid var(--warn)}.dot._{opacity:.55}
  main{max-width:1200px;margin:14px auto;padding:0 12px 28px}
  .calendar{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
  .dow{font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;text-align:center;padding:6px 0}
  .day{min-height:112px;display:flex;flex-direction:column;gap:6px;background:var(--card);border:1px solid color-mix(in srgb,var(--muted)20%,transparent);border-radius:10px;padding:8px}
  .day.other{opacity:.55}
  .date{display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:16px}
  .intentRow{display:flex;gap:6px}
  .note{margin-top:10px;color:var(--muted);font-size:11px;text-align:center}
  #toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:var(--card);border:1px solid color-mix(in srgb,var(--muted)30%,transparent);padding:8px 12px;border-radius:10px;display:none}
  #toast.show{display:block}
</style>
</head>
<body>
<header><div class="bar">
<h1>ADR-FR Wallboard</h1>
<div class="pill"><label for="monthSel" style="color:#8187a2;font-size:11px;margin-right:6px">Month</label><input id="monthSel" type="month"></div>
<button id="prev" class="btn">◀ Prev</button><button id="next" class="btn">Next ▶</button>
<div class="pill"><span style="color:#8187a2;font-size:11px">I am</span><select id="meSel"></select></div>
</div></header>
<main>
  <div id="dow" class="calendar"></div>
  <div id="grid" class="calendar"></div>
  <div class="note">Click AM/PM dot to set intent.</div>
</main>
<div id="toast"></div>
<script>
(function(){
  const qs=s=>document.querySelector(s), grid=qs('#grid'), dow=qs('#dow'), monthSel=qs('#monthSel'), toast=qs('#toast');
  const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];function mkey(d){return d.toISOString().slice(0,7)}function f(d){return d.toISOString().slice(0,10)}
  function renderDOW(){dow.innerHTML='';DOW.forEach(d=>{const e=document.createElement('div');e.className='dow';e.textContent=d;dow.appendChild(e);});}renderDOW();
  async function wall(ym){const r=await fetch('/api/wallboard?month='+ym);return r.json();}
  function buildCells(ym){const [y,m]=ym.split('-').map(Number);const first=new Date(y,m-1,1);const start=new Date(first);start.setDate(first.getDate()-first.getDay());const days=[];for(let i=0;i<42;i++){const d=new Date(start);d.setDate(start.getDate()+i);days.push(d);}return {month:first.getMonth(),days};}
  function dotClass(c){return 'dot '+(c==='-'?'_':c)}
  function render(ym,data){grid.innerHTML='';const {assignments={},intents={}}=data;const {month,days}=buildCells(ym);days.forEach(d=>{const day=f(d),other=d.getMonth()!==month;const card=document.createElement('div');card.className='day'+(other?' other':'');const top=document.createElement('div');top.className='date';top.innerHTML='<div>'+d.getDate()+'</div>';const row=document.createElement('div');row.className='intentRow';['AM','PM'].forEach(s=>{const code=(intents?.[day+'|'+s])??'-';const span=document.createElement('span');span.className=dotClass(code);span.textContent=code==='-'?'–':code;row.appendChild(span);});top.appendChild(row);card.appendChild(top);grid.appendChild(card);});}
  function setMonthInput(d){monthSel.value=mkey(d)}
  function curMonth(){return monthSel.value||mkey(new Date())}
  async function redraw(){const ym=curMonth();render(ym,await wall(ym))}
  const urlMonth=new URL(location.href).searchParams.get('month');setMonthInput(urlMonth?new Date(urlMonth+'-01'):new Date());redraw().catch(e=>grid.innerHTML='<div>Error '+e.message+'</div>');
})();
</script></body></html>`;

// ---- API + HTML handler ----
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { DB, IMPORT_TOKEN } = env;

    // Serve new calendar HTML
    if (url.pathname === "/wallboard.html") {
      return new Response(WALLBOARD_CAL_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // Simple health check
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, db: "up" });
    }

    // List members
    if (url.pathname === "/api/members") {
      const rs = await DB.prepare(
        "SELECT id, name, role, is_admin, can_drive_type3, prefer_24h FROM members ORDER BY id"
      ).all();
      return Response.json({ ok: true, members: rs.results || [] });
    }

    // Wallboard API
    if (url.pathname === "/api/wallboard") {
      const month = url.searchParams.get("month") || "2025-10";
      const prefix = month + "-";
      const rs = await DB.prepare(
        `SELECT shift_date, unit_code, shift_name, member_id,
                (SELECT name FROM members m WHERE m.id = s.member_id) AS member_name
           FROM shifts s WHERE shift_date LIKE ? ORDER BY shift_date, unit_code, shift_name`
      ).bind(prefix + "%").all();

      const assignments: Record<string, any> = {};
      for (const r of rs.results || []) {
        assignments[`${r.shift_date}|${r.unit_code}|${r.shift_name}`] = {
          member_name: r.member_name,
        };
      }

      return Response.json({
        month,
        days: 31,
        cutoff: "2025-10-26",
        today: "2025-10-07",
        trucks: ["120", "121", "131"],
        truckShifts: ["Day", "Night"],
        ampmShifts: ["AM", "PM"],
        assignments,
        intents: {},
      });
    }

    // CSV imports (token protected)
    if (url.pathname.startsWith("/admin/import/")) {
      const token = url.searchParams.get("token");
      if (token !== IMPORT_TOKEN)
        return new Response("unauthorized", { status: 403 });
      const body = await req.text();
      return Response.json({ ok: true, received: body.length });
    }

    return new Response("Not found", { status: 404 });
  },
};
