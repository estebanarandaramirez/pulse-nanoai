/**
 * getTreasuryBalances — Admin only
 *
 * Returns live balances for all Pulse treasury wallets:
 *   - Solana distribution wallet: SOL + PULSE token balance
 *   - OctaSpace treasury wallet: OCTA balance (EVM, OctaSpace network)
 *   - Clore.ai platform account: CLORE balance
 *
 * Env vars:
 *   SOLANA_RPC_URL      — Solana RPC (default: publicnode mainnet)
 *   OCTA_WALLET_ADDRESS — Treasury wallet address on OctaSpace EVM network
 *   CLOREAI_API_KEY     — Clore.ai account API key
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SOLANA_RPC       = Deno.env.get('SOLANA_RPC_URL') ?? 'https://solana-rpc.publicnode.com';
const DISTRIBUTION_WALLET = '5aADoB6ietioCnJLGq9rT4bJ5iJ3hrodKjhjKEUfkHQc';
const PULSE_ATA           = '6Kwsa4upYKvvPCQvZH2LxQu5oZaCu3hShJrcTqpuA6B';
const OCTA_RPC         = 'https://rpc.octa.space';
const CLORE_BASE       = 'https://api.clore.ai/v1';

async function solanaRpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json: any = await res.json();
  return json.result;
}

async function evmGetBalance(walletAddress: string): Promise<number> {
  const res = await fetch(OCTA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_getBalance',
      params: [walletAddress, 'latest'],
    }),
  });
  const json: any = await res.json();
  // result is a hex string in wei; OCTA has 18 decimals
  const wei = BigInt(json.result ?? '0x0');
  return Number(wei) / 1e18;
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

  const octaWallet = Deno.env.get('OCTA_WALLET_ADDRESS');

  const results = await Promise.allSettled([
    // ── SOL balance ───────────────────────────────────────────────────────────
    (async () => {
      const result: any = await solanaRpc('getBalance', [DISTRIBUTION_WALLET]);
      return { balance_sol: (result?.value ?? result ?? 0) / 1e9 };
    })(),

    // ── PULSE token balance ───────────────────────────────────────────────────
    (async () => {
      const result: any = await solanaRpc('getTokenAccountBalance', [PULSE_ATA]);
      return { balance_pulse: result?.value?.uiAmount ?? 0 };
    })(),

    // ── OCTA balance (EVM wallet on OctaSpace network) ────────────────────────
    (async () => {
      if (!octaWallet) return { balance_octa: null, balance_usd: 0, note: 'OCTA_WALLET_ADDRESS not set' };
      const balanceOcta = await evmGetBalance(octaWallet);
      let octaPriceUsd = 0.09;
      try {
        const pr = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=octaspace&vs_currencies=usd');
        const pd: any = await pr.json();
        octaPriceUsd = pd?.octaspace?.usd ?? octaPriceUsd;
      } catch { /* keep default */ }
      return {
        balance_octa: balanceOcta,
        octa_price_usd: octaPriceUsd,
        balance_usd: parseFloat((balanceOcta * octaPriceUsd).toFixed(2)),
        wallet: octaWallet,
      };
    })(),

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
