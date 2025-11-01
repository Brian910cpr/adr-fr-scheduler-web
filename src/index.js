// worker/index.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // -- CORS helpers
    const corsify = (resp, origin="*") => {
      const r = new Response(resp.body, resp);
      r.headers.set("Access-Control-Allow-Origin", origin);
      r.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      r.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      r.headers.set("Access-Control-Max-Age", "86400");
      r.headers.set("Vary", "Origin");
      return r;
    };
    if (request.method === "OPTIONS") {
      return corsify(new Response(null, { status: 204 }));
    }

    // -- health
    if (url.pathname === "/api/health") {
      return corsify(new Response(JSON.stringify({ ok:true, version:"r3", db:true }), {
        status: 200, headers: { "Content-Type":"application/json" }
      }));
    }

    // -- read window
    if (url.pathname === "/api/state" && request.method === "GET") {
      const start = url.searchParams.get("start");
      const end   = url.searchParams.get("end");
      if (!start || !end) {
        return corsify(new Response(JSON.stringify({ error:"start,end required" }), {
          status:400, headers:{ "Content-Type":"application/json" }
        }));
      }
      const dates = []; { let d=new Date(start+"T12:00:00Z"), to=new Date(end+"T12:00:00Z");
        while(d<=to){ dates.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate()+1); } }
      const placeholders = dates.map(()=>"?").join(",");
      const rs = await env.DB.prepare(
        `SELECT user_id,date,half,state,COALESCE(note,'') AS note
         FROM sc_availability WHERE date IN (${placeholders})`
      ).bind(...dates).all();

      const availability = {};
      for (const row of (rs.results||[])) {
        availability[row.user_id] ??= {};
        availability[row.user_id][row.date] ??= { AM:"unset", PM:"unset", notes:{ AM:"", PM:"" } };
        availability[row.user_id][row.date][row.half] = row.state || "unset";
        availability[row.user_id][row.date].notes[row.half] = row.note || "";
      }
      const shifts = {};
      for (const d of dates) shifts[d] = { AM:{assignees:[],status:"unassigned"}, PM:{assignees:[],status:"unassigned"} };

      return corsify(new Response(JSON.stringify({ shifts, availability, prefs:{} }), {
        status:200, headers:{ "Content-Type":"application/json" }
      }));
    }

    // -- write availability (camelCase required)
    if (url.pathname === "/api/availability" && request.method === "POST") {
      let b={}; try{ b=await request.json(); }catch{}
      const { userId, date, half, state } = b;
      const note = typeof b.note === "string" ? b.note : null;
      if (!userId || !date || !half || !state) {
        return corsify(new Response(JSON.stringify({ error:"userId,date,half,state required" }), {
          status:400, headers:{ "Content-Type":"application/json" }
        }));
      }
      await env.DB.prepare(`
        INSERT INTO sc_availability (user_id,date,half,state,note,updated_at)
        VALUES (?1,?2,?3,?4,COALESCE(?5,''),unixepoch())
        ON CONFLICT(user_id,date,half) DO UPDATE SET
          state=excluded.state, note=COALESCE(excluded.note,''), updated_at=unixepoch()
      `).bind(userId, date, half, state, note).run();

      return corsify(new Response(JSON.stringify({ ok:true }), {
        status:200, headers:{ "Content-Type":"application/json" }
      }));
    }

    return corsify(new Response(JSON.stringify({ error:"not found" }), {
      status:404, headers:{ "Content-Type":"application/json" }
    }));
  }
}
