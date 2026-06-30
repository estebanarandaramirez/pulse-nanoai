/**
 * Supabase Edge Function: snapshot-daily-earnings
 * Runs daily via pg_cron. For every user who has registered GPUs:
 *   1. Scrapes OctaSpace hosting/nodes to get 24h income per node
 *   2. Reads Clore.ai my_servers to estimate 24h income per server
 *   3. Attributes earnings to each user via the `gpus` Supabase table
 *      (matched by node_id / platform_node_id for OctaSpace,
 *       clore_server_id for Clore.ai)
 *   4. Upserts one earnings_log row per user
 *
 * Required env vars (Supabase Edge Function secrets):
 *   OCTASPACE_WEB_EMAIL, OCTASPACE_WEB_PASSWORD
 *   CLOREAI_API_KEY
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  ← injected automatically
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CUBE_BASE  = 'https://cube.octa.computer';
const CLORE_BASE = 'https://api.clore.ai/v1';

// ── Helpers ──────────────────────────────────────────────────────────────────
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

async function timedFetch(url: string, opts: RequestInit = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ── OctaSpace: returns Map<node_id, income_24h_usd> ─────────────────────────
async function fetchOctaNodeIncome(): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const email    = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');
  if (!email || !password) return result;

  try {
    const jar  = new CookieJar();
    const hdrs: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };

    const loginPage = await timedFetch(`${CUBE_BASE}/users/sign_in`, { headers: hdrs });
    jar.ingest(loginPage.headers);
    const csrf = extractCsrf(await loginPage.text());
    if (!csrf) return result;

    const signIn = await fetch(`${CUBE_BASE}/users/sign_in`, {
      method: 'POST', redirect: 'manual',
      headers: {
        ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': jar.toString(), 'Referer': `${CUBE_BASE}/users/sign_in`, 'Origin': CUBE_BASE,
      },
      body: new URLSearchParams({
        authenticity_token: csrf,
        'user[email]': email, 'user[password]': password,
        'user[remember_me]': '0', commit: 'Log in',
      }).toString(),
    });
    jar.ingest(signIn.headers);
    const loc = signIn.headers.get('location') ?? '';
    if (signIn.status >= 400 || loc.includes('/sign_in') || !loc) return result;

    const redir = loc.startsWith('http') ? loc : `${CUBE_BASE}${loc}`;
    jar.ingest((await fetch(redir, { redirect: 'follow', headers: { ...hdrs, 'Cookie': jar.toString() } })).headers);

    const html = await (await timedFetch(`${CUBE_BASE}/hosting/nodes`, {
      redirect: 'follow', headers: { ...hdrs, 'Cookie': jar.toString() },
    })).text();

    const rowPat = /<tr[\s\S]*?<\/tr>/gi;
    let m: RegExpExecArray | null;
    while ((m = rowPat.exec(html)) !== null) {
      const row = m[0];
      const idMatch = row.match(/href=["']\/(?:hosting\/)?nodes\/(\d+)["']/i);
      if (!idMatch) continue;
      const nodeId = idMatch[1];
      const inc = row.match(/([\d.]+)\s*[ØØ]\s*[\/|]\s*\$?\s*([\d.]+)/i)
               ?? row.match(/([\d.]+)\s*\/\s*([\d.]+)\s*\$/i);
      result.set(nodeId, parseFloat(inc?.[2] ?? '0'));
    }
  } catch (e) { console.error('OctaSpace scrape failed:', e); }
  return result;
}

// ── Clore.ai: returns Map<server_id, income_24h_usd> ────────────────────────
// Estimates 24h income as price_per_hour * 24 for rented servers.
async function fetchCloreServerIncome(): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const apiKey = Deno.env.get('CLOREAI_API_KEY');
  if (!apiKey) return result;

  try {
    const res = await timedFetch(`${CLORE_BASE}/my_servers`, { headers: { auth: apiKey } });
    if (!res.ok) return result;
    const { servers = [] } = await res.json();

    for (const s of servers) {
      if (!s.rented) continue;
      const gpuCount = s.gpu_array?.length ?? s.specs?.gpus_count ?? 1;
      const dailyUsd = parseFloat(s.price?.usd?.on_demand_usd ?? 0);
      const income24h = dailyUsd > 0 ? dailyUsd / gpuCount : 0;
      result.set(s.id, parseFloat(income24h.toFixed(4)));
    }
  } catch (e) { console.error('Clore.ai fetch failed:', e); }
  return result;
}

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const today = (body.date as string) ?? new Date().toISOString().slice(0, 10);

  // 1. Load all registered GPUs so we know which user owns which node/server
  const { data: gpus, error: gpusErr } = await sb
    .from('gpus')
    .select('user_email, node_id, platform_node_id, clore_server_id, active_platform');

  if (gpusErr) return Response.json({ error: gpusErr.message }, { status: 500 });
  if (!gpus?.length) return Response.json({ success: true, message: 'No GPUs registered', date: today });

  // 2. Fetch live income maps in parallel
  const [octaIncome, cloreIncome] = await Promise.all([
    fetchOctaNodeIncome(),
    fetchCloreServerIncome(),
  ]);

  // 3. Aggregate per user
  const perUser = new Map<string, { octa: number; clore: number }>();

  for (const gpu of gpus) {
    const email = gpu.user_email;
    if (!email) continue;
    if (!perUser.has(email)) perUser.set(email, { octa: 0, clore: 0 });
    const u = perUser.get(email)!;

    // OctaSpace attribution: check both node_id and platform_node_id columns
    const octaId = gpu.platform_node_id ?? gpu.node_id;
    if (octaId && octaIncome.has(String(octaId))) {
      u.octa += octaIncome.get(String(octaId))!;
    }

    // Clore.ai attribution: match by clore_server_id
    if (gpu.clore_server_id && cloreIncome.has(Number(gpu.clore_server_id))) {
      u.clore += cloreIncome.get(Number(gpu.clore_server_id))!;
    }
  }

  // 4. Upsert one earnings_log row per user
  const rows = [...perUser.entries()].map(([user_email, { octa, clore }]) => ({
    date: today,
    user_email,
    octa_usd:  parseFloat(octa.toFixed(4)),
    clore_usd: parseFloat(clore.toFixed(4)),
    total_usd: parseFloat((octa + clore).toFixed(4)),
  }));

  const { error: upsertErr } = await sb
    .from('earnings_log')
    .upsert(rows, { onConflict: 'date,user_email' });

  if (upsertErr) return Response.json({ error: upsertErr.message }, { status: 500 });

  console.log(`[snapshot] ${today} — ${rows.length} user(s) logged:`,
    rows.map(r => `${r.user_email} $${r.total_usd}`).join(', '));

  return Response.json({ success: true, date: today, users: rows });
});
