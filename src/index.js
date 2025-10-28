// FILE: src/index.js
// ShiftCommander — API (Cloudflare Worker, D1)
// Adds:
//  • 4-way availability (prefer|available|unset|no)
//  • Per-shift member notes (note + approved flag)
//  • Member flags: type3_driver, inactive
//  • Frictionless Shift Swap endpoint
//  • Supervisor note-approval endpoint
//
// D1 tables used (REMOTE):
//   users(id TEXT PK, name TEXT, role TEXT, member_no TEXT, can_drive TEXT, notes TEXT,
//         type3_driver INTEGER DEFAULT 0, inactive INTEGER DEFAULT 0)
//   sc_prefs(user_id TEXT PK, prefer24s INTEGER DEFAULT 0, notes TEXT DEFAULT '')
//   sc_availability(user_id TEXT, date TEXT, half 'AM'|'PM', state 'unset'|'prefer'|'available'|'no',
//                   note TEXT DEFAULT '', note_approved INTEGER DEFAULT 1,
//                   PRIMARY KEY(user_id,date,half))
//   sc_shifts(date TEXT, half 'AM'|'PM', assignees TEXT JSON, status 'unassigned'|'proposed'|'approved',
//             PRIMARY KEY(date,half))
//
// CORS is open by default for now.

