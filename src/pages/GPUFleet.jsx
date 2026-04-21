import { useState, useEffect } from "react";
import { RefreshCw, Search, ChevronDown, ChevronUp, Activity, DollarSign, Cpu } from "lucide-react";
import { base44 } from "@/api/base44Client";
import StatCard from "../components/shared/StatCard";
import StatusTag from "../components/shared/StatusTag";

const MOCK_FLEET = [
  { gpu_id: "GPU-4090-001", model: "RTX 4090", location: "US-East", status: "active", uptime_percent: 92, total_earned_usd: 1247, rate_per_hour: 0.508, vram_gb: 24, pls_minted: 14200 },
  { gpu_id: "GPU-3090-002", model: "RTX 3090", location: "EU-West", status: "active", uptime_percent: 88, total_earned_usd: 982, rate_per_hour: 0.179, vram_gb: 24, pls_minted: 11200 },
  { gpu_id: "GPU-3080-003", model: "RTX 3080", location: "US-West", status: "idle", uptime_percent: 65, total_earned_usd: 612, rate_per_hour: 0.175, vram_gb: 10, pls_minted: 7000 },
  { gpu_id: "GPU-3070-004", model: "RTX 3070", location: "Asia-SE", status: "active", uptime_percent: 78, total_earned_usd: 445, rate_per_hour: 0.155, vram_gb: 8, pls_minted: 5100 },
  { gpu_id: "GPU-3060-005", model: "RTX 3060", location: "EU-North", status: "maintenance", uptime_percent: 0, total_earned_usd: 289, rate_per_hour: 0.120, vram_gb: 12, pls_minted: 3300 },
  { gpu_id: "GPU-4090-006", model: "RTX 4090", location: "US-East", status: "active", uptime_percent: 95, total_earned_usd: 1580, rate_per_hour: 0.508, vram_gb: 24, pls_minted: 18100 },
  { gpu_id: "GPU-3090-007", model: "RTX 3090", location: "US-West", status: "offline", uptime_percent: 0, total_earned_usd: 720, rate_per_hour: 0.179, vram_gb: 24, pls_minted: 8200 },
  { gpu_id: "GPU-3080-008", model: "RTX 3080", location: "Asia-East", status: "active", uptime_percent: 82, total_earned_usd: 890, rate_per_hour: 0.175, vram_gb: 10, pls_minted: 10200 },
];

const MOCK_MARKET = [
  { source: "Clore.ai", gpu: "RTX 4090", vram: 24, price_hr: 0.802, location: "US", status: "available" },
  { source: "Clore.ai", gpu: "A100", vram: 80, price_hr: 1.750, location: "EU", status: "rented" },
  { source: "Clore.ai", gpu: "RTX 4090", vram: 24, price_hr: 0.810, location: "US", status: "available" },
  { source: "Clore.ai", gpu: "RTX 3090", vram: 24, price_hr: 0.298, location: "EU", status: "available" },
  { source: "RunPod", gpu: "H100", vram: 80, price_hr: 2.890, location: "US", status: "rented" },
  { source: "RunPod", gpu: "RTX 4090", vram: 24, price_hr: 0.890, location: "US", status: "available" },
];

const STATUS_FILTER = ["all", "active", "idle", "offline", "maintenance"];

export default function GPUFleet() {
  const [gpus, setGpus] = useState(MOCK_FLEET);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [marketOpen, setMarketOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await base44.entities.GPU.list();
      if (data?.length) {
        // Deduplicate: keep only the most recent record per user+model combination
        const seen = new Map();
        [...data].sort((a, b) => new Date(b.last_heartbeat || 0) - new Date(a.last_heartbeat || 0))
          .forEach(g => {
            const key = `${g.user_email}|${g.model}`;
            if (!seen.has(key)) seen.set(key, g);
          });
        setGpus([...seen.values()]);
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = gpus.filter(g =>
    (statusFilter === "all" || g.status === statusFilter) &&
    (g.gpu_id?.toLowerCase().includes(search.toLowerCase()) || g.model?.toLowerCase().includes(search.toLowerCase()))
  );

  const active = gpus.filter(g => g.status === "active").length;
  const totalEarned = gpus.reduce((s, g) => s + (g.total_earned_usd || 0), 0);
  const avgUptime = gpus.length ? (gpus.reduce((s, g) => s + (g.uptime_percent || 0), 0) / gpus.length).toFixed(1) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">GPU Fleet</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setMarketOpen(p => !p)}
            className="flex items-center gap-2 px-3 py-1.5 border border-cyan/40 text-cyan text-[9px] tracking-[1.5px] uppercase font-mono rounded-md hover:border-cyan transition-colors">
            Live Market {marketOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          <button onClick={load} disabled={loading}
            className="p-1.5 border border-border rounded-md text-muted-foreground hover:text-cyan hover:border-cyan/50 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Active / Total" value={`${active} / ${gpus.length}`} color="accent" icon={Activity} />
        <StatCard label="Total Earned" value={`$${totalEarned.toLocaleString()}`} color="primary" icon={DollarSign} />
        <StatCard label="Avg Uptime" value={`${avgUptime}%`} color="amber" icon={Cpu} />
      </div>

      {marketOpen && (
        <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
          <div className="px-4 py-3 border-b border-border">
            <span className="text-[9px] tracking-[2px] uppercase text-muted-foreground">Live Market Offers</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Source", "GPU", "VRAM", "$/hr", "Location", "Status"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MOCK_MARKET.map((m, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-cyan">{m.source}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-foreground">{m.gpu}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{m.vram}GB</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${m.price_hr.toFixed(3)}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{m.location}</td>
                    <td className="px-4 py-2.5"><StatusTag status={m.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search GPU ID or model..."
            className="w-full bg-input border border-border rounded-md pl-9 pr-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none" />
        </div>
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTER.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-md text-[9px] tracking-[1px] uppercase font-mono transition-colors
                ${statusFilter === s ? "bg-cyan/20 text-cyan border border-cyan/40" : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {["GPU ID", "Model", "Status", "Rate/hr", "Uptime", "VRAM", "Location", "Earned"].map(h => (
                  <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(g => (
                <tr key={g.gpu_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.gpu_id}</td>
                  <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{g.model}</td>
                  <td className="px-4 py-2.5"><StatusTag status={g.status} /></td>
                  <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">${(g.rate_per_hour || 0).toFixed(3)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-14 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${g.uptime_percent || 0}%`, background: (g.uptime_percent || 0) > 90 ? "var(--neon-green)" : (g.uptime_percent || 0) > 70 ? "var(--amber)" : "var(--pulse-red)" }} />
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground">{g.uptime_percent || 0}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.vram_gb}GB</td>
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.location}</td>
                  <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${(g.total_earned_usd || 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}