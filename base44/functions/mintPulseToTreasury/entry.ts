/**
 * mintPulseToTreasury
 *
 * Mints PULSE tokens directly to the Solana treasury wallet.
 * Used to seed the treasury for testing the payout flow without CEX conversion.
 *
 * Call with { amount: 10000 } to mint 10,000 PULSE.
 * Defaults to 10,000 PULSE if amount not specified.
 *
 * Required env var: PULSE_MINT_AUTHORITY_KEY (falls back to TREASURY_PRIVATE_KEY)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Connection, PublicKey, Keypair } from 'npm:@solana/web3.js@1.98.0';
import { getOrCreateAssociatedTokenAccount, mintTo } from 'npm:@solana/spl-token@0.4.9';
import bs58 from 'npm:bs58@6.0.0';

const PULSE_MINT      = '2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p';
const TREASURY        = '5aADoB6ietioCnJLGq9rT4bJ5iJ3hrodKjhjKEUfkHQc';
const RPC_URL         = 'https://api.mainnet-beta.solana.com';
const PULSE_DECIMALS  = 6;

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  // Mint authority key — may be same keypair as treasury or a separate one
  const mintAuthKey = Deno.env.get('PULSE_MINT_AUTHORITY_KEY') ?? Deno.env.get('TREASURY_PRIVATE_KEY');
  if (!mintAuthKey) {
    return Response.json({ error: 'PULSE_MINT_AUTHORITY_KEY or TREASURY_PRIVATE_KEY not set' }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const amount: number = body.amount ?? 10000;

  const trimmed = mintAuthKey.trim();
  let mintAuthority: Keypair;
  try {
    const secretBytes = trimmed.startsWith('[')
      ? Uint8Array.from(JSON.parse(trimmed))
      : bs58.decode(trimmed);
    mintAuthority = Keypair.fromSecretKey(secretBytes);
  } catch (e: any) {
    return Response.json({ error: `Failed to parse mint authority key: ${e.message}` }, { status: 500 });
  }

  const connection  = new Connection(RPC_URL, 'confirmed');
  const mintPubkey  = new PublicKey(PULSE_MINT);
  const treasuryPub = new PublicKey(TREASURY);

  // Ensure treasury has a PULSE token account
  let ata;
  try {
    ata = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mintPubkey, treasuryPub);
  } catch (e: any) {
    return Response.json({ error: `Failed to get/create treasury token account: ${e.message}` }, { status: 500 });
  }

  // Mint
  const lamports = BigInt(Math.floor(amount * 10 ** PULSE_DECIMALS));
  let txHash: string;
  try {
    txHash = await mintTo(connection, mintAuthority, mintPubkey, ata.address, mintAuthority, lamports);
  } catch (e: any) {
    return Response.json({
      error: `Mint failed: ${e.message}`,
      hint: 'Confirm that PULSE_MINT_AUTHORITY_KEY is the actual mint authority for this token. Check on Solana Explorer.',
    }, { status: 500 });
  }

  return Response.json({
    success: true,
    minted_pulse: amount,
    treasury_wallet: TREASURY,
    treasury_ata: ata.address.toBase58(),
    tx_hash: txHash,
    next_step: 'Treasury now has PULSE. Run processPlatformRevenue { dry_run: true } to preview the distribution.',
  });
});
