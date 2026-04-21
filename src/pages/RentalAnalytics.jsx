import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { base44 } from "@/api/base44Client";
import StatCard from "../components/shared/StatCard";
import StatusTag from "../components/shared/StatusTag";
import SectionTitle from "../components/shared/SectionTitle";
import { Clock, DollarSign, Activity } from "lucide-react";
import { format } from "date-fns";

const MOCK_RECORDS = [
  { id: "1", platform: "Clore.ai", gpu_model: "NVIDIA RTX 4090",       hours_rented: 12, cost_per_hour: 0.720, total_cost: 8.64,  status: "completed", started_at: new Date(Date.now() - 86400000 * 2).toISOString() },
  { id: "2", platform: "Clore.ai", gpu_model: "NVIDIA A100 SXM4 80GB", hours_rented: 6,  cost_per_hour: 1.600, total_cost: 9.60,  status: "completed", started_at: new Date(Date.now() - 86400000 * 3).toISOString() },
  { id: "3", platform: "Clore.ai", gpu_model: "NVIDIA RTX 4090",       hours_rented: 24, cost_per_hour: 0.720, total_cost: 17.28, status: "active",    started_at: new Date(Date.now() - 3600000 * 5).toISOString() },
  { id: "4", platform: "Clore.ai", gpu_model: "NVIDIA RTX 3090",       hours_rented: 8,  cost_per_hour: 0.250, total_cost: 2.00,  status: "completed", started_at: new Date(Date.now() - 86400000 * 5).toISOString() },
  { id: "5", platform: "Clore.ai", gpu_model: "NVIDIA RTX 3080",       hours_rented: 10, cost_per_hour: 0.150, total_cost: 1.50,  status: "completed", started_at: new Date(Date.now() - 86400000 * 7).toISOString() },
];

const PLATFORM_COLORS = { "Clore.ai": "#00e5ff" };
const PIE_COLORS = ["#00e5ff", "#39ff14", "#ffaa00", "#8844ff"];

const CTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-[10px] font-mono">
      {payload.map(p => <div key={p.name} style={{ color: p.color }}>{p.name}: {p.value}</div>)}
    </div>
  );
};

export default function RentalAnalytics() {
  const [records, setRecords] = useState(MOCK_RECORDS);

  useEffect(() => {
    base44.entities.RentalRecord.list("-created_date", 50).then(d => { if (d?.length) setRecords(d); }).catch(() => {});
  }, []);

  const totalSpend = records.reduce((s, r) => s + (r.total_cost || 0), 0);
  const totalHours = records.reduce((s, r) => s + (r.hours_rented || 0), 0);
  const active = records.filter(r => r.status === "active").length;

  const byPlatform = Object.entries(
    records.reduce((acc, r) => {
      acc[r.platform] = (acc[r.platform] || 0) + (r.total_cost || 0);
      return acc;
    }, {})
  ).map(([platform, value]) => ({ platform, value: parseFloat(value.toFixed(2)) }));

  const byModel = Object.entries(
    records.reduce((acc, r) => {
      acc[r.gpu_model] = (acc[r.gpu_model] || 0) + r.hours_rented;
      return acc;
    }, {})
  ).map(([gpu_model, hours]) => ({ gpu_model, hours }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Rental Analytics</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard label="Total Spend" value={`$${totalSpend.toFixed(2)}`} color="primary" icon={DollarSign} />
        <StatCard label="Total Hours" value={totalHours.toString()} color="amber" icon={Clock} />
        <StatCard label="Active Rentals" value={active.toString()} color="accent" icon={Activity} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>Spend by Platform</SectionTitle>
          <div className="mt-4 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byPlatform} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="platform" tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={65} />
                <Tooltip content={<CTooltip />} />
                <Bar dataKey="value" name="$ Spent" radius={[0, 3, 3, 0]}>
                  {byPlatform.map((entry, i) => <Cell key={i} fill={PIE_COLORS[i % 4]} fillOpacity={0.8} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <SectionTitle>Hours by GPU Model</SectionTitle>
          <div className="mt-4 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byModel}>
                <XAxis dataKey="gpu_model" tick={{ fontSize: 8, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }} axisLine={false} tickLine={false} width={25} />
                <Tooltip content={<CTooltip />} />
                <Bar dataKey="hours" name="Hours" fill="#00e5ff" fillOpacity={0.8} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border"><SectionTitle>Rental Records</SectionTitle></div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {["Date", "Platform", "GPU", "Hours", "Rate/hr", "Total", "Status"].map(h => (
                  <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{r.started_at ? format(new Date(r.started_at), "MMM d, HH:mm") : "—"}</td>
                  <td className="px-4 py-2.5 text-[10px] font-mono" style={{ color: PLATFORM_COLORS[r.platform] || "inherit" }}>{r.platform}</td>
                  <td className="px-4 py-2.5 text-[10px] font-mono text-foreground">{r.gpu_model}</td>
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{r.hours_rented}h</td>
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">${r.cost_per_hour?.toFixed(3)}</td>
                  <td className="px-4 py-2.5 text-[11px] font-mono text-cyan">${r.total_cost?.toFixed(2)}</td>
                  <td className="px-4 py-2.5"><StatusTag status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}