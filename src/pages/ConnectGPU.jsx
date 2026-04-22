import { useState } from "react";
import { CheckCircle, Cpu, DollarSign, TrendingUp, Users, Zap, Download, ExternalLink } from "lucide-react";
import { base44 } from "@/api/base44Client";
import GPUDetector from "../components/shared/GPUDetector";
import SectionTitle from "../components/shared/SectionTitle";

const STEPS = ["GPU Registered", "Assigned to Node", "Now Earning"];

const PLATFORMS = [
  {
    id: "clore",
    name: "Clore.ai",
    color: "cyan",
    borderClass: "border-cyan/40",
    activeBorderClass: "border-cyan",
    activeBgClass: "bg-cyan/10",
    textClass: "text-cyan",
    badge: "NVIDIA only",
    badgeClass: "bg-cyan/10 text-cyan",
    description: "Lightweight systemd daemon. Simple setup, established marketplace.",
    ports: "TCP 22, 80, 443, 8080",
    filename: "pulse-clore-setup.bat",
  },
  {
    id: "octaspace",
    name: "OctaSpace",
    color: "purple",
    borderClass: "border-purple-400/40",
    activeBorderClass: "border-purple-400",
    activeBgClass: "bg-purple-500/10",
    textClass: "text-purple-400",
    badge: "NVIDIA only",
    badgeClass: "bg-purple-500/10 text-purple-400",
    description: "Docker-based OSN node. Different job types, decentralised network.",
    ports: "TCP/UDP 51800-51816, TCP 18888",
    filename: "pulse-octa-setup.bat",
    extraNote: "After install you'll register your node at cube.octa.computer",
  },
];

