import { useState, useEffect } from "react";
import { Wallet, CheckCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";

export default function PhantomConnect({ onWalletChange }) {
  const [wallet, setWallet] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("pulse-wallet");
    if (stored) {
      setWallet(stored);
      onWalletChange?.(stored);
    }
  }, []);

  const connect = async () => {
    setLoading(true);
    try {
      if (window.solana?.isPhantom) {
        const resp = await window.solana.connect();
        const addr = resp.publicKey.toString();
        setWallet(addr);
        localStorage.setItem("pulse-wallet", addr);
        onWalletChange?.(addr);
        // Persist wallet address to user profile
        await base44.auth.updateMe({ solana_wallet: addr }).catch(() => {});
      } else {
        window.open("https://phantom.app/", "_blank");
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const disconnect = () => {
    if (window.solana?.isPhantom) window.solana.disconnect();
    setWallet(null);
    localStorage.removeItem("pulse-wallet");
    onWalletChange?.(null);
    base44.auth.updateMe({ solana_wallet: "" }).catch(() => {});
  };

  if (wallet) {
    return (
      <div className="flex items-center gap-3 bg-card border border-neon-green/30 rounded-md px-4 py-3 glow-green">
        <CheckCircle className="w-4 h-4 text-neon-green" />
        <div>
          <div className="text-[9px] text-muted-foreground tracking-[2px] uppercase">Phantom Connected</div>
          <div className="text-[11px] font-mono text-neon-green text-glow-green">
            {wallet.slice(0, 6)}...{wallet.slice(-6)}
          </div>
        </div>
        <button
          onClick={disconnect}
          className="ml-auto text-[9px] tracking-[1px] uppercase text-muted-foreground hover:text-pulse-red transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={connect}
      disabled={loading}
      className="flex items-center gap-2 bg-card border border-cyan/40 hover:border-cyan hover:glow-cyan rounded-md px-4 py-3 transition-all group"
    >
      {loading ? (
        <div className="w-4 h-4 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
      ) : (
        <Wallet className="w-4 h-4 text-cyan" />
      )}
      <div>
        <div className="text-[9px] text-muted-foreground tracking-[2px] uppercase">Wallet</div>
        <div className="text-[11px] font-mono text-cyan group-hover:text-glow-cyan">
          {loading ? "Connecting..." : "Connect Phantom"}
        </div>
      </div>
    </button>
  );
}