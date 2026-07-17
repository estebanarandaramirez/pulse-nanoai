/**
 * processPlatformRevenue
 *
 * Distributes PULSE to GPU node operators based on their ACTUAL earnings
 * since the last payout run, read directly from Supabase earnings_log.
 *
 * Each user receives PULSE = (their_earnings_usd * 60%) / $0.01_per_PULSE
 * 40% stays in treasury as reserve.
 *
 * Call with { dry_run: true } to preview without sending transactions.
 *
 * Required env vars: TREASURY_PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import {
  Connection, PublicKey, Keypair, Transaction,
} from 'npm:@solana/web3.js@1.98.0';
import {
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from 'npm:@solana/spl-token@0.4.9';
import { createClient } from 'npm:@supabase/supabase-js@2';
import bs58 from 'npm:bs58@6.0.0';

const RPC_URL = Deno.env.get('SOLANA_RPC_URL') ?? 'https://solana-rpc.publicnode.com';

const PULSE_MINT     = new PublicKey('2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p');
const PULSE_DECIMALS = 6;
const PULSE_PRICE    = 0.01; // $0.01 per PULSE
const USER_SHARE     = 0.60; // 60% to users, 40% stays in treasury

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user && user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!treasuryKey) return Response.json({ error: 'TREASURY_PRIVATE_KEY not set' }, { status: 500 });
  if (!supabaseUrl || !supabaseKey) return Response.json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const dry_run: boolean = !!body.dry_run;

  // ── 1. Active PayoutSchedule → get last_run_at ───────────────────────────
  const schedules = await base44.asServiceRole.entities.PayoutSchedule.filter({ is_active: true });
  if (!schedules?.length) {
    return Response.json({ message: 'No active PayoutSchedule. Create one in base44 entities with is_active: true.' });
  }
  const schedule = schedules[0];
  const sinceDate = schedule.last_run_at
    ? new Date(schedule.last_run_at).toISOString().slice(0, 10)
    : '2000-01-01';

  // ── 2. Sum earnings per user since last payout ───────────────────────────
  const sb = createClient(supabaseUrl, supabaseKey);
  const { data: logs, error: logErr } = await sb
    .from('earnings_log')
    .select('user_email, total_usd')
    .gt('date', sinceDate);

  if (logErr) return Response.json({ error: logErr.message }, { status: 500 });
  if (!logs?.length) {
    return Response.json({ message: `No earnings recorded since ${sinceDate}. Nothing to distribute.` });
  }

  const userEarnings: Record<string, number> = {};
  for (const row of logs) {
    userEarnings[row.user_email] = (userEarnings[row.user_email] ?? 0) + (parseFloat(row.total_usd) || 0);
  }

  const totalUSD     = Object.values(userEarnings).reduce((s, v) => s + v, 0);
  const userShareUSD = totalUSD * USER_SHARE;
  const totalPulse   = userShareUSD / PULSE_PRICE;

  // ── 3. User → Solana wallet map ──────────────────────────────────────────
  const allUsers = await base44.asServiceRole.entities.User.list();
  const walletMap: Record<string, string> = {};
  for (const u of allUsers ?? []) {
    if (u.email && u.solana_wallet) walletMap[u.email] = u.solana_wallet;
  }

  // ── 4. Treasury keypair ───────────────────────────────────────────────────
  const trimmed = treasuryKey.trim();
  const secretBytes = trimmed.startsWith('[')
    ? Uint8Array.from(JSON.parse(trimmed))
    : bs58.decode(trimmed);
  const treasury = Keypair.fromSecretKey(secretBytes);
  const connection = new Connection(RPC_URL, 'confirmed');

  // ── 5. Verify treasury PULSE balance ─────────────────────────────────────
  // Token account verified on-chain: 6Kwsa4upYKvvPCQvZH2LxQu5oZaCu3hShJrcTqpuA6B
  const TREASURY_ATA = '6Kwsa4upYKvvPCQvZH2LxQu5oZaCu3hShJrcTqpuA6B';
  const treasuryAta = new PublicKey(TREASURY_ATA);
  let treasuryBalance = 0n;
  try {
    const rpcRes = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountBalance',
        params: [TREASURY_ATA],
      }),
    });
    const rpcData = await rpcRes.json();
    const amount = rpcData?.result?.value?.amount;
    if (!amount) throw new Error(`RPC returned no balance. Raw: ${JSON.stringify(rpcData).slice(0, 300)}`);
    treasuryBalance = BigInt(amount);
  } catch (e: any) {
    return Response.json({
      error: 'Treasury PULSE balance check failed',
      detail: e?.message ?? String(e),
    }, { status: 400 });
  }

  const totalPulseLamports = BigInt(Math.floor(totalPulse * 10 ** PULSE_DECIMALS));
  if (!dry_run && treasuryBalance < totalPulseLamports) {
    return Response.json({
      error: 'Insufficient PULSE in treasury',
      treasury_has: Number(treasuryBalance) / 10 ** PULSE_DECIMALS,
      needs: totalPulse,
    }, { status: 400 });
  }

  // ── 6. Distribute ─────────────────────────────────────────────────────────
  const dist = { success: 0, failed: 0, skipped_no_wallet: 0 };
  const payouts: any[] = [];

  for (const [email, earned] of Object.entries(userEarnings)) {
    if (earned <= 0) continue;

    const walletAddr = walletMap[email];
    if (!walletAddr) {
      dist.skipped_no_wallet++;
      payouts.push({ email, earned_usd: earned, status: 'skipped — no solana_wallet on User profile' });
      continue;
    }

    const userPulse    = (earned * USER_SHARE) / PULSE_PRICE;
    const userLamports = BigInt(Math.floor(userPulse * 10 ** PULSE_DECIMALS));

    if (dry_run) {
      dist.success++;
      payouts.push({
        email,
        wallet: walletAddr.slice(0, 8) + '...',
        earned_usd: parseFloat(earned.toFixed(4)),
        user_share_usd: parseFloat((earned * USER_SHARE).toFixed(4)),
        pulse_out: parseFloat(userPulse.toFixed(2)),
        status: 'dry_run',
      });
      continue;
    }

    try {
      const recipientPubkey = new PublicKey(walletAddr);
      const recipientAta = await getOrCreateAssociatedTokenAccount(
        connection, treasury, PULSE_MINT, recipientPubkey
      );
      // Get fresh blockhash immediately before signing to avoid expiry
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: treasury.publicKey }).add(
        createTransferInstruction(treasuryAta!, recipientAta.address, treasury.publicKey, userLamports)
      );
      tx.sign(treasury);
      const rawTx = tx.serialize();
      const txHash = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 });
      await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed');

      await base44.asServiceRole.entities.ClaimEvent.create({
        amount_pls: userPulse, tx_hash: txHash, status: 'confirmed', user_email: email,
      }).catch(() => {});

      dist.success++;
      payouts.push({
        email,
        wallet: walletAddr.slice(0, 8) + '...',
        earned_usd: parseFloat(earned.toFixed(4)),
        pulse_out: parseFloat(userPulse.toFixed(2)),
        tx_hash: txHash,
        status: 'confirmed',
      });
    } catch (e: any) {
      dist.failed++;
      payouts.push({ email, earned_usd: earned, pulse_out: userPulse, status: 'failed', error: e.message });
    }
  }

  // ── 7. Update schedule ────────────────────────────────────────────────────
  if (!dry_run) {
    await base44.asServiceRole.entities.PayoutSchedule.update(schedule.id, {
      last_run_at: new Date().toISOString(),
      last_run_status: dist.failed === 0 ? 'success' : 'partial_failure',
      last_run_tx_count: dist.success,
    });
  }

  return Response.json({
    dry_run,
    since_date: sinceDate,
    total_revenue_usd: parseFloat(totalUSD.toFixed(4)),
    user_share_usd: parseFloat(userShareUSD.toFixed(4)),
    treasury_reserve_usd: parseFloat((totalUSD * (1 - USER_SHARE)).toFixed(4)),
    pulse_price_usd: PULSE_PRICE,
    total_pulse_distributed: parseFloat(totalPulse.toFixed(2)),
    treasury_pulse_before: Number(treasuryBalance) / 10 ** PULSE_DECIMALS,
    distribution: dist,
    payouts,
  });
});
