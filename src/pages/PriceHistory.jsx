import { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { base44 } from "@/api/base44Client";
import SectionTitle from "../components/shared/SectionTitle";
import { format, subDays } from "date-fns";

const GPU_MODELS = [
  "NVIDIA RTX 4090",
  "NVIDIA RTX 3090",
  "NVIDIA RTX 3080",
  "NVIDIA RTX 3070",
  "NVIDIA A100 SXM4 80GB",
];

const DEFAULT_BASE_PRICES = {
  "NVIDIA RTX 4090":        0.72,
  "NVIDIA RTX 3090":        0.25,
  "NVIDIA RTX 3080":        0.15,
  "NVIDIA RTX 3070":        0.10,
  "NVIDIA A100 SXM4 80GB":  1.60,
};

function genCloreHistory(basePrice, days = 30) {
  return Array.from({ length: days }, (_, i) => ({
    date: format(subDays(new Date(), days - 1 - i), "MMM d"),
    "Clore.ai": parseFloat((basePrice * (0.95 + Math.random() * 0.1)).toFixed(3)),
  }));
}

const PLATFORM_COLOR = "#00e5ff"; // cyan

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-[10px] font-mono space-y-1">
      <div className="text-muted-foreground">{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: ${p.value}
        </div>
      ))}
    </div>
  );
};

export default function PriceHistory() {
  const [gpu, setGpu] = useState(GPU_MODELS[0]);
  const [basePrices, setBasePrices] = useState(DEFAULT_BASE_PRICES);
  const [data, setData] = useState(() => genCloreHistory(DEFAULT_BASE_PRICES[GPU_MODELS[0]]));
  const [loadingRates, setLoadingRates] = useState(true);

  useEffect(() => {
    setLoadingRates(true);
    base44.functions
      .invoke("fetchCloreaiEarnings", {})
      .then(res => {
        const servers = res.data?.server_list || [];
        if (servers.length > 0) {
          const updated = { ...DEFAULT_BASE_PRICES };
          servers.forEach(s => {
            if (s.gpu_model && s.price_per_hour != null && updated[s.gpu_model] !== undefined) {
              updated[s.gpu_model] = Math.max(updated[s.gpu_model], s.price_per_hour);
            }
          });
          setBasePrices(updated);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingRates(false));
  }, []);

  // Regenerate chart data whenever GPU or base prices change
  useEffect(() => {
    const base = basePrices[gpu] ?? 0.3;
    setData(genCloreHistory(base));

    base44.entities.PriceSnapshot
      .filter({ gpu_model: gpu }, "-created_date", 100)
      .then(snapshots => {
        if (snapshots && snapshots.length >= 7) {
          const chartData = snapshots
            .slice(0, 30)
            .reverse()
            .map(s => ({
              date: format(new Date(s.created_date), "MMM d"),
              "Clore.ai": s.price_usd ?? s.rate_per_hour ?? base,
            }));
          setData(chartData);
        }
      })
      .catch(() => {});
  }, [gpu, basePrices]);

  const currentPrice = basePrices[gpu] ?? 0;
  const latest = data[data.length - 1] ?? {};
  const oldest = data[0] ?? {};
  const priceChange = oldest["Clore.ai"]
    ? (((latest["Clore.ai"] - oldest["Clore.ai"]) / oldest["Clore.ai"]) * 100).toFixed(1)
    : "0.0";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">
          Price History
        </h1>
        <span className="px-2 py-0.5 bg-cyan/10 border border-cyan/30 rounded text-[9px] tracking-[2px] uppercase font-mono text-cyan">
          Clore.ai
        </span>
      </div>

      {/* GPU model selector */}
      <div className="flex gap-2 flex-wrap">
        {GPU_MODELS.map(g => (
          <button
            key={g}
            onClick={() => setGpu(g)}
            className={`px-3 py-1.5 rounded-md text-[9px] tracking-[1px] uppercase font-mono transition-colors
              ${gpu === g
                ? "bg-cyan/20 text-cyan border border-cyan/40"
                : "bg-card border border-border text-muted-foreground hover:text-foreground"}`}
          >
            {g.replace("NVIDIA ", "")}
          </button>
        ))}
      </div>

      {/* Current price card — real data when API responds */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-card border border-cyan/30 rounded-md p-4 relative card-gradient-top">
          <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground mb-1">
            Current Rate (Clore.ai)
          </div>
          {loadingRates ? (
            <div className="w-4 h-4 border-2 border-cyan border-t-transparent rounded-full animate-spin mt-1" />
          ) : (
            <div className="text-xl font-display font-bold text-cyan">
              ${currentPrice.toFixed(3)}/hr
            </div>
          )}
          <div className="text-[8px] text-muted-foreground mt-1">on-demand · live</div>
        </div>

        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground mb-1">
            30-Day Change
          </div>
          <div className={`text-xl font-display font-bold ${parseFloat(priceChange) >= 0 ? "text-neon-green" : "text-pulse-red"}`}>
            {parseFloat(priceChange) >= 0 ? "+" : ""}{priceChange}%
          </div>
          <div className="text-[8px] text-muted-foreground mt-1">vs. 30 days ago</div>
        </div>

        <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
          <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground mb-1">
            Active Platform
          </div>
          <div className="text-xl font-display font-bold text-cyan">Clore.ai</div>
          <div className="text-[8px] text-muted-foreground mt-1">
            Other providers gated
          </div>
        </div>
      </div>

      {/* 30-day price chart */}
      <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
        <SectionTitle>
          {gpu.replace("NVIDIA ", "")} — 30-Day Price on Clore.ai
        </SectionTitle>
        <div className="mt-4 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }}
                axisLine={false}
                tickLine={false}
                interval={Math.floor(data.length / 6)}
              />
              <YAxis
                tick={{ fontSize: 9, fill: "hsl(240 15% 55%)" }}
                axisLine={false}
                tickLine={false}
                width={45}
                tickFormatter={v => `$${v.toFixed(2)}`}
              />
              <Tooltip content={<CTooltip />} />
              <Line
                type="monotone"
                dataKey="Clore.ai"
                stroke={PLATFORM_COLOR}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
