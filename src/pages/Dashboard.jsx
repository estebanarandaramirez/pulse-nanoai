import { useState, useEffect } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { DollarSign, Cpu, Coins, Activity, Server, Users } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { supabase } from "@/api/supabaseClient";
import { useAuth } from "@/lib/AuthContext";
import StatCard from "../components/shared/StatCard";
import SectionTitle from "../components/shared/SectionTitle";
import StatusTag from "../components/shared/StatusTag";
import LiveMarketRates from "../components/shared/LiveMarketRates";

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-[10px] font-mono">
      <div className="text-muted-foreground mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: ${typeof p.value === "number" ? p.value.toFixed(2) : p.value}
        </div>
      ))}
    </div>
  );
};

export default function Dashboard() {
  const { user } = useAuth();
  const [plsData, setPlsData] = useState({ supply: { uiAmount: 18400000 }, price_usd: 0.01 });
  const [myGPUs, setMyGPUs] = useState([]);
  const [myNode, setMyNode] = useState(null);
  const [cloreData, setCloreData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    base44.functions.invoke("solanaToken", {}).then(r => { if (r.data) setPlsData(r.data); }).catch(() => {});
    base44.functions.invoke("fetchCloreaiEarnings", {}).then(r => { if (r.data) setCloreData(r.data); }).catch(() => {});

    if (user?.email) {
      const loadGPUs = async () => {
        try {
          let gpus = [];
          if (supabase) {
            const { data, error } = await supabase
              .from('gpus')
              .select('*')
              .eq('user_email', user.email)
              .order('last_heartbeat', { ascending: false });
            if (!error) gpus = data || [];
          }
          setMyGPUs(gpus);
          const nodeId = gpus[0]?.node_id;
          if (nodeId) {
            const nodes = await base44.entities.Node.filter({ node_id: nodeId }).catch(() => []);
            if (nodes?.length) setMyNode(nodes[0]);
          }
        } catch {}
        setLoading(false);
      };
      loadGPUs();
    } else {
      setLoading(false);
    }
  }, [user?.email]);

  const plsM = ((plsData?.supply?.uiAmount || 18400000) / 1e6).toFixed(1);
  const myTotalEarned = myGPUs.reduce((s, g) => s + (g.total_earned_usd ?? 0), 0);
  const myDailyEarned = myGPUs.reduce((s, g) => s + (g.daily_earned_usd ?? 0), 0);

  // Only project earnings from active GPUs
  const activeGPUs = myGPUs.filter(g => g.status === 'active');
  const projectedDaily = activeGPUs.reduce((s, g) => s + ((g.rate_per_hour || 0) * 24 * 0.9), 0);
  const displayDaily = myDailyEarned > 0 ? myDailyEarned : projectedDaily;

  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const revenueChart = DAYS.map(day => ({ day, revenue: parseFloat(displayDaily.toFixed(2)) }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Dashboard</h1>
        <span className="px-2 py-0.5 bg-cyan/10 border border-cyan/30 rounded text-[9px] tracking-[2px] uppercase font-mono text-cyan">
          live · solana mainnet
        </span>
      </div>

      {myNode && (
        <div className="bg-card border border-cyan/20 rounded-md p-4 relative card-gradient-top">
          <div className="flex items-center gap-3 flex-wrap">
            <Server className="w-4 h-4 text-cyan flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-mono text-cyan font-semibold">{myNode.name} · {myNode.platform}</div>
              <div className="text-[9px] font-mono text-muted-foreground mt-0.5">
                {myNode.gpu_count ?? 0} / {myNode.target_gpu_count ?? 1000} GPUs · {myNode.status}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan rounded-full"
                  style={{ width: `${Math.min(100, ((myNode.gpu_count ?? 0) / (myNode.target_gpu_count ?? 1000)) * 100)}%` }}
                />
              </div>
              <span className="text-[9px] font-mono text-muted-foreground">
                {Math.round(((myNode.gpu_count ?? 0) / (myNode.target_gpu_count ?? 1000)) * 100)}% full
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Daily Earnings"
          value={displayDaily > 0 ? `$${displayDaily.toFixed(2)}` : "—"}
          sub={activeGPUs.length > 0 ? `${activeGPUs.length} GPU${activeGPUs.length !== 1 ? "s" : ""} active` : "No active GPUs"}
          color="primary" icon={DollarSign}
        />
        <StatCard
          label="Total Earned"
          value={`$${myTotalEarned.toFixed(2)}`}
          sub="60% of gross revenue"
          color="accent" icon={Coins}
        />
        <StatCard
          label={myNode ? "Node GPUs" : "Clore Servers"}
          value={myNode ? `${myNode.gpu_count ?? 0}` : cloreData ? `${cloreData.total_servers}` : "—"}
          sub={myNode ? myNode.name : cloreData ? `${cloreData.rented_servers} rented` : "Loading..."}
          color="amber" icon={myNode ? Users : Cpu}
        />
        <StatCard label="PULSE Supply" value={`${plsM}M`} sub={`$${plsData.price_usd} per PULSE`} color="purple" icon={Activity} />
      </div>

      {/* Clore.ai live balance */}
      {cloreData && (
        <div className="bg-card border border-neon-green/20 rounded-md p-4 flex items-center gap-4 flex-wrap card-gradient-top">
          <div className="flex-1 min-w-0">
            <div className="text-[9px] tracking-[2px] uppercase text-neon-green mb-1">Clore.ai Account Balance</div>
            <div className="text-2xl font-display font-bold text-neon-green">
              ${cloreData.total_earnings_usd.toFixed(2)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground">
              {cloreData.total_servers} servers · {cloreData.rented_servers} rented
            </div>
            <div className="text-[9px] font-mono text-muted-foreground mt-0.5">
              Synced {new Date(cloreData.last_fetched).toLocaleTimeString()}
            </div>
          </div>
        </div>
      )}

      {/* Revenue chart — projected from current GPU rates */}
      {myGPUs.length > 0 && displayDaily > 0 && (
        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>
            Daily Revenue Projection
            <span className="ml-2 text-[8px] text-muted-foreground normal-case tracking-normal">at current rate</span>
          </SectionTitle>
          <div className="mt-3 h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueChart}>
                <defs>
                  <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00e5ff" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#00e5ff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={45} />
                <Tooltip content={<CTooltip />} />
                <Area type="monotone" dataKey="revenue" name="Revenue $" stroke="#00e5ff" fill="url(#cyanGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* My GPUs */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border"><SectionTitle>My GPUs</SectionTitle></div>
        {loading ? (
          <div className="p-8 text-center text-[10px] font-mono text-muted-foreground">Loading...</div>
        ) : myGPUs.length === 0 ? (
          <div className="p-8 text-center">
            <Cpu className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <div className="text-[11px] font-mono text-muted-foreground mb-3">No GPUs registered yet.</div>
            <a href="/connect" className="px-4 py-2 bg-cyan/10 border border-cyan/40 text-cyan text-[10px] font-mono rounded-md hover:border-cyan transition-colors">
              Connect a GPU →
            </a>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Model", "Status", "Rate/hr", "Uptime", "Platform", "Earned"].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {myGPUs.map(g => (
                  <tr key={g.gpu_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{g.model}</td>
                    <td className="px-4 py-2.5"><StatusTag status={g.status} /></td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">${(g.rate_per_hour || 0).toFixed(3)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-16 bg-muted rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{
                            width: `${g.uptime_percent || 0}%`,
                            background: (g.uptime_percent || 0) > 90 ? "var(--neon-green)" : (g.uptime_percent || 0) > 70 ? "var(--amber)" : "var(--pulse-red)"
                          }} />
                        </div>
                        <span className="text-[10px] font-mono text-muted-foreground">{g.uptime_percent || 0}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{g.active_platform || "—"}</td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${(g.total_earned_usd || 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <LiveMarketRates />
    </div>
  );
}
