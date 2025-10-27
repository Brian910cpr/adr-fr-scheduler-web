// ShiftCommander — API + Diagnostics + Bulk Import (Cloudflare Worker)
// Routes:
//   POST /api/seed                  -> create tables + demo data
//   GET  /api/users                 -> list users
//   POST /api/users                 -> add one {name, role, member_no?, can_drive?, notes?}
//   POST /api/users/bulk?truncate=1&token=...  -> CSV import (text/plain)
//   GET  /api/state?start=YYYY-MM-DD&end=YYYY-MM-DD
//   POST /api/availability          -> {userId,date,half,state}
//   POST /api/prefs                 -> {userId, prefer24s?, notes?}
//   POST /api/shift/assign          -> {date,half,userId}
//   POST /api/shift/status          -> {date,half,status}
//   GET  /test/schema/users         -> PRAGMA table_info(users)
//   GET  /test/users                -> first 25 users

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = "*";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    try {
      // --- WebSocket (optional) ---
      if (url.pathname === "/ws") {
        if (request.headers.get("Upgrade") !== "websocket") return json({ error: "upgrade required" }, 426, origin);
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        hub.accept(server);
        return new Response(null, { status: 101, webSocket: client });
      }

      // --- Seed DB (creates tables + demo) ---
      if (url.pathname === "/api/seed" && request.method === "POST") {
        await migrate(env.DB);
        await seed(env.DB);
        hub.broadcast({ type: "SYNC", changed: "seed" });
        return json({ ok: true, now: new Date().toISOString() }, 200, origin);
      }

      // --- Users (GET list) ---
      if (url.pathname === "/api/users" && request.method === "GET") {
        await migrate(env.DB);
        const rows = await env.DB.prepare("SELECT * FROM users ORDER BY name").all();
        const list = (rows.results || []).map(r => ({ ...r, can_drive: safeParseJSON(r.can_drive, []) }));
        return json(list, 200, origin);
      }

      // --- Users (POST create one) ---
      if (url.pathname === "/api/users" && request.method === "POST") {
        await migrate(env.DB);
        await ensureUsersTableHasColumns(env);
        const body = await request.json();
        if (!body.name || !body.role) return json({ error: "name and role required" }, 400, origin);
        const id = body.id || makeId(body.name);
        await env.DB.prepare(
          "INSERT INTO users(id,name,role,member_no,can_drive,notes) VALUES(?,?,?,?,?,?)"
        ).bind(
          id,
          body.name,
          body.role,
          body.member_no || "",
          JSON.stringify(body.can_drive || []),
          body.notes || ""
        ).run();
        await env.DB.prepare("INSERT OR IGNORE INTO prefs(user_id,prefer24s,notes) VALUES(?,?,?)").bind(id, 0, "").run();
        hub.broadcast({ type: "SYNC", changed: "users" });
        return json({ id, name: body.name, role: body.role }, 200, origin);
      }

      // --- Prefs (POST upsert) ---
      if (url.pathname === "/api/prefs" && request.method === "POST") {
        await migrate(env.DB);
        const body = await request.json();
        if (!body.userId) return json({ error: "userId required" }, 400, origin);
        await env.DB.prepare(
          "INSERT INTO prefs(user_id, prefer24s, notes) VALUES(?,?,?) " +
          "ON CONFLICT(user_id) DO UPDATE SET prefer24s=excluded.prefer24s, notes=COALESCE(excluded.notes,prefs.notes)"
        ).bind(body.userId, body.prefer24s ? 1 : 0, body.notes ?? null).run();
        hub.broadcast({ type: "SYNC", changed: "prefs", userId: body.userId });
        return json({ ok: true }, 200, origin);
      }

      // --- State (window) ---
      if (url.pathname === "/api/state" && request.method === "GET") {
        await migrate(env.DB);
        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");
        if (!start || !end) return json({ error: "start and end required" }, 400, origin);

        const shiftsRows = await env.DB.prepare("SELECT * FROM shifts WHERE date BETWEEN ? AND ?").bind(start, end).all();
        const avRows = await env.DB.prepare("SELECT * FROM availability WHERE date BETWEEN ? AND ?").bind(start, end).all();
        const prefsRows = await env.DB.prepare("SELECT user_id, prefer24s, notes FROM prefs").all();

        const shifts = {};
        (shiftsRows.results || []).forEach(r => {
          (shifts[r.date] ||= {});
          shifts[r.date][r.half] = { assignees: safeParseJSON(r.assignees, []), status: r.status };
        });

        const availability = {};
        (avRows.results || []).forEach(r => {
          (availability[r.user_id] ||= {});
          (availability[r.user_id][r.date] ||= { AM: "unset", PM: "unset" });
          availability[r.user_id][r.date][r.half] = r.state;
        });

        const prefs = {};
        (prefsRows.results || []).forEach(p => { prefs[p.user_id] = { prefer24s: !!p.prefer24s, notes: p.notes || "" }; });

        return json({ shifts, availability, prefs }, 200, origin);
      }

      // --- Availability (POST set) ---
      if (url.pathname === "/api/availability" && request.method === "POST") {
        await migrate(env.DB);
        const body = await request.json();
        if (!body.userId || !body.date || !body.half || !body.state) return json({ error: "userId,date,half,state required" }, 400, origin);
        await env.DB.prepare(
          "INSERT INTO availability(user_id,date,half,state) VALUES(?,?,?,?) " +
          "ON CONFLICT(user_id,date,half) DO UPDATE SET state=excluded.state"
        ).bind(body.userId, body.date, body.half, body.state).run();
        hub.broadcast({ type: "SYNC", changed: "availability", userId: body.userId, date: body.date, half: body.half });
        return json({ ok: true }, 200, origin);
      }

      // --- Shift assign toggle ---
      if (url.pathname === "/api/shift/assign" && request.method === "POST") {
        await migrate(env.DB);
        const body = await request.json();
        if (!body.date || !body.half || !body.userId) return json({ error: "date,half,userId required" }, 400, origin);
        await ensureShift(env.DB, body.date, body.half);
        const row = await env.DB.prepare("SELECT assignees, status FROM shifts WHERE date=? AND half=?").bind(body.date, body.half).first();
        const assignees = safeParseJSON(row?.assignees, []);
        const idx = assignees.indexOf(body.userId);
        if (idx >= 0) assignees.splice(idx, 1); else assignees.push(body.userId);
        const nextStatus = assignees.length ? (row?.status === "approved" ? "approved" : "proposed") : "unassigned";
        await env.DB.prepare("UPDATE shifts SET assignees=?, status=? WHERE date=? AND half=?").bind(JSON.stringify(assignees), nextStatus, body.date, body.half).run();
        hub.broadcast({ type: "SYNC", changed: "shift", date: body.date, half: body.half });
        return json({ assignees, status: nextStatus }, 200, origin);
      }

      // --- Shift status set ---
      if (url.pathname === "/api/shift/status" && request.method === "POST") {
        await migrate(env.DB);
        const body = await request.json();
        if (!body.date || !body.half || !body.status) return json({ error: "date,half,status required" }, 400, origin);
        await ensureShift(env.DB, body.date, body.half);
        await env.DB.prepare("UPDATE shifts SET status=? WHERE date=? AND half=?").bind(body.status, body.date, body.half).run();
        hub.broadcast({ type: "SYNC", changed: "shift", date: body.date, half: body.half });
        return json({ ok: true }, 200, origin);
      }

      // --- Diagnostics ---
      if (url.pathname === "/test/schema/users" && request.method === "GET") {
        await migrate(env.DB);
        const res = await env.DB.prepare("PRAGMA table_info(users)").all();
        return json(res.results || [], 200, origin);
      }
      if (url.pathname === "/test/users" && request.method === "GET") {
        await migrate(env.DB);
        const res = await env.DB.prepare("SELECT id,name,role,member_no,can_drive,notes FROM users ORDER BY name LIMIT 25").all();
        const rows = (res.results || []).map(r => ({ ...r, can_drive: safeParseJSON(r.can_drive, []) }));
        return json(rows, 200, origin);
      }

      // --- Bulk CSV import ---
      if (url.pathname === "/api/users/bulk" && request.method === "POST") {
        await migrate(env.DB);
        await ensureUsersTableHasColumns(env);
        const truncate = url.searchParams.get("truncate") === "1";
        const token = url.searchParams.get("token") || "";
        if (env.IMPORT_TOKEN && token !== env.IMPORT_TOKEN) return json({ error: "unauthorized" }, 401, origin);

        const text = await request.text();
        const { rows, errors } = parseCsvUsers(text);
        if (!rows.length) return json({ error: "No rows parsed", errors }, 400, origin);

        if (truncate) {
          await env.DB.prepare("DELETE FROM users").run();
          await env.DB.prepare("DELETE FROM prefs").run();
        }

        let ok = 0, fail = 0;
        for (const r of rows) {
          try {
            const id = r.id || ("u" + Math.random().toString(36).slice(2, 8));
            await env.DB.prepare(
              "INSERT INTO users(id,name,role,member_no,can_drive,notes) VALUES(?,?,?,?,?,?)"
            ).bind(
              id,
              r.name,
              r.role || "EMT",
              r.member_no || "",
              JSON.stringify(r.can_drive || []),
              r.notes || ""
            ).run();
            await env.DB.prepare("INSERT OR IGNORE INTO prefs(user_id, prefer24s, notes) VALUES(?,?,?)").bind(id, 0, "").run();
            ok++;
          } catch {
            fail++;
          }
        }
        hub.broadcast({ type: "SYNC", changed: "users" });
        return json({ ok, fail, errors, now: new Date().toISOString() }, 200, origin);
      }

      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      return json({ error: e?.message || String(e) }, 500, origin);
    }
  }
};

