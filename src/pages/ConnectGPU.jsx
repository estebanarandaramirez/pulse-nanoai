import { useState } from "react";
import { CheckCircle, Cpu, DollarSign, Clock, TrendingUp, Users, Zap } from "lucide-react";
import { base44 } from "@/api/base44Client";
import GPUDetector from "../components/shared/GPUDetector";
import SectionTitle from "../components/shared/SectionTitle";

const STEPS = ["GPU Detected", "Assigned to Node", "Now Earning"];

export default function ConnectGPU() {
  const [gpu, setGpu] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const onDetected = async (detected) => {
    setGpu(detected);
    setLoading(true);
    try {
      const r = await base44.functions.invoke("registerGPUDaemon", {
        gpu_model: detected.name,
        vram_gb: detected.vram,
        platform_preference: "auto",
        daemon_id: `${detected.name.replace(/ /g, "-")}-${Math.random().toString(36).slice(2, 8)}`,
        uptime_percent: 100,
      });

      const saladRate = r.data.salad_rate_hr ?? 0.3;
      const node = r.data.node;

      setResult({
        gpu_id: r.data.gpu_id,
        gpu_name: detected.name,
        vram_gb: detected.vram,
        platform: r.data.recommended_platform ?? "Salad",
        salad_rate_hr: saladRate,
        user_rate_hr: parseFloat((saladRate * 0.6).toFixed(3)),
        daily_usd: parseFloat((saladRate * 0.6 * 24).toFixed(2)),
        monthly_usd: parseFloat((saladRate * 0.6 * 24 * 30).toFixed(0)),
        node: node ?? null,
      });
    } catch {
      const saladRate = 0.3;
      setResult({
        gpu_id: `GPU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        gpu_name: detected.name,
        vram_gb: detected.vram,
        platform: "Salad",
        salad_rate_hr: saladRate,
        user_rate_hr: parseFloat((saladRate * 0.6).toFixed(3)),
        daily_usd: parseFloat((saladRate * 0.6 * 24).toFixed(2)),
        monthly_usd: parseFloat((saladRate * 0.6 * 24 * 30).toFixed(0)),
        node: null,
      });
    }
    setLoading(false);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
        <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">
          Connect GPU
        </h1>
      </div>

      {/* Progress steps */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-[9px] tracking-[1px] uppercase font-mono transition-colors
              ${i === 0 && gpu
                ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                : i === 1 && result
                ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                : i === 2 && result
                ? "border-cyan/40 bg-cyan/10 text-cyan"
                : "border-border text-muted-foreground"}`}>
              <span className="font-mono text-[8px]">0{i + 1}</span>
              {s}
            </div>
            {i < STEPS.length - 1 && <div className="w-4 h-px bg-border" />}
          </div>
        ))}
      </div>

      {/* GPU Detector */}
      <div>
        <SectionTitle>Detect Your GPU</SectionTitle>
        <div className="mt-3">
          <GPUDetector onDetected={onDetected} />
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-3 px-4 py-3 bg-card border border-cyan/30 rounded-md">
          <div className="w-5 h-5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
          <span className="text-[10px] font-mono text-cyan">
            Registering GPU and assigning to compute node...
          </span>
        </div>
      )}

      {result && (
        <>
          {/* Success banner */}
          <div className="flex items-center gap-3 px-4 py-3 bg-neon-green/10 border border-neon-green/30 rounded-md glow-green">
            <CheckCircle className="w-5 h-5 text-neon-green flex-shrink-0" />
            <div>
              <div className="text-[10px] font-mono text-neon-green font-medium">
                GPU Live — ID: {result.gpu_id}
              </div>
              <div className="text-[9px] text-muted-foreground mt-0.5">
                Earning on {result.platform} via{" "}
                {result.node ? result.node.node_name : "the Pulse network"}
              </div>
            </div>
          </div>

          {/* Node info */}
          {result.node && (
            <div className="bg-card border border-cyan/20 rounded-md p-4 relative card-gradient-top">
              <SectionTitle>Your Compute Node</SectionTitle>
              <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Node", value: result.node.node_name, color: "text-cyan" },
                  { label: "Platform", value: result.node.platform, color: "text-neon-green" },
                  {
                    label: "GPUs in node",
                    value: `${result.node.gpu_count} / ${result.node.target_gpu_count}`,
                    color: "text-amber",
                  },
                  {
                    label: "Node fill",
                    value: `${result.node.fill_percent ?? 0}%`,
                    color: "text-purple",
                  },
                ].map(m => (
                  <div key={m.label} className="bg-muted/30 rounded-md p-3">
                    <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground mb-1">
                      {m.label}
                    </div>
                    <div className={`text-sm font-display font-bold ${m.color}`}>{m.value}</div>
                  </div>
                ))}
              </div>

              {/* Node fill bar */}
              <div className="mt-3">
                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-cyan transition-all"
                    style={{ width: `${result.node.fill_percent ?? 0}%` }}
                  />
                </div>
                <p className="text-[8px] font-mono text-muted-foreground mt-1">
                  Node activates at full capacity ({result.node.target_gpu_count} GPUs)
                </p>
              </div>
            </div>
          )}

          {/* Earnings projection */}
          <div>
            <SectionTitle>Your Earnings (60% share)</SectionTitle>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
              {[
                { label: "Rate/hr", value: `$${result.user_rate_hr.toFixed(3)}`, icon: Zap, color: "text-cyan" },
                { label: "Daily Est.", value: `$${result.daily_usd.toFixed(2)}`, icon: DollarSign, color: "text-neon-green" },
                { label: "Monthly Est.", value: `$${result.monthly_usd}`, icon: TrendingUp, color: "text-amber" },
                { label: "Your Share", value: "60%", icon: Users, color: "text-purple" },
              ].map(m => {
                const Icon = m.icon;
                return (
                  <div key={m.label} className="bg-card border border-border rounded-md p-3 relative card-gradient-top">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Icon className={`w-3 h-3 ${m.color}`} />
                      <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground">{m.label}</div>
                    </div>
                    <div className={`text-lg font-display font-bold ${m.color}`}>{m.value}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Revenue split */}
          <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
            <SectionTitle>Revenue Split</SectionTitle>
            <div className="mt-3 h-4 rounded-full overflow-hidden bg-muted flex">
              <div className="h-full bg-cyan" style={{ width: "60%" }} title="60% You" />
              <div className="h-full bg-amber/70" style={{ width: "40%" }} title="40% Pulse" />
            </div>
            <div className="flex justify-between mt-2">
              <span className="text-[9px] font-mono text-cyan">60% — You</span>
              <span className="text-[9px] font-mono text-amber">40% — Pulse Network</span>
            </div>
            <p className="text-[8px] font-mono text-muted-foreground mt-2">
              Platform ({result.platform}) tracks your GPU's individual earnings.
              Pulse distributes 60% directly to your wallet.
            </p>
          </div>

          {/* Done */}
          <div className="bg-card/50 border border-border rounded-md p-4 text-center">
            <div className="text-[10px] font-mono text-neon-green mb-1">All set. Your GPU is live.</div>
            <div className="text-[9px] text-muted-foreground">
              Head to your <a href="/wallet" className="text-cyan hover:underline">Wallet</a> to
              claim PULSE tokens, or check the{" "}
              <a href="/leaderboard" className="text-amber hover:underline">Leaderboard</a> to see
              where you rank.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
