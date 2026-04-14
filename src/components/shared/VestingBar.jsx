import { format } from "date-fns";

export default function VestingBar({ stream }) {
  const pct = stream.total_pls > 0 ? Math.min(100, (stream.claimed_pls / stream.total_pls) * 100) : 0;
  const claimable = stream.total_pls - stream.claimed_pls;

  return (
    <div className="bg-card border border-border rounded-md p-4 relative card-gradient-top">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono text-foreground capitalize">{stream.source?.replace("_", " ") || "GPU Revenue"}</span>
        <span className="text-[9px] text-muted-foreground">
          {stream.end_date ? format(new Date(stream.end_date), "MMM d, yyyy") : "—"}
        </span>
      </div>
      <div className="flex items-end gap-2 mb-3">
        <span className="text-lg font-display font-bold text-cyan text-glow-cyan">
          {stream.total_pls?.toLocaleString()} PULSE
        </span>
        <span className="text-[10px] text-muted-foreground mb-0.5">total</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden mb-2">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, var(--cyan), var(--neon-green))"
          }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground">
        <span>{stream.claimed_pls?.toLocaleString()} claimed</span>
        <span className="text-neon-green">{claimable.toLocaleString()} claimable</span>
      </div>
    </div>
  );
}