export interface Env {
  DB: D1Database;
  IMPORT_TOKEN: string;
  BUILD_TAG: string;
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
    status: init.status,
  });
}

function bad(msg: string, status = 400) {
  return json({ ok: false, error: msg }, { status });
}

const HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallboard</title>
<style>
  body{background:#0b1620;color:#e8eef5;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial,sans-serif;margin:0;padding:24px}
  .box{background:#0f2133;border:1px solid #1f3a55;border-radius:12px;padding:16px}
  table{width:100%;border-collapse:collapse}
  th,td{border-bottom:1px solid #1f3a55;padding:8px;text-align:center}
  th{color:#a8c4dd;font-weight:600}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre}
  button{background:#1e90ff;border:0;color:white;padding:8px 12px;border-radius:8px;cursor:pointer}
</style>
<h1>Wallboard</h1>
<div class="box">
  <p>Month <span id="month"></span> — Today <span id="today"></span> — Cutoff <span id="cutoff"></span></p>
  <div id="grid"></div>
</div>
<h3 style="margin-top:24px;">Preview Assignments</h3>
<div class="box mono" id="preview">Click the button.</div>
<p><button id="btn">Preview Assignments</button></p>
<script>
const month = new URL(location.href).searchParams.get("month") || new Date().toISOString().slice(0,7);
document.getElementById("month").textContent = month;

async function load(){
  const r = await fetch("/api/wallboard?month="+encodeURIComponent(month));
  const data = await r.json();
  document.getElementById("today").textContent = data.today;
  document.getElementById("cutoff").textContent = data.cutoff;

  const trucks = data.trucks;
  const shifts = data.truckShifts;
  const days = data.days;

  let html = "<table><thead><tr><th>Date</th>";
  for (const t of trucks) for (const s of shifts) html += "<th>"+t+" "+s+"</th>";
  html += "</tr></thead><tbody>";
  const y_m = month;
  const [y,m] = y_m.split("-");
  for(let d=1; d<=days; d++){
    const dd = String(d).padStart(2,"0");
    const date = y+"-"+m+"-"+dd;
    html += "<tr><td>"+date+"</td>";
    for(const t of trucks){
      for(const s of shifts){
        const k = date+"|"+t+"|"+s;
        const a = data.assignments[k] || {};
        html += "<td>"+(a.member_name ?? "—")+"</td>";
      }
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  document.getElementById("grid").innerHTML = html;
}
load();

document.getElementById("btn").onclick = async () => {
  const r = await fetch("/api/wallboard?month="+encodeURIComponent(month));
  const j = await r.json();
  document.getElementById("preview").textContent = JSON.stringify(j, null, 2);
};
</script>
</html>`;

async function getMembers(env: Env) {
  const rs = await env.DB.prepare(`SELECT id, name, role, is_admin, can_drive_type3, prefer_24h FROM members ORDER BY name`).all();
  return { ok: true, members: rs.results ?? [] };
}

async function getWallboard(env: Env, month: string) {
  // Expect YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(month)) return bad("month must be YYYY-MM");
  const start = `${month}-01`;
  // Days in month via SQLite: compute next month’s 1st then -1 day in app
  const nextMonth = new Date(start + "T00:00:00Z");
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const last = new Date(+nextMonth - 24*60*60*1000);
  const days = last.getUTCDate();

  const trucks = ["120","121","131"];
  const truckShifts = ["Day","Night"];
  const ampmShifts = ["AM","PM"];
  const today = new Date().toISOString().slice(0,10);
  // example cutoff: last Sunday of month (simple static)
  const cutoff = `${month}-26`;

  // Pull assignments for the visible month
  const rs = await env.DB.prepare(
    `SELECT shift_date, unit_code, shift_name, member_id,
            (SELECT name FROM members m WHERE m.id = s.member_id) AS member_name
     FROM shifts s
     WHERE shift_date BETWEEN ? AND ?
     ORDER BY shift_date, unit_code, shift_name`
  ).bind(`${month}-01`, `${month}-31`).all();

  const assignments: Record<string, {member_name: string|null}> = {};
  for (const r of (rs.results as any[] ?? [])) {
    const key = `${r.shift_date}|${r.unit_code}|${r.shift_name}`;
    assignments[key] = { member_name: r.member_name ?? null };
  }

  // Pull intents for AM/PM (optional table; safe if missing)
  let intents: Record<string,string> = {};
  try {
    const irs = await env.DB.prepare(
      `SELECT intent_date, shift_name, intent_code
       FROM intents
       WHERE intent_date BETWEEN ? AND ?`
    ).bind(`${month}-01`, `${month}-31`).all();
    for (const r of (irs.results as any[] ?? [])) {
      intents[`${r.intent_date}|${r.shift_name}`] = r.intent_code;
    }
  } catch (_) {
    // no intents table yet — ignore
  }

  return json({ month, days, cutoff, today, trucks, truckShifts, ampmShifts, assignments, intents });
}

async function importCSV(req: Request, env: Env, kind: "members" | "calendar") {
  // token guard
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (token !== env.IMPORT_TOKEN) return bad("invalid token", 401);

  const text = await req.text();
  if (!text || !text.includes("\n")) return bad("empty csv");

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const header = lines.shift()!;
  const rows = lines.map(l => l.split(","));

  if (kind === "members") {
    // expected: id,name,role,is_admin,can_drive_type3,prefer_24h
    const want = "id,name,role,is_admin,can_drive_type3,prefer_24h";
    if (header.trim() !== want) return bad(`CSV needs header: ${want}`);
    let up = 0, sk = 0;
    const stmt = env.DB.prepare(
      `INSERT INTO members (id,name,role,is_admin,can_drive_type3,prefer_24h)
       VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, role=excluded.role, is_admin=excluded.is_admin,
         can_drive_type3=excluded.can_drive_type3, prefer_24h=excluded.prefer_24h`
    );
    const batch = env.DB.batch.bind(env.DB);
    const ops: D1PreparedStatement[] = [];
    for (const r of rows) {
      if (r.length < 6) { sk++; continue; }
      ops.push(stmt.bind(+r[0], r[1], r[2]||null, +r[3]||0, +r[4]||0, +r[5]||0));
    }
    if (ops.length) await batch(ops);
    up = ops.length;
    return json({ ok: true, upserted: up, skipped: sk });
  }

  // calendar
  const want = "shift_date,unit_code,shift_name,member_id,intent";
  if (header.trim() !== want) return bad("CSV needs shift_date, unit_code, shift_name");
  let up = 0, sk = 0;
  const stmt = env.DB.prepare(
    `INSERT INTO shifts (shift_date,unit_code,shift_name,member_id,intent)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(shift_date,unit_code,shift_name) DO UPDATE SET
       member_id=excluded.member_id, intent=excluded.intent`
  );
  const ops: D1PreparedStatement[] = [];
  for (const r of rows) {
    const [d,u,s,mid,intent] = r;
    if (!d || !u || !s) { sk++; continue; }
    ops.push(stmt.bind(d, u, s, mid ? +mid : null, intent ?? "-"));
  }
  if (ops.length) await env.DB.batch(ops);
  up = ops.length;
  return json({ ok: true, upserted: up, skipped: sk, missingMembers: [] });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const { pathname, searchParams } = url;

      // HTML
      if (req.method === "GET" && pathname === "/wallboard.html") {
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // APIs
      if (req.method === "GET" && pathname === "/api/members") {
        return json(await getMembers(env));
      }

      if (req.method === "GET" && pathname === "/api/wallboard") {
        const month = searchParams.get("month") || new Date().toISOString().slice(0,7);
        return await getWallboard(env, month);
      }

      if (req.method === "POST" && pathname === "/admin/import/members") {
        return await importCSV(req, env, "members");
      }

      if (req.method === "POST" && pathname === "/admin/import/calendar") {
        return await importCSV(req, env, "calendar");
      }

      // Health
      if (pathname === "/") {
        return json({ ok: true, tag: env.BUILD_TAG || "dev" });
      }

      return bad("not found", 404);
    } catch (err: any) {
      return bad(`server error: ${err?.message || String(err)}`, 500);
    }
  }
};
