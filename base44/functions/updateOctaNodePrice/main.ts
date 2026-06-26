/**
 * updateOctaNodePrice
 * Updates the rental price for an OctaSpace node via web scraping.
 *
 * Required env vars:
 *   OCTASPACE_WEB_EMAIL    — email for cube.octa.computer login
 *   OCTASPACE_WEB_PASSWORD — password for cube.octa.computer login
 *
 * Input:
 *   node_id    string  — node ID (e.g. "11409")
 *   base_usd   number  — base price per hour in USD (e.g. 0.10 → $0.10/hr)
 *   storage_usd  number  — optional, price per GB storage in USD (default: 0.001)
 *   traffic_usd  number  — optional, price per GB traffic in USD (default: 0.003)
 *
 * Output: { success: boolean, message: string }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const CUBE_BASE = 'https://cube.octa.computer';

class CookieJar {
  private jar = new Map<string, string>();

  ingest(headers: Headers): void {
    const raw: string[] = typeof (headers as any).getSetCookie === 'function'
      ? (headers as any).getSetCookie()
      : (headers.get('set-cookie') ?? '').split(/,(?=[^ ])/);
    for (const cookie of raw) {
      const pair = cookie.split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  toString(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function extractCsrf(html: string): string {
  const m = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i)
    ?? html.match(/name=["']authenticity_token["'][^>]+value=["']([^"']+)["']/i)
    ?? html.match(/value=["']([^"']+)["'][^>]+name=["']authenticity_token["']/i);
  return m ? m[1] : '';
}

async function signIn(email: string, password: string): Promise<{ jar: CookieJar; hdrs: Record<string, string> }> {
  const jar = new CookieJar();
  const hdrs: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };

  const loginPageRes = await fetch(`${CUBE_BASE}/users/sign_in`, { headers: hdrs });
  jar.ingest(loginPageRes.headers);
  const loginHtml = await loginPageRes.text();
  const csrf = extractCsrf(loginHtml);
  if (!csrf) throw new Error('Could not extract CSRF from sign-in page');

  const signInRaw = await fetch(`${CUBE_BASE}/users/sign_in`, {
    method: 'POST',
    redirect: 'manual',
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
  jar.ingest(signInRaw.headers);

  const location = signInRaw.headers.get('location') ?? '';
  if (signInRaw.status >= 400 || signInRaw.status === 200 || location.includes('/sign_in') || !location) {
    throw new Error(`Sign-in failed — status=${signInRaw.status} location=${location}`);
  }

  const redirectTarget = location.startsWith('http') ? location : `${CUBE_BASE}${location}`;
  const signInRes = await fetch(redirectTarget, { redirect: 'follow', headers: { ...hdrs, 'Cookie': jar.toString() } });
  jar.ingest(signInRes.headers);

  if (signInRes.url.includes('/users/sign_in')) {
    throw new Error('Sign-in redirected back to login page — credentials may be wrong');
  }

  return { jar, hdrs };
}

async function updateNodePrice(
  jar: CookieJar,
  commonHeaders: Record<string, string>,
  nodeId: string,
  baseUsdPerHour: number,
  storageUsd: number,
  trafficUsd: number,
): Promise<{ success: boolean; message: string; debug?: string }> {
  // Convert human-readable USD to OctaSpace integer format (× 10000)
  const baseInt = Math.round(baseUsdPerHour * 10000);
  const storageInt = Math.round(storageUsd * 10000);
  const trafficInt = Math.round(trafficUsd * 10000);

  const priceUrl = `${CUBE_BASE}/nodes/${nodeId}/node_price`;

  // ── Step 1: GET configuration page to obtain a valid CSRF token ──────────────
  const configRes = await fetch(`${CUBE_BASE}/nodes/${nodeId}?type=configuration`, {
    redirect: 'follow',
    headers: { ...commonHeaders, 'Cookie': jar.toString() },
  });
  jar.ingest(configRes.headers);
  const configHtml = await configRes.text();

  if (configRes.status >= 400 || configRes.url.includes('/sign_in')) {
    return {
      success: false,
      message: `Could not load configuration page for node ${nodeId}`,
      debug: `status=${configRes.status} url=${configRes.url}`,
    };
  }

  const csrf = extractCsrf(configHtml);
  if (!csrf) {
    return { success: false, message: `Could not extract CSRF token for node ${nodeId}` };
  }

  // Shared headers for the AJAX PATCH calls to /node_price
  const ajaxHeaders = {
    ...commonHeaders,
    'Cookie': jar.toString(),
    'Referer': configRes.url,
    'Origin': CUBE_BASE,
    'X-CSRF-Token': csrf,
    'X-Requested-With': 'XMLHttpRequest',
  };

  // Helper: PATCH /nodes/:id/node_price with multipart FormData (matching browser behaviour)
  async function patchPrice(fields: Record<string, string>): Promise<{ status: number; body: string }> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const res = await fetch(priceUrl, { method: 'PATCH', redirect: 'follow', headers: ajaxHeaders, body: fd });
    jar.ingest(res.headers);
    return { status: res.status, body: await res.text() };
  }

  // ── Step 2: Switch to USD mode ───────────────────────────────────────────────
  const currencyRes = await patchPrice({ 'node_price[currency_usd]': '1' });
  if (currencyRes.status >= 400) {
    return {
      success: false,
      message: `Failed to switch node ${nodeId} to USD mode`,
      debug: `status=${currencyRes.status} body=${currencyRes.body.slice(0, 200)}`,
    };
  }

  // ── Step 3: Set base price ───────────────────────────────────────────────────
  const baseRes = await patchPrice({
    'node_price[base_usd]': String(baseInt),
    'node_price[attr_name]': 'base_usd',
  });
  if (baseRes.status >= 400) {
    return {
      success: false,
      message: `Failed to set base price on node ${nodeId}`,
      debug: `status=${baseRes.status} sentBaseInt=${baseInt} body=${baseRes.body.slice(0, 200)}`,
    };
  }

  // ── Step 4: Set storage price ────────────────────────────────────────────────
  const storageRes = await patchPrice({
    'node_price[storage_usd]': String(storageInt),
    'node_price[attr_name]': 'storage_usd',
  });

  // ── Step 5: Set traffic price ────────────────────────────────────────────────
  const trafficRes = await patchPrice({
    'node_price[traffic_usd]': String(trafficInt),
    'node_price[attr_name]': 'traffic_usd',
  });

  // ── Step 6: Re-GET config page to verify what was actually saved ─────────────
  const verifyRes = await fetch(`${CUBE_BASE}/nodes/${nodeId}?type=configuration`, {
    redirect: 'follow',
    headers: { ...commonHeaders, 'Cookie': jar.toString() },
  });
  jar.ingest(verifyRes.headers);
  const verifyHtml = await verifyRes.text();

  const savedBaseMatch = verifyHtml.match(/name=["']node_price\[base_usd\]["'][^>]+value=["']([^"']+)["']|value=["']([^"']+)["'][^>]+name=["']node_price\[base_usd\]["']/i);
  const savedBaseRaw = savedBaseMatch ? (savedBaseMatch[1] ?? savedBaseMatch[2]) : 'unknown';
  const savedBaseUsd = savedBaseRaw !== 'unknown' ? (Number(savedBaseRaw) / 10000).toFixed(4) : 'unknown';
  const currencyMatch = verifyHtml.match(/name=["']node_price\[currency_usd\]["'][^>]+value=["']([^"']+)["']|value=["']([^"']+)["'][^>]+name=["']node_price\[currency_usd\]["']/i);
  const savedCurrency = currencyMatch ? (currencyMatch[1] ?? currencyMatch[2]) : 'unknown';

  return {
    success: true,
    message: `Node ${nodeId} price updated: $${savedBaseUsd}/hr base (raw=${savedBaseRaw}), currency_usd=${savedCurrency}`,
    debug: `priceUrl=${priceUrl} sentBaseInt=${baseInt} storageStatus=${storageRes.status} trafficStatus=${trafficRes.status}`,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { node_id, base_usd, storage_usd = 0.001, traffic_usd = 0.003 } = await req.json().catch(() => ({}));

  if (!node_id) return Response.json({ error: 'node_id is required' }, { status: 400 });
  if (base_usd == null || typeof base_usd !== 'number') {
    return Response.json({ error: 'base_usd is required and must be a number (e.g. 0.10 for $0.10/hr)' }, { status: 400 });
  }

  const email = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');
  if (!email || !password) {
    return Response.json({
      success: false,
      message: 'OCTASPACE_WEB_EMAIL and OCTASPACE_WEB_PASSWORD are not set. Add them in Base44 → Settings → Environment Variables.',
    });
  }

  try {
    const { jar, hdrs } = await signIn(email, password);
    const result = await updateNodePrice(jar, hdrs, String(node_id), base_usd, storage_usd, traffic_usd);
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ success: false, message: `Unexpected error: ${err.message}` }, { status: 500 });
  }
});
