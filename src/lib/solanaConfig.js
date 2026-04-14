/**
 * Solana Network Configuration
 * Switch between mainnet and testnet based on environment
 */

const NETWORK = import.meta.env.VITE_SOLANA_NETWORK || 'mainnet';

export const SOLANA_CONFIG = {
  network: NETWORK,
  rpc_url: NETWORK === 'testnet'
    ? 'https://api.testnet.solana.com'
    : 'https://api.mainnet-beta.solana.com',
  pulse_mint: NETWORK === 'testnet'
    ? 'TokenkegQfeZyiNwAJsyFbPVwwQnmZmwMw8d9VLLngc' // Testnet USDC for testing
    : '2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p', // Mainnet PULSE
  pulse_decimals: 6,
  pulse_price_usd: NETWORK === 'testnet' ? 0.01 : 0.01,
  is_testnet: NETWORK === 'testnet',
};

export function getNetworkLabel() {
  return SOLANA_CONFIG.is_testnet ? '🧪 TESTNET' : '🚀 MAINNET';
}