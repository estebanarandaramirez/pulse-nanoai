import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import StatCard from "../components/shared/StatCard";
import { TrendingUp, DollarSign, Cpu, Coins, RefreshCw } from "lucide-react";
import SectionTitle from "../components/shared/SectionTitle";
import { base44 } from "@/api/base44Client";

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-[10px] font-mono space-y-1">
      <div className="text-muted-foreground">{label}</div>
      {payload.map(p => <div key={p.name} style={{ color: p.color }}>{p.name}: {p.value}</div>)}
    </div>
  );
};

export default function Analytics() {
  const [clore, setClore] = useState(null);
  const [octa, setOcta] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [cloreRes, octaRes] = await Promise.allSettled([
      base44.functions.invoke("fetchCloreaiEarnings", {}),
      base44.functions.invoke("fetchOctaspaceEarnings", {}),
    ]);
    if (cloreRes.status === "fulfilled") setClore(cloreRes.value.data);
    if (octaRes.status === "fulfilled") setOcta(octaRes.value.data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const totalEarnings = (clore?.total_earnings_usd ?? 0) + (octa?.total_earnings_usd ?? 0);
  const totalServers = (clore?.total_servers ?? 0) + (octa?.active_nodes ?? 0);
  const rentedServers = clore?.rented_servers ?? 0;

  // Platform breakdown bar chart data
  const platformData = [
    { platform: "Clore.ai",  earnings: clore?.total_earnings_usd ?? 0,  servers: clore?.total_servers ?? 0 },
    { platform: "OctaSpace", earnings: octa?.total_earnings_usd ?? 0,   servers: octa?.active_nodes ?? 0 },
  ].filter(p => p.servers > 0 || p.earnings > 0);

  // Top GPU models by market rate from Clore
  const marketRates = (clore?.market_rates ?? []).slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Analytics</h1>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 border border-cyan/40 text-cyan text-[9px] tracking-[1.5px] uppercase font-mono rounded-md hover:border-cyan transition-colors">
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-card border border-border rounded-md p-4 animate-pulse h-20" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Total Earnings" value={`$${totalEarnings.toFixed(2)}`} color="primary" icon={DollarSign} />
          <StatCard label="Active Servers" value={`${totalServers}`} color="accent" icon={Cpu} />
          <StatCard label="Currently Rented" value={`${rentedServers}`} color="amber" icon={Coins} />
          <StatCard
            label="Utilisation"
            value={totalServers > 0 ? `${Math.round((rentedServers / totalServers) * 100)}%` : "—"}
            color="purple" icon={TrendingUp}
          />
        </div>
      )}

      {/* Platform breakdown */}
      {!loading && platformData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
            <SectionTitle>Earnings by Platform</SectionTitle>
            <div className="mt-4 h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={platformData}>
                  <XAxis dataKey="platform" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={45} tickFormatter={v => `$${v.toFixed(2)}`} />
                  <Tooltip content={<CTooltip />} />
                  <Bar dataKey="earnings" name="Earnings $" fill="#00e5ff" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
            <SectionTitle>Servers by Platform</SectionTitle>
            <div className="mt-4 h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={platformData}>
                  <XAxis dataKey="platform" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={25} />
                  <Tooltip content={<CTooltip />} />
                  <Bar dataKey="servers" name="Servers" fill="#39ff14" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Clore server list */}
      {!loading && clore?.server_list?.length > 0 && (
        <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
          <div className="px-4 py-3 border-b border-border">
            <SectionTitle>Clore.ai Servers</SectionTitle>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Server ID", "GPU", "GPUs", "Rate/hr", "Rented"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {clore.server_list.map(s => (
                  <tr key={s.server_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">#{s.server_id}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{s.gpu_model}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-cyan">{s.gpu_count}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${s.price_per_hour.toFixed(4)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${s.rented ? "bg-neon-green/10 text-neon-green" : "bg-muted text-muted-foreground"}`}>
                        {s.rented ? "Rented" : "Available"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Clore.ai market rates */}
      {!loading && marketRates.length > 0 && (
        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>Live Market Rates — Clore.ai</SectionTitle>
          <div className="mt-4 space-y-2">
            {marketRates.map(r => (
              <div key={r.name} className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground w-40 flex-shrink-0 truncate">{r.name}</span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-cyan"
                    style={{ width: `${Math.min(100, (r.price_per_hour / (marketRates[0]?.price_per_hour || 1)) * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-cyan w-20 text-right">${r.price_per_hour.toFixed(4)}/hr</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* OctaSpace nodes */}
      {!loading && octa?.nodes?.length > 0 && (
        <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
          <div className="px-4 py-3 border-b border-border">
            <SectionTitle>OctaSpace Nodes</SectionTitle>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Node ID", "GPU", "Status", "Rate/hr", "Earnings"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {octa.nodes.map(n => (
                  <tr key={n.node_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{n.node_id}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{n.gpu_name}</td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-neon-green">{n.status}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">${n.rate_per_hour.toFixed(4)}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${n.earnings_usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && !clore && !octa && (
        <div className="bg-card border border-dashed border-border rounded-md p-8 text-center text-[10px] font-mono text-muted-foreground">
          No platform data yet — set CLOREAI_API_KEY and OCTASPACE_API_KEY in base44 env vars.
        </div>
      )}
    </div>
  );
}
