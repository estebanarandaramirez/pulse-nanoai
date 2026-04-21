import { useState, useEffect } from "react";
import { Wallet, CheckCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";

export default function PhantomConnect({ onWalletChange }) {
  const [wallet, setWallet] = useState(null);
  const [loading, setLoading] = useState(false);

  const getProvider = () => window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null);

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
      const provider = getProvider();
      if (provider) {
        const resp = await provider.connect();
        const addr = resp.publicKey.toString();
        setWallet(addr);
        localStorage.setItem("pulse-wallet", addr);
        onWalletChange?.(addr);
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
    const provider = getProvider();
    if (provider) provider.disconnect();
    setWallet(null);
    localStorage.removeItem("pulse-wallet");
    onWalletChange?.(null);
    base44.auth.updateMe({ solana_wallet: "" }).catch(() => {});
  };

  if (wallet) {
    return (
      <div className="bg-card border border-neon-green/30 rounded-md px-4 py-3 glow-green">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-neon-green animate-pulse" />
            <span className="text-[9px] tracking-[2px] uppercase text-muted-foreground">Phantom Connected</span>
          </div>
          <button
            onClick={disconnect}
            className="text-[9px] tracking-[1px] uppercase text-muted-foreground hover:text-pulse-red transition-colors"
          >
            Disconnect
          </button>
        </div>
        <div className="text-[12px] font-mono text-neon-green text-glow-green">
          {wallet.slice(0, 6)}...{wallet.slice(-6)}
        </div>
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