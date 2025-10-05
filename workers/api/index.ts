
import { startAuth, verifyAuth } from './auth/routes';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TWILIO_SID?: string;
  TWILIO_TOKEN?: string;
  TWILIO_FROM?: string;
}

function J(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/api/auth/start'  && req.method === 'POST') return startAuth(req, env);
    if (p === '/api/auth/verify' && req.method === 'POST') return verifyAuth(req, env);

    if (p === '/api/health' && req.method === 'GET') {
      try { await env.DB.prepare('SELECT 1').first(); return J(200,{ok:true,db:'up'}); }
      catch(e){ return J(500,{ok:false,error:String(e)}); }
    }

    if (p === '/api/wallboard' && req.method === 'GET') {
      const rows = await env.DB.prepare("SELECT service_date,block,unit_id,seat_role,assignee_member_number,status,quality,flashing FROM wallboard ORDER BY service_date, block, unit_id, seat_role").all();
      return J(200, { ok:true, rows: rows.results || [] });
    }

    if (!p.startsWith('/api')) {
      return env.ASSETS.fetch(req);
    }

    return J(404, { ok:false, error:'Not found' });
  }
};
