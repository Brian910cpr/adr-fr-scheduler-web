export default {
  async fetch(request, env, ctx) {
    // CORS helper
    const cors = (resp, origin = "*") => {
      const r = new Response(resp.body, resp);
      r.headers.set("Access-Control-Allow-Origin", origin);
      r.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      r.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      r.headers.set("Access-Control-Max-Age", "86400");
      return r;
    };

    // Preflight
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    // Health
    if (url.pathname === "/api/health") {
      const body = JSON.stringify({ ok: true, version: "r3", db: true });
      return cors(new Response(body, { status: 200, headers: { "Content-Type": "application/json" }}));
    }

    // Read state window
    if (url.pathname === "/api/state" && request.method === "GET") {
      const start = url.searchParams.get("start");
      const end   = url.searchParams.get("end");
      if (!start || !end) {
        return cors(new Response(JSON.stringify({ error: "start,end required" }), { status: 400, headers: { "Content-Type": "application/json" }}));
      }

      // Build a date list (inclusive)
      const dates = [];
      {
        let d = new Date(start + "T12:00:00Z");
        const to = new Date(end   + "T12:00:00Z");
        while (d <= to) {
          dates.push(d.toISOString().slice(0,10));
          d.setUTCDate(d.getUTCDate() + 1);
        }
      }

      // Pull availability for the span
      const placeholders = dates.map(_ => "?").join(",");
      const sql = `
        SELECT user_id, date, half, state, COALESCE(note,'') AS note
        FROM sc_availability
        WHERE date IN (${placeholders})
      `;
      const rs = await env.DB.prepare(sql).bind(...dates).all();

      // Shape into { availability: { userId: { date: { AM, PM, notes }}}}
      const availability = {};
      for (const row of rs.results ?? []) {
        availability[row.user_id] ??= {};
        availability[row.user_id][row.date] ??= { AM: "unset", PM: "unset", notes: { AM:"", PM:"" } };
        availability[row.user_id][row.date][row.half] = row.state || "unset";
        availability[row.user_id][row.date].notes[row.half] = row.note || "";
      }

      // Shifts stub (unchanged)
      const shifts = {};
      for (const d of dates) {
        shifts[d] = { AM: { assignees: [], status: "unassigned" }, PM: { assignees: [], status: "unassigned" } };
      }

      return cors(new Response(JSON.stringify({ shifts, availability, prefs: {} }), {
        status: 200, headers: { "Content-Type": "application/json" }
      }));
    }

    // Write availability (strict camelCase)
    if (url.pathname === "/api/availability" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { body = {}; }

      const userId = body.userId;
      const date   = body.date;
      const half   = body.half;   // 'AM' | 'PM'
      const state  = body.state;  // 'prefer' | 'available' | 'unset' | 'no'
      const note   = typeof body.note === "string" ? body.note : null;

      if (!userId || !date || !half || !state) {
        return cors(new Response(JSON.stringify({ error: "userId,date,half,state required" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        }));
      }

      // Upsert; updated_at handled via trigger or use unixepoch() here
      await env.DB.prepare(`
        INSERT INTO sc_availability (user_id, date, half, state, note, updated_at)
        VALUES (?1, ?2, ?3, ?4, COALESCE(?5,''), unixepoch())
        ON CONFLICT(user_id, date, half) DO UPDATE SET
          state = excluded.state,
          note  = COALESCE(excluded.note,''),
          updated_at = unixepoch()
      `).bind(userId, date, half, state, note).run();

      return cors(new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" }
      }));
    }

    return cors(new Response(JSON.stringify({ error: "not found" }), {
      status: 404, headers: { "Content-Type": "application/json" }
    }));
  }
}
