export interface Env { DB: D1Database; }
const j = (s:number, b:any) => new Response(JSON.stringify(b), {status:s, headers:{'Content-Type':'application/json'}});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), p = url.pathname;

    if (req.method === 'POST' && p === '/api/claim') {
      const data = await req.json();
      const { member_identifier, service_date, block, role, unit_id='120', confirm=false } = data;

      const member = member_identifier
        ? await env.DB.prepare('SELECT * FROM members WHERE member_number=?1 OR full_name=?1')
            .bind(String(member_identifier)).first()
        : null;

      await env.DB.prepare(
        `INSERT INTO call_log (source, member_number, full_name, action, unit_id, service_date, block, seat_role, result, verified, payload)
         VALUES ('web', ?1, ?2, 'claim', ?3, ?4, ?5, ?6, 'logged', ?7, ?8)`
      ).bind(
        member?.member_number ?? null,
        member?.full_name ?? (data.full_name ?? null),
        unit_id, service_date, block, role,
        member ? 1 : 0,
        JSON.stringify(data)
      ).run();

      const seat = await env.DB.prepare(
        'SELECT * FROM wallboard WHERE service_date=? AND block=? AND unit_id=? AND seat_role=?'
      ).bind(service_date, block, unit_id, role).first();

      if (seat && seat.status === 'open' && member) {
        await env.DB.prepare(
          `UPDATE wallboard
           SET assignee_member_number=?1, status='confirmed', quality='green', flashing='none',
               notes=COALESCE(notes,'') || ' | web-claim'
           WHERE service_date=?2 AND block=?3 AND unit_id=?4 AND seat_role=?5`
        ).bind(member.member_number, service_date, block, unit_id, role).run();
        return j(200, { ok:true, assigned:true, message:'Confirmed. Thank you for stepping up!' });
      }

      await env.DB.prepare(
        `UPDATE wallboard SET status='standby', quality='grey'
         WHERE service_date=? AND block=? AND unit_id=? AND seat_role=?`
      ).bind(service_date, block, unit_id, role).run();

      return j(200, { ok:true, assigned:false, message:'Logged as standby. Shifts ≥3 weeks out show grey until Wednesday publish.' });
    }

    if (req.method === 'POST' && p === '/api/remove') {
      const data = await req.json();
      const { service_date, block, role, unit_id='120' } = data;

      await env.DB.prepare(
        `UPDATE wallboard
         SET assignee_member_number=NULL, status='open', quality='red', flashing='red',
             notes=COALESCE(notes,'') || ' | web-remove'
         WHERE service_date=?1 AND block=?2 AND unit_id=?3 AND seat_role=?4`
      ).bind(service_date, block, unit_id, role).run();

      await env.DB.prepare(
        `INSERT INTO call_log (source, action, unit_id, service_date, block, seat_role, result, payload)
         VALUES ('web','remove',?1,?2,?3,?4,'logged',?5)`
      ).bind(unit_id, service_date, block, role, JSON.stringify(data)).run();

      return j(200, { ok:true, message:'Removed. Standby list will be contacted as needed.' });
    }

    if (req.method === 'GET' && p === '/api/wallboard') {
      const date = url.searchParams.get('date');
      const q = date
        ? await env.DB.prepare('SELECT * FROM wallboard WHERE service_date=? ORDER BY unit_id, seat_role').bind(date).all()
        : await env.DB.prepare('SELECT * FROM wallboard ORDER BY service_date, unit_id, seat_role').all();
      return j(200, { ok:true, rows: q.results });
    }

    return j(404, { ok:false, error:'Not found' });
  }
}
