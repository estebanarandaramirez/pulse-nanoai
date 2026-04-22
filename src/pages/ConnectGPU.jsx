import { useState } from "react";
import { CheckCircle, Download, ExternalLink, LayoutGrid } from "lucide-react";
import SectionTitle from "../components/shared/SectionTitle";

const STEPS = ["Download Installer", "Run Installer", "Now Earning"];

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
    borderClass: "border-purple/40",
    activeBorderClass: "border-purple",
    activeBgClass: "bg-purple/10",
    textClass: "text-purple",
    badge: "NVIDIA only",
    badgeClass: "bg-purple/10 text-purple",
    description: "Docker-based OSN node. Different job types, decentralised network.",
    ports: "TCP/UDP 51800-51816, TCP 18888",
    filename: "pulse-octa-setup.bat",
    extraNote: "After install you'll register your node at cube.octa.computer",
  },
];

export default function ConnectGPU() {
  const [selectedPlatform, setSelectedPlatform] = useState("clore");
  const [downloaded, setDownloaded] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState(null);

  const platform = PLATFORMS.find((p) => p.id === selectedPlatform);

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
      setDownloaded(true);
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
          <div className="mt-2 flex items-start gap-1.5 text-[9px] font-mono text-purple/80">
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
                ? "bg-purple/10 border-purple/40 hover:border-purple hover:bg-purple/20 text-purple"
                : "bg-cyan/10 border-cyan/40 hover:border-cyan hover:bg-cyan/20 text-cyan"
            }`}
          >
            {scriptLoading
              ? <div className={`w-3 h-3 border border-t-transparent rounded-full animate-spin ${platform?.id === "octaspace" ? "border-purple" : "border-cyan"}`} />
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
              ${i === 0 && downloaded
                ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                : i === 1 && downloaded
                ? `${platform?.activeBorderClass ?? "border-cyan"} ${platform?.activeBgClass ?? "bg-cyan/10"} ${platform?.textClass ?? "text-cyan"}`
                : i === 2 && downloaded
                ? `${platform?.activeBorderClass ?? "border-cyan"} ${platform?.activeBgClass ?? "bg-cyan/10"} ${platform?.textClass ?? "text-cyan"}`
                : "border-border text-muted-foreground"}`}>
              <span className="font-mono text-[8px]">0{i + 1}</span>
              {s}
            </div>
            {i < STEPS.length - 1 && <div className="w-4 h-px bg-border" />}
          </div>
        ))}
      </div>

      {/* Step 3 — completion */}
      <div className={`bg-card border rounded-md p-5 relative card-gradient-top ${platform?.borderClass ?? "border-border"}`}>
        <SectionTitle>Step 3 — You're Done</SectionTitle>
        <p className="text-[9px] font-mono text-muted-foreground mt-2 leading-relaxed">
          The installer handles everything — GPU detection, service setup, and registration with the Pulse network.
          Once it completes, your GPU appears automatically in the fleet.
        </p>
        {selectedPlatform === "octaspace" && (
          <div className="mt-3 flex items-start gap-1.5 text-[9px] font-mono text-purple">
            <ExternalLink className="w-3 h-3 mt-0.5 flex-shrink-0" />
            One manual step: register your node token at cube.octa.computer → Hosting → Nodes → Add Node
          </div>
        )}
        <div className="mt-4 flex items-center gap-3">
          <a href="/gpu-fleet"
            className={`inline-flex items-center gap-2 px-4 py-2 border rounded-md text-[10px] font-mono transition-all
              ${platform?.id === "octaspace"
                ? "bg-purple/10 border-purple/40 hover:border-purple text-purple"
                : "bg-cyan/10 border-cyan/40 hover:border-cyan text-cyan"}`}>
            <LayoutGrid className="w-3 h-3" />
            View GPU Fleet
          </a>
          <span className="text-[9px] font-mono text-muted-foreground">
            Your GPU will appear here once the installer completes.
          </span>
        </div>
      </div>
    </div>
  );
}