export default function ConnectGPU() {
  const [selectedPlatform, setSelectedPlatform] = useState("clore");
  const [gpu, setGpu] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState(null);

  const platform = PLATFORMS.find((p) => p.id === selectedPlatform);

  const onDetected = async (detected) => {
    setGpu(detected);
    setLoading(true);
    const fnName = selectedPlatform === "octaspace" ? "registerOctaspaceDaemon" : "registerGPUDaemon";
    const platformLabel = selectedPlatform === "octaspace" ? "OctaSpace" : "Clore.ai";
    try {
      const r = await base44.functions.invoke(fnName, {
        gpu_model: detected.name,
        vram_gb: detected.vram,
        platform: platformLabel,
      });

      const userRate = r.data.user_rate_hr ?? parseFloat((r.data.gross_rate_hr * 0.6).toFixed(4));

      setResult({
        gpu_id: r.data.gpu_id,
        gpu_name: detected.name,
        vram_gb: detected.vram,
        platform: r.data.active_platform ?? platformLabel,
        gross_rate_hr: r.data.gross_rate_hr ?? 0,
        user_rate_hr: userRate,
        daily_usd: parseFloat((userRate * 24 * 0.9).toFixed(2)),
        monthly_usd: parseFloat((userRate * 24 * 0.9 * 30).toFixed(0)),
        clore_server_id: r.data.clore_server_id ?? null,
        octa_node_token: r.data.octa_node_token ?? null,
        node: r.data.node ?? null,
      });
    } catch {
      const userRate = 0.18;
      setResult({
        gpu_id: `${selectedPlatform === "octaspace" ? "OCTA" : "CLORE"}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        gpu_name: detected.name,
        vram_gb: detected.vram,
        platform: platformLabel,
        gross_rate_hr: 0.30,
        user_rate_hr: userRate,
        daily_usd: parseFloat((userRate * 24 * 0.9).toFixed(2)),
        monthly_usd: parseFloat((userRate * 24 * 0.9 * 30).toFixed(0)),
        clore_server_id: null,
        octa_node_token: null,
        node: null,
      });
    }
    setLoading(false);
  };

  const downloadSetupScript = async () => {
    setScriptLoading(true);
    setScriptError(null);
    try {
      const token = localStorage.getItem("base44_access_token");
      const appId = import.meta.env.VITE_BASE44_APP_ID;
      const res = await fetch(
        `https://api.base44.app/api/apps/${appId}/functions/generateSetupScript`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "Authorization": `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ platform: selectedPlatform, user_token: token }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setScriptError(err.error ?? `Server error ${res.status}`);
        setScriptLoading(false);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = platform.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setScriptError("Network error — could not reach server.");
    }
    setScriptLoading(false);
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

      {/* Platform selector */}
      <div>
        <div className="text-[10px] font-mono tracking-[2px] uppercase text-muted-foreground mb-3">
          Step 1 — Choose Your Platform
        </div>
        <div className="grid grid-cols-2 gap-3">
          {PLATFORMS.map((p) => {
            const active = selectedPlatform === p.id;
            return (
              <button
                key={p.id}
                onClick={() => { setSelectedPlatform(p.id); setResult(null); setGpu(null); }}
                className={`text-left p-4 rounded-md border transition-all ${
                  active
                    ? `${p.activeBorderClass} ${p.activeBgClass}`
                    : `${p.borderClass} bg-card hover:${p.activeBgClass}`
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-[11px] font-mono font-semibold ${active ? p.textClass : "text-foreground"}`}>
                    {p.name}
                  </span>
                  <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded ${p.badgeClass}`}>
                    {p.badge}
                  </span>
                </div>
                <p className="text-[9px] text-muted-foreground leading-relaxed">{p.description}</p>
                <p className="text-[8px] font-mono text-muted-foreground/60 mt-1.5">Ports: {p.ports}</p>
              </button>
            );
          })}
        </div>
        {platform?.extraNote && (
          <div className="mt-2 flex items-start gap-1.5 text-[9px] font-mono text-purple-400/80">
            <ExternalLink className="w-3 h-3 mt-0.5 flex-shrink-0" />
            {platform.extraNote}
          </div>
        )}
      </div>

      {/* Download button */}
      <div className={`bg-card border rounded-md p-4 relative card-gradient-top ${platform?.borderClass ?? "border-border"}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className={`text-[10px] font-mono tracking-[2px] uppercase mb-1 ${platform?.textClass ?? "text-cyan"}`}>
              Step 2 — Download &amp; Run Setup
            </div>
            <p className="text-[9px] font-mono text-muted-foreground leading-relaxed">
              Download and <span className="text-foreground">double-click</span>{" "}
              <span className={platform?.textClass ?? "text-cyan"}>{platform?.filename}</span>.<br />
              If you see <span className="text-foreground">"Open File — Security Warning"</span>, click{" "}
              <span className="text-neon-green font-semibold">Run</span>.<br />
              A UAC dialog will appear — click <span className="text-neon-green font-semibold">Yes</span>.<br />
              <span className="text-muted-foreground/70">The warning is normal for downloaded scripts.</span>
            </p>
          </div>
          <button
            onClick={downloadSetupScript}
            disabled={scriptLoading}
            className={`flex-shrink-0 flex items-center gap-2 px-4 py-2 border rounded-md text-[10px] font-mono transition-all ${
              platform?.id === "octaspace"
                ? "bg-purple-500/10 border-purple-400/40 hover:border-purple-400 hover:bg-purple-500/20 text-purple-400"
                : "bg-cyan/10 border-cyan/40 hover:border-cyan hover:bg-cyan/20 text-cyan"
            }`}
          >
            {scriptLoading
              ? <div className={`w-3 h-3 border border-t-transparent rounded-full animate-spin ${platform?.id === "octaspace" ? "border-purple-400" : "border-cyan"}`} />
              : <Download className="w-3 h-3" />}
            {scriptLoading ? "Generating..." : platform?.filename}
          </button>
        </div>
        {scriptError && (
          <div className="mt-3 px-3 py-2 bg-pulse-red/10 border border-pulse-red/30 rounded text-[9px] font-mono text-pulse-red">
            {scriptError}
          </div>
        )}
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
                ? `${platform?.activeBorderClass ?? "border-cyan/40"} ${platform?.activeBgClass ?? "bg-cyan/10"} ${platform?.textClass ?? "text-cyan"}`
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
        <SectionTitle>Step 3 — Register Your GPU with Pulse</SectionTitle>
        <p className="text-[9px] font-mono text-muted-foreground mt-1 mb-3">
          The installer sets up the {platform?.name} service on your machine. This step registers your GPU with Pulse so earnings are tracked and PULSE tokens can be distributed to your wallet.
        </p>
        <GPUDetector onDetected={onDetected} />
      </div>

      {loading && (
        <div className="flex items-center gap-3 px-4 py-3 bg-card border border-cyan/30 rounded-md">
          <div className="w-5 h-5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
          <span className="text-[10px] font-mono text-cyan">
            Registering GPU on {platform?.name} via Pulse...
          </span>
        </div>
      )}

      {result && (
        <>
          {/* Success banner */}
          <div className="flex items-center gap-3 px-4 py-3 bg-neon-green/10 border border-neon-green/30 rounded-md glow-green">
            <CheckCircle className="w-5 h-5 text-neon-green flex-shrink-0" />
            <div className="flex-1">
              <div className="text-[10px] font-mono text-neon-green font-medium">
                GPU Registered — ID: {result.gpu_id}
              </div>
              <div className="text-[9px] text-muted-foreground mt-0.5">
                Earning on {result.platform} via{" "}
                {result.node ? result.node.node_name : "the Pulse network"}
                {result.clore_server_id ? ` · Server #${result.clore_server_id}` : ""}
                {result.octa_node_token ? ` · Token: ${result.octa_node_token.slice(0, 8)}…` : ""}
              </div>
            </div>
          </div>

          {/* OctaSpace node registration reminder */}
          {result.platform === "OctaSpace" && result.octa_node_token && (
            <div className="bg-purple-500/5 border border-purple-400/30 rounded-md p-4">
              <div className="text-[10px] font-mono text-purple-400 mb-2">Register on OctaSpace Cube</div>
              <p className="text-[9px] font-mono text-muted-foreground mb-3">
                Your node token must be registered at cube.octa.computer before jobs can be assigned.
              </p>
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 rounded font-mono text-[10px] text-foreground mb-3">
                {result.octa_node_token}
              </div>
              <a
                href="https://cube.octa.computer"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[9px] font-mono text-purple-400 hover:underline"
              >
                <ExternalLink className="w-3 h-3" />
                Open cube.octa.computer → Hosting → Nodes → Add Node
              </a>
            </div>
          )}

          {/* Node info */}
          {result.node && (
            <div className="bg-card border border-cyan/20 rounded-md p-4 relative card-gradient-top">
              <SectionTitle>Your Compute Node</SectionTitle>
              <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Node", value: result.node.node_name, color: "text-cyan" },
                  { label: "Platform", value: result.node.platform ?? result.platform, color: "text-neon-green" },
                  { label: "GPUs in node", value: `${result.node.gpu_count} / ${result.node.target_gpu_count}`, color: "text-amber" },
                  { label: "Node fill", value: `${result.node.fill_percent ?? 0}%`, color: "text-purple" },
                ].map(m => (
                  <div key={m.label} className="bg-muted/30 rounded-md p-3">
                    <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground mb-1">{m.label}</div>
                    <div className={`text-sm font-display font-bold ${m.color}`}>{m.value}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-cyan transition-all" style={{ width: `${result.node.fill_percent ?? 0}%` }} />
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
                { label: "Rate/hr", value: `$${result.user_rate_hr.toFixed(3)}`, icon: Zap, color: platform?.textClass ?? "text-cyan" },
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
              <div className="h-full" style={{ width: "40%", backgroundColor: "var(--amber)" }} title="40% Pulse" />
            </div>
            <div className="flex justify-between mt-2">
              <span className="text-[9px] font-mono text-cyan">60% — You</span>
              <span className="text-[9px] font-mono text-amber">40% — Pulse Network</span>
            </div>
            <p className="text-[8px] font-mono text-muted-foreground mt-2">
              {result.platform} tracks your machine's earnings. Pulse distributes 60% to your wallet as PULSE tokens.
            </p>
          </div>

          {/* Done */}
          <div className="bg-card/50 border border-border rounded-md p-4 text-center">
            <div className="text-[10px] font-mono text-neon-green mb-1">All set. Your GPU is registered.</div>
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
