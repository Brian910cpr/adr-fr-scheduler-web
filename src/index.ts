// src/index.ts
export interface Env {
  DB: D1Database;
  BUILD_TAG: string;
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const text = (body: string, status = 200, type = "text/plain; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type } });

function monthWindow(monthParam?: string) {
  let y: number, m: number;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [yy, mm] = monthParam.split("-").map(Number);
    y = yy; m = mm;
  } else {
    const now = new Date();
    y = now.getUTCFullYear(); m = now.getUTCMonth() + 1;
  }
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m, 1));
  const iso = (d: Date) => d.toISOString().slice(0,10);
  return { month: `${y}-${String(m).padStart(2,"0")}`, startISO: iso(start), endISO: iso(end) };
}

async function hasColumn(env: Env, table: string, col: string): Promise<boolean> {
  try {
    const q = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const cols = (q.results as any[]).map(r => String(r.name).toLowerCase());
    return cols.includes(col.toLowerCase());
  } catch {
    return false;
  }
}

async function apiMembers(env: Env) {
  try {
    const { results } = await env.DB
      .prepare(`SELECT id, name, role, is_admin, can_drive_type3, prefer_24h FROM members ORDER BY name`)
      .all();
    return json({ ok: true, members: results ?? [] });
  } catch (e: any) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function apiWallboard(req: Request, env: Env) {
  const url = new URL(req.url);
  const { month, startISO, endISO } = monthWindow(url.searchParams.get("month") || undefined);

  try {
    // Detect schema (old: no seat_role; new: seat_role exists)
    const seatRoleExists = await hasColumn(env, "shifts", "seat_role");

    // Build SQL according to schema
    const sql = seatRoleExists
      ? `SELECT s.shift_date, s.unit_code, s.shift_name, s.seat_role,
                 s.member_id, m.name AS member_name
           FROM shifts s
           LEFT JOIN members m ON m.id = s.member_id
          WHERE s.shift_date >= ? AND s.shift_date < ?
          ORDER BY s.shift_date, s.unit_code, s.shift_name, s.seat_role`
      : `SELECT s.shift_date, s.unit_code, s.shift_name,
                 NULL AS seat_role,
                 s.member_id, m.name AS member_name
           FROM shifts s
           LEFT JOIN members m ON m.id = s.member_id
          WHERE s.shift_date >= ? AND s.shift_date < ?
          ORDER BY s.shift_date, s.unit_code, s.shift_name`;

    const { results } = await env.DB.prepare(sql).bind(startISO, endISO).all();

    // trucks list (ignore pseudo-unit "ALL")
    const units = new Set<string>();
    for (const r of results as any[]) {
      if (r.unit_code && r.unit_code !== "ALL") units.add(String(r.unit_code));
    }
    const trucks = [...(units.size ? units : new Set(["120", "121", "131"]))];

    // assignments map: date|unit|shift[|seat] -> { member_name }
    const assignments: Record<string, { member_name: string | null }> = {};
    for (const r of results as any[]) {
      const date = r.shift_date, unit = r.unit_code, shift = r.shift_name;
      if (!date || !unit || !shift) continue;

      if (seatRoleExists) {
        const seat = r.seat_role ?? null;
        if (!seat) continue;
        const key = `${date}|${unit}|${shift}|${seat}`;
        assignments[key] = { member_name: r.member_name ?? null };
      } else {
        // old schema has one member per (date,unit,shift) with unknown seat
        const key = `${date}|${unit}|${shift}|A`;
        // if A already taken, place into D (best-effort)
        if (assignments[key]) {
          const keyD = `${date}|${unit}|${shift}|D`;
          assignments[keyD] = { member_name: r.member_name ?? null };
        } else {
          assignments[key] = { member_name: r.member_name ?? null };
        }
      }
    }

    // intents are optional
    let intents: Record<string,string> = {};
    try {
      const qi = await env.DB.prepare(
        `SELECT intent_date, shift_name, intent FROM intents WHERE intent_date >= ? AND intent_date < ?`
      ).bind(startISO, endISO).all();
      intents = Object.fromEntries(
        (qi.results as any[]).map(r => [`${r.intent_date}|${r.shift_name}`, r.intent ?? "-"])
      );
    } catch {/* table might not exist */}

    const dt = new Date(`${month}-01T00:00:00Z`);
    const days = new Date(dt.getUTCFullYear(), dt.getUTCMonth()+1, 0).getUTCDate();

    return json({
      month,
      days,
      today: new Date().toISOString().slice(0,10),
      trucks,
      truckShifts: ["Day","Night"],
      ampmShifts: ["AM","PM"],
      assignments,
      intents,
    });
  } catch (e: any) {
    // Don’t ever surface 1101 to the client
    return json({ ok:false, error:String(e) }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/api/members")   return apiMembers(env);
      if (pathname === "/api/wallboard") return apiWallboard(req, env);
      if (pathname === "/__health")      return json({ ok:true, build: env.BUILD_TAG||"dev" });
      return text("Not Found", 404);
    } catch (e:any) {
      return json({ ok:false, error:String(e) }, 500);
    }
  }
};