const API_ORIGIN = "*";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    try {
      // ----- Migrations/seed helpers -----
      if (url.pathname === "/api/seed" && request.method === "POST") {
        await migrate(env.DB);
        // Seed 180 days AM/PM if missing
        const today = new Date();
        for (let i = 0; i < 180; i++) {
          const d = new Date(today); d.setDate(d.getDate() + i);
          const k = d.toISOString().slice(0, 10);
          await ensureShift(env.DB, k, "AM");
          await ensureShift(env.DB, k, "PM");
        }
        return json({ ok: true }, 200);
      }

      // ----- Users -----
      if (url.pathname === "/api/users" && request.method === "GET") {
        const rows = await env.DB
          .prepare("SELECT id,name,role,member_no,can_drive,notes,type3_driver,inactive FROM users ORDER BY name")
          .all();
        const out = (rows.results || []).map(r => ({
          ...r,
          can_drive: safeParse(r.can_drive, []),
          type3_driver: !!r.type3_driver,
          inactive: !!r.inactive
        }));
        return json(out, 200);
      }

      // Update member flags: type3_driver / inactive (Supervisor)
      if (url.pathname === "/api/user/flags" && request.method === "POST") {
        const b = await request.json();
        if (!b.userId) return json({ error: "userId required" }, 400);
        await env.DB
          .prepare("UPDATE users SET type3_driver=COALESCE(?,type3_driver), inactive=COALESCE(?,inactive) WHERE id=?")
          .bind(bool01(b.type3_driver), bool01(b.inactive), b.userId)
          .run();
        return json({ ok: true }, 200);
      }

      // ----- State payload for a window -----
      if (url.pathname === "/api/state" && request.method === "GET") {
        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");
        if (!start || !end) return json({ error: "start,end required (yyyy-mm-dd)" }, 400);

        const shiftsRows = await env.DB
          .prepare("SELECT date,half,assignees,status FROM sc_shifts WHERE date BETWEEN ? AND ?")
          .bind(start, end).all();

        const avRows = await env.DB
          .prepare("SELECT user_id,date,half,state,note,note_approved FROM sc_availability WHERE date BETWEEN ? AND ?")
          .bind(start, end).all();

        const prefsRows = await env.DB
          .prepare("SELECT user_id, prefer24s, notes FROM sc_prefs")
          .all();

        const usersRows = await env.DB
          .prepare("SELECT id,name,role,type3_driver,inactive FROM users")
          .all();

        const shifts = {};
        (shiftsRows.results || []).forEach(r => {
          (shifts[r.date] ||= {});
          shifts[r.date][r.half] = { assignees: safeParse(r.assignees, []), status: r.status };
        });

        const availability = {};
        (avRows.results || []).forEach(r => {
          (availability[r.user_id] ||= {});
          const d = (availability[r.user_id][r.date] ||= { AM: null, PM: null });
          d[r.half] = { state: r.state, note: r.note || "", note_approved: !!r.note_approved };
        });

        const prefs = {};
        (prefsRows.results || []).forEach(p => prefs[p.user_id] = { prefer24s: !!p.prefer24s, notes: p.notes || "" });

        const users = {};
        (usersRows.results || []).forEach(u => users[u.id] = {
          name: u.name, role: u.role, type3_driver: !!u.type3_driver, inactive: !!u.inactive
        });

        return json({ shifts, availability, prefs, users }, 200);
      }

      // ----- Availability (4-way) + per-shift note (member) -----
      if (url.pathname === "/api/availability" && request.method === "POST") {
        const b = await request.json();
        if (!b.userId || !b.date || !b.half || !b.state)
          return json({ error: "userId,date,half,state required" }, 400);

        await env.DB.prepare(
          "INSERT INTO sc_availability(user_id,date,half,state,note,note_approved) VALUES(?,?,?,?,?,?) " +
          "ON CONFLICT(user_id,date,half) DO UPDATE SET state=excluded.state," +
          "  note=COALESCE(excluded.note,sc_availability.note)," +
          "  note_approved=CASE WHEN excluded.note IS NOT NULL THEN 0 ELSE sc_availability.note_approved END"
        ).bind(
          b.userId, b.date, b.half, normState(b.state),
          b.note ?? null,
          b.note ? 0 : 1
        ).run();

        return json({ ok: true }, 200);
      }

      // Approve/clear a note (Supervisor)
      if (url.pathname === "/api/note/approve" && request.method === "POST") {
        const b = await request.json();
        if (!b.userId || !b.date || !b.half) return json({ error: "userId,date,half required" }, 400);
        await env.DB.prepare(
          "UPDATE sc_availability SET note_approved=?, note=COALESCE(note,'') WHERE user_id=? AND date=? AND half=?"
        ).bind(bool01(b.approved ?? 1), b.userId, b.date, b.half).run();
        return json({ ok: true }, 200);
      }

      // Assign/unassign (Supervisor or system)
      if (url.pathname === "/api/shift/assign" && request.method === "POST") {
        const b = await request.json();
        if (!b.date || !b.half || !b.userId) return json({ error: "date,half,userId required" }, 400);
        await ensureShift(env.DB, b.date, b.half);
        const row = await env.DB.prepare("SELECT assignees,status FROM sc_shifts WHERE date=? AND half=?")
          .bind(b.date, b.half).first();
        const arr = safeParse(row?.assignees, []);
        const i = arr.indexOf(b.userId);
        if (i >= 0) arr.splice(i, 1); else arr.push(b.userId);
        const next = arr.length ? (row?.status === "approved" ? "approved" : "proposed") : "unassigned";
        await env.DB.prepare("UPDATE sc_shifts SET assignees=?, status=? WHERE date=? AND half=?")
          .bind(JSON.stringify(arr), next, b.date, b.half).run();
        return json({ assignees: arr, status: next }, 200);
      }

      if (url.pathname === "/api/shift/status" && request.method === "POST") {
        const b = await request.json();
        if (!b.date || !b.half || !b.status) return json({ error: "date,half,status required" }, 400);
        await ensureShift(env.DB, b.date, b.half);
        await env.DB.prepare("UPDATE sc_shifts SET status=? WHERE date=? AND half=?")
          .bind(b.status, b.date, b.half).run();
        return json({ ok: true }, 200);
      }

      // ----- Frictionless Shift Swap -----
      // POST body: { userId, date, half, replacementId? }
      // If replacementId provided and eligible => swap & approve.
      // If not provided => returns a suggestion list (eligible members).
      if (url.pathname === "/api/shift/swap" && request.method === "POST") {
        const b = await request.json();
        if (!b.userId || !b.date || !b.half) return json({ error: "userId,date,half required" }, 400);

        // Current assignees
        const row = await env.DB.prepare("SELECT assignees,status FROM sc_shifts WHERE date=? AND half=?")
          .bind(b.date, b.half).first();
        const assignees = safeParse(row?.assignees, []);
        if (!assignees.includes(b.userId)) {
          return json({ error: "user not currently assigned" }, 400);
        }

        // Build eligibles (very lightweight scoring gate here)
        const elig = await env.DB.prepare(
          "SELECT id,name,role,inactive FROM users WHERE inactive=0"
        ).all();

        // avail states that allow assignment
        const av = await env.DB.prepare(
          "SELECT user_id,state FROM sc_availability WHERE date=? AND half=?"
        ).bind(b.date, b.half).all();
        const byUser = new Map((av.results || []).map(r => [r.user_id, r.state]));

        const eligible = (elig.results || []).filter(u => {
          const st = byUser.get(u.id) || "unset";
          // allow prefer/available/unset but not explicit 'no'
          if (st === "no") return false;
          if (assignees.includes(u.id)) return false;
          return true;
        }).map(u => ({ id: u.id, name: u.name, role: u.role }));

        if (!b.replacementId) {
          return json({ suggestions: eligible.slice(0, 12) }, 200);
        }

        // Perform swap if replacementId eligible
        const ok = eligible.find(e => e.id === b.replacementId);
        if (!ok) return json({ error: "replacement not eligible" }, 400);

        // swap in the array
        const idx = assignees.indexOf(b.userId);
        assignees.splice(idx, 1, b.replacementId);

        await env.DB.prepare("UPDATE sc_shifts SET assignees=?, status=? WHERE date=? AND half=?")
          .bind(JSON.stringify(assignees), "approved", b.date, b.half).run();

        return json({ ok: true, assignees }, 200);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  }
};

