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

// ── OctaSpace web login (same approach as getOctaNodeInfo) ─────────────────────
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

async function fetchOctaBalance(): Promise<{ balance_octa: number; octa_price_usd: number; balance_usd: number; note?: string }> {
  const email = Deno.env.get('OCTASPACE_WEB_EMAIL');
  const password = Deno.env.get('OCTASPACE_WEB_PASSWORD');
  if (!email || !password) return { balance_octa: 0, octa_price_usd: 0, balance_usd: 0, note: 'OCTASPACE_WEB_EMAIL / OCTASPACE_WEB_PASSWORD not set' };

  const { jar, hdrs } = await octaSignIn(email, password);

  // Fetch the hosting dashboard — balance is shown in the page header/sidebar
  const res = await fetch(`${CUBE_BASE}/hosting`, {
    redirect: 'follow',
    headers: { ...hdrs, 'Cookie': jar.toString() },
  });
  jar.ingest(res.headers);
  const html = await res.text();

  // Try multiple patterns for the OCTA balance amount.
  // OctaSpace uses the Ø symbol for OCTA in income rows; the wallet balance
  // is typically shown as a plain decimal near "balance", "withdraw", or "wallet".
  let balanceOcta = 0;
  const patterns = [
    // e.g. "Balance: 12.3456 Ø" or "12.3456 OCTA"
    /[Bb]alance[\s\S]{0,200}?([\d]+\.[\d]+)\s*(?:Ø|OCTA)/,
    /[Ww]allet[\s\S]{0,200}?([\d]+\.[\d]+)\s*(?:Ø|OCTA)/,
    /[Ww]ithdraw[\s\S]{0,200}?([\d]+\.[\d]+)\s*(?:Ø|OCTA)/,
    // Fallback: any decimal followed by OCTA/Ø not on a row with "/" (that would be income_24h)
    /([\d]+\.[\d]{4,})\s*(?:Ø|OCTA)/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) { balanceOcta = parseFloat(m[1]); break; }
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
      if (!apiKey) return { balance_clore: 0, balance_usd: 0, note: 'CLOREAI_API_KEY not set' };
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
