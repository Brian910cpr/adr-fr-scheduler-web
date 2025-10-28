// ShiftCommander API — Reserve/Inactive/Type-III ready
// D1 binding: env.DB
// Exposes:
//   GET  /api/users
//   POST /api/users/bulk?truncate=1&token=...           (CSV import)
//   POST /api/seed?days=180                              (seed sc_shifts window)
//   GET  /api/state?start=YYYY-MM-DD&end=YYYY-MM-DD      (window payload)
//   POST /api/availability { userId,date,half,state }    (prefer/available/no/unset)
//   POST /api/shift/assign { date,half,userId,override } (manual seat)
//   POST /api/shift/status  { date,half,status }         (unassigned|proposed|approved)
//   POST /api/me/reserve    { userId,reserve }           (member toggle; also supervisor)
//   POST /api/me/inactive   { userId,inactive }          (supervisor toggle)
//   POST /api/me/type3      { userId,type3 }             (supervisor toggle)
// Diagnostics:
//   GET  /test/schema/users
//   GET  /test/users

const RESERVE_VOLUNTEER_BONUS = 3; // scoring bump when reserve volunteers

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization"
        }
      });
    }

    try {
      // ---------- Diagnostics ----------
      if (url.pathname === "/test/schema/users") {
        const res = await env.DB.prepare("PRAGMA table_info(users)").all();
        return json(res.results ?? []);
      }
      if (url.pathname === "/test/users") {
        const res = await env.DB
          .prepare("SELECT id,name,role,member_no,can_drive,notes,inactive,reserve,type3_driver FROM users ORDER BY name LIMIT 25")
          .all();
        const rows = (res.results || []).map(cleanUser);
        return json(rows);
      }

      // ---------- Users ----------
      if (url.pathname === "/api/users" && request.method === "GET") {
        const res = await env.DB
          .prepare("SELECT id,name,role,member_no,can_drive,notes,inactive,reserve,type3_driver FROM users ORDER BY name")
          .all();
        return json((res.results || []).map(cleanUser));
      }

      // Bulk CSV import of users (safe: auto-add columns if missing)
      if (url.pathname === "/api/users/bulk" && request.method === "POST") {
        await ensureUsersTableHasColumns(env);
        const truncate = url.searchParams.get("truncate") === "1";
        const token = url.searchParams.get("token");
        if (env.IMPORT_TOKEN && token !== env.IMPORT_TOKEN) {
          return json({ error: "unauthorized" }, 401);
        }

        const text = await request.text();
        const { rows, errors } = parseCsvUsers(text);
        if (!rows.length) return json({ error: "No rows parsed", errors }, 400);

        if (truncate) {
          await env.DB.prepare("DELETE FROM users").run();
          await env.DB.prepare("DELETE FROM sc_prefs").run();
        }

        let ok = 0, fail = 0;
        for (const r of rows) {
          try {
            const id = r.id || ("u" + Math.random().toString(36).slice(2, 8));
            await env.DB.prepare(
              "INSERT INTO users(id,name,role,member_no,can_drive,notes,inactive,reserve,type3_driver) VALUES(?,?,?,?,?,?,?,?,?)"
            ).bind(
              id,
              r.name,
              r.role || "EMT",
              r.member_no || "",
              JSON.stringify(r.can_drive || []),
              r.notes || "",
              r.inactive ? 1 : 0,
              r.reserve ? 1 : 0,
              r.type3_driver ? 1 : 0
            ).run();
            await env.DB.prepare("INSERT OR IGNORE INTO sc_prefs(user_id, prefer24s, notes) VALUES(?,?,?)")
              .bind(id, 0, "").run();
            ok++;
          } catch {
            fail++;
          }
        }
        return json({ ok, fail, errors, now: new Date().toISOString() });
      }

      // ---------- Seed shifts ----------
      if (url.pathname === "/api/seed" && request.method === "POST") {
        const days = parseInt(url.searchParams.get("days") || "180", 10);
        await ensureSCtables(env);
        await seedShifts(env, days);
        return json({ ok: true });
      }

      // ---------- State window ----------
      if (url.pathname === "/api/state" && request.method === "GET") {
        await ensureSCtables(env);
        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");
        if (!start || !end) return json({ error: "start/end required (YYYY-MM-DD)" }, 400);

        const shifts = await loadShifts(env, start, end);
        const availability = await loadAvailability(env, start, end);
        const prefs = await loadPrefs(env);
        return json({ shifts, availability, prefs });
      }

      // ---------- Availability upsert ----------
      if (url.pathname === "/api/availability" && request.method === "POST") {
        await ensureSCtables(env);
        const b = await request.json();
        const { userId, date, half, state } = b || {};
        if (!userId || !date || !half || !state) return json({ error: "userId,date,half,state required" }, 400);
        if (!["AM", "PM"].includes(half)) return json({ error: "half must be AM|PM" }, 400);
        if (!["prefer", "available", "no", "unset"].includes(state)) return json({ error: "bad state" }, 400);

        if (state === "unset") {
          await env.DB.prepare("DELETE FROM sc_availability WHERE user_id=? AND date=? AND half=?")
            .bind(userId, date, half).run();
        } else {
          await env.DB.prepare(
            "INSERT INTO sc_availability(user_id,date,half,state) VALUES(?,?,?,?) ON CONFLICT(user_id,date,half) DO UPDATE SET state=excluded.state"
          ).bind(userId, date, half, state).run();
        }
        return json({ ok: true });
      }

      // ---------- Assign / Status ----------
      if (url.pathname === "/api/shift/assign" && request.method === "POST") {
        await ensureSCtables(env);
        const b = await request.json();
        const { userId, date, half, override } = b || {};
        if (!userId || !date || !half) return json({ error: "userId,date,half required" }, 400);

        const urow = await env.DB.prepare(
          "SELECT id,inactive,reserve FROM users WHERE id=?"
        ).bind(userId).first();
        if (!urow) return json({ error: "user not found" }, 404);
        if (urow.inactive && !override) {
          return json({ error: "user is inactive; supervisor override required" }, 409);
        }
        if (urow.reserve && !override) {
          const st = await getAvail(env, userId, date, half);
          if (!isVolunteerState(st)) {
            return json({ error: "reserve user has not volunteered for this shift" }, 409);
          }
        }

        const srow = await env.DB.prepare(
          "SELECT assignees,status FROM sc_shifts WHERE date=? AND half=?"
        ).bind(date, half).first();
        if (!srow) {
          await env.DB.prepare("INSERT INTO sc_shifts(date,half,assignees,status) VALUES(?,?,?,?)")
            .bind(date, half, JSON.stringify([userId]), "proposed").run();
          return json({ assignees: [userId], status: "proposed" });
        }
        const list = tryJson(srow.assignees, []);
        if (!list.includes(userId)) list.push(userId);
        const status = srow.status || "proposed";
        await env.DB.prepare(
          "UPDATE sc_shifts SET assignees=?, status=? WHERE date=? AND half=?"
        ).bind(JSON.stringify(list), status, date, half).run();
        return json({ assignees: list, status });
      }

      if (url.pathname === "/api/shift/status" && request.method === "POST") {
        const b = await request.json();
        const { date, half, status } = b || {};
        if (!date || !half || !status) return json({ error: "date,half,status required" }, 400);
        if (!["unassigned","proposed","approved"].includes(status)) return json({ error: "bad status" }, 400);
        const exists = await env.DB.prepare("SELECT 1 FROM sc_shifts WHERE date=? AND half=?").bind(date, half).first();
        if (!exists) {
          await env.DB.prepare("INSERT INTO sc_shifts(date,half,assignees,status) VALUES(?,?,?,?)")
            .bind(date, half, "[]", status).run();
        } else {
          await env.DB.prepare("UPDATE sc_shifts SET status=? WHERE date=? AND half=?")
            .bind(status, date, half).run();
        }
        return json({ ok: true });
      }

      // ---------- Member/Supervisor toggles ----------
      if (url.pathname === "/api/me/reserve" && request.method === "POST") {
        const b = await request.json();
        if (!b?.userId || typeof b.reserve !== "boolean") return json({ error: "userId,reserve required" }, 400);
        await ensureUserColumns(env);
        await env.DB.prepare("UPDATE users SET reserve=? WHERE id=?").bind(b.reserve ? 1 : 0, b.userId).run();
        return json({ ok: true, reserve: !!b.reserve });
      }

      if (url.pathname === "/api/me/inactive" && request.method === "POST") {
        const b = await request.json();
        if (!b?.userId || typeof b.inactive !== "boolean") return json({ error: "userId,inactive required" }, 400);
        await ensureUserColumns(env);
        await env.DB.prepare("UPDATE users SET inactive=? WHERE id=?").bind(b.inactive ? 1 : 0, b.userId).run();
        return json({ ok: true, inactive: !!b.inactive });
      }

      if (url.pathname === "/api/me/type3" && request.method === "POST") {
        const b = await request.json();
        if (!b?.userId || typeof b.type3 !== "boolean") return json({ error: "userId,type3 required" }, 400);
        await ensureUserColumns(env);
        await env.DB.prepare("UPDATE users SET type3_driver=? WHERE id=?").bind(b.type3 ? 1 : 0, b.userId).run();
        return json({ ok: true, type3: !!b.type3 });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: (err && err.message) || String(err) }, 500);
    }
  }
};

