/**
 * getTreasuryBalances — Admin only
 *
 * Returns live balances for all Pulse treasury wallets:
 *   - Solana distribution wallet: SOL + PULSE token balance
 *   - OctaSpace hosting account: OCTA earnings balance (web-scraped)
 *   - Clore.ai platform account: CLORE balance
 *
 * Env vars:
 *   SOLANA_RPC_URL            — Solana RPC (default: publicnode mainnet)
 *   OCTASPACE_WEB_EMAIL       — OctaSpace hosting portal login email
 *   OCTASPACE_WEB_PASSWORD    — OctaSpace hosting portal login password
 *   CLOREAI_API_KEY           — Clore.ai account API key
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const RPC_URL             = Deno.env.get('SOLANA_RPC_URL') ?? 'https://solana-rpc.publicnode.com';
const DISTRIBUTION_WALLET = '5aADoB6ietioCnJLGq9rT4bJ5iJ3hrodKjhjKEUfkHQc';
const PULSE_ATA           = '6Kwsa4upYKvvPCQvZH2LxQu5oZaCu3hShJrcTqpuA6B';
const CUBE_BASE           = 'https://cube.octa.computer';
const CLORE_BASE          = 'https://api.clore.ai/v1';

// ── Solana RPC helper ──────────────────────────────────────────────────────────
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json: any = await res.json();
  return json.result;
}

// ── OctaSpace web login ────────────────────────────────────────────────────────
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

async function octaSignIn(email: string, password: string) {
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
    throw new Error(`OctaSpace sign-in failed — status=${signInRaw.status}`);
  }
  const redirectTarget = location.startsWith('http') ? location : `${CUBE_BASE}${location}`;
  const signInRes = await fetch(redirectTarget, { redirect: 'follow', headers: { ...hdrs, 'Cookie': jar.toString() } });
  jar.ingest(signInRes.headers);
  return { jar, hdrs };
}

// Extract short snippets of text around keyword matches for debugging
function extractSnippets(html: string, keywords: string[], maxPer = 2, radius = 120): string[] {
  const snippets: string[] = [];
  for (const kw of keywords) {
    let idx = 0;
    let found = 0;
    while (found < maxPer) {
      const pos = html.toLowerCase().indexOf(kw.toLowerCase(), idx);
      if (pos < 0) break;
      const raw = html.slice(Math.max(0, pos - radius), pos + radius + kw.length);
      // Strip tags and collapse whitespace for readability
      snippets.push(`[${kw}]: ${raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
      idx = pos + 1;
      found++;
    }
  }
  return snippets.slice(0, 8);
}

async function fetchOctaBalance(): Promise<{
  balance_octa: number | null; octa_price_usd: number; balance_usd: number;
  note?: string; _debug?: Record<string, unknown>;
}> {
  const email    = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');
  if (!email || !password) {
    return { balance_octa: null, octa_price_usd: 0, balance_usd: 0, note: 'OCTASPACE_WEB_EMAIL / OCTASPACE_WEB_PASSWORD not set' };
  }

  let balanceOcta = 0;
  const debugLog: string[] = [];

  try {
    const { jar, hdrs } = await octaSignIn(email, password);
    debugLog.push('login: ok');

    const sessionHdrs = { ...hdrs, 'Cookie': jar.toString(), 'Accept': 'application/json, text/html, */*' };

    // ── Step 1: fetch /hosting/nodes and extract balance_controller.js URL ────
    const nodesRes = await fetch(`${CUBE_BASE}/hosting/nodes`, { redirect: 'follow', headers: sessionHdrs });
    jar.ingest(nodesRes.headers);
    const nodesHtml = await nodesRes.text();
    debugLog.push(`/hosting/nodes: ${nodesHtml.length}b`);

    // The importmap in the HTML maps module names → hashed asset paths.
    // Extract the balance_controller path so we can read the JS and find what URL it calls.
    const importmapMatch = nodesHtml.match(/"controllers\/balance_controller"\s*:\s*"([^"]+)"/);
    if (importmapMatch) {
      const jsPath = importmapMatch[1]; // e.g. /assets/controllers/balance_controller-abc123.js
      debugLog.push(`balance_controller.js: ${jsPath}`);

      // Fetch the public JS asset (no auth required for static assets)
      const jsRes = await fetch(`${CUBE_BASE}${jsPath}`);
      if (jsRes.ok) {
        const jsText = await jsRes.text();
        debugLog.push(`js size: ${jsText.length}b`);

        // Mine URL string literals from the minified JS.
        // Look for paths that contain "balance" or "wallet".
        const urlStrings = new Set<string>();
        for (const m of jsText.matchAll(/["'`](\/[a-z0-9_/.-]{3,80})["'`]/g)) {
          const p = m[1];
          if (/balance|wallet|account/i.test(p)) urlStrings.add(p);
        }
        debugLog.push(`JS url candidates: ${[...urlStrings].join(', ')}`);

        // Try each found URL with the authenticated session
        for (const path of urlStrings) {
          try {
            const r = await fetch(`${CUBE_BASE}${path}`, {
              redirect: 'follow',
              headers: { ...sessionHdrs, 'Accept': 'application/json' },
            });
            jar.ingest(r.headers);
            if (!r.ok) { debugLog.push(`${path}: ${r.status}`); continue; }
            const ct = r.headers.get('content-type') ?? '';
            const body = await r.text();
            debugLog.push(`${path}: ${r.status} ${ct} ${body.slice(0, 120)}`);
            if (ct.includes('json')) {
              const data = JSON.parse(body);
              const candidate = data.balance ?? data.amount ?? data.octa ?? data.octa_balance ?? data.value;
              if (candidate != null) {
                balanceOcta = parseFloat(candidate) || 0;
                if (balanceOcta > 0) break;
              }
            }
          } catch (e: any) { debugLog.push(`${path}: err ${e.message}`); }
        }
      }
    }

    // ── Step 2: Try common endpoint guesses if still 0 ────────────────────────
    if (balanceOcta === 0) {
      const guesses = [
        '/hosting/balance', '/hosting/balance.json',
        '/hosting/wallet', '/hosting/wallet.json',
        '/hosting/accounts/balance', '/hosting/accounts/balance.json',
        '/api/v1/hosting/balance', '/api/v1/accounts/balance',
      ];
      for (const path of guesses) {
        try {
          const r = await fetch(`${CUBE_BASE}${path}`, {
            redirect: 'follow',
            headers: { ...sessionHdrs, 'Accept': 'application/json' },
          });
          jar.ingest(r.headers);
          const ct = r.headers.get('content-type') ?? '';
          const body = await r.text();
          debugLog.push(`guess ${path}: ${r.status} ${body.slice(0, 100)}`);
          if (r.ok && ct.includes('json')) {
            const data = JSON.parse(body);
            const candidate = data.balance ?? data.amount ?? data.octa ?? data.value;
            if (candidate != null) {
              balanceOcta = parseFloat(candidate) || 0;
              if (balanceOcta > 0) break;
            }
          }
        } catch { /* continue */ }
      }
    }
  } catch (e: any) {
    return { balance_octa: null, octa_price_usd: 0, balance_usd: 0, note: `Login failed: ${e.message}` };
  }

  // OCTA price from CoinGecko
  let octaPriceUsd = 0.09;
  try {
    const pr = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=octaspace&vs_currencies=usd', { headers: { 'Accept': 'application/json' } });
    const pd: any = await pr.json();
    octaPriceUsd = pd?.octaspace?.usd ?? octaPriceUsd;
  } catch { /* keep default */ }

  return {
    balance_octa: balanceOcta,
    octa_price_usd: octaPriceUsd,
    balance_usd: parseFloat((balanceOcta * octaPriceUsd).toFixed(2)),
    _debug: { log: debugLog },
  };
}

