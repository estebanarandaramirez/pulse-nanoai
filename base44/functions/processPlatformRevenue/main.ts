/**
 * processPlatformRevenue
 *
 * Two-phase daily payout:
 *   Phase 1 — Accumulate: find EarningsLog records not yet queued (payout_queued != true),
 *             add their total_usd to PendingPayout per user, mark them payout_queued=true.
 *   Phase 2 — Pay: for each user with pending_usd > 0, send PULSE tokens.
 *             On success → zero the PendingPayout row.
 *             On failure → leave it; next cycle retries automatically.
 *
 * This means a failed transaction never orphans earnings — the balance stays and
 * is retried next cycle without any manual override_since_date dance.
 *
 * Call with { dry_run: true } to preview without sending transactions.
 * Call with { seed_since: "YYYY-MM-DD" } to only queue records from that date onwards
 * (useful for initial migration — manually mark older already-paid records payout_queued=true
 * in the entity editor, then run with seed_since to pick up genuinely unpaid ones).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import {
  Connection, PublicKey, Keypair, Transaction,
} from 'npm:@solana/web3.js@1.98.0';
import {
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from 'npm:@solana/spl-token@0.4.9';
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
  if (!treasuryKey) return Response.json({ error: 'TREASURY_PRIVATE_KEY not set' }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const dry_run: boolean = !!body.dry_run;
  const seed_since: string | undefined = body.seed_since; // optional date floor for initial migration

  // ── Phase 1: Accumulate unqueued EarningsLog → PendingPayout ────────────────
  const accumulateLog: string[] = [];

  const allLogs = await base44.asServiceRole.entities.EarningsLog.list();
  const unqueued = (allLogs ?? []).filter((l: any) => {
    if (l.payout_queued === true) return false;
    if ((parseFloat(l.total_usd) || 0) <= 0) return false;
    if (seed_since && (l.date ?? '') < seed_since) return false;
    return true;
  });

  for (const log of unqueued) {
    if (!log.user_email) continue;
    const addUsd = parseFloat(log.total_usd) || 0;

    if (!dry_run) {
      // Upsert PendingPayout: increment pending_usd
      const existing = await base44.asServiceRole.entities.PendingPayout.filter({ user_email: log.user_email });
      if (existing?.length > 0) {
        const newBal = parseFloat(((parseFloat(existing[0].pending_usd) || 0) + addUsd).toFixed(6));
        await base44.asServiceRole.entities.PendingPayout.update(existing[0].id, { pending_usd: newBal });
      } else {
        await base44.asServiceRole.entities.PendingPayout.create({ user_email: log.user_email, pending_usd: addUsd });
      }
      // Mark as queued so it's never double-counted
      await base44.asServiceRole.entities.EarningsLog.update(log.id, { payout_queued: true });
    }
    accumulateLog.push(`queued $${addUsd} for ${log.user_email} (date: ${log.date})`);
  }

  // ── Phase 2: Pay from PendingPayout ─────────────────────────────────────────
  const allPending = await base44.asServiceRole.entities.PendingPayout.list();
  const payable = (allPending ?? []).filter((p: any) => (parseFloat(p.pending_usd) || 0) > 0);

  if (payable.length === 0 && unqueued.length === 0) {
    return Response.json({ message: 'Nothing to pay — no pending balances and no unqueued earnings.' });
  }

  // User → Solana wallet map
  const allUsers = await base44.asServiceRole.entities.User.list();
  const walletMap: Record<string, string> = {};
  for (const u of allUsers ?? []) {
    if (u.email && u.solana_wallet) walletMap[u.email] = u.solana_wallet;
  }

  // Treasury keypair
  const trimmed = treasuryKey.trim();
  const secretBytes = trimmed.startsWith('[')
    ? Uint8Array.from(JSON.parse(trimmed))
    : bs58.decode(trimmed);
  const treasury = Keypair.fromSecretKey(secretBytes);
  const connection = new Connection(RPC_URL, 'confirmed');

  // Verify treasury PULSE balance
  const TREASURY_ATA = '6Kwsa4upYKvvPCQvZH2LxQu5oZaCu3hShJrcTqpuA6B';
  const treasuryAta = new PublicKey(TREASURY_ATA);
  let treasuryBalance = 0n;
  try {
    const rpcRes = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountBalance', params: [TREASURY_ATA] }),
    });
    const rpcData = await rpcRes.json();
    const amount = rpcData?.result?.value?.amount;
    if (!amount) throw new Error(`RPC returned no balance: ${JSON.stringify(rpcData).slice(0, 200)}`);
    treasuryBalance = BigInt(amount);
  } catch (e: any) {
    return Response.json({ error: 'Treasury balance check failed', detail: e.message }, { status: 400 });
  }

  const dist = { success: 0, failed: 0, skipped_no_wallet: 0 };
  const payouts: any[] = [];

  // Use dry_run-adjusted payable list (in dry_run, simulate from unqueued totals)
  const dryRunPayable: { user_email: string; pending_usd: number }[] = dry_run
    ? Object.entries(
        unqueued.reduce((acc: Record<string, number>, l: any) => {
          acc[l.user_email] = (acc[l.user_email] ?? 0) + (parseFloat(l.total_usd) || 0);
          return acc;
        }, {} as Record<string, number>)
      ).map(([user_email, pending_usd]) => ({ user_email, pending_usd }))
    : payable.map((p: any) => ({ user_email: p.user_email, pending_usd: parseFloat(p.pending_usd) || 0, _id: p.id }));

  for (const row of (dry_run ? dryRunPayable : payable)) {
    const pendingUsd = parseFloat((row as any).pending_usd) || 0;
    if (pendingUsd <= 0) continue;

    const walletAddr = walletMap[(row as any).user_email];
    if (!walletAddr) {
      dist.skipped_no_wallet++;
      payouts.push({ email: (row as any).user_email, pending_usd: pendingUsd, status: 'skipped — no solana_wallet' });
      continue;
    }

    const userPulse    = (pendingUsd * USER_SHARE) / PULSE_PRICE;
    const userLamports = BigInt(Math.floor(userPulse * 10 ** PULSE_DECIMALS));

    if (dry_run) {
      dist.success++;
      payouts.push({
        email: (row as any).user_email,
        wallet: walletAddr.slice(0, 8) + '...',
        pending_usd: parseFloat(pendingUsd.toFixed(4)),
        user_share_usd: parseFloat((pendingUsd * USER_SHARE).toFixed(4)),
        pulse_out: parseFloat(userPulse.toFixed(2)),
        status: 'dry_run',
      });
      continue;
    }

    const totalLamports = BigInt(Math.floor(
      (dryRunPayable.reduce((s, r) => s + (r.pending_usd * USER_SHARE / PULSE_PRICE), 0)) * 10 ** PULSE_DECIMALS
    ));
    if (treasuryBalance < totalLamports) {
      return Response.json({
        error: 'Insufficient PULSE in treasury',
        treasury_has: Number(treasuryBalance) / 10 ** PULSE_DECIMALS,
        needs: Number(totalLamports) / 10 ** PULSE_DECIMALS,
      }, { status: 400 });
    }

    try {
      const recipientPubkey = new PublicKey(walletAddr);
      const recipientAta = await getOrCreateAssociatedTokenAccount(
        connection, treasury, PULSE_MINT, recipientPubkey,
      );
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: treasury.publicKey }).add(
        createTransferInstruction(treasuryAta, recipientAta.address, treasury.publicKey, userLamports)
      );
      tx.sign(treasury);
      const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
      try {
        await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed');
      } catch {
        const status = await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
        const confirmed = status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized';
        if (!confirmed) throw new Error(`Transaction ${txHash} not confirmed`);
      }

      // Zero out PendingPayout only after confirmed transaction
      await base44.asServiceRole.entities.PendingPayout.update((row as any)._id, { pending_usd: 0 });

      await base44.asServiceRole.entities.ClaimEvent.create({
        amount_pls: userPulse, tx_hash: txHash, status: 'confirmed', user_email: (row as any).user_email,
      }).catch(() => {});

      dist.success++;
      payouts.push({
        email: (row as any).user_email,
        wallet: walletAddr.slice(0, 8) + '...',
        pending_usd: parseFloat(pendingUsd.toFixed(4)),
        pulse_out: parseFloat(userPulse.toFixed(2)),
        tx_hash: txHash,
        status: 'confirmed',
      });
    } catch (e: any) {
      // Leave PendingPayout unchanged — next cycle retries automatically
      dist.failed++;
      payouts.push({ email: (row as any).user_email, pending_usd: pendingUsd, status: 'failed', error: e.message });
    }
  }

  // Update PayoutSchedule for display/audit only (last_run_at always advances — failures are handled by PendingPayout)
  if (!dry_run) {
    try {
      const schedules = await base44.asServiceRole.entities.PayoutSchedule.filter({ is_active: true });
      if (schedules?.length > 0) {
        await base44.asServiceRole.entities.PayoutSchedule.update(schedules[0].id, {
          last_run_at: new Date().toISOString(),
          last_run_status: dist.failed === 0 ? 'success' : 'partial_failure',
          last_run_tx_count: dist.success,
        });
      }
    } catch { /* non-fatal */ }
  }

  return Response.json({
    dry_run,
    accumulated: accumulateLog,
    total_pulse_distributed: parseFloat(payouts.filter(p => p.status !== 'failed' && p.status !== 'skipped — no solana_wallet').reduce((s, p) => s + (p.pulse_out ?? 0), 0).toFixed(2)),
    treasury_pulse_balance: Number(treasuryBalance) / 10 ** PULSE_DECIMALS,
    distribution: dist,
    payouts,
  });
});
