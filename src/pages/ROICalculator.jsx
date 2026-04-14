import { useState } from "react";
import { Calculator, TrendingUp, DollarSign, Zap } from "lucide-react";
import StatCard from "../components/shared/StatCard";
import SectionTitle from "../components/shared/SectionTitle";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const GPU_MARKET_RATES = {
  "RTX 4090": 0.847, "RTX 4080": 0.560, "RTX 3090": 0.298,
  "RTX 3080": 0.175, "RTX 3070": 0.155, "RTX 3060": 0.120,
  "A100": 1.890, "H100": 2.890,
};

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-[10px] font-mono space-y-1">
      <div className="text-muted-foreground">{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: ${typeof p.value === "number" ? p.value.toFixed(2) : p.value}
        </div>
      ))}
    </div>
  );
};

export default function ROICalculator() {
  const [gpu, setGpu] = useState("RTX 4090");
  const [powerW, setPowerW] = useState(350);
  const [electricityRate, setElectricityRate] = useState(0.12);
  const [gpuCostUsd, setGpuCostUsd] = useState(1800);
  const [uptimePct, setUptimePct] = useState(90);
  const [tokenRewardsHr, setTokenRewardsHr] = useState(10);
  const [tokenPriceUsd, setTokenPriceUsd] = useState(0.01);

  const rateHr = GPU_MARKET_RATES[gpu] || 0.5;
  const effectiveHrsPerDay = 24 * (uptimePct / 100);
  const grossPerDay = rateHr * effectiveHrsPerDay;
  const yourSharePerDay = grossPerDay * 0.6;
  const powerCostPerDay = (powerW / 1000) * electricityRate * effectiveHrsPerDay;
  const tokenValuePerDay = tokenRewardsHr * effectiveHrsPerDay * tokenPriceUsd;
  const netPerDay = yourSharePerDay + tokenValuePerDay - powerCostPerDay;
  const breakEvenDays = netPerDay > 0 ? Math.ceil(gpuCostUsd / netPerDay) : Infinity;

  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i],
    revenue: parseFloat((yourSharePerDay * 30).toFixed(2)),
    cost: parseFloat((powerCostPerDay * 30).toFixed(2)),
    net: parseFloat((netPerDay * 30).toFixed(2)),
  }));

  const annualNet = netPerDay * 365;
  const annualROI = gpuCostUsd > 0 ? (annualNet / gpuCostUsd) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">ROI Calculator</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Inputs */}
        <div className="bg-card border border-border rounded-md p-5 relative card-gradient-top space-y-4">
          <SectionTitle>Configuration</SectionTitle>

          <div>
            <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">GPU Model</label>
            <select value={gpu} onChange={e => setGpu(e.target.value)}
              className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none">
              {Object.keys(GPU_MARKET_RATES).map(g => <option key={g}>{g}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "GPU Purchase Cost ($)", val: gpuCostUsd, set: setGpuCostUsd },
              { label: "Power Draw (W)", val: powerW, set: setPowerW },
              { label: "Electricity $/kWh", val: electricityRate, set: setElectricityRate },
              { label: "Target Uptime %", val: uptimePct, set: setUptimePct },
              { label: "PLS Rewards/hr", val: tokenRewardsHr, set: setTokenRewardsHr },
              { label: "PLS Price (USD)", val: tokenPriceUsd, set: setTokenPriceUsd },
            ].map(f => (
              <div key={f.label}>
                <label className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground block mb-1">{f.label}</label>
                <input type="number" value={f.val} onChange={e => f.set(parseFloat(e.target.value) || 0)}
                  className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-primary/50 outline-none" />
              </div>
            ))}
          </div>

          <div className="pt-2 border-t border-border text-[10px] font-mono text-muted-foreground">
            Market rate for <span className="text-cyan">{gpu}</span>: <span className="text-neon-green">${rateHr.toFixed(3)}/hr</span>
          </div>
        </div>

        {/* Results */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Net / Day" value={`$${netPerDay.toFixed(2)}`} color={netPerDay >= 0 ? "accent" : "amber"} icon={DollarSign} />
            <StatCard label="Net / Month" value={`$${(netPerDay * 30).toFixed(0)}`} color="primary" icon={TrendingUp} />
            <StatCard label="Annual ROI" value={`${annualROI.toFixed(1)}%`} color={annualROI >= 0 ? "accent" : "amber"} icon={Calculator} />
            <StatCard label="Break-even" value={breakEvenDays === Infinity ? "∞" : `${breakEvenDays}d`} color="amber" icon={Zap} />
          </div>

          <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top space-y-2">
            <SectionTitle>Daily Breakdown</SectionTitle>
            {[
              { label: "Gross Revenue", val: `$${grossPerDay.toFixed(3)}`, color: "text-foreground" },
              { label: "Your Share (60%)", val: `$${yourSharePerDay.toFixed(3)}`, color: "text-neon-green" },
              { label: "PLS Token Value", val: `$${tokenValuePerDay.toFixed(3)}`, color: "text-purple" },
              { label: "Power Cost", val: `-$${powerCostPerDay.toFixed(3)}`, color: "text-pulse-red" },
              { label: "Net Profit", val: `$${netPerDay.toFixed(3)}`, color: netPerDay >= 0 ? "text-cyan" : "text-amber" },
            ].map(r => (
              <div key={r.label} className="flex justify-between text-[10px] font-mono py-1 border-b border-border/50">
                <span className="text-muted-foreground">{r.label}</span>
                <span className={r.color}>{r.val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
        <SectionTitle>Monthly Profit Projection</SectionTitle>
        <div className="mt-4 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly}>
              <XAxis dataKey="month" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={40} tickFormatter={v => `$${v.toFixed(0)}`} />
              <Tooltip content={<CTooltip />} />
              <ReferenceLine y={0} stroke="hsl(240 30% 18%)" />
              <Bar dataKey="revenue" name="Revenue" fill="#00e5ff" fillOpacity={0.7} radius={[2, 2, 0, 0]} stackId="a" />
              <Bar dataKey="cost" name="Power Cost" fill="#ff4444" fillOpacity={0.7} radius={[2, 2, 0, 0]} stackId="b" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}