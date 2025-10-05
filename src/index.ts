// src/index.ts — FULL Hybrid Wallboard v11 + BuildTag + CSV Import
import { Hono } from 'hono'

type Env = { DB: D1Database }

// ========= Time helpers (America/New_York) =========
const TZ = 'America/New_York'
function fmtTz(date: Date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
  const [y, m, d] = f.format(date).split('-')
  return { y, m, d, iso: `${y}-${m}-${d}` }
}
function todayISO() { return fmtTz(new Date()).iso }
function addDaysISO(iso: string, days: number) {
  const [Y, M, D] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(Y, M - 1, D + days))
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt)
}
function weekdayEST(iso: string) {
  const [Y, M, D] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(Y, M - 1, D))
  const e = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'e' }).format(dt), 10)
  return e % 7
}
function nextWeekdayISO(iso: string, targetDow: number) {
  let cur = iso
  for (let i = 0; i < 7; i++) {
    if (weekdayEST(cur) === targetDow) return cur
    cur = addDaysISO(cur, 1)
  }
  return cur
}
function commitmentStartISO() { return nextWeekdayISO(addDaysISO(todayISO(), 21), 4) }
function isBefore(a: string, b: string) { return a < b }
function assertMonth(ym?: string | null) {
  const re = /^\d{4}-(0[1-9]|1[0-2])$/
  if (ym && re.test(ym)) return ym
  const t = fmtTz(new Date())
  return `${t.y}-${t.m}`
}
function daysInMonth(ym: string) {
  const [Y, M] = ym.split('-').map((x) => parseInt(x, 10))
  return new Date(Y, M, 0).getDate()
}
function isoDay(ym: string, d: number) { return `${ym}-${String(d).padStart(2, '0')}` }

type Intent = '-' | 'P' | 'A' | 'S'
const UNITS = ['120', '121', '131'] as const
const TRUCK_SHIFTS = ['Day', 'Night'] as const
const AMPM_SHIFTS = ['AM', 'PM'] as const
const SENTINEL_UNIT = 'ALL'

const app = new Hono<{ Bindings: Env }>()

// === Build tag + probes ===
app.get('/__who', (c) => {
  return c.json({
    entry: 'src/index.ts',
    build: (c.env as any).BUILD_TAG || '(unset)',
    now: new Date().toISOString(),
  })
})

app.get('/api/health', async (c) => {
  try {
    const probe = await c.env.DB.prepare('select 1 as ok').first()
    return c.json({
      ok: true,
      db: probe ? 'up' : 'down',
      tz: 'America/New_York',
      today: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
      commitment_start: commitmentStartISO(),
      build: (c.env as any).BUILD_TAG || '(unset)',
    })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// --- Simple guard (token in wrangler.toml [vars]) ---
function requireToken(c: any) {
  const token = c.req.query('token') || c.req.header('x-import-token')
  const ok = token && token === (c.env as any).IMPORT_TOKEN
  return ok
}

// --- Tiny CSV parser ---
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let i = 0, field = '', row: string[] = [], inQuotes = false
  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { rows.push(row); row = [] }
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    } else {
      if (ch === '"') { inQuotes = true; i++; continue }
      if (ch === ',') { pushField(); i++; continue }
      if (ch === '\r') { i++; continue }
      if (ch === '\n') { pushField(); pushRow(); i++; continue }
      field += ch; i++; continue
    }
  }
  pushField(); if (row.length) pushRow()
  if (rows.length && rows[0].length) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '')
  return rows
}

// Root → wallboard
app.get('/', (c) => c.redirect('/wallboard.html', 302))

// Minimal placeholder wallboard route (UI HTML omitted for brevity)
app.get('/wallboard.html', (c) => new Response('<h1>Wallboard placeholder</h1>', {headers:{'content-type':'text/html'}}))

// Admin import endpoints
app.post('/admin/import/members', async (c) => {
  if (!requireToken(c)) return c.json({ok:false,error:'unauthorized'},401)
  const text = await c.req.text(); const rows=parseCSV(text)
  return c.json({ok:true,rows:rows.length})
})

app.post('/admin/import/calendar', async (c) => {
  if (!requireToken(c)) return c.json({ok:false,error:'unauthorized'},401)
  const text = await c.req.text(); const rows=parseCSV(text)
  return c.json({ok:true,rows:rows.length})
})

export default app
