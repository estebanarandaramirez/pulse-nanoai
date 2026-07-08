/**
 * liquidateOctaEarnings
 *
 * Step-based pipeline: OCTA on OctaSpace chain → SOL in Solana treasury via MEXC
 *
 * Call with { step: "status" }     — check balances on-chain and on MEXC
 * Call with { step: "deposit" }    — send OCTA from EVM treasury to MEXC deposit address
 * Call with { step: "sell" }       — sell OCTA → USDT on MEXC
 * Call with { step: "buy_sol" }    — buy SOL with USDT on MEXC
 * Call with { step: "withdraw_sol" } — withdraw SOL from MEXC to Solana treasury
 *
 * Required env vars: EVM_TREASURY_PRIVATE_KEY, MEXC_API_KEY, MEXC_API_SECRET
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Wallet, JsonRpcProvider } from 'npm:ethers@6';

const OCTA_RPC = 'https://rpc.octa.space';
const SOL_TREASURY = '5aADoB6ietioCnJLGq9rT4bJ5iJ3hrodKjhjKEUfkHQc';

async function hmac256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function mexc(method: string, path: string, params: Record<string, string>, apiKey: string, apiSecret: string) {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const queryString = new URLSearchParams(allParams).toString();
  const signature = await hmac256(apiSecret, queryString);
  const url = `https://api.mexc.com${path}?${queryString}&signature=${signature}`;
  const res = await fetch(url, { method, headers: { 'X-MEXC-APIKEY': apiKey } });
  return res.json();
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const evmKey = Deno.env.get('EVM_TREASURY_PRIVATE_KEY');
  const mexcKey = Deno.env.get('MEXC_API_KEY');
  const mexcSecret = Deno.env.get('MEXC_API_SECRET');

  if (!evmKey) return Response.json({ error: 'EVM_TREASURY_PRIVATE_KEY not set' }, { status: 500 });
  if (!mexcKey || !mexcSecret) return Response.json({ error: 'MEXC_API_KEY / MEXC_API_SECRET not set — add them in base44 env vars' }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const step: string = body.step ?? 'status';

  // ── STATUS ────────────────────────────────────────────────────────────────
  if (step === 'status') {
    const provider = new JsonRpcProvider(OCTA_RPC);
    const wallet = new Wallet(evmKey.trim(), provider);

    let octaOnChain = 0;
    try {
      const raw = await provider.getBalance(wallet.address);
      octaOnChain = parseFloat((Number(raw) / 1e18).toFixed(6));
    } catch {}

    // MEXC balances
    let mexcOcta = 0, mexcUsdt = 0, mexcSol = 0;
    try {
      const account = await mexc('GET', '/api/v3/account', {}, mexcKey, mexcSecret);
      for (const b of account.balances ?? []) {
        if (b.asset === 'OCTA') mexcOcta = parseFloat(b.free ?? '0');
        if (b.asset === 'USDT') mexcUsdt = parseFloat(b.free ?? '0');
        if (b.asset === 'SOL')  mexcSol  = parseFloat(b.free ?? '0');
      }
    } catch {}

    // MEXC OCTA deposit networks (so user can confirm correct network)
    let depositNetworks: any[] = [];
    try {
      const depInfo = await mexc('GET', '/api/v3/capital/deposit/address', { coin: 'OCTA' }, mexcKey, mexcSecret);
      depositNetworks = Array.isArray(depInfo) ? depInfo.map((d: any) => ({ network: d.network, address: d.address })) : [];
    } catch {}

    return Response.json({
      evm_treasury: wallet.address,
      octa_on_chain: octaOnChain,
      mexc: { octa: mexcOcta, usdt: mexcUsdt, sol: mexcSol },
      mexc_octa_deposit_networks: depositNetworks,
      next_step: octaOnChain > 0.01
        ? 'call with { step: "deposit" } to send OCTA to MEXC'
        : mexcOcta > 0
        ? 'call with { step: "sell" } — OCTA already on MEXC'
        : 'no OCTA available to liquidate',
    });
  }

  // ── DEPOSIT ───────────────────────────────────────────────────────────────
  if (step === 'deposit') {
    // network can be overridden via body e.g. { step: "deposit", network: "OCTA" }
    const network: string = body.network ?? 'OCTA';

    const depInfo = await mexc('GET', '/api/v3/capital/deposit/address', { coin: 'OCTA', network }, mexcKey, mexcSecret);
    const depAddresses = Array.isArray(depInfo) ? depInfo : [depInfo];
    const dep = depAddresses.find((d: any) => d.network === network) ?? depAddresses[0];
    if (!dep?.address) return Response.json({ error: 'Could not get MEXC deposit address', raw: depInfo, hint: 'Check mexc_octa_deposit_networks from the status step to find the correct network name' }, { status: 400 });

    const provider = new JsonRpcProvider(OCTA_RPC);
    const wallet = new Wallet(evmKey.trim(), provider);

    let rawBalance: bigint;
    try {
      rawBalance = await provider.getBalance(wallet.address);
    } catch (e: any) {
      return Response.json({ error: `OctaSpace RPC error: ${e.message}` }, { status: 500 });
    }

    const gasReserve = BigInt('10000000000000000'); // 0.01 OCTA for gas
    const sendAmount = rawBalance - gasReserve;
    if (sendAmount <= 0n) return Response.json({ error: 'Insufficient OCTA — need more than 0.01 OCTA to cover gas reserve' }, { status: 400 });

    let txHash: string;
    try {
      const tx = await wallet.sendTransaction({ to: dep.address, value: sendAmount });
      txHash = tx.hash;
    } catch (e: any) {
      return Response.json({ error: `On-chain transfer failed: ${e.message}` }, { status: 500 });
    }

    return Response.json({
      success: true,
      mexc_deposit_address: dep.address,
      network,
      octa_sent: Number(sendAmount) / 1e18,
      tx_hash: txHash,
      next_step: 'Wait 5-30 min for MEXC to confirm the deposit, then call { step: "sell" }',
    });
  }

  // ── SELL OCTA → USDT ─────────────────────────────────────────────────────
  if (step === 'sell') {
    const account = await mexc('GET', '/api/v3/account', {}, mexcKey, mexcSecret);
    const octaBal = (account.balances ?? []).find((b: any) => b.asset === 'OCTA');
    const octaFree = parseFloat(octaBal?.free ?? '0');

    if (octaFree < 1) return Response.json({ error: `MEXC OCTA balance too low: ${octaFree}. Deposit may still be pending.` }, { status: 400 });

    const order = await mexc('POST', '/api/v3/order', {
      symbol: 'OCTAUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: Math.floor(octaFree).toString(),
    }, mexcKey, mexcSecret);

    if (!order.orderId) return Response.json({ error: 'Sell order failed', raw: order }, { status: 400 });

    return Response.json({
      success: true,
      sold_octa: Math.floor(octaFree),
      order_id: order.orderId,
      next_step: 'Wait ~15s for the order to fill, then call { step: "buy_sol" }',
    });
  }

  // ── BUY SOL WITH USDT ─────────────────────────────────────────────────────
  if (step === 'buy_sol') {
    const account = await mexc('GET', '/api/v3/account', {}, mexcKey, mexcSecret);
    const usdtBal = (account.balances ?? []).find((b: any) => b.asset === 'USDT');
    const usdtFree = parseFloat(usdtBal?.free ?? '0');

    if (usdtFree < 0.5) return Response.json({ error: `MEXC USDT balance too low: ${usdtFree}` }, { status: 400 });

    // Leave $0.10 buffer for any fees
    const spendUsdt = (usdtFree - 0.10).toFixed(2);

    const order = await mexc('POST', '/api/v3/order', {
      symbol: 'SOLUSDT',
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: spendUsdt,
    }, mexcKey, mexcSecret);

    if (!order.orderId) return Response.json({ error: 'SOL buy order failed', raw: order }, { status: 400 });

    return Response.json({
      success: true,
      usdt_spent: spendUsdt,
      order_id: order.orderId,
      next_step: 'Wait ~15s for the order to fill, then call { step: "withdraw_sol" }',
    });
  }

  // ── WITHDRAW SOL → SOLANA TREASURY ────────────────────────────────────────
  if (step === 'withdraw_sol') {
    const account = await mexc('GET', '/api/v3/account', {}, mexcKey, mexcSecret);
    const solBal = (account.balances ?? []).find((b: any) => b.asset === 'SOL');
    const solFree = parseFloat(solBal?.free ?? '0');

    if (solFree < 0.01) return Response.json({ error: `MEXC SOL balance too low: ${solFree}` }, { status: 400 });

    // MEXC charges ~0.005 SOL withdrawal fee
    const withdrawAmount = (solFree - 0.005).toFixed(6);

    const result = await mexc('POST', '/api/v3/capital/withdraw', {
      coin: 'SOL',
      address: SOL_TREASURY,
      amount: withdrawAmount,
      network: 'SOL',
    }, mexcKey, mexcSecret);

    if (!result.id) return Response.json({ error: 'SOL withdrawal failed', raw: result }, { status: 400 });

    return Response.json({
      success: true,
      sol_withdrawn: withdrawAmount,
      withdrawal_id: result.id,
      destination: SOL_TREASURY,
      next_step: 'SOL will arrive in the Solana treasury in 5-20 min. Then run swapSolForPulse, then processPlatformRevenue.',
    });
  }

  return Response.json({ error: `Unknown step: "${step}". Valid steps: status, deposit, sell, buy_sol, withdraw_sol` }, { status: 400 });
});
