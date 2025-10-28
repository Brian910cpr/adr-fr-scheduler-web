// src/index.js
// Cloudflare Worker for ADR-FR Scheduler API
// Requires in wrangler.toml:
// name = "adr-fr-scheduler-api"
// main = "src/index.js"
// compatibility_date = "2024-11-01"
// [vars]
// IMPORT_TOKEN = "qwerty123"
// [[d1_databases]]
// binding = "DB"
// database_name = "adr_fr"
// database_id = "<your-d1-id>"

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      // ROUTES
      if (req.method === "GET" && pathname === "/api/health") {
        return cors(await handleHealth(env));
      }

      if (req.method === "POST" && pathname === "/api/echo") {
        const body = await safeJson(req);
        return cors(json({ method: req.method, url: req.url, body }));
      }

      // Data seed (protected)
      if (req.method === "POST" && pathname === "/api/seed") {
        return cors(await handleSeed(url, req, env));
      }

      // Users
      if (req.method === "GET" && pathname === "/api/users") {
        return cors(await handleUsers(env));
      }

      // State window
      if (req.method === "GET" && pathname === "/api/state") {
        return cors(await handleState(url, env));
      }

      // Availability upsert
      if (req.method === "POST" && pathname === "/api/availability") {
        return cors(await handleAvailability(req, env));
      }

      // Per-day note upsert
      if (req.method === "POST" && pathname === "/api/note") {
        return cors(await handleNote(req, env));
      }

      // User flags (protected)
      if (req.method === "POST" && pathname === "/api/user-flags") {
        return cors(await handleUserFlags(req, env));
      }

      return cors(json({ error: "not found" }, 404));
    } catch (err) {
      console.error("UNCAUGHT", err);
      return cors(json({ error: err?.message || "server error" }, 500));
    }
  },
};

/* ========================= Handlers ========================= */

