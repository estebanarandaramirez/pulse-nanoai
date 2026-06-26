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

  // ── Step 1: GET configuration page ──────────────────────────────────────────
  const configRes = await fetch(`${CUBE_BASE}/nodes/${nodeId}?type=configuration`, {
    redirect: 'follow',
    headers: {
      ...commonHeaders,
      'Cookie': jar.toString(),
      'Referer': `${CUBE_BASE}/nodes`,
    },
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

  // ── Step 2: Find the node_settings PATCH form and extract CSRF ──────────────
  const patchFormPattern = /<input[^>]+name=["']_method["'][^>]+value=["']patch["'][^>]*>|<input[^>]+value=["']patch["'][^>]+name=["']_method["'][^>]*>/gi;
  let formScope = configHtml;
  let formActionAttr: string | undefined;
  let match: RegExpExecArray | null;
  const subActionPattern = /\/(change_|delete|destroy|remove)/i;

  while ((match = patchFormPattern.exec(configHtml)) !== null) {
    const pos = match.index;
    const formStart = configHtml.lastIndexOf('<form', pos);
    const formEnd = configHtml.indexOf('</form>', pos) + '</form>'.length;
    if (formStart === -1 || formEnd <= formStart) continue;
    const candidate = configHtml.slice(formStart, formEnd);
    const action = candidate.match(/<form[^>]+action=["']([^"']+)["']/i)?.[1] ?? '';
    const actionPath = action.split('?')[0];
    if (
      actionPath.match(new RegExp(`/nodes/${nodeId}\\/?$`)) ||
      (!subActionPattern.test(action) && action.includes(`/nodes/${nodeId}`))
    ) {
      formScope = candidate;
      formActionAttr = actionPath || action;
      break;
    }
  }

  const editCsrf = extractCsrf(formScope) || extractCsrf(configHtml);
  if (!editCsrf) {
    const formActions = [...configHtml.matchAll(/<form[^>]+action=["']([^"']+)["']/gi)].map(m => m[1]);
    return {
      success: false,
      message: `Could not extract CSRF token from configuration page for node ${nodeId}`,
      debug: `formActions=${JSON.stringify(formActions)}`,
    };
  }

  // Guard: if we couldn't find the node_settings form, fail explicitly rather than
  // POSTing to the wrong URL and falsely detecting success from the node page URL.
  if (!formActionAttr || !formActionAttr.includes('node_settings')) {
    const allActions = [...configHtml.matchAll(/<form[^>]+action=["']([^"']+)["']/gi)].map(m => m[1]);
    const patchActions = [...configHtml.matchAll(/name=["']_method["'][^>]+value=["']patch["']|value=["']patch["'][^>]+name=["']_method["']/gi)].length;
    return {
      success: false,
      message: `Could not locate node_settings form for node ${nodeId}`,
      debug: `formActionAttr=${formActionAttr} patchForms=${patchActions} allFormActions=${JSON.stringify(allActions)}`,
    };
  }

  const patchUrl = formActionAttr.startsWith('http') ? formActionAttr : `${CUBE_BASE}${formActionAttr}`;

  // ── Step 3: Build the complete save-settings payload ─────────────────────────
  // Must send the full payload (not just price fields) or Rails resets other fields.
  const body = new URLSearchParams();
  body.set('_method', 'patch');
  body.set('authenticity_token', editCsrf);

  // Services: keep Rental enabled
  body.append('node_setting[services][]', '1');

  // Service ports
  body.set('node_setting[service_ports_start]', '51800');
  body.set('node_setting[service_ports_end]', '51816');
  body.append('node_setting[service_ports_enable]', '0');
  body.append('node_setting[service_ports_enable]', '1');

  // Prices in USD (currency_usd=1 → USD mode)
  body.set('node_price[currency_usd]', '1');
  body.append('node_price[attr_name]', 'base_usd');
  body.set('node_price[base_usd]', String(baseInt));
  body.set('node_price[formatted_base_usd]', baseUsdPerHour.toFixed(4));
  body.append('node_price[attr_name]', 'storage_usd');
  body.set('node_price[storage_usd]', String(storageInt));
  body.set('node_price[formatted_storage_usd]', storageUsd.toFixed(4));
  body.append('node_price[attr_name]', 'traffic_usd');
  body.set('node_price[traffic_usd]', String(trafficInt));
  body.set('node_price[formatted_traffic_usd]', trafficUsd.toFixed(4));

  // Availability: all days Mon-Sun, hours 0-23 UTC
  for (let d = 1; d <= 7; d++) body.append('node_setting[rent_days][]', String(d));
  body.set('node_setting[rent_hours_start]', '0');
  body.set('node_setting[rent_hours_end]', '23');

  // Mining disabled, maintenance off
  body.append('node_setting[mining_disabled]', '0');
  body.append('node_setting[mining_disabled]', '1');
  body.set('node_setting[maintenance]', '0');

  body.set('commit', 'Save settings');

  // ── Step 4: POST to node_settings ────────────────────────────────────────────
  const saveRes = await fetch(patchUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      ...commonHeaders,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': jar.toString(),
      'Referer': configRes.url,
      'Origin': CUBE_BASE,
      'X-CSRF-Token': editCsrf,
    },
    body: body.toString(),
  });
  jar.ingest(saveRes.headers);
  const saveHtml = await saveRes.text();

  const saveSuccess = saveRes.status < 300 &&
    (saveHtml.includes('successfully updated') || saveHtml.includes('Node was successfully'));

  if (saveSuccess) {
    return {
      success: true,
      message: `Node ${nodeId} price updated: $${baseUsdPerHour.toFixed(4)}/hr base, $${storageUsd.toFixed(4)}/GB storage, $${trafficUsd.toFixed(4)}/GB traffic (USD)`,
      debug: `patchUrl=${patchUrl}`,
    };
  }

  const errMatch = saveHtml.match(/<div[^>]+flex-1[^>]*>\s*([^<]{5,}?)\s*<\/div>/i);
  const errMsg = errMatch ? errMatch[1].trim() : `HTTP ${saveRes.status}`;
  const saveSnippet = saveHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  return {
    success: false,
    message: `Node ${nodeId} price update failed: ${errMsg}`,
    debug: `patchUrl=${patchUrl} patchStatus=${saveRes.status} finalUrl=${saveRes.url} body=${saveSnippet}`,
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
