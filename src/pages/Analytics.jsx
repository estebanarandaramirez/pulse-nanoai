import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import StatCard from "../components/shared/StatCard";
import { TrendingUp, DollarSign, Cpu, Coins } from "lucide-react";
import SectionTitle from "../components/shared/SectionTitle";

const MONTHLY = [
  { month: "Oct", revenue: 28400, pls: 284000, gpus: 320 },
  { month: "Nov", revenue: 34200, pls: 342000, gpus: 380 },
  { month: "Dec", revenue: 41800, pls: 418000, gpus: 430 },
  { month: "Jan", revenue: 38900, pls: 389000, gpus: 410 },
  { month: "Feb", revenue: 44200, pls: 442000, gpus: 460 },
  { month: "Mar", revenue: 47800, pls: 478000, gpus: 490 },
  { month: "Apr", revenue: 46800, pls: 468000, gpus: 500 },
];

const PLATFORM_SPLIT = [
  { platform: "Clore.ai", revenue: 46800, pct: 100 },
];

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-[10px] font-mono space-y-1">
      <div className="text-muted-foreground">{label}</div>
      {payload.map(p => <div key={p.name} style={{ color: p.color }}>{p.name}: {p.value?.toLocaleString()}</div>)}
    </div>
  );
};

export default function Analytics() {
  const totalRevenue = MONTHLY.reduce((s, m) => s + m.revenue, 0);
  const avgGPUs = Math.round(MONTHLY.reduce((s, m) => s + m.gpus, 0) / MONTHLY.length);
  const totalPLS = MONTHLY.reduce((s, m) => s + m.pls, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Analytics</h1>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="7-Month Revenue" value={`$${(totalRevenue / 1000).toFixed(0)}k`} color="primary" icon={DollarSign} />
        <StatCard label="Avg GPU Fleet" value={avgGPUs.toString()} color="accent" icon={Cpu} />
        <StatCard label="PLS Distributed" value={`${(totalPLS / 1e6).toFixed(1)}M`} color="amber" icon={Coins} />
        <StatCard label="MoM Growth" value="+8.4%" color="purple" icon={TrendingUp} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>Monthly Revenue</SectionTitle>
          <div className="mt-4 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={MONTHLY}>
                <defs>
                  <linearGradient id="aRevGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00e5ff" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#00e5ff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="month" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={45} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                <Tooltip content={<CTooltip />} />
                <Area type="monotone" dataKey="revenue" name="Revenue $" stroke="#00e5ff" fill="url(#aRevGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>GPU Fleet Growth</SectionTitle>
          <div className="mt-4 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={MONTHLY}>
                <XAxis dataKey="month" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={30} />
                <Tooltip content={<CTooltip />} />
                <Bar dataKey="gpus" name="GPUs" fill="#39ff14" radius={[2, 2, 0, 0]} fillOpacity={0.8} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
        <SectionTitle>Revenue by Platform (This Month)</SectionTitle>
        <div className="mt-4 space-y-3">
          {PLATFORM_SPLIT.map(p => (
            <div key={p.platform} className="flex items-center gap-3">
              <span className="text-[10px] font-mono text-muted-foreground w-20 flex-shrink-0">{p.platform}</span>
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-cyan" style={{ width: `${p.pct}%` }} />
              </div>
              <span className="text-[10px] font-mono text-cyan w-16 text-right">${p.revenue.toLocaleString()}</span>
              <span className="text-[9px] font-mono text-muted-foreground w-8 text-right">{p.pct}%</span>
            </div>
          ))}
          <p className="text-[8px] font-mono text-muted-foreground pt-1">
            Other providers (RunPod, OctaSpace) are currently gated.
          </p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
        <SectionTitle>PLS Token Emissions</SectionTitle>
        <div className="mt-4 h-40">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={MONTHLY}>
              <defs>
                <linearGradient id="plsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8844ff" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#8844ff" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="month" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={55} tickFormatter={v => `${(v/1000).toFixed(0)}k`} />
              <Tooltip content={<CTooltip />} />
              <Area type="monotone" dataKey="pls" name="PLS Emitted" stroke="#8844ff" fill="url(#plsGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}