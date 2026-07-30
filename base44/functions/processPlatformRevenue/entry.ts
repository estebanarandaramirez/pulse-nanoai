/**
 * processPlatformRevenue
 *
 * Two-phase daily payout:
 *   Phase 1 — Accumulate: EarningsLog records with payout_queued != true are added to
 *             PendingPayout per user and marked payout_queued=true. A record is never
 *             counted twice regardless of how many times the job runs.
 *   Phase 2 — Pay: each user with pending_usd > 0 receives PULSE tokens.
 *             On success: PendingPayout row is zeroed.
 *             On failure: row is left intact; next cycle retries automatically.
 *
 * Body params:
 *   dry_run: true       — preview only, no state changes
 *   seed_since: "YYYY-MM-DD" — only accumulate EarningsLog records on or after this date
 *                              (use during initial migration to skip already-paid records)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Connection, PublicKey, Keypair, Transaction } from 'npm:@solana/web3.js@1.98.0';
import { createTransferInstruction, getOrCreateAssociatedTokenAccount } from 'npm:@solana/spl-token@0.4.9';
import bs58 from 'npm:bs58@6.0.0';

const RPC_URL        = Deno.env.get('SOLANA_RPC_URL') ?? 'https://solana-rpc.publicnode.com';
const PULSE_MINT     = new PublicKey('2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p');
const PULSE_DECIMALS = 6;
const PULSE_PRICE    = 0.01;
const USER_SHARE     = 0.60;
const TREASURY_ATA   = '6Kwsa4upYKvvPCQvZH2LxQu5oZaCu3hShJrcTqpuA6B';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (user && user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
  if (!treasuryKey) return Response.json({ error: 'TREASURY_PRIVATE_KEY not set' }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const dry_run   = !!body.dry_run;
  const seedSince = (body.seed_since as string) ?? null;

  // ── Phase 1: Accumulate unqueued EarningsLog → PendingPayout ────────────────
  const accumulateLog: string[] = [];
  const allLogs = (await base44.asServiceRole.entities.EarningsLog.list()) ?? [];
  const unqueued = allLogs.filter((l: any) =>
    l.payout_queued !== true &&
    (parseFloat(l.total_usd) || 0) > 0 &&
    (!seedSince || (l.date ?? '') >= seedSince)
  );

  for (const log of unqueued) {
    if (!log.user_email) continue;
    const addUsd = parseFloat(log.total_usd) || 0;

    if (!dry_run) {
      const existing = await base44.asServiceRole.entities.PendingPayout.filter({ user_email: log.user_email });
      if (existing?.length > 0) {
        const newBal = parseFloat(((parseFloat(existing[0].pending_usd) || 0) + addUsd).toFixed(6));
        await base44.asServiceRole.entities.PendingPayout.update(existing[0].id, { pending_usd: newBal });
      } else {
        await base44.asServiceRole.entities.PendingPayout.create({ user_email: log.user_email, pending_usd: addUsd });
      }
      await base44.asServiceRole.entities.EarningsLog.update(log.id, { payout_queued: true });
    }
    accumulateLog.push(`queued $${addUsd} for ${log.user_email} (${log.date})`);
  }

  // ── Phase 2: Pay from PendingPayout ─────────────────────────────────────────
  // In dry_run mode simulate from what would be accumulated (unqueued totals per user)
  type PayRow = { id: string | null; user_email: string; pending_usd: number };

  let payable: PayRow[];
  if (dry_run) {
    const byUser: Record<string, number> = {};
    for (const l of unqueued) {
      if (!l.user_email) continue;
      byUser[l.user_email] = (byUser[l.user_email] ?? 0) + (parseFloat(l.total_usd) || 0);
    }
    payable = Object.entries(byUser).map(([user_email, pending_usd]) => ({ id: null, user_email, pending_usd }));
  } else {
    const allPending = (await base44.asServiceRole.entities.PendingPayout.list()) ?? [];
    payable = allPending
      .filter((p: any) => (parseFloat(p.pending_usd) || 0) > 0)
      .map((p: any) => ({ id: p.id, user_email: p.user_email, pending_usd: parseFloat(p.pending_usd) || 0 }));
  }

  if (payable.length === 0) {
    return Response.json({ dry_run, accumulated: accumulateLog, message: 'Nothing pending to pay.' });
  }

  // Wallet map
  const allUsers = (await base44.asServiceRole.entities.User.list()) ?? [];
  const walletMap: Record<string, string> = {};
  for (const u of allUsers) {
    if (u.email && u.solana_wallet) walletMap[u.email] = u.solana_wallet;
  }

  // Treasury
  const secretBytes = treasuryKey.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(treasuryKey.trim()))
    : bs58.decode(treasuryKey.trim());
  const treasury  = Keypair.fromSecretKey(secretBytes);
  const connection = new Connection(RPC_URL, 'confirmed');

  // Treasury PULSE balance
  let treasuryBalance = 0n;
  try {
    const rpcRes  = await fetch(RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountBalance', params: [TREASURY_ATA] }),
    });
    const rpcData = await rpcRes.json();
    const amount  = rpcData?.result?.value?.amount;
    if (!amount) throw new Error(`No balance in RPC response: ${JSON.stringify(rpcData).slice(0, 200)}`);
    treasuryBalance = BigInt(amount);
  } catch (e: any) {
    return Response.json({ error: 'Treasury balance check failed', detail: e.message }, { status: 400 });
  }

  const dist   = { success: 0, failed: 0, skipped_no_wallet: 0 };
  const results: any[] = [];
  const treasuryPub = new PublicKey(TREASURY_ATA);

  for (const row of payable) {
    if (row.pending_usd <= 0) continue;

    const walletAddr = walletMap[row.user_email];
    if (!walletAddr) {
      dist.skipped_no_wallet++;
      results.push({ email: row.user_email, pending_usd: row.pending_usd, status: 'skipped — no wallet' });
      continue;
    }

    const pulse    = (row.pending_usd * USER_SHARE) / PULSE_PRICE;
    const lamports = BigInt(Math.floor(pulse * 10 ** PULSE_DECIMALS));

    if (dry_run) {
      dist.success++;
      results.push({
        email: row.user_email,
        wallet: walletAddr.slice(0, 8) + '...',
        pending_usd: row.pending_usd,
        user_share_usd: parseFloat((row.pending_usd * USER_SHARE).toFixed(4)),
        pulse_out: parseFloat(pulse.toFixed(2)),
        status: 'dry_run',
      });
      continue;
    }

    if (treasuryBalance < lamports) {
      results.push({ email: row.user_email, pending_usd: row.pending_usd, status: 'failed — insufficient treasury balance' });
      dist.failed++;
      continue;
    }

    try {
      const recipientPubkey = new PublicKey(walletAddr);
      const recipientAta    = await getOrCreateAssociatedTokenAccount(connection, treasury, PULSE_MINT, recipientPubkey);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: treasury.publicKey })
        .add(createTransferInstruction(treasuryPub, recipientAta.address, treasury.publicKey, lamports));
      tx.sign(treasury);
      const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });

      try {
        await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed');
      } catch {
        const status = await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
        const ok = status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized';
        if (!ok) throw new Error(`Transaction ${txHash} not confirmed`);
      }

      // Zero the PendingPayout row only after confirmed tx
      await base44.asServiceRole.entities.PendingPayout.update(row.id!, { pending_usd: 0 });
      await base44.asServiceRole.entities.ClaimEvent.create({
        amount_pls: pulse, tx_hash: txHash, status: 'confirmed', user_email: row.user_email,
      }).catch(() => {});

      treasuryBalance -= lamports;
      dist.success++;
      results.push({ email: row.user_email, wallet: walletAddr.slice(0, 8) + '...', pending_usd: row.pending_usd, pulse_out: parseFloat(pulse.toFixed(2)), tx_hash: txHash, status: 'confirmed' });
    } catch (e: any) {
      // Leave PendingPayout intact — next cycle retries automatically
      dist.failed++;
      results.push({ email: row.user_email, pending_usd: row.pending_usd, pulse_out: parseFloat(pulse.toFixed(2)), status: 'failed', error: e.message });
    }
  }

  // Update PayoutSchedule for display only
  if (!dry_run) {
    try {
      const schedules = (await base44.asServiceRole.entities.PayoutSchedule.filter({ is_active: true })) ?? [];
      if (schedules.length > 0) {
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
    distribution: dist,
    treasury_pulse_balance: Number(treasuryBalance) / 10 ** PULSE_DECIMALS,
    payouts: results,
  });
});
