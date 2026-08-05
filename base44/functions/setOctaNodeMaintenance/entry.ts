/**
 * setOctaNodeMaintenance
 * Toggles maintenance mode on an OctaSpace node via web login.
 * Called by the PulseCoordinator when a Clore rental starts/ends.
 *
 * Input:  { node_id: string, maintenance: boolean }
 * Output: { success: boolean }
 *
 * Required env vars: OCTASPACE_WEB_EMAIL, OCTASPACE_WEB_PASSWORD
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

function extractFormInt(html: string, fieldName: string): number {
  const escaped = fieldName.replace(/[[\]]/g, '\\$&');
  const m = html.match(new RegExp(`name=["']${escaped}["'][^>]+value=["']([^"']+)["']`))
    ?? html.match(new RegExp(`value=["']([^"']+)["'][^>]+name=["']${escaped}["']`));
  return m ? parseInt(m[1]) || 0 : 0;
}

async function signIn(email: string, password: string): Promise<{ jar: CookieJar; hdrs: Record<string, string> }> {
  const jar = new CookieJar();
  const hdrs: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const loginPageRes = await fetch(`${CUBE_BASE}/users/sign_in`, { headers: hdrs });
  jar.ingest(loginPageRes.headers);
  const loginHtml = await loginPageRes.text();
  const csrf = extractCsrf(loginHtml);
  if (!csrf) throw new Error('Could not extract CSRF from sign-in page');
  const signInRaw = await fetch(`${CUBE_BASE}/users/sign_in`, {
    method: 'POST', redirect: 'manual',
    headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': jar.toString(), 'Referer': `${CUBE_BASE}/users/sign_in`, 'Origin': CUBE_BASE },
    body: new URLSearchParams({ authenticity_token: csrf, 'user[email]': email, 'user[password]': password, 'user[remember_me]': '0', commit: 'Log in' }).toString(),
  });
  jar.ingest(signInRaw.headers);
  const location = signInRaw.headers.get('location') ?? '';
  if (signInRaw.status >= 400 || signInRaw.status === 200 || location.includes('/sign_in') || !location) {
    throw new Error(`Sign-in failed — status=${signInRaw.status}`);
  }
  const redirectTarget = location.startsWith('http') ? location : `${CUBE_BASE}${location}`;
  const signInRes = await fetch(redirectTarget, { redirect: 'follow', headers: { ...hdrs, 'Cookie': jar.toString() } });
  jar.ingest(signInRes.headers);
  return { jar, hdrs };
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const email    = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');
  if (!email || !password) {
    return Response.json({ error: 'OCTASPACE_WEB_EMAIL/OCTASPACE_WEB_PASSWORD not configured' }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const nodeId     = String(body.node_id ?? '');
  const maintenance = Boolean(body.maintenance);

  if (!nodeId) return Response.json({ error: 'node_id required' }, { status: 400 });

  try {
    const { jar, hdrs } = await signIn(email, password);

    // Fetch config page to get current settings + fresh CSRF token
    const configRes = await fetch(`${CUBE_BASE}/nodes/${nodeId}?type=configuration`, {
      redirect: 'follow',
      headers: { ...hdrs, 'Cookie': jar.toString() },
    });
    jar.ingest(configRes.headers);
    const configHtml = await configRes.text();
    const csrf = extractCsrf(configHtml);
    if (!csrf) throw new Error('Could not extract CSRF from node config page');

    // Preserve current prices from the form
    const baseUsd    = extractFormInt(configHtml, 'node_price[base_usd]');
    const storageUsd = extractFormInt(configHtml, 'node_price[storage_usd]');
    const trafficUsd = extractFormInt(configHtml, 'node_price[traffic_usd]');
    const portsStart = extractFormInt(configHtml, 'node_setting[service_ports_start]') || 51800;
    const portsEnd   = extractFormInt(configHtml, 'node_setting[service_ports_end]')   || 51816;

    // Rental service enabled when checkbox is present and checked
    const rentalEnabled = /name=["']node_setting\[services\]\[\]["'][^>]*value=["']rental["'][^>]*checked/i.test(configHtml)
      || (/value=["']rental["']/i.test(configHtml) && !/name=["']node_setting\[services\]\[\]["'/i.test(configHtml));

    const params = new URLSearchParams();
    params.set('_method', 'patch');
    params.set('authenticity_token', csrf);
    if (rentalEnabled) params.append('node_setting[services][]', 'rental');
    else params.append('node_setting[services][]', '');
    params.set('node_setting[service_ports_start]', String(portsStart));
    params.set('node_setting[service_ports_end]', String(portsEnd));
    params.append('node_setting[service_ports_enable]', '0');
    params.append('node_setting[service_ports_enable]', '1');
    params.append('node_price[attr_name]', 'base_usd');
    params.set('node_price[base_usd]', String(baseUsd));
    params.append('node_price[attr_name]', 'storage_usd');
    params.set('node_price[storage_usd]', String(storageUsd));
    params.append('node_price[attr_name]', 'traffic_usd');
    params.set('node_price[traffic_usd]', String(trafficUsd));
    for (const d of [1, 2, 3, 4, 5, 6, 7]) params.append('node_setting[rent_days][]', String(d));
    params.set('node_setting[rent_hours_start]', '0');
    params.set('node_setting[rent_hours_end]', '23');
    params.append('node_setting[mining_disabled]', '0');
    params.append('node_setting[mining_disabled]', '1');
    params.set('node_setting[maintenance]', maintenance ? '1' : '0');
    params.set('commit', 'Save settings');

    const saveRes = await fetch(`${CUBE_BASE}/nodes/${nodeId}/node_settings`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...hdrs,
        'Cookie': jar.toString(),
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Origin': CUBE_BASE,
        'Referer': `${CUBE_BASE}/nodes/${nodeId}?type=configuration`,
        'X-CSRF-Token': csrf,
        'Turbo-Frame': `configuration_node_${nodeId}`,
      },
      body: params.toString(),
    });

    if (saveRes.status >= 400) throw new Error(`node_settings POST returned ${saveRes.status}`);

    return Response.json({ success: true, node_id: nodeId, maintenance });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
});
