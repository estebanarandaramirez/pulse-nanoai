import { useState, useEffect } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { DollarSign, Cpu, Coins, Activity, Server, Users } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import StatCard from "../components/shared/StatCard";
import SectionTitle from "../components/shared/SectionTitle";
import StatusTag from "../components/shared/StatusTag";
import LiveMarketRates from "../components/shared/LiveMarketRates";

const WEEKLY_REVENUE = [
  { day: "Mon", revenue: 1280, lp: 138000 }, { day: "Tue", revenue: 1420, lp: 140200 },
  { day: "Wed", revenue: 1380, lp: 139500 }, { day: "Thu", revenue: 1590, lp: 141800 },
  { day: "Fri", revenue: 1510, lp: 141200 }, { day: "Sat", revenue: 1620, lp: 142100 },
  { day: "Sun", revenue: 1554, lp: 142580 },
];

const FLEET_MOCK = [
  { model: "RTX 4090", units: 210, uptime: 95.2, rev_day: 572.4, status: "active" },
  { model: "RTX 4080", units: 85, uptime: 92.1, rev_day: 158.2, status: "active" },
  { model: "A100", units: 42, uptime: 98.0, rev_day: 318.5, status: "active" },
  { model: "H100", units: 28, uptime: 97.4, rev_day: 284.6, status: "active" },
  { model: "RTX 3090", units: 95, uptime: 88.3, rev_day: 97.5, status: "idle" },
  { model: "RTX 4070", units: 40, uptime: 79.2, rev_day: 48.2, status: "active" },
];

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-[10px] font-mono">
      <div className="text-muted-foreground mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color }}>{p.name}: {typeof p.value === "number" && p.value > 1000 ? `$${p.value.toLocaleString()}` : p.value}</div>
      ))}
    </div>
  );
};

export default function Dashboard() {
  const { user } = useAuth();
  const [plsData, setPlsData] = useState({ supply: { uiAmount: 18400000 }, price_usd: 0.01 });
  const [myGPUs, setMyGPUs] = useState([]);
  const [myNode, setMyNode] = useState(null);

  useEffect(() => {
    base44.functions.invoke("solanaToken", {}).then(r => { if (r.data) setPlsData(r.data); }).catch(() => {});

    // Load user's GPUs and their node
    if (user?.email) {
      base44.entities.GPU.filter({ user_email: user.email }).then(async gpus => {
        if (!gpus?.length) return;
        setMyGPUs(gpus);
        const nodeId = gpus[0]?.node_id;
        if (nodeId) {
          const nodes = await base44.entities.Node.filter({ node_id: nodeId }).catch(() => []);
          if (nodes?.length) setMyNode(nodes[0]);
        }
      }).catch(() => {});
    }
  }, [user?.email]);

  const plsM = ((plsData?.supply?.uiAmount || 18400000) / 1e6).toFixed(1);
  const myTotalEarned = myGPUs.reduce((s, g) => s + (g.total_earned_usd ?? 0), 0);
  const myDailyEarned = myGPUs.reduce((s, g) => s + (g.daily_earned_usd ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Dashboard</h1>
        <span className="px-2 py-0.5 bg-cyan/10 border border-cyan/30 rounded text-[9px] tracking-[2px] uppercase font-mono text-cyan">
          live · solana mainnet
        </span>
      </div>

      {/* Node info banner — shown once user has a GPU assigned */}
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

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Your Daily Earnings"
          value={myDailyEarned > 0 ? `$${myDailyEarned.toFixed(2)}` : "$1,554"}
          sub={myGPUs.length > 0 ? `${myGPUs.length} GPU${myGPUs.length !== 1 ? "s" : ""} active` : "500 GPUs network-wide"}
          color="primary" icon={DollarSign}
        />
        <StatCard
          label="Your Share (60%)"
          value={myTotalEarned > 0 ? `$${(myTotalEarned * 0.6).toFixed(2)}` : "$932"}
          sub="via PULSE tokens"
          color="accent" icon={Coins}
        />
        <StatCard
          label={myNode ? "Node GPUs" : "GPU Fleet"}
          value={myNode ? `${myNode.gpu_count ?? 0}` : "500"}
          sub={myNode ? `${myNode.name}` : "94.2% avg uptime"}
          color="amber" icon={myNode ? Users : Cpu}
        />
        <StatCard label="PULSE Supply" value={`${plsM}M`} sub={`$${plsData.price_usd} per PULSE`} color="purple" icon={Activity} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>Revenue — 7 Days</SectionTitle>
          <div className="mt-3 h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={WEEKLY_REVENUE}>
                <defs>
                  <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00e5ff" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#00e5ff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={40} />
                <Tooltip content={<CTooltip />} />
                <Area type="monotone" dataKey="revenue" name="Revenue $" stroke="#00e5ff" fill="url(#cyanGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>LP Depth — 7 Days</SectionTitle>
          <div className="mt-3 h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={WEEKLY_REVENUE}>
                <defs>
                  <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#39ff14" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#39ff14" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={50} />
                <Tooltip content={<CTooltip />} />
                <Area type="monotone" dataKey="lp" name="LP Depth $" stroke="#39ff14" fill="url(#greenGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Fleet Summary */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border"><SectionTitle>Fleet Summary</SectionTitle></div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {["Model", "Units", "Uptime", "Revenue/Day", "Status"].map(h => (
                  <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FLEET_MOCK.map(g => (
                <tr key={g.model} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 text-[11px] font-mono text-foreground">{g.model}</td>
                  <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">{g.units}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-16 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${g.uptime}%`, background: g.uptime > 90 ? "var(--neon-green)" : g.uptime > 70 ? "var(--amber)" : "var(--pulse-red)" }} />
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground">{g.uptime}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-[11px] font-mono text-neon-green">${g.rev_day.toFixed(2)}</td>
                  <td className="px-4 py-2.5"><StatusTag status={g.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Live Market Rates */}
      <LiveMarketRates />

      {/* Protocol Health */}
      <div>
        <SectionTitle>Protocol Health</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          {[
            { label: "LP Pool Depth", value: "$142,580", sub: "Raydium USDC/PLS", color: "text-neon-green" },
            { label: "Total PULSE Minted", value: "18.4M", sub: "Supply cap 100M", color: "text-cyan" },
            { label: "Buyback Fund", value: "$8,912", sub: "15% of treasury", color: "text-amber" },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
              <div className="text-[9px] tracking-[2px] uppercase text-muted-foreground mb-2">{c.label}</div>
              <div className={`text-xl font-display font-bold ${c.color}`}>{c.value}</div>
              <div className="text-[9px] text-muted-foreground mt-1">{c.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}