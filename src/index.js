/* src/index.js — ShiftCommander hotfix (pure JS)
   Uses sc_* tables so we don't collide with legacy schemas.
   Endpoints:
     GET  /api/users
     GET  /api/state?start=YYYY-MM-DD&end=YYYY-MM-DD
     POST /api/availability   { userId, date, half:"AM"|"PM", state:"unset|prefer|available|no" }
     POST /api/shift/assign   { date, half, userId }
     POST /api/shift/status   { date, half, status:"unassigned|proposed|approved" }
     POST /api/seed           (ensure next 60 days of AM/PM exist in sc_shifts)
*/

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    try {
      // ----- USERS (unchanged: reads legacy `users`) -----
      if (url.pathname === "/api/users" && request.method === "GET") {
        const res = await env.DB.prepare("SELECT * FROM users ORDER BY name").all();
        const list = (res.results || []).map(r => ({
          ...r,
          can_drive: safeParseJson(r.can_drive, [])
        }));
        return json(list);
      }

      // ----- STATE (reads sc_* tables) -----
      if (url.pathname === "/api/state" && request.method === "GET") {
        const start = url.searchParams.get("start") || "1970-01-01";
        const end   = url.searchParams.get("end")   || "2100-12-31";

        // shifts
        const s = await env.DB
          .prepare("SELECT date, half, assignees, status FROM sc_shifts WHERE date BETWEEN ? AND ?")
          .bind(start, end)
          .all();

        const shifts = {};
        for (const r of (s.results || [])) {
          const d = r.date;
          if (!shifts[d]) shifts[d] = {};
          shifts[d][r.half] = { assignees: safeParseJson(r.assignees, []), status: r.status };
        }

        // availability
        const a = await env.DB
          .prepare("SELECT user_id, date, half, state FROM sc_availability WHERE date BETWEEN ? AND ?")
          .bind(start, end)
          .all();

        const availability = {};
        for (const r of (a.results || [])) {
          if (!availability[r.user_id]) availability[r.user_id] = {};
          if (!availability[r.user_id][r.date]) availability[r.user_id][r.date] = { AM: "unset", PM: "unset" };
          availability[r.user_id][r.date][r.half] = r.state;
        }

        // prefs
        const p = await env.DB
          .prepare("SELECT user_id, prefer24s, notes FROM sc_prefs")
          .all();

        const prefs = {};
        for (const r of (p.results || [])) {
          prefs[r.user_id] = { prefer24s: !!r.prefer24s, notes: r.notes || "" };
        }

        return json({ shifts, availability, prefs });
      }

      // ----- AVAILABILITY (writes sc_availability) -----
      if (url.pathname === "/api/availability" && request.method === "POST") {
        const body = await request.json();
        if (!body.userId || !body.date || !body.half || !body.state) {
          return json({ error: "userId,date,half,state required" }, 400);
        }
        await env.DB.prepare(
          "INSERT INTO sc_availability(user_id,date,half,state) VALUES(?,?,?,?) " +
          "ON CONFLICT(user_id,date,half) DO UPDATE SET state=excluded.state"
        ).bind(body.userId, body.date, body.half, body.state).run();
        return json({ ok: true });
      }

      // ----- SHIFT ASSIGN (writes sc_shifts) -----
      if (url.pathname === "/api/shift/assign" && request.method === "POST") {
        const body = await request.json();
        if (!body.date || !body.half || !body.userId) {
          return json({ error: "date,half,userId required" }, 400);
        }

        await ensureScShift(env.DB, body.date, body.half);

        const row = await env.DB
          .prepare("SELECT assignees, status FROM sc_shifts WHERE date=? AND half=?")
          .bind(body.date, body.half)
          .first();

        const assignees = safeParseJson(row && row.assignees, []);
        const i = assignees.indexOf(body.userId);
        if (i >= 0) assignees.splice(i, 1); else assignees.push(body.userId);

        const nextStatus = assignees.length
          ? (row && row.status === "approved" ? "approved" : "proposed")
          : "unassigned";

        await env.DB
          .prepare("UPDATE sc_shifts SET assignees=?, status=? WHERE date=? AND half=?")
          .bind(JSON.stringify(assignees), nextStatus, body.date, body.half)
          .run();

        return json({ assignees, status: nextStatus });
      }

      // ----- SHIFT STATUS (writes sc_shifts) -----
      if (url.pathname === "/api/shift/status" && request.method === "POST") {
        const body = await request.json();
        if (!body.date || !body.half || !body.status) {
          return json({ error: "date,half,status required" }, 400);
        }
        await ensureScShift(env.DB, body.date, body.half);
        await env.DB
          .prepare("UPDATE sc_shifts SET status=? WHERE date=? AND half=?")
          .bind(body.status, body.date, body.half)
          .run();
        return json({ ok: true });
      }

      // ----- SEED (ensure next 60d exist in sc_shifts) -----
      if (url.pathname === "/api/seed" && request.method === "POST") {
        const now = new Date();
        for (let i = 0; i < 60; i++) {
          const d = new Date(now);
          d.setDate(d.getDate() + i);
          const k = d.toISOString().slice(0, 10);
          await ensureScShift(env.DB, k, "AM");
          await ensureScShift(env.DB, k, "PM");
        }
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: (err && err.message) || String(err) }, 500);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function safeParseJson(s, fallback) {
  try { return JSON.parse(s ?? ""); } catch { return fallback; }
}

async function ensureScShift(DB, date, half) {
  const row = await DB
    .prepare("SELECT 1 FROM sc_shifts WHERE date=? AND half=?")
    .bind(date, half)
    .first();
  if (!row) {
    await DB
      .prepare("INSERT INTO sc_shifts(date, half, assignees, status) VALUES(?,?,?,?)")
      .bind(date, half, "[]", "unassigned")
      .run();
  }
}
