import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Keypair, Connection, LAMPORTS_PER_SOL } from 'npm:@solana/web3.js@1.98.0';
import { getAssociatedTokenAddress, getAccount } from 'npm:@solana/spl-token@0.4.9';
import { Wallet, JsonRpcProvider, formatEther } from 'npm:ethers@6';
import bs58 from 'npm:bs58@6.0.0';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (user?.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
  } catch {}

  // ── Solana treasury ───────────────────────────────────────────────────────
  const treasuryKey = Deno.env.get('TREASURY_PRIVATE_KEY');
  if (!treasuryKey) return Response.json({ error: 'TREASURY_PRIVATE_KEY not set' }, { status: 500 });

  let keypair: InstanceType<typeof Keypair>;
  let detectedFormat = 'unknown';
  const trimmed = treasuryKey.trim();
  try {
    let secretBytes: Uint8Array;
    if (trimmed.startsWith('[')) {
      secretBytes = Uint8Array.from(JSON.parse(trimmed));
      detectedFormat = 'json_array';
    } else {
      secretBytes = bs58.decode(trimmed);
      detectedFormat = 'base58';
    }
    keypair = Keypair.fromSecretKey(secretBytes);
  } catch (e: any) {
    return Response.json({ error: `Failed to parse TREASURY_PRIVATE_KEY: ${e.message}` }, { status: 500 });
  }

  const solAddress = keypair.publicKey.toBase58();

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const balance = await connection.getBalance(keypair.publicKey);

  const PULSE_MINT_ADDR = '2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p';
  let pulse_balance = 0;
  try {
    const { PublicKey } = await import('npm:@solana/web3.js@1.98.0');
    const ata = await getAssociatedTokenAddress(new PublicKey(PULSE_MINT_ADDR), keypair.publicKey);
    const acc = await getAccount(connection, ata);
    pulse_balance = Number(acc.amount) / 1_000_000;
  } catch { /* no token account yet */ }

  let sol_usd = 130;
  try {
    const pr = await fetch('https://price.jup.ag/v6/price?ids=SOL');
    const pd = await pr.json();
    sol_usd = pd?.data?.SOL?.price || 130;
  } catch {}

  // ── EVM treasury ─────────────────────────────────────────────────────────
  const evmKey = Deno.env.get('EVM_TREASURY_PRIVATE_KEY');
  let evm: Record<string, any> = { configured: false };
  if (evmKey) {
    try {
      const evmWallet = new Wallet(evmKey.trim());
      const evmAddress = evmWallet.address;

      let eth_balance = 0;
      let eth_usd = 0;
      try {
        const provider = new JsonRpcProvider('https://cloudflare-eth.com');
        const raw = await provider.getBalance(evmAddress);
        eth_balance = parseFloat(formatEther(raw));
      } catch { /* RPC unreachable */ }

      try {
        const pr = await fetch('https://price.jup.ag/v6/price?ids=ETH');
        const pd = await pr.json();
        eth_usd = (pd?.data?.ETH?.price || 0) * eth_balance;
      } catch {}

      evm = {
        configured: true,
        address: evmAddress,
        balance_eth: parseFloat(eth_balance.toFixed(6)),
        balance_usd: parseFloat(eth_usd.toFixed(2)),
        network: 'ethereum-mainnet',
        note: 'OctaSpace OCTA rewards are sent here',
      };
    } catch (e: any) {
      evm = { configured: false, error: e.message };
    }
  }

  return Response.json({
    solana: {
      address: solAddress,
      balance_sol: balance / LAMPORTS_PER_SOL,
      balance_usd: parseFloat(((balance / LAMPORTS_PER_SOL) * sol_usd).toFixed(2)),
      pulse_balance,
      sol_price_usd: sol_usd,
      network: 'mainnet',
      detected_key_format: detectedFormat,
      ready_for_distribution: pulse_balance > 0 ? 'YES — has PULSE tokens' : 'PENDING — run a distribution cycle to acquire PULSE via Jupiter swap',
    },
    evm,
  });
});
