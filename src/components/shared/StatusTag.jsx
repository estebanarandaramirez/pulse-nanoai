export default function StatusTag({ status }) {
  const map = {
    active: { color: "text-neon-green border-neon-green/40 bg-neon-green/10", dot: "bg-neon-green" },
    confirmed: { color: "text-neon-green border-neon-green/40 bg-neon-green/10", dot: "bg-neon-green" },
    healthy: { color: "text-neon-green border-neon-green/40 bg-neon-green/10", dot: "bg-neon-green" },
    completed: { color: "text-neon-green border-neon-green/40 bg-neon-green/10", dot: "bg-neon-green" },
    rented: { color: "text-neon-green border-neon-green/40 bg-neon-green/10", dot: "bg-neon-green" },
    idle: { color: "text-amber border-amber/40 bg-amber/10", dot: "bg-amber" },
    pending: { color: "text-amber border-amber/40 bg-amber/10", dot: "bg-amber" },
    warning: { color: "text-amber border-amber/40 bg-amber/10", dot: "bg-amber" },
    watching: { color: "text-amber border-amber/40 bg-amber/10", dot: "bg-amber" },
    triggered: { color: "text-amber border-amber/40 bg-amber/10", dot: "bg-amber" },
    offline: { color: "text-pulse-red border-pulse-red/40 bg-pulse-red/10", dot: "bg-pulse-red" },
    failed: { color: "text-pulse-red border-pulse-red/40 bg-pulse-red/10", dot: "bg-pulse-red" },
    critical: { color: "text-pulse-red border-pulse-red/40 bg-pulse-red/10", dot: "bg-pulse-red" },
    cancelled: { color: "text-pulse-red border-pulse-red/40 bg-pulse-red/10", dot: "bg-pulse-red" },
    maintenance: { color: "text-purple border-purple/40 bg-purple/10", dot: "bg-purple" },
    paused: { color: "text-muted-foreground border-border bg-muted/30", dot: "bg-muted-foreground" },
  };
  const s = map[status?.toLowerCase()] || map.paused;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[9px] tracking-[1.5px] uppercase font-mono ${s.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {status}
    </span>
  );
}