// ---------- helpers ----------
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}
function json(obj, status = 200, origin = "*") {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors(origin) } });
}
function safeParseJSON(s, dflt) { try { return JSON.parse(s || ""); } catch { return dflt; } }
async function ensureShift(DB, date, half) {
  const row = await DB.prepare("SELECT 1 FROM shifts WHERE date=? AND half=?").bind(date, half).first();
  if (!row) await DB.prepare("INSERT INTO shifts(date,half,assignees,status) VALUES(?,?,?,?)").bind(date, half, "[]", "unassigned").run();
}
function makeId(name) {
  const base = Array.from(new TextEncoder().encode(name)).reduce((a,b)=> (a+b)%1e9, 0).toString(36);
  return "u" + base + Math.random().toString(36).slice(2,6);
}
async function migrate(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    member_no TEXT DEFAULT '',
    can_drive TEXT DEFAULT '[]',
    notes TEXT DEFAULT ''
  )`).run();

  await DB.prepare(`CREATE TABLE IF NOT EXISTS prefs (
    user_id TEXT PRIMARY KEY,
    prefer24s INTEGER DEFAULT 0,
    notes TEXT DEFAULT ''
  )`).run();

  await DB.prepare(`CREATE TABLE IF NOT EXISTS availability (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    half TEXT CHECK(half IN ('AM','PM')) NOT NULL,
    state TEXT CHECK(state IN ('unset','prefer','available','no')) NOT NULL,
    PRIMARY KEY (user_id, date, half)
  )`).run();

  await DB.prepare(`CREATE TABLE IF NOT EXISTS shifts (
    date TEXT NOT NULL,
    half TEXT CHECK(half IN ('AM','PM')) NOT NULL,
    assignees TEXT NOT NULL DEFAULT '[]',
    status TEXT CHECK(status IN ('unassigned','proposed','approved')) NOT NULL DEFAULT 'unassigned',
    PRIMARY KEY (date, half)
  )`).run();
}
async function ensureUsersTableHasColumns(env) {
  const res = await env.DB.prepare("PRAGMA table_info(users)").all();
  const cols = (res.results || []).map(c => c.name);
  if (!cols.includes("member_no")) await env.DB.prepare("ALTER TABLE users ADD COLUMN member_no TEXT").run();
  if (!cols.includes("can_drive")) await env.DB.prepare("ALTER TABLE users ADD COLUMN can_drive TEXT DEFAULT '[]'").run();
}
function parseCsvUsers(text) {
  const rows = []; const errors = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { rows, errors: ["CSV empty"] };

  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const idx = k => header.indexOf(k);
  const iName = idx("name"); if (iName < 0) return { rows, errors: ["CSV must include a 'name' column"] };
  const iRole = idx("role");
  const iMember = idx("member_no");
  const iCan = idx("can_drive");
  const iNotes = idx("notes");
  const iId = idx("id");

  for (let i=1;i<lines.length;i++){
    const cols = lines[i].split(",").map(s => s.trim());
    if (!cols.length) continue;
    const name = cols[iName];
    if (!name) { errors.push(`Row ${i+1}: name missing`); continue; }

    const user = { name };
    if (iRole >= 0)   user.role = cols[iRole] || "EMT";
    if (iMember >= 0) user.member_no = cols[iMember] || "";
    if (iNotes >= 0)  user.notes = cols[iNotes] || "";
    if (iId >= 0)     user.id = cols[iId] || undefined;

    if (iCan >= 0 && cols[iCan]) user.can_drive = cols[iCan].split(";").map(s => s.trim()).filter(Boolean);
    else user.can_drive = [];

    rows.push(user);
  }
  return { rows, errors };
}
async function seed(DB) {
  const demo = [
    { id: "u1", name: "Alex", role: "EMT", member_no: "1001", can_drive: ["Rescue 1"], notes: "" },
    { id: "u2", name: "Bailey", role: "Driver", member_no: "1002", can_drive: ["Rescue 1","Tanker 2"], notes: "Prefers weekends" },
    { id: "u3", name: "Casey", role: "ALS", member_no: "1003", can_drive: ["Rescue 1"], notes: "Avoids Mondays" },
    { id: "u4", name: "Drew", role: "EMT", member_no: "1004", can_drive: ["Brush 3"], notes: "" }
  ];
  for (const u of demo) {
    await DB.prepare("INSERT OR IGNORE INTO users(id,name,role,member_no,can_drive,notes) VALUES(?,?,?,?,?,?)")
      .bind(u.id, u.name, u.role, u.member_no, JSON.stringify(u.can_drive), u.notes).run();
    await DB.prepare("INSERT OR IGNORE INTO prefs(user_id,prefer24s,notes) VALUES(?,?,?)").bind(u.id, 0, "").run();
  }
  const now = new Date();
  for (let i=0;i<60;i++){
    const d = new Date(now); d.setDate(d.getDate()+i);
    const k = d.toISOString().slice(0,10);
    await ensureShift(DB, k, "AM");
    await ensureShift(DB, k, "PM");
  }
}

// in-memory WS hub
const hub = {
  sockets: new Set(),
  accept(ws){ ws.accept(); this.sockets.add(ws); ws.addEventListener("close", ()=> this.sockets.delete(ws)); ws.addEventListener("error", ()=> this.sockets.delete(ws)); },
  broadcast(obj){ const msg = JSON.stringify(obj); for (const ws of this.sockets) { try{ ws.send(msg); } catch{} } }
};
