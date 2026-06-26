/**
 * getOctaNodeInfo
 * Scrapes cube.octa.computer (web login) to get real-time node data:
 * status, rate/hr, and 24h income — all from the actual dashboard HTML.
 *
 * Required env vars:
 *   OCTASPACE_WEB_EMAIL
 *   OCTASPACE_WEB_PASSWORD
 *
 * Input:  {} — returns all nodes
 * Output: { nodes: [{ node_id, name, status, rate_per_hour, income_24h_octa, income_24h_usd }] }
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

    // Extract all node IDs and their surrounding row HTML
    // The table has columns: ID | Name | DC | Uptime | Version | Status | Image | Income 24HR
    const nodes: any[] = [];
    const rowPattern = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowPattern.exec(listHtml)) !== null) {
      const row = rowMatch[0];

      // Node ID: look for /nodes/:id link in the row
      const idMatch = row.match(/href=["']\/(?:hosting\/)?nodes\/(\d+)["']/i);
      if (!idMatch) continue;
      const nodeId = idMatch[1];

      // Node name: text of the link
      const nameMatch = row.match(/href=["']\/(?:hosting\/)?nodes\/\d+["'][^>]*>([^<]+)</i);
      const nodeName = nameMatch ? nameMatch[1].trim() : `Node ${nodeId}`;

      // Status: look for Online/Offline text
      const statusMatch = row.match(/\b(Online|Offline|online|offline)\b/i);
      const status = statusMatch ? statusMatch[1].toLowerCase() : 'offline';

      // Income 24h: pattern like "11.10 Ø / 0.94 $" or "11.10 / 0.94"
      const incomeMatch = row.match(/([\d.]+)\s*[ØØ]\s*[\/|]\s*\$?\s*([\d.]+)/i)
        ?? row.match(/([\d.]+)\s*\/\s*([\d.]+)\s*\$/i);
      const income24hOcta = incomeMatch ? parseFloat(incomeMatch[1]) : 0;
      const income24hUsd  = incomeMatch ? parseFloat(incomeMatch[2]) : 0;

      if (!nodes.find(n => n.node_id === nodeId)) {
        nodes.push({ node_id: nodeId, name: nodeName, status, income_24h_octa: income24hOcta, income_24h_usd: income24hUsd });
      }
    }

    // ── For each node: scrape config page for current rate/hr ───────────────────
    for (const node of nodes) {
      try {
        const configRes = await fetch(`${CUBE_BASE}/nodes/${node.node_id}?type=configuration`, {
          redirect: 'follow',
          headers: { ...hdrs, 'Cookie': jar.toString() },
        });
        jar.ingest(configRes.headers);
        const configHtml = await configRes.text();

        // base_usd integer (×10000) from the form input
        const baseMatch = configHtml.match(/name=["']node_price\[base_usd\]["'][^>]+value=["']([^"']+)["']|value=["']([^"']+)["'][^>]+name=["']node_price\[base_usd\]["']/i);
        const baseRaw = baseMatch ? parseFloat(baseMatch[1] ?? baseMatch[2]) : 0;

        // currency_usd: 0=OCTA, 1=USD
        const currMatch = configHtml.match(/name=["']node_price\[currency_usd\]["'][^>]+value=["']([^"']+)["']|value=["']([^"']+)["'][^>]+name=["']node_price\[currency_usd\]["']/i);
        const currencyUsd = currMatch ? parseInt(currMatch[1] ?? currMatch[2]) : 0;

        let ratePerHour = 0;
        if (currencyUsd === 1) {
          // USD mode: integer ÷ 10000
          ratePerHour = baseRaw / 10000;
        } else {
          // OCTA mode: convert via price from coingecko (rough)
          ratePerHour = 0;
        }

        // Also grab OCTA price to convert OCTA-mode rates if needed
        if (currencyUsd === 0 && baseRaw > 0) {
          const priceRaw = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=octaspace&vs_currencies=usd',
            { headers: { Accept: 'application/json' } }
          ).then(r => r.json()).catch(() => null);
          const octaPrice = priceRaw?.octaspace?.usd ?? 0.085;
          ratePerHour = (baseRaw / 10000) * octaPrice;
        }

        node.rate_per_hour = parseFloat(ratePerHour.toFixed(4));
        node.currency_mode = currencyUsd === 1 ? 'USD' : 'OCTA';
      } catch {
        node.rate_per_hour = 0;
        node.currency_mode = 'unknown';
      }
    }

    return Response.json({ success: true, nodes, scraped_from: listRes.url });
  } catch (err: any) {
    return Response.json({ success: false, message: `Error: ${err.message}` }, { status: 500 });
  }
});