async function handleHealth(env) {
  // confirm worker+db wiring
  try {
    const r = await env.DB.prepare("SELECT 1 as ok").first();
    return json({ ok: true, version: "r3", db: !!r });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function handleSeed(url, req, env) {
  requireToken(req, env);
  const days = clampInt(parseInt(url.searchParams.get("days") || "60", 10), 1, 365);
  // Create sc_shifts if missing
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS sc_shifts(
      date TEXT NOT NULL,
      half TEXT NOT NULL CHECK(half IN ('AM','PM')),
      assignees TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'unassigned',
      PRIMARY KEY(date, half)
    );
  `);

  // Fill next N days (today + N-1)
  const sql = `
    WITH RECURSIVE dates(d) AS (
      SELECT date('now')
      UNION ALL
      SELECT date(d, '+1 day') FROM dates WHERE d < date('now', ?)
    )
    INSERT OR IGNORE INTO sc_shifts(date, half, assignees, status)
    SELECT d,'AM','[]','unassigned' FROM dates
    UNION ALL
    SELECT d,'PM','[]','unassigned' FROM dates
  `;
  // date('now', '+(days-1) day')
  const lastOffset = `+${days - 1} day`;
  await env.DB.prepare(sql).bind(lastOffset).run();

  return json({ ok: true, seeded: days * 2 });
}

async function handleUsers(env) {
  // Ensure table present (no-op if exists)
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      member_no TEXT DEFAULT '',
      can_drive TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      inactive INTEGER NOT NULL DEFAULT 0,
      reserve  INTEGER NOT NULL DEFAULT 0,
      type3_driver INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Return all users
  const rows = await env.DB.prepare(
    "SELECT id,name,role,member_no,can_drive,notes,inactive,reserve,type3_driver FROM users ORDER BY name"
  ).all();

  const users = (rows?.results || []).map(row => ({
    id: row.id,
    name: row.name,
    role: row.role,
    member_no: row.member_no || "",
    can_drive: parseMaybeJSON(row.can_drive, []),
    notes: row.notes || "",
    inactive: !!row.inactive,
    reserve: !!row.reserve,
    type3_driver: !!row.type3_driver,
  }));

  return json(users);
}

async function handleState(url, env) {
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!isISODate(start) || !isISODate(end)) {
    return json({ error: "start/end must be YYYY-MM-DD" }, 400);
  }

  // Ensure tables
  await ensureTables(env);

  // Shifts in window
  const shiftsRows = await env.DB.prepare(
    "SELECT date, half, assignees, status FROM sc_shifts WHERE date BETWEEN ? AND ? ORDER BY date, half"
  ).bind(start, end).all();

  // Availability for users in window
  const avRows = await env.DB.prepare(
    "SELECT user_id, date, half, state FROM sc_availability WHERE date BETWEEN ? AND ?"
  ).bind(start, end).all();

  // Basic prefs (optional; empty defaults)
  const prefRows = await env.DB.prepare(
    "SELECT user_id, prefer24s, notes FROM sc_prefs"
  ).all().catch(() => ({ results: [] })); // if table missing

  const result = {
    shifts: {},        // date -> { AM:{assignees,status}, PM:{...} }
    availability: {},  // user_id -> date -> {AM,PM}
    prefs: {},         // user_id -> { prefer24s, notes }
  };

  // Compose shifts
  for (const r of (shiftsRows?.results || [])) {
    result.shifts[r.date] ||= {};
    result.shifts[r.date][r.half] = {
      assignees: parseMaybeJSON(r.assignees, []),
      status: r.status || "unassigned",
    };
  }

  // Compose availability
  for (const r of (avRows?.results || [])) {
    result.availability[r.user_id] ||= {};
    result.availability[r.user_id][r.date] ||= {};
    result.availability[r.user_id][r.date][r.half] = r.state; // "prefer" | "available" | "unset" | "no"
  }

  // Compose prefs
  for (const r of (prefRows?.results || [])) {
    result.prefs[r.user_id] = {
      prefer24s: !!r.prefer24s,
      notes: r.notes || "",
    };
  }

  return json(result);
}

async function handleAvailability(req, env) {
  const body = await safeJson(req);
  const { user_id, date, half, state } = body || {};

  if (!user_id || !isISODate(date) || !["AM", "PM"].includes(half) ||
      !["prefer", "available", "unset", "no"].includes(state)) {
    return json({ error: "Invalid payload" }, 400);
  }

  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS sc_availability(
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      half TEXT NOT NULL CHECK(half IN ('AM','PM')),
      state TEXT NOT NULL,
      PRIMARY KEY(user_id,date,half)
    );
  `);

  await env.DB.prepare(`
    INSERT INTO sc_availability(user_id,date,half,state)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id,date,half) DO UPDATE SET state=excluded.state
  `).bind(user_id, date, half, state).run();

  return json({ ok: true });
}

async function handleNote(req, env) {
  const body = await safeJson(req);
  const { user_id, date, note } = body || {};
  if (!user_id || !isISODate(date) || typeof note !== "string") {
    return json({ error: "Invalid payload" }, 400);
  }

  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS sc_notes(
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(user_id, date)
    );
  `);

  await env.DB.prepare(`
    INSERT INTO sc_notes(user_id,date,note)
    VALUES(?,?,?)
    ON CONFLICT(user_id,date) DO UPDATE SET note=excluded.note
  `).bind(user_id, date, note.slice(0, 200)).run();

  return json({ ok: true });
}

async function handleUserFlags(req, env) {
  requireToken(req, env);
  const body = await safeJson(req);
  const { user_id, inactive, reserve, type3_driver } = body || {};
  if (!user_id) return json({ error: "user_id required" }, 400);

  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      member_no TEXT DEFAULT '',
      can_drive TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      inactive INTEGER NOT NULL DEFAULT 0,
      reserve  INTEGER NOT NULL DEFAULT 0,
      type3_driver INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Ensure user exists; if not, no-op with 404
  const exists = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(user_id).first();
  if (!exists) return json({ error: "user not found" }, 404);

  await env.DB.prepare(`
    UPDATE users
    SET inactive = ?, reserve = ?, type3_driver = ?
    WHERE id = ?
  `).bind(boolToInt(inactive), boolToInt(reserve), boolToInt(type3_driver), user_id).run();

  return json({ ok: true });
}

/* ========================= Helpers ========================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Import-Token");
  return new Response(res.body, { status: res.status, headers: h });
}

async function safeJson(req) {
  try {
    const txt = await req.text();
    return txt ? JSON.parse(txt) : {};
  } catch {
    return {};
  }
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function boolToInt(v) { return v ? 1 : 0; }
function clampInt(n, min, max) { return isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }

function parseMaybeJSON(s, fallback) {
  if (!s || typeof s !== "string") return fallback;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
}

async function ensureTables(env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS sc_shifts(
      date TEXT NOT NULL,
      half TEXT NOT NULL CHECK(half IN ('AM','PM')),
      assignees TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'unassigned',
      PRIMARY KEY(date, half)
    );
    CREATE TABLE IF NOT EXISTS sc_availability(
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      half TEXT NOT NULL CHECK(half IN ('AM','PM')),
      state TEXT NOT NULL,
      PRIMARY KEY(user_id,date,half)
    );
    CREATE TABLE IF NOT EXISTS sc_prefs(
      user_id TEXT PRIMARY KEY,
      prefer24s INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT ''
    );
  `);
}

function requireToken(req, env) {
  const token = req.headers.get("X-Import-Token") || "";
  if (!env.IMPORT_TOKEN || token !== env.IMPORT_TOKEN) {
    throw new ErrorJSON("unauthorized", 401);
  }
}

class ErrorJSON extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Top-level error mapping for requireToken
const originalFetch = exportDefaultFetchWrapper();
function exportDefaultFetchWrapper() {
  // No-op: we already exported default above; this helper is a placeholder to keep lints calm.
  return null;
}