// ---------- helpers ----------
function cors() {
  return {
    "Access-Control-Allow-Origin": API_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors() } });
}
function safeParse(s, d) { try { return JSON.parse(s ?? ""); } catch { return d; } }
function bool01(v) { return v === undefined || v === null ? null : (v ? 1 : 0); }
function normState(s) {
  const k = String(s || "").toLowerCase();
  if (k === "prefer") return "prefer";
  if (k === "available") return "available";
  if (k === "no") return "no";
  return "unset";
}
async function ensureShift(DB, date, half) {
  const r = await DB.prepare("SELECT 1 FROM sc_shifts WHERE date=? AND half=?").bind(date, half).first();
  if (!r) await DB.prepare("INSERT INTO sc_shifts(date,half,assignees,status) VALUES(?,?,?,?)")
    .bind(date, half, "[]", "unassigned").run();
}
async function migrate(DB) {
  // ensure sc_* tables exist
  await DB.prepare(`CREATE TABLE IF NOT EXISTS sc_prefs(
    user_id TEXT PRIMARY KEY, prefer24s INTEGER DEFAULT 0, notes TEXT DEFAULT ''
  )`).run();

  await DB.prepare(`CREATE TABLE IF NOT EXISTS sc_availability(
    user_id TEXT NOT NULL, date TEXT NOT NULL, half TEXT CHECK(half IN ('AM','PM')) NOT NULL,
    state TEXT CHECK(state IN ('unset','prefer','available','no')) NOT NULL,
    note TEXT DEFAULT '', note_approved INTEGER DEFAULT 1,
    PRIMARY KEY(user_id,date,half)
  )`).run();

  await DB.prepare(`CREATE TABLE IF NOT EXISTS sc_shifts(
    date TEXT NOT NULL, half TEXT CHECK(half IN ('AM','PM')) NOT NULL,
    assignees TEXT NOT NULL DEFAULT '[]',
    status TEXT CHECK(status IN ('unassigned','proposed','approved')) NOT NULL DEFAULT 'unassigned',
    PRIMARY KEY(date, half)
  )`).run();

  // add columns on users if missing
  const u = await DB.prepare("PRAGMA table_info(users)").all();
  const cols = (u.results || []).map(c => c.name);
  if (!cols.includes("type3_driver")) {
    await DB.prepare("ALTER TABLE users ADD COLUMN type3_driver INTEGER DEFAULT 0").run();
  }
  if (!cols.includes("inactive")) {
    await DB.prepare("ALTER TABLE users ADD COLUMN inactive INTEGER DEFAULT 0").run();
  }

  // add note columns on sc_availability if migrating from older simple table
  const a = await DB.prepare("PRAGMA table_info(sc_availability)").all();
  const acols = (a.results || []).map(c => c.name);
  if (!acols.includes("note")) {
    await DB.prepare("ALTER TABLE sc_availability ADD COLUMN note TEXT DEFAULT ''").run();
  }
  if (!acols.includes("note_approved")) {
    await DB.prepare("ALTER TABLE sc_availability ADD COLUMN note_approved INTEGER DEFAULT 1").run();
  }
}