// ------------- Utilities -------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function tryJson(s, fallback) {
  try { return JSON.parse(s ?? ""); } catch { return fallback; }
}

function cleanUser(r) {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    member_no: r.member_no,
    can_drive: tryJson(r.can_drive, []),
    notes: r.notes || "",
    inactive: !!r.inactive,
    reserve: !!r.reserve,
    type3_driver: !!r.type3_driver
  };
}

async function ensureSCtables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sc_prefs(
    user_id TEXT PRIMARY KEY, prefer24s INTEGER DEFAULT 0, notes TEXT DEFAULT ''
  );`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sc_availability(
    user_id TEXT NOT NULL, date TEXT NOT NULL,
    half TEXT CHECK(half IN ('AM','PM')) NOT NULL,
    state TEXT CHECK(state IN ('unset','prefer','available','no')) NOT NULL,
    PRIMARY KEY(user_id,date,half)
  );`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sc_shifts(
    date TEXT NOT NULL, half TEXT CHECK(half IN ('AM','PM')) NOT NULL,
    assignees TEXT NOT NULL DEFAULT '[]',
    status TEXT CHECK(status IN ('unassigned','proposed','approved')) NOT NULL DEFAULT 'unassigned',
    PRIMARY KEY(date,half)
  );`).run();

  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sc_availability_date ON sc_availability(date);").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sc_shifts_status ON sc_shifts(status);").run();
}

async function ensureUserColumns(env) {
  const info = await env.DB.prepare("PRAGMA table_info(users)").all();
  const cols = (info.results || []).map(c => c.name);
  const missing = [];
  if (!cols.includes("member_no")) missing.push("ALTER TABLE users ADD COLUMN member_no TEXT DEFAULT ''");
  if (!cols.includes("can_drive")) missing.push("ALTER TABLE users ADD COLUMN can_drive TEXT DEFAULT '[]'");
  if (!cols.includes("notes")) missing.push("ALTER TABLE users ADD COLUMN notes TEXT DEFAULT ''");
  if (!cols.includes("inactive")) missing.push("ALTER TABLE users ADD COLUMN inactive INTEGER DEFAULT 0");
  if (!cols.includes("reserve")) missing.push("ALTER TABLE users ADD COLUMN reserve INTEGER DEFAULT 0");
  if (!cols.includes("type3_driver")) missing.push("ALTER TABLE users ADD COLUMN type3_driver INTEGER DEFAULT 0");
  for (const sql of missing) await env.DB.prepare(sql).run();
}
async function ensureUsersTableHasColumns(env) { return ensureUserColumns(env); }

async function seedShifts(env, days) {
  // today -> today+days
  await env.DB.prepare(`
    WITH RECURSIVE dates(d) AS (
      SELECT date('now')
      UNION ALL
      SELECT date(d, '+1 day') FROM dates WHERE d < date('now', ?)
    )
    INSERT OR IGNORE INTO sc_shifts(date,half,assignees,status)
    SELECT d,'AM','[]','unassigned' FROM dates
    UNION ALL
    SELECT d,'PM','[]','unassigned' FROM dates;
  `).bind(`+${days} day`).run();
}

async function loadShifts(env, start, end) {
  const out = {};
  const res = await env.DB.prepare(
    "SELECT date,half,assignees,status FROM sc_shifts WHERE date>=? AND date<=? ORDER BY date,half"
  ).bind(start, end).all();
  for (const r of (res.results || [])) {
    out[r.date] ||= {};
    out[r.date][r.half] = { assignees: tryJson(r.assignees, []), status: r.status };
  }
  return out;
}

async function loadAvailability(env, start, end) {
  const out = {};
  const res = await env.DB.prepare(
    "SELECT user_id,date,half,state FROM sc_availability WHERE date>=? AND date<=?"
  ).bind(start, end).all();
  for (const r of (res.results || [])) {
    out[r.user_id] ||= {};
    out[r.user_id][r.date] ||= {};
    out[r.user_id][r.date][r.half] = r.state;
  }
  return out;
}

async function loadPrefs(env) {
  const out = {};
  const res = await env.DB.prepare("SELECT user_id,prefer24s,notes FROM sc_prefs").all();
  for (const r of (res.results || [])) {
    out[r.user_id] = { prefer24s: !!r.prefer24s, notes: r.notes || "" };
  }
  return out;
}

function isVolunteerState(s) {
  return s === "prefer" || s === "available";
}
async function getAvail(env, userId, date, half) {
  const row = await env.DB.prepare(
    "SELECT state FROM sc_availability WHERE user_id=? AND date=? AND half=?"
  ).bind(userId, date, half).first();
  return row?.state ?? "unset";
}

// Example hook for auto-scheduler candidate filtering (call when you build candidates)
async function eligibleForAuto(env, user, date, half) {
  if (user.inactive) return false;
  if (user.reserve) {
    const st = await getAvail(env, user.id, date, half);
    return isVolunteerState(st);
  }
  return true;
}

// CSV parser for /api/users/bulk
function parseCsvUsers(text) {
  const rows = [];
  const errors = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { rows, errors: ["CSV empty"] };

  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const idx = (k) => header.indexOf(k);

  const iName = idx("name");
  if (iName < 0) return { rows, errors: ["CSV must include 'name'"] };
  const iRole  = idx("role");
  const iMem   = idx("member_no");
  const iDrive = idx("can_drive");
  const iNotes = idx("notes");
  const iId    = idx("id");
  const iInactive = idx("inactive");
  const iReserve  = idx("reserve");
  const iType3    = idx("type3_driver");

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(s => s.trim());
    const name = cols[iName];
    if (!name) { errors.push(`Row ${i+1}: name missing`); continue; }
    const row = {
      name,
      role: iRole>=0 ? (cols[iRole]||"EMT") : "EMT",
      member_no: iMem>=0 ? (cols[iMem]||"") : "",
      can_drive: iDrive>=0 && cols[iDrive] ? cols[iDrive].split(";").map(s=>s.trim()).filter(Boolean) : [],
      notes: iNotes>=0 ? (cols[iNotes]||"") : "",
      id: iId>=0 && cols[iId] ? cols[iId] : undefined,
      inactive: iInactive>=0 ? ["1","true","yes","y"].includes(cols[iInactive].toLowerCase()) : false,
      reserve:  iReserve>=0 ? ["1","true","yes","y"].includes(cols[iReserve].toLowerCase())   : false,
      type3_driver: iType3>=0 ? ["1","true","yes","y"].includes(cols[iType3].toLowerCase())   : false,
    };
    rows.push(row);
  }
  return { rows, errors };
}
