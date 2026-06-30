/**
 * Supabase Edge Function: snapshot-daily-earnings
 * Fetches live earnings from OctaSpace + Clore.ai and upserts today's row
 * in the earnings_log table. Triggered daily by pg_cron.
 *
 * Auto-available env vars (set in Supabase dashboard → Settings → Edge Functions):
 *   OCTASPACE_WEB_EMAIL
 *   OCTASPACE_WEB_PASSWORD
 *   CLOREAI_API_KEY
 *   PULSE_USER_EMAIL   — whose earnings_log row to write
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CUBE_BASE  = 'https://cube.octa.computer';
const CLORE_BASE = 'https://api.clore.ai/v1';

// ── Cookie jar (OctaSpace web login) ────────────────────────────────────────
class CookieJar {
  private jar = new Map<string, string>();
  ingest(h: Headers) {
    const raw: string[] = typeof (h as any).getSetCookie === 'function'
      ? (h as any).getSetCookie()
      : (h.get('set-cookie') ?? '').split(/,(?=[^ ])/);
    for (const c of raw) {
      const p = c.split(';')[0].trim();
      const eq = p.indexOf('=');
      if (eq > 0) this.jar.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
    }
  }
  toString() { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

function extractCsrf(html: string): string {
  return (
    html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i) ??
    html.match(/name=["']authenticity_token["'][^>]+value=["']([^"']+)["']/i) ??
    ['', '']
  )[1];
}

async function timedFetch(url: string, opts: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ── OctaSpace: sum income_24h_usd across all hosted nodes ──────────────────
async function fetchOctaIncome(): Promise<number> {
  const email    = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');
  if (!email || !password) return 0;

  try {
    const jar  = new CookieJar();
    const hdrs: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };

    const loginPage = await timedFetch(`${CUBE_BASE}/users/sign_in`, { headers: hdrs });
    jar.ingest(loginPage.headers);
    const csrf = extractCsrf(await loginPage.text());
    if (!csrf) return 0;

    const signIn = await fetch(`${CUBE_BASE}/users/sign_in`, {
      method: 'POST', redirect: 'manual',
      headers: {
        ...hdrs,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': jar.toString(),
        'Referer': `${CUBE_BASE}/users/sign_in`,
        'Origin': CUBE_BASE,
      },
      body: new URLSearchParams({
        authenticity_token: csrf,
        'user[email]': email,
        'user[password]': password,
        'user[remember_me]': '0',
        commit: 'Log in',
      }).toString(),
    });
    jar.ingest(signIn.headers);

    const loc = signIn.headers.get('location') ?? '';
    if (signIn.status >= 400 || loc.includes('/sign_in') || !loc) return 0;

    const redir = loc.startsWith('http') ? loc : `${CUBE_BASE}${loc}`;
    const after = await fetch(redir, { redirect: 'follow', headers: { ...hdrs, 'Cookie': jar.toString() } });
    jar.ingest(after.headers);

    const listRes = await timedFetch(`${CUBE_BASE}/hosting/nodes`, {
      redirect: 'follow',
      headers: { ...hdrs, 'Cookie': jar.toString() },
    });
    const html = await listRes.text();

    let total = 0;
    const rowPat = /<tr[\s\S]*?<\/tr>/gi;
    let m: RegExpExecArray | null;
    while ((m = rowPat.exec(html)) !== null) {
      const row = m[0];
      if (!row.match(/href=["']\/(?:hosting\/)?nodes\/(\d+)["']/i)) continue;
      const inc = row.match(/([\d.]+)\s*[ØØ]\s*[\/|]\s*\$?\s*([\d.]+)/i)
               ?? row.match(/([\d.]+)\s*\/\s*([\d.]+)\s*\$/i);
      if (inc) total += parseFloat(inc[2]);
    }
    return parseFloat(total.toFixed(2));
  } catch { return 0; }
}

// ── Clore.ai: fetch account balance in USD ──────────────────────────────────
async function fetchCloreBalance(): Promise<number> {
  const apiKey = Deno.env.get('CLOREAI_API_KEY');
  if (!apiKey) return 0;
  try {
    const res = await timedFetch(`${CLORE_BASE}/balance`, { headers: { auth: apiKey } });
    if (!res.ok) return 0;
    const data = await res.json();
    return parseFloat((data.usd_value ?? data.balance ?? 0).toFixed(2));
  } catch { return 0; }
}

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // Allow GET (from pg_cron) or POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const userEmail = Deno.env.get('PULSE_USER_EMAIL');
  if (!userEmail) return Response.json({ error: 'PULSE_USER_EMAIL not set' }, { status: 500 });

  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const today = (body.date as string) ?? new Date().toISOString().slice(0, 10);

  const [octaUsd, cloreUsd] = await Promise.all([fetchOctaIncome(), fetchCloreBalance()]);
  const totalUsd = parseFloat((octaUsd + cloreUsd).toFixed(2));

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error } = await sb.from('earnings_log').upsert(
    { date: today, user_email: userEmail, octa_usd: octaUsd, clore_usd: cloreUsd, total_usd: totalUsd },
    { onConflict: 'date,user_email' },
  );

  if (error) return Response.json({ error: error.message }, { status: 500 });

  console.log(`[snapshot] ${today} — octa=$${octaUsd} clore=$${cloreUsd} total=$${totalUsd}`);
  return Response.json({ success: true, date: today, octa_usd: octaUsd, clore_usd: cloreUsd, total_usd: totalUsd });
});
