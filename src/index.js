// src/index.js  (Cloudflare Worker) — restore + extend APIs used by Member/Supervisor
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const send = (code, obj) =>
      new Response(JSON.stringify(obj), {
        status: code,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type,x-import-token",
          "access-control-allow-methods": "GET,POST,OPTIONS",
        },
      });
    if (request.method === "OPTIONS") return send(204, {});

    const q = (n, d = "") => url.searchParams.get(n) ?? d;

    try {
      if (url.pathname === "/api/health") {
        let ok = true;
        try { await env.DB.prepare("select 1").first(); } catch { ok = false; }
        return send(200, { ok, version: "r3", db: ok });
      }

      if (url.pathname === "/api/echo" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        return send(200, { method: request.method, url: url.toString(), body });
      }

      if (url.pathname === "/api/users") {
        const { results } = await env.DB.prepare(
          `SELECT id,name,role,member_no,can_drive,notes,inactive,reserve,type3_driver
           FROM users ORDER BY name`
        ).all();
        return send(200, results.map(r => ({
          ...r,
          can_drive: JSON.parse(r.can_drive || "[]"),
          inactive: !!r.inactive,
          reserve: !!r.reserve,
          type3_driver: !!r.type3_driver,
        })));
      }

      // write flags on a user (inactive / type3; reserve optional)
      if (url.pathname === "/api/user-flags" && request.method === "POST") {
        const b = await request.json().catch(()=> ({}));
        const { userId, inactive, type3_driver, reserve } = b || {};
        if (!userId) return send(400, { error: "userId required" });
        await env.DB.prepare(
          `UPDATE users
             SET inactive = coalesce(?, inactive),
                 type3_driver = coalesce(?, type3_driver),
                 reserve = coalesce(?, reserve)
           WHERE id = ?`
        ).bind(
          typeof inactive === "boolean" ? (inactive ? 1 : 0) : null,
          typeof type3_driver === "boolean" ? (type3_driver ? 1 : 0) : null,
          typeof reserve === "boolean" ? (reserve ? 1 : 0) : null,
          userId
        ).run();
        return send(200, { ok: true });
      }

      // seed shifts
      if (url.pathname === "/api/seed" && request.method === "POST") {
        const tok = request.headers.get("x-import-token");
        if (tok !== env.IMPORT_TOKEN) return send(401, { error: "unauthorized" });
        const days = Math.max(1, Math.min(365, Number(q("days","60"))));
        const sql = `
WITH RECURSIVE dates(d) AS (
  SELECT date('now')
  UNION ALL
  SELECT date(d, '+1 day') FROM dates WHERE d < date('now','+${days-1} day')
)
INSERT OR IGNORE INTO sc_shifts(date,half,assignees,status)
SELECT d,'AM','[]','unassigned' FROM dates
UNION ALL
SELECT d,'PM','[]','unassigned' FROM dates;`;
        await env.DB.exec(sql);
        return send(200, { ok: true, seeded: days*2 });
      }

      // state window
      if (url.pathname === "/api/state") {
        const start = q("start"); const end = q("end");
        if (!start || !end) return send(400, { error: "start,end required" });

        const shifts = await env.DB.prepare(
          `SELECT date,half,assignees,status FROM sc_shifts
           WHERE date BETWEEN ? AND ? ORDER BY date,half`
        ).bind(start,end).all();

        const availability = await env.DB.prepare(
          `SELECT user_id,date,half,state,note FROM sc_availability
           WHERE date BETWEEN ? AND ?`
        ).bind(start,end).all();

        const prefs = await env.DB.prepare(
          `SELECT user_id,prefer24s,notes FROM sc_prefs`
        ).all().catch(()=>({results:[]}));

        const shiftMap = {};
        for (const r of shifts.results) {
          (shiftMap[r.date] ??= {})[r.half] = {
            assignees: JSON.parse(r.assignees || "[]"),
            status: r.status
          };
        }
        const availMap = {};
        for (const r of availability.results) {
          ((availMap[r.user_id] ??= {})[r.date] ??= {})[r.half] = r.state;
        }
        const prefsMap = {};
        for (const r of prefs.results) {
          prefsMap[r.user_id] = { prefer24s: !!r.prefer24s, notes: r.notes || "" };
        }

        return send(200, { shifts: shiftMap, availability: availMap, prefs: prefsMap });
      }

      // availability upsert (+ note)
      if (url.pathname === "/api/availability" && request.method === "POST") {
        const b = await request.json().catch(()=> ({}));
        const { userId, date, half, state } = b || {};
        const note = b.note ?? "";
        if (!userId || !date || !half || !state) return send(400, { error: "userId,date,half,state required" });
        await env.DB.prepare(
          `INSERT INTO sc_availability(user_id,date,half,state,note,updated_at)
           VALUES(?,?,?,?,?,unixepoch())
           ON CONFLICT(user_id,date,half) DO UPDATE SET
             state=excluded.state,note=excluded.note,updated_at=unixepoch()`
        ).bind(userId,date,half,state,note).run();
        return send(200, { ok: true });
      }

      // notes feed for supervisor
      if (url.pathname === "/api/notes") {
        const start = q("start"); const end = q("end");
        if (!start || !end) return send(400, { error: "start,end required" });
        const { results } = await env.DB.prepare(
          `SELECT a.date,a.half,a.note,a.updated_at,u.id as user_id,u.name as user_name
           FROM sc_availability a
           JOIN users u ON u.id=a.user_id
           WHERE a.note <> '' AND a.date BETWEEN ? AND ?
           ORDER BY a.date, CASE a.half WHEN 'AM' THEN 0 ELSE 1 END, a.updated_at DESC`
        ).bind(start,end).all();
        return send(200, { ok: true, count: results.length, notes: results });
      }

      // prefs write
      if (url.pathname === "/api/prefs" && request.method === "POST") {
        const b = await request.json().catch(()=> ({}));
        const { userId, prefer24s, notes } = b || {};
        if (!userId) return send(400, { error:"userId required" });
        await env.DB.prepare(
          `INSERT INTO sc_prefs(user_id,prefer24s,notes)
           VALUES(?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET
             prefer24s=excluded.prefer24s, notes=excluded.notes`
        ).bind(userId, prefer24s?1:0, notes??"").run();
        return send(200, { ok:true });
      }

      return send(404, { error: "not found" });
    } catch (e) {
      return send(500, { error: String(e?.message || e) });
    }
  }
};
