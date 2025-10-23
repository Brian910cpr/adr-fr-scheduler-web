
import { J, hashCode, generateCode, maskPhone, randomToken, sendSMS } from '../util/util';

type Member = {
  member_number: string;
  full_name: string;
  phone?: string;
  email?: string;
  role?: string;
  active?: number;
};

async function body<T>(req: Request): Promise<T> { return await req.json() as T; }

async function findMember(env: Env, ident: string): Promise<Member|null> {
  const byNumber = await env.DB.prepare("SELECT * FROM members WHERE member_number = ?1").bind(ident).first<Member>();
  if (byNumber) return byNumber;
  const byName = await env.DB.prepare("SELECT * FROM members WHERE lower(full_name) = lower(?1)").bind(ident).first<Member>();
  return byName ?? null;
}

export async function startAuth(req: Request, env: Env) {
  const b = await body<{member_identifier:string}>(req).catch(()=>({member_identifier:''}));
  const ident = (b.member_identifier||'').trim();
  if (!ident) return J(400,{ok:false,error:"Missing member_identifier"});
  const m = await findMember(env, ident);

  if (!m || m.active===0) {
    await env.DB.prepare("INSERT INTO audit_log(action, meta) VALUES('auth_start_fail', ?1)")
      .bind(JSON.stringify({ ident })).run();
    return J(200,{ok:true, channel:"sms", mask:"**********"});
  }

  const channel = (m.phone && m.phone.trim()) ? 'sms' : (m.email ? 'email' : 'sms');
  const code = generateCode();
  const nonce = randomToken(12);
  const h = await hashCode(nonce, code);
  const ttl = Math.floor(Date.now()/1000) + 10*60;

  await env.DB.prepare("INSERT INTO otp_codes(member_number, channel, code_hash, nonce, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(m.member_number, channel, h, nonce, ttl).run();

  try {
    if (channel==='sms' && m.phone) await sendSMS(env, m.phone, `ADR FR verification code: ${code}`);
  } catch (e) {
    await env.DB.prepare("INSERT INTO audit_log(action, meta) VALUES('auth_start_send_error', ?1)")
      .bind(JSON.stringify({ member: m.member_number, error: String(e) })).run();
  }

  await env.DB.prepare("INSERT INTO audit_log(actor_member_number, action, meta) VALUES(?1,'auth_start',?2)")
    .bind(m.member_number, JSON.stringify({ channel })).run();

  return J(200,{ok:true, channel, mask: m.phone ? maskPhone(m.phone) : '***@***'});
}

export async function verifyAuth(req: Request, env: Env) {
  const b = await body<{member_identifier:string, code:string}>(req).catch(()=>({member_identifier:'', code:''}));
  const ident = (b.member_identifier||'').trim();
  const code = (b.code||'').trim();
  if (!ident || !code) return J(400,{ok:false,error:"Missing member_identifier or code"});

  const m = await findMember(env, ident);
  if (!m || m.active===0) {
    await env.DB.prepare("INSERT INTO audit_log(action, meta) VALUES('auth_verify_fail_no_member', ?1)")
      .bind(JSON.stringify({ ident })).run();
    return J(401,{ok:false,error:"Invalid or expired code"});
  }

  const now = Math.floor(Date.now()/1000);
  const row = await env.DB.prepare("SELECT * FROM otp_codes WHERE member_number=?1 AND used_at IS NULL AND expires_at>=?2 ORDER BY id DESC LIMIT 1")
    .bind(m.member_number, now).first<any>();
  if (!row) return J(401,{ok:false,error:"Invalid or expired code"});

  const attempts = (row.attempts ?? 0) + 1;
  if (attempts > 5) {
    await env.DB.prepare("UPDATE otp_codes SET used_at=?1 WHERE id=?2").bind(now,row.id).run();
    await env.DB.prepare("INSERT INTO audit_log(actor_member_number, action, meta) VALUES(?1,'auth_verify_locked',?2)")
      .bind(m.member_number, JSON.stringify({reason:"too-many-attempts"})).run();
    return J(429,{ok:false,error:"Too many attempts"});
  }
  await env.DB.prepare("UPDATE otp_codes SET attempts=?1 WHERE id=?2").bind(attempts,row.id).run();

  const h = await hashCode(row.nonce, code);
  if (h !== row.code_hash) {
    await env.DB.prepare("INSERT INTO audit_log(actor_member_number, action, meta) VALUES(?1,'auth_verify_fail_code',?2)")
      .bind(m.member_number, JSON.stringify({ attempts })).run();
    return J(401,{ok:false,error:"Invalid or expired code"});
  }

  await env.DB.prepare("UPDATE otp_codes SET used_at=?1 WHERE id=?2").bind(now,row.id).run();

  const token = crypto.randomUUID().replace(/-/g,'') + randomToken(16);
  const maxAgeSec = 60*60*24*30;
  const exp = now + maxAgeSec;
  const role = (m.role==='supervisor') ? 'supervisor' : 'member';
  await env.DB.prepare("INSERT INTO sessions(token, member_number, role, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(token, m.member_number, role, exp).run();
  await env.DB.prepare("INSERT INTO audit_log(actor_member_number, action, meta) VALUES(?1,'auth_verify_success',?2)")
    .bind(m.member_number, JSON.stringify({ role })).run();

  const headers = new Headers({ 'Content-Type':'application/json' });
  headers.append('Set-Cookie', `sess=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`);
  return new Response(JSON.stringify({ ok:true, member_number:m.member_number, role, display:m.full_name }), { status:200, headers });
}
