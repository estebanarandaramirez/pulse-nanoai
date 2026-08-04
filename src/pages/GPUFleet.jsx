import { useState, useEffect } from "react";
import { RefreshCw, Search } from "lucide-react";
import { base44 } from "@/api/base44Client";
import StatCard from "../components/shared/StatCard";
import StatusTag from "../components/shared/StatusTag";
import { Activity, DollarSign, Cpu } from "lucide-react";

const STATUS_FILTER = ["all", "active", "offline", "maintenance"];

export default function GPUFleet() {
  const [gpus, setGpus] = useState([]);
  const [platformStatus, setPlatformStatus] = useState({}); // { [gpu_id]: 'idle'|'busy'|'offline' }
  const [platformLoading, setPlatformLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch live idle/busy from OctaSpace + Clore after GPU list loads
  const fetchPlatformStatus = async (loadedGpus) => {
    setPlatformLoading(true);
    try {
      const [octaRes, cloreRes] = await Promise.allSettled([
        base44.functions.invoke('getOctaNodeInfo', {}),
        base44.functions.invoke('fetchCloreaiEarnings', {}),
      ]);

      const lookup = {};

      // OctaSpace: gpu_id matches the node name exactly ("OCTA-NVIDIAGeForceRTX3090-AWZIVG")
      if (octaRes.status === 'fulfilled') {
        for (const node of octaRes.value.data?.nodes ?? []) {
          lookup[node.name] = node.availability; // 'idle' | 'busy' | 'offline'
        }
      }

      // Clore: match by GPU model (case-insensitive partial match)
      if (cloreRes.status === 'fulfilled') {
        for (const server of cloreRes.value.data?.server_list ?? []) {
          const gpu = loadedGpus.find(g =>
            g.active_platform === 'Clore.ai' &&
            (g.model?.toLowerCase().includes(server.gpu_model?.toLowerCase()) ||
             server.gpu_model?.toLowerCase().includes(g.model?.toLowerCase()))
          );
          if (gpu) lookup[gpu.gpu_id] = server.rented ? 'busy' : 'idle';
        }
      }

      setPlatformStatus(lookup);
    } catch { /* platform status stays empty */ }
    setPlatformLoading(false);
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('getGPUFleet', {});
      if (res.data.error) {
        setError(res.data.error);
      } else {
        const loadedGpus = res.data.gpus || [];
        setGpus(loadedGpus);
        fetchPlatformStatus(loadedGpus);
      }
    } catch (e) {
      setError(`Error: ${e.message}`);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = gpus.filter(g =>
    (statusFilter === "all" || g.status === statusFilter) &&
    ((g.gpu_id ?? "").toLowerCase().includes(search.toLowerCase()) ||
     (g.model ?? "").toLowerCase().includes(search.toLowerCase()) ||
     (g.user_email ?? "").toLowerCase().includes(search.toLowerCase()))
  );

  const active = gpus.filter(g => g.status === "active").length;
  const uniqueUsers = [...new Map(gpus.map(g => [g.user_email, g])).values()];
  const totalEarned = uniqueUsers.reduce((s, g) => s + (g.earnings_usd || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">GPU Fleet</h1>
          {platformLoading && (
            <span className="text-[9px] font-mono text-muted-foreground">fetching live status...</span>
          )}
        </div>
        <button onClick={load} disabled={loading}
          className="p-1.5 border border-border rounded-md text-muted-foreground hover:text-cyan hover:border-cyan/50 transition-colors">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 bg-pulse-red/10 border border-pulse-red/40 rounded-md text-[10px] font-mono text-pulse-red">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Active / Total" value={`${active} / ${gpus.length}`} color="accent" icon={Activity} />
        <StatCard label="Total Users" value={uniqueUsers.length.toString()} color="primary" icon={Cpu} />
        <StatCard label="Total Earned (All Users)" value={`$${totalEarned.toFixed(2)}`} color="amber" icon={DollarSign} />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search GPU, model, or email..."
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
        {loading ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">Loading fleet...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">
            {gpus.length === 0 ? "No GPUs registered yet." : "No GPUs match the current filter."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["GPU ID", "Model", "User", "Status", "Availability", "Platform", "User Earned"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(g => (
                  <tr key={g.gpu_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground max-w-[180px] truncate">{g.gpu_id}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{g.model}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground max-w-[140px] truncate">{g.user_email || "—"}</td>
                    <td className="px-4 py-2.5"><StatusTag status={g.status} /></td>
                    <td className="px-4 py-2.5">
                      {platformStatus[g.gpu_id]
                        ? <StatusTag status={platformStatus[g.gpu_id]} />
                        : <span className="text-[10px] font-mono text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.active_platform || "—"}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${(g.earnings_usd || 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