async function safeFetch(url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, { headers });
    return { ok: res.ok, text: await res.text(), ct: res.headers.get('content-type') ?? '' };
  } catch (e: any) {
    return { ok: false, text: '', ct: '', err: e.message };
  }
}

function tryParse(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user || user.role !== 'admin') {
    return Response.json({ error: 'Admin only' }, { status: 403 });
  }

  const results = await Promise.allSettled([
    // ── SOL balance ───────────────────────────────────────────────────────────
    (async () => {
      const result: any = await rpc('getBalance', [DISTRIBUTION_WALLET]);
      const lamports = result?.value ?? result ?? 0;
      return { balance_sol: lamports / 1e9 };
    })(),

    // ── PULSE token balance ───────────────────────────────────────────────────
    (async () => {
      const result: any = await rpc('getTokenAccountBalance', [PULSE_ATA]);
      const ui = result?.value?.uiAmount ?? 0;
      return { balance_pulse: ui };
    })(),

    // ── OctaSpace hosting balance (web-scraped) ───────────────────────────────
    fetchOctaBalance(),

    // ── Clore.ai account balance ──────────────────────────────────────────────
    (async () => {
      const apiKey = Deno.env.get('CLOREAI_API_KEY');
      if (!apiKey) return { balance_clore: null, balance_usd: 0, note: 'CLOREAI_API_KEY not set' };
      const r = await safeFetch(`${CLORE_BASE}/balance`, { 'auth': apiKey });
      if (!r.ok) return { balance_clore: 0, balance_usd: 0 };
      const data = tryParse(r.text);
      return {
        balance_clore: parseFloat(data?.balance ?? 0),
        balance_usd: parseFloat((data?.usd_value ?? 0).toFixed(2)),
      };
    })(),
  ]);

  const [solR, pulseR, octaR, cloreR] = results;

  return Response.json({
    distribution_wallet: DISTRIBUTION_WALLET,
    pulse_ata: PULSE_ATA,
    sol:   solR.status   === 'fulfilled' ? solR.value   : { balance_sol: null,   error: (solR as any).reason?.message },
    pulse: pulseR.status === 'fulfilled' ? pulseR.value : { balance_pulse: null, error: (pulseR as any).reason?.message },
    octa:  octaR.status  === 'fulfilled' ? octaR.value  : { balance_octa: null,  error: (octaR as any).reason?.message },
    clore: cloreR.status === 'fulfilled' ? cloreR.value : { balance_clore: null, error: (cloreR as any).reason?.message },
    fetched_at: new Date().toISOString(),
  });
});
