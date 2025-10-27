// src/index.ts — ShiftCommander hotfix: use sc_* tables to avoid legacy collisions.
// Endpoints provided here:
//   GET  /api/users                     (unchanged; reads existing `users` table)
//   GET  /api/state?start=YYYY-MM-DD&end=YYYY-MM-DD   (uses sc_shifts, sc_availability, sc_prefs)
//   POST /api/availability              (writes sc_availability)
//   POST /api/shift/assign              (writes sc_shifts)
//   POST /api/shift/status              (writes sc_shifts)
//   POST /api/seed                      (fills sc_shifts for the next 60 days)

export default {
  async fetch(request: Request, env: any): Promise<Response> {
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
      // ----- USERS (unchanged) -----
      if (url.pathname === "/api/users" && request.method === "GET") {
        const res = await env.DB.prepare("SELECT * FROM users ORDER BY name").all();
        const list = (res.results || []).map((r: any) => ({
          ...r,
          can_drive: safeParseJson(r.can_drive, [])
        }));
        return json(list);
      }

      // ----- STATE (now reads sc_* tables) -----
      if (url.pathname === "/api/state" && request.method === "GET") {
        const start = url.searchParams.get("start") || "1970-01-01";
        const end   = url.searchParams.get("end")   || "2100-12-31";

        // shifts
        const s = await env.DB
          .prepare("SELECT date, half, assignees, status FROM sc_shifts WHERE date BETWEEN ? AND ?")
          .bind(start, end)
          .all();

        const shifts: Record<string, any> = {};
        for (const r of (s.results || [])) {
          const d = r.date;
          if (!shifts[d]) shifts[d] = {};
          shifts[d][r.half] = {
            assignees: safeParseJson(r.assignees, []),
            status: r.status
          };
        }

        // availability
        const a = await env.DB
          .prepare("SELECT user_id, date, half, state FROM sc_availability WHERE date BETWEEN ? AND ?")
          .bind(start, end)
          .all();

        const availability: Record<string, any> = {};
        for (const r of (a.results || [])) {
          if (!availability[r.user_id]) availability[r.user_id] = {};
          if (!availability[r.user_id][r.date]) availability[r.user_id][r.date] = { AM: "unset", PM: "unset" };
          availability[r.user_id][r.date][r.half] = r.state;
        }

        // prefs
        const p = await env.DB
          .prepare("SELECT user_id, prefer24s, notes FROM sc_prefs")
          .all();

        const prefs: Record<string, any> = {};
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

        const assignees: string[] = safeParseJson(row?.assignees, []);
        const i = assignees.indexOf(body.userId);
        if (i >= 0) assignees.splice(i, 1); else assignees.push(body.userId);

        const nextStatus = assignees.length
          ? (row?.status === "approved" ? "approved" : "proposed")
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

      // ----- SEED (fills sc_shifts forward 60d) -----
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
    } catch (err: any) {
      return json({ error: err?.message || String(err) }, 500);
    }
  }
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function safeParseJson(s: any, fallback: any) {
  try { return JSON.parse(s ?? ""); } catch { return fallback; }
}

async function ensureScShift(DB: any, date: string, half: "AM"|"PM") {
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
