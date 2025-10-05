
export function J(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
export function maskPhone(p: string): string {
  if (!p) return "";
  const tail = p.replace(/\D/g, "");
  const last4 = tail.slice(-4);
  return `***-***-${last4}`;
}
export function generateCode(): string {
  const n = Math.floor(Math.random() * 1000000);
  return String(n).padStart(6, '0');
}
export function randomToken(len = 32): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random()*alphabet.length)];
  return out;
}
export async function hashCode(nonce: string, code: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(nonce + code);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const b = new Uint8Array(digest);
  let str = '';
  for (let i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
  return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export async function sendSMS(env: Env, to: string, body: string) {
  const sid = env.TWILIO_SID;
  const token = env.TWILIO_TOKEN;
  const from = env.TWILIO_FROM;
  if (!sid || !token || !from) throw new Error("Twilio secrets missing");
  const creds = btoa(`${sid}:${token}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ From: from, To: to, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Twilio error: ${res.status} ${txt}`);
  }
  return true;
}
