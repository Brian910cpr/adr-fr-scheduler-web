// Cloudflare Worker (Modules) — ShiftCommander API
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const { pathname, searchParams } = url;

      // simple router
      if (pathname === "/api/users" && request.method === "GET") {
        const rows = await qAll(env.DB, `SELECT id, name, role,
                 COALESCE(member_no,'') member_no,
                 COALESCE(can_drive,'[]') can_drive,
                 COALESCE(notes,'') notes,
                 COALESCE(inactive,0) inactive,
                 COALESCE(reserve,0) reserve,
                 COALESCE(type3_driver,0) type3_driver
               FROM users ORDER BY name`);
        return json(rows);
      }

      if (pathname === "/api/state" && request.method === "GET") {
        const start = searchParams.get("start");
        const end   = searchParams.get("end");
        if (!start || !end) return json({ error: "start/end required" }, 400);

        const avail = await qAll(env.DB, `SELECT user_id, date, half, state
                                           FROM sc_availability
                                           WHERE date BETWEEN ? AND ?`, [start, end]);

        const shifts = await qAll(env.DB, `SELECT date, half, assignees, status
                                           FROM sc_shifts
                                           WHERE date BETWEEN ? AND ?`, [start, end]);

        const prefs = await qAll(env.DB, `SELECT user_id, prefer24s, notes FROM sc_prefs`);

        const users = await qAll(env.DB, `SELECT id, name, role,
                 COALESCE(inactive,0) inactive, COALESCE(reserve,0) reserve,
                 COALESCE(type3_driver,0) type3_driver FROM users`);

        // shape
        const availability = {};
        for (const r of avail) {
          availability[r.user_id] ||= {};
          availability[r.user_id][r.date] ||= { AM: "unset", PM: "unset" };
          availability[r.user_id][r.date][r.half] = r.state;
        }

        const shiftMap = {};
        for (const r of shifts) {
          shiftMap[r.date] ||= {};
          shiftMap[r.date][r.half] = {
            assignees: JSON.parse(r.assignees || "[]"),
            status: r.status || "unassigned",
          };
        }

        const prefMap = {};
        for (const r of prefs) prefMap[r.user_id] = { prefer24s: !!r.prefer24s, notes: r.notes||"" };

        return json({ shifts: shiftMap, availability, prefs: prefMap, users });
      }

      if (pathname === "/api/availability" && request.method === "POST") {
        const { userId, date, half, state } = await request.json();
        await qRun(env.DB, `INSERT INTO sc_availability(user_id,date,half,state)
                            VALUES(?,?,?,?)
                            ON CONFLICT(user_id,date,half) DO UPDATE SET state=excluded.state`,
                   [userId, date, half, state]);
        return json({ ok: true });
      }

      if (pathname === "/api/prefs" && request.method === "POST") {
        const { userId, prefer24s, notes } = await request.json();
        await qRun(env.DB, `INSERT INTO sc_prefs(user_id, prefer24s, notes)
                            VALUES(?,?,?)
                            ON CONFLICT(user_id) DO UPDATE SET prefer24s=excluded.prefer24s, notes=COALESCE(excluded.notes, sc_prefs.notes)`,
                   [userId, prefer24s ? 1 : 0, notes ?? null]);
        return json({ ok: true });
      }

      if (pathname === "/api/note" && request.method === "POST") {
        const { userId, date, note } = await request.json();
        // store as "YYYY-MM-DD: note" inside sc_prefs.notes JSON-ish map
        // lightweight: keep per-user notes in a small JSON object
        const row = await qOne(env.DB, `SELECT notes FROM sc_prefs WHERE user_id=?`, [userId]);
        const map = row?.notes ? safeJSON(row.notes, {}) : {};
        map[date] = String(note||"").slice(0,60);
        await qRun(env.DB, `INSERT INTO sc_prefs(user_id, prefer24s, notes)
                            VALUES(?, COALESCE((SELECT prefer24s FROM sc_prefs WHERE user_id=?),0), ?)
                            ON CONFLICT(user_id) DO UPDATE SET notes=excluded.notes`,
                   [userId, userId, JSON.stringify(map)]);
        return json({ ok: true });
      }

      if (pathname === "/api/shift/assign" && request.method === "POST") {
        const { date, half, userId } = await request.json();
        const row = await qOne(env.DB, `SELECT assignees, status FROM sc_shifts WHERE date=? AND half=?`, [date, half]);
        const arr = row?.assignees ? safeJSON(row.assignees, []) : [];
        if (!arr.includes(userId)) arr.push(userId);
        await qRun(env.DB, `INSERT INTO sc_shifts(date,half,assignees,status)
                            VALUES(?,?,?,?)
                            ON CONFLICT(date,half) DO UPDATE SET assignees=excluded.assignees`,
                   [date, half, JSON.stringify(arr), row?.status || "proposed"]);
        return json({ ok: true, assignees: arr });
      }

      if (pathname === "/api/shift/status" && request.method === "POST") {
        const { date, half, status } = await request.json();
        await qRun(env.DB, `INSERT INTO sc_shifts(date,half,assignees,status)
                            VALUES(?,?, '[]', ?)
                            ON CONFLICT(date,half) DO UPDATE SET status=excluded.status`,
                   [date, half, status]);
        return json({ ok: true });
      }

      if (pathname === "/api/user/flags" && request.method === "POST") {
        const { userId, reserve, type3, inactive } = await request.json();
        await qRun(env.DB, `UPDATE users SET
                  reserve=COALESCE(?,reserve),
                  type3_driver=COALESCE(?,type3_driver),
                  inactive=COALESCE(?,inactive)
                WHERE id=?`, [reserve, type3, inactive, userId]);
        return json({ ok: true });
      }

      if (pathname === "/api/swap" && request.method === "POST") {
        const { date, half, from, to } = await request.json();
        // naive: replace from->to if to not disqualified
        const row = await qOne(env.DB, `SELECT assignees,status FROM sc_shifts WHERE date=? AND half=?`, [date, half]);
        const a = row?.assignees ? safeJSON(row.assignees, []) : [];
        const i = a.indexOf(from);
        if (i>=0) a[i]=to; else a.push(to);
        // mark proposed if anything changed
        await qRun(env.DB, `INSERT INTO sc_shifts(date,half,assignees,status)
                            VALUES(?,?,?,?)
                            ON CONFLICT(date,half) DO UPDATE SET assignees=excluded.assignees, status='proposed'`,
                   [date, half, JSON.stringify(a), "proposed"]);
        return json({ ok:true, assignees:a });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
};

/* helpers */
function json(obj, status=200){ return new Response(JSON.stringify(obj), {status, headers:{"Content-Type":"application/json"}}); }
async function qAll(db, sql, args=[]){ const { results } = await db.prepare(sql).bind(...args).all(); return results||[]; }
async function qOne(db, sql, args=[]){ const r = await qAll(db, sql, args); return r[0]||null; }
async function qRun(db, sql, args=[]){ await db.prepare(sql).bind(...args).run(); }
function safeJSON(s,fallback){try{return JSON.parse(s)}catch{return fallback}}
