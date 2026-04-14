export default function StatCard({ label, value, sub, color = "primary", icon: Icon }) {
  const colorMap = {
    primary: { text: "text-cyan", border: "border-cyan/30", bg: "bg-cyan/5" },
    accent: { text: "text-neon-green", border: "border-neon-green/30", bg: "bg-neon-green/5" },
    amber: { text: "text-amber", border: "border-amber/30", bg: "bg-amber/5" },
    purple: { text: "text-purple", border: "border-purple/30", bg: "bg-purple/5" },
  };
  const c = colorMap[color] || colorMap.primary;

  return (
    <div className={`bg-card border ${c.border} rounded-md p-4 relative card-gradient-top overflow-hidden`}>
      <div className={`absolute inset-0 ${c.bg} opacity-30`} />
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[9px] tracking-[2px] uppercase text-muted-foreground font-mono">{label}</span>
          {Icon && <Icon className={`w-4 h-4 ${c.text} opacity-70`} />}
        </div>
        <div className={`text-2xl font-display font-bold ${c.text} text-glow-cyan`}>{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground mt-1 font-mono">{sub}</div>}
      </div>
    </div>
  );
}