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

export default function LiveMarketRates() {
  const [gpuClasses, setGpuClasses] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updated, setUpdated] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("fetchCloreaiEarnings", {});
      const servers = res.data?.server_list;
      if (servers && servers.length > 0) {
        // Build a GPU class rate list from live server listings
        const rateMap = {};
        servers.forEach(s => {
          if (!s.gpu_model || !s.price_per_hour) return;
          if (!rateMap[s.gpu_model] || s.price_per_hour > rateMap[s.gpu_model]) {
            rateMap[s.gpu_model] = s.price_per_hour;
          }
        });
        const classes = Object.entries(rateMap)
          .map(([name, price_per_hour]) => ({ name, price_per_hour }))
          .sort((a, b) => b.price_per_hour - a.price_per_hour);
        setGpuClasses(classes.length ? classes : CLORE_FALLBACK);
      } else {
        setGpuClasses(CLORE_FALLBACK);
      }
    } catch {
      setGpuClasses(CLORE_FALLBACK);
      setError("Using cached rates — configure CLOREAI_API_KEY for live data.");
    }
    setUpdated(new Date());
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[9px] tracking-[2px] uppercase text-muted-foreground">
          Live Market Rates — Clore.ai
        </h3>
        <div className="flex items-center gap-3">
          {updated && (
            <span className="text-[9px] text-muted-foreground">
              Updated {format(updated, "HH:mm:ss")}
            </span>
          )}
          <button onClick={load} disabled={loading}
            className="text-muted-foreground hover:text-cyan transition-colors" title="Refresh rates">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-amber/10 border border-amber/30 rounded-md text-[9px] font-mono text-amber">
          {error}
        </div>
      )}

      <div className="bg-card border border-cyan/30 rounded-md overflow-hidden">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan animate-pulse-glow" />
          <span className="text-[9px] tracking-[2px] uppercase font-mono text-cyan">Clore.ai</span>
          <span className="ml-auto text-[8px] font-mono text-muted-foreground tracking-[1px]">
            $/hr · on-demand
          </span>
        </div>

        {loading ? (
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
              {(gpuClasses || []).slice(0, 10).map((cls, i) => (
                <tr key={cls.name ?? i} className="hover:bg-muted/20 transition-colors border-b border-border/30">
                  <td className="px-3 py-2 text-[10px] font-mono text-foreground">{cls.name}</td>
                  <td className="px-3 py-2 text-[11px] font-mono text-right text-cyan font-semibold">
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
