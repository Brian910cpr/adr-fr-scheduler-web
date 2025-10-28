// Cloudflare Worker — ShiftCommander API
// Routes used here:
//   GET  /api/state?start=YYYY-MM-DD&end=YYYY-MM-DD
//   (other routes you already have remain unchanged)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    try {
      if (pathname === "/api/state" && request.method === "GET") {
        const start = searchParams.get("start");
        const end   = searchParams.get("end");
        if (!start || !end) {
          return json({ error: "start and end are required YYYY-MM-DD" }, 400);
        }

        // Load window of shifts
        const shiftRows = await qAll(env.DB, `
          SELECT date, half, assignees, status
          FROM sc_shifts
          WHERE date BETWEEN ? AND ?
          ORDER BY date, CASE half WHEN 'AM' THEN 0 ELSE 1 END
        `, [start, end]);

        const shifts = {};
        for (const r of shiftRows) {
          const d = r.date, h = r.half;
          if (!shifts[d]) shifts[d] = {};
          const assignees = safeJSON(r.assignees, []);
          const tip = await computeTip(env.DB, assignees);
          shifts[d][h] = { assignees, status: r.status, tip };
        }

        // Availability
        const avRows = await qAll(env.DB, `
          SELECT user_id, date, half, state
          FROM sc_availability
          WHERE date BETWEEN ? AND ?
        `, [start, end]);

        const availability = {};
        for (const a of avRows) {
          if (!availability[a.user_id]) availability[a.user_id] = {};
          if (!availability[a.user_id][a.date]) availability[a.user_id][a.date] = {};
          availability[a.user_id][a.date][a.half] = a.state;
        }

        // Prefs
        const pRows = await qAll(env.DB, `SELECT user_id, prefer24s, notes FROM sc_prefs`);
        const prefs = {};
        for (const p of pRows) {
          prefs[p.user_id] = { prefer24s: !!p.prefer24s, notes: p.notes || "" };
        }

        return json({ shifts, availability, prefs }, 200);
      }

      // Fallback
      return json({ error: "not found" }, 404);

    } catch (err) {
      return json({ error: err?.message || String(err) }, 500);
    }
  }
};

// -------------------- helpers --------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
async function qAll(DB, sql, params = []) {
  const { results } = await DB.prepare(sql).bind(...params).all();
  return results || [];
}
function safeJSON(s, d){ try { return JSON.parse(s || ""); } catch { return d; } }

// Minimal tip: want ALS + EMT + DRIVER on the rig.
// If something’s missing, nudge with the first missing need.
async function computeTip(DB, assigneeIds) {
  if (!assigneeIds || !assigneeIds.length) return "Needs ALS";

  const placeholders = assigneeIds.map(() => "?").join(",");
  const rows = await qAll(DB,
    `SELECT id, UPPER(role) AS role FROM users WHERE id IN (${placeholders})`,
    assigneeIds
  );
  const roles = rows.map(r => r.role || "");
  const haveALS    = roles.includes("ALS");
  const haveEMT    = roles.includes("EMT");
  const haveDriver = roles.includes("DRIVER");

  if (!haveALS)    return "Needs ALS";
  if (!haveEMT)    return "Needs EMT";
  if (!haveDriver) return "Needs Driver";
  return "";
}
