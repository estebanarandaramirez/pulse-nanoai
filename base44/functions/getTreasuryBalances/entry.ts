/**
 * getTreasuryBalances — Admin only
 *
 * Returns live balances for all Pulse treasury wallets:
 *   - Solana distribution wallet: SOL + PULSE token balance
 *   - OctaSpace platform account: OCTA balance
 *   - Clore.ai platform account: CLORE balance
 *
 * Env vars required:
 *   SOLANA_RPC_URL      — Solana RPC (default: publicnode mainnet)
 *   OCTASPACE_API_KEY   — OctaSpace host API key
 *   CLOREAI_API_KEY     — Clore.ai account API key
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const RPC_URL         = Deno.env.get('SOLANA_RPC_URL') ?? 'https://solana-rpc.publicnode.com';
const DISTRIBUTION_WALLET = '5aADoB6ietioCnJLGq9rT4bJ5iJ3hrodKjhjKEUfkHQc';
const PULSE_ATA           = '6Kwsa4upYKvvPCQvZH2LxQu5oZaCu3hShJrcTqpuA6B';
const OCTA_HOSTS = ['https://cube.octa.computer/api/v1', 'https://api.octa.space'];
const CLORE_BASE  = 'https://api.clore.ai/v1';

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json: any = await res.json();
  return json.result;
}

async function safeFetch(url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    return { ok: res.ok, text, ct: res.headers.get('content-type') ?? '' };
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

    // ── OctaSpace account balance ─────────────────────────────────────────────
    (async () => {
      const apiKey = Deno.env.get('OCTASPACE_API_KEY');
      if (!apiKey) return { balance_octa: null, octa_price_usd: null, note: 'OCTASPACE_API_KEY not set' };
      const headers = { 'Authorization': apiKey, 'Accept': 'application/json' };
      let balanceOcta = 0;
      for (const base of OCTA_HOSTS) {
        const r = await safeFetch(`${base}/accounts/balance`, headers);
        if (r.ok && r.ct.includes('application/json')) {
          const data = tryParse(r.text);
          if (data) { balanceOcta = parseFloat(data.balance ?? 0); break; }
        }
      }
      // OCTA price from CoinGecko
      let octaPriceUsd = 0.09;
      const priceRaw = await safeFetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=octaspace&vs_currencies=usd',
        { 'Accept': 'application/json' },
      );
      if (priceRaw.ok) {
        const pd = tryParse(priceRaw.text);
        octaPriceUsd = pd?.octaspace?.usd ?? octaPriceUsd;
      }
      return { balance_octa: balanceOcta, octa_price_usd: octaPriceUsd, balance_usd: parseFloat((balanceOcta * octaPriceUsd).toFixed(2)) };
    })(),

    // ── Clore.ai account balance ──────────────────────────────────────────────
    (async () => {
      const apiKey = Deno.env.get('CLOREAI_API_KEY');
      if (!apiKey) return { balance_clore: null, balance_usd: null, note: 'CLOREAI_API_KEY not set' };
      const r = await safeFetch(`${CLORE_BASE}/balance`, { 'auth': apiKey });
      if (!r.ok) return { balance_clore: 0, balance_usd: 0, error: `HTTP ${r.ok}` };
      const data = tryParse(r.text);
      const balanceClore = parseFloat(data?.balance ?? 0);
      const balanceUsd   = parseFloat((data?.usd_value ?? 0).toFixed(2));
      return { balance_clore: balanceClore, balance_usd: balanceUsd };
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
