/**
 * swapSolForPulse
 *
 * Swaps SOL → PULSE in the Solana treasury wallet via Jupiter aggregator.
 * Call with { sol_amount: 0.5 } to swap 0.5 SOL worth of PULSE.
 * Defaults to swapping 80% of available SOL balance if sol_amount not specified.
 *
 * Required env var: TREASURY_PRIVATE_KEY
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import {
  Keypair,
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from 'npm:@solana/web3.js@1.98.0';
import bs58 from 'npm:bs58@6.0.0';

const PULSE_MINT = '2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p';
const WSOL_MINT  = 'So11111111111111111111111111111111111111112';
const RPC_URL    = 'https://api.mainnet-beta.solana.com';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
  if (!treasuryKey) return Response.json({ error: 'TREASURY_PRIVATE_KEY not set' }, { status: 500 });

  const trimmed = treasuryKey.trim();
  let keypair: Keypair;
  try {
    const secretBytes = trimmed.startsWith('[')
      ? Uint8Array.from(JSON.parse(trimmed))
      : bs58.decode(trimmed);
    keypair = Keypair.fromSecretKey(secretBytes);
  } catch (e: any) {
    return Response.json({ error: `Failed to parse TREASURY_PRIVATE_KEY: ${e.message}` }, { status: 500 });
  }

  const connection = new Connection(RPC_URL, 'confirmed');

  // Determine how much SOL to swap
  let solBalance = 0;
  try {
    const raw = await connection.getBalance(keypair.publicKey);
    solBalance = raw / LAMPORTS_PER_SOL;
  } catch {}

  const body = await req.json().catch(() => ({}));
  // Default: swap 80% of balance, keeping 0.01 SOL for rent/fees
  const defaultSwap = Math.max(0, solBalance * 0.8 - 0.01);
  const solAmount: number = body.sol_amount ?? defaultSwap;

  if (solAmount <= 0) {
    return Response.json({
      error: 'No SOL to swap',
      sol_balance: solBalance,
      hint: 'Send SOL to the treasury first, or specify sol_amount',
    }, { status: 400 });
  }

  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  // Get Jupiter quote
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${WSOL_MINT}&outputMint=${PULSE_MINT}&amount=${lamports}&slippageBps=100`;
  const quoteRes = await fetch(quoteUrl);
  const quote = await quoteRes.json();

  if (!quote.outAmount) {
    return Response.json({ error: 'Jupiter quote failed', raw: quote }, { status: 400 });
  }

  const pulseOut = Number(quote.outAmount) / 1e6;

  // Get swap transaction from Jupiter
  const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  const swapData = await swapRes.json();

  if (!swapData.swapTransaction) {
    return Response.json({ error: 'Jupiter swap transaction build failed', raw: swapData }, { status: 400 });
  }

  // Sign and send
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  let txHash: string;
  try {
    txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(txHash, 'confirmed');
  } catch (e: any) {
    return Response.json({ error: `Swap transaction failed: ${e.message}` }, { status: 500 });
  }

  return Response.json({
    success: true,
    sol_swapped: solAmount,
    pulse_received: pulseOut,
    tx_hash: txHash,
    treasury: keypair.publicKey.toBase58(),
    next_step: 'Treasury now has PULSE. Set PayoutSchedule.pool_amount in base44 entities, then run processPlatformRevenue.',
  });
});
