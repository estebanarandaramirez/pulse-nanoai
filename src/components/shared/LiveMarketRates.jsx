import { useState, useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";

const CLORE_FALLBACK = [
  { name: "NVIDIA RTX 4090",        price_per_hour: 0.72 },
  { name: "NVIDIA RTX 3090",        price_per_hour: 0.25 },
  { name: "NVIDIA RTX 3080",        price_per_hour: 0.15 },
  { name: "NVIDIA RTX 3070",        price_per_hour: 0.10 },
  { name: "NVIDIA A100 SXM4 80GB",  price_per_hour: 1.60 },
];

const OCTA_RATES = [
  { name: "NVIDIA H100 80GB",       price_per_hour: 1.50 },
  { name: "NVIDIA A100 80GB",       price_per_hour: 1.50 },
  { name: "NVIDIA RTX 4090",        price_per_hour: 0.45 },
  { name: "NVIDIA RTX 3090",        price_per_hour: 0.45 },
  { name: "NVIDIA RTX 4080",        price_per_hour: 0.30 },
  { name: "NVIDIA RTX 3080",        price_per_hour: 0.18 },
  { name: "NVIDIA RTX 3070",        price_per_hour: 0.12 },
];

const PLATFORMS = [
  { id: "clore",      label: "Clore.ai",   color: "text-cyan",        dot: "bg-cyan",        border: "border-cyan/30" },
  { id: "octaspace",  label: "OctaSpace",  color: "text-purple-400",  dot: "bg-purple-400",  border: "border-purple-400/30" },
];

export default function LiveMarketRates() {
  const [tab, setTab] = useState("clore");
  const [cloreRates, setCloreRates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updated, setUpdated] = useState(null);

  const loadClore = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("fetchCloreaiEarnings", {});
      const marketRates = res.data?.market_rates;
      setCloreRates(marketRates?.length ? marketRates : CLORE_FALLBACK);
    } catch {
      setCloreRates(CLORE_FALLBACK);
      setError("Using cached rates — configure CLOREAI_API_KEY for live data.");
    }
    setUpdated(new Date());
    setLoading(false);
  };

  useEffect(() => { loadClore(); }, []);

  const active = PLATFORMS.find(p => p.id === tab);
  const rates = tab === "clore" ? (cloreRates || CLORE_FALLBACK) : OCTA_RATES;
  const isLive = tab === "clore";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[9px] tracking-[2px] uppercase text-muted-foreground">
          Market Rates
        </h3>
        <div className="flex items-center gap-3">
          {updated && isLive && (
            <span className="text-[9px] text-muted-foreground">
              Updated {format(updated, "HH:mm:ss")}
            </span>
          )}
          {isLive && (
            <button onClick={loadClore} disabled={loading}
              className="text-muted-foreground hover:text-cyan transition-colors" title="Refresh rates">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          )}
        </div>
      </div>

      {/* Platform tabs */}
      <div className="flex gap-1">
        {PLATFORMS.map(p => (
          <button key={p.id} onClick={() => setTab(p.id)}
            className={`px-3 py-1 rounded text-[9px] font-mono tracking-[1px] uppercase transition-all border ${
              tab === p.id
                ? `${p.color} ${p.border} bg-white/5`
                : "text-muted-foreground border-transparent hover:border-border"
            }`}>
            {p.label}
          </button>
        ))}
      </div>

      {error && tab === "clore" && (
        <div className="px-3 py-2 bg-amber/10 border border-amber/30 rounded-md text-[9px] font-mono text-amber">
          {error}
        </div>
      )}

      <div className={`bg-card border rounded-md overflow-hidden ${active.border}`}>
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${active.dot} animate-pulse-glow`} />
          <span className={`text-[9px] tracking-[2px] uppercase font-mono ${active.color}`}>{active.label}</span>
          <span className="ml-auto text-[8px] font-mono text-muted-foreground tracking-[1px]">
            {tab === "octaspace" ? "est. $/hr · on-demand" : "$/hr · on-demand"}
          </span>
        </div>

        {loading && tab === "clore" ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/50">
                <th className="px-3 py-1.5 text-[8px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">GPU</th>
                <th className="px-3 py-1.5 text-[8px] tracking-[1.5px] uppercase text-muted-foreground text-right font-normal">Rate/hr</th>
              </tr>
            </thead>
            <tbody>
              {rates.slice(0, 10).map((cls, i) => (
                <tr key={cls.name ?? i} className="hover:bg-muted/20 transition-colors border-b border-border/30">
                  <td className="px-3 py-2 text-[10px] font-mono text-foreground">{cls.name}</td>
                  <td className={`px-3 py-2 text-[11px] font-mono text-right font-semibold ${active.color}`}>
                    ${(cls.price_per_hour || 0).toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
