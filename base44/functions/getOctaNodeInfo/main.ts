/**
 * getOctaNodeInfo
 * Scrapes cube.octa.computer (web login) to get real-time node data:
 * status, availability (idle/busy), rate/hr, and 24h income.
 *
 * Required env vars:
 *   OCTASPACE_WEB_EMAIL
 *   OCTASPACE_WEB_PASSWORD
 *
 * Input:  {} — returns all nodes
 * Output: { nodes: [{ node_id, name, gpu_name, status, availability, rate_per_hour, currency_mode, income_24h_octa, income_24h_usd }] }
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

function parseGpuFromNodeName(name: string): string {
  // "OCTA-NVIDIAGeForceRTX3090-AWZIVG" → "NVIDIA Ge Force RTX 3090"
  const parts = name.split('-');
  if (parts.length >= 3 && parts[0] === 'OCTA') {
    return parts.slice(1, -1).join('')
      .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2');
  }
  return '';
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

  const email = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');
  if (!email || !password) {
    return Response.json({ success: false, message: 'OCTASPACE_WEB_EMAIL and OCTASPACE_WEB_PASSWORD not set' });
  }

  try {
    const { jar, hdrs } = await signIn(email, password);

    // ── Scrape /hosting/nodes list — has status + 24h income ────────────────────
    const listRes = await fetch(`${CUBE_BASE}/hosting/nodes`, {
      redirect: 'follow',
      headers: { ...hdrs, 'Cookie': jar.toString() },
    });
    jar.ingest(listRes.headers);
    const listHtml = await listRes.text();

    const nodes: any[] = [];
    const rowPattern = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowPattern.exec(listHtml)) !== null) {
      const row = rowMatch[0];

      // Node ID: link in the row
      const idMatch = row.match(/href=["']\/(?:hosting\/)?nodes\/(\d+)["']/i);
      if (!idMatch) continue;
      const nodeId = idMatch[1];

      // Node name: text of the link
      const nameMatch = row.match(/href=["']\/(?:hosting\/)?nodes\/\d+["'][^>]*>([^<]+)</i);
      const nodeName = nameMatch ? nameMatch[1].trim() : `Node ${nodeId}`;

      // Status: Online/Offline/Busy/Rented text
      const statusMatch = row.match(/\b(Online|Offline|Busy|Rented|Idle|Ready|online|offline|busy|rented|idle|ready)\b/i);
      const rawStatus = statusMatch ? statusMatch[1].toLowerCase() : 'offline';
      const status = (rawStatus === 'online' || rawStatus === 'idle' || rawStatus === 'ready') ? 'online' : rawStatus;

      // Active instance/container count for busy detection
      const instanceMatch = row.match(/\b(\d+)\s*(?:instance|container|worker|active\s+job)/i)
        ?? row.match(/(?:instance|container)[^>]*>\s*(\d+)/i);
      const activeInstances = instanceMatch ? parseInt(instanceMatch[1]) : 0;
      const busyKeyword = /\b(?:busy|rented|occupied)\b/i.test(row);

      // availability: idle (online, not rented) | busy (online, rented) | offline
      const availability = status === 'online'
        ? (busyKeyword || activeInstances > 0 ? 'busy' : 'idle')
        : 'offline';

      // Income 24h: "11.10 Ø / 0.94 $" or "11.10 / 0.94"
      const incomeMatch = row.match(/([\d.]+)\s*[ØØ]\s*[\/|]\s*\$?\s*([\d.]+)/i)
        ?? row.match(/([\d.]+)\s*\/\s*([\d.]+)\s*\$/i);
      const income24hOcta = incomeMatch ? parseFloat(incomeMatch[1]) : 0;
      const income24hUsd  = incomeMatch ? parseFloat(incomeMatch[2]) : 0;

      if (!nodes.find(n => n.node_id === nodeId)) {
        nodes.push({
          node_id: nodeId,
          name: nodeName,
          gpu_name: parseGpuFromNodeName(nodeName),
          status,
          availability,
          income_24h_octa: income24hOcta,
          income_24h_usd: income24hUsd,
        });
      }
    }

    // ── For each node: scrape config page for current rate/hr ───────────────────
    let octaPrice = 0.085;
    for (const node of nodes) {
      try {
        const configRes = await fetch(`${CUBE_BASE}/nodes/${node.node_id}?type=configuration`, {
          redirect: 'follow',
          headers: { ...hdrs, 'Cookie': jar.toString() },
        });
        jar.ingest(configRes.headers);
        const configHtml = await configRes.text();

        // base_usd integer (×10000) from the form input
        const baseMatch = configHtml.match(/name=["']node_price\[base_usd\]["'][^>]+value=["']([^"']+)["']/)
          ?? configHtml.match(/value=["']([^"']+)["'][^>]+name=["']node_price\[base_usd\]["']/);
        const baseRaw = baseMatch ? parseFloat(baseMatch[1]) : 0;

        // currency_usd: Rails boolean checkbox pattern.
        // A hidden input (value="0") is always in the HTML; the checkbox (value="1") is checked only in USD mode.
        // We look for the `checked` attribute on the currency_usd input — hidden inputs never have `checked`.
        const usdChecked = /<input[^>]*name=["']node_price\[currency_usd\]["'][^>]*\bchecked\b/i.test(configHtml)
          || /<input[^>]*\bchecked\b[^>]*name=["']node_price\[currency_usd\]["']/i.test(configHtml);
        const currencyUsd = usdChecked ? 1 : 0;

        let ratePerHour = 0;
        if (currencyUsd === 1) {
          ratePerHour = baseRaw / 10000;
        } else if (baseRaw > 0) {
          // OCTA mode: fetch price once for all nodes
          if (octaPrice === 0.085) {
            const priceRaw = await fetch(
              'https://api.coingecko.com/api/v3/simple/price?ids=octaspace&vs_currencies=usd',
              { headers: { Accept: 'application/json' } }
            ).then(r => r.json()).catch(() => null);
            octaPrice = priceRaw?.octaspace?.usd ?? 0.085;
          }
          ratePerHour = (baseRaw / 10000) * octaPrice;
        }

        node.rate_per_hour = parseFloat(ratePerHour.toFixed(4));
        node.currency_mode = currencyUsd === 1 ? 'USD' : 'OCTA';
        node.base_usd_raw = baseRaw;
      } catch {
        node.rate_per_hour = 0;
        node.currency_mode = 'unknown';
      }
    }

    // Include a small HTML snippet for the first node row for debugging availability detection
    const firstNodeId = nodes[0]?.node_id;
    let _debug_row_snippet: string | null = null;
    if (firstNodeId) {
      const idx = listHtml.indexOf(`/nodes/${firstNodeId}`);
      if (idx > 0) {
        const rowStart = listHtml.lastIndexOf('<tr', idx);
        const rowEnd = listHtml.indexOf('</tr>', idx) + 5;
        if (rowStart > 0 && rowEnd > rowStart) {
          _debug_row_snippet = listHtml.slice(rowStart, Math.min(rowEnd, rowStart + 800));
        }
      }
    }

    return Response.json({ success: true, nodes, scraped_from: listRes.url, _debug_row_snippet });
  } catch (err: any) {
    return Response.json({ success: false, message: `Error: ${err.message}` }, { status: 500 });
  }
});
