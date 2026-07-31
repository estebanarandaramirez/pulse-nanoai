import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { RefreshCw, ChevronDown, ChevronRight, CheckCircle, Clock, AlertCircle } from "lucide-react";

const STATUS_COLORS = {
  new:      "text-pulse-red border-pulse-red/40 bg-pulse-red/10",
  reviewed: "text-amber border-amber/40 bg-amber/10",
  resolved: "text-neon-green border-neon-green/40 bg-neon-green/10",
};

const STATUS_ICON = {
  new:      AlertCircle,
  reviewed: Clock,
  resolved: CheckCircle,
};

const PLATFORM_COLOR = {
  clore:      "text-cyan border-cyan/30 bg-cyan/10",
  octaspace:  "text-purple border-purple/30 bg-purple/10",
};

function StatusBadge({ status }) {
  const cls = STATUS_COLORS[status] ?? "text-muted-foreground border-border bg-muted/20";
  const Icon = STATUS_ICON[status] ?? AlertCircle;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[9px] font-mono uppercase tracking-[1px] ${cls}`}>
      <Icon className="w-2.5 h-2.5" />
      {status}
    </span>
  );
}

function ReportRow({ report, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(report.admin_notes ?? "");
  const [status, setStatus] = useState(report.status ?? "new");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await base44.entities.InstallReport.update(report.id, { status, admin_notes: notes });
    onUpdate();
    setEditing(false);
    setSaving(false);
  };

  const ts = report.created_date
    ? new Date(report.created_date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <div className={`border-b border-border/50 transition-colors ${expanded ? "bg-muted/10" : "hover:bg-muted/5"}`}>
      {/* Summary row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="text-muted-foreground flex-shrink-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>

        <div className="w-32 flex-shrink-0">
          <StatusBadge status={status} />
        </div>

        <div className="w-20 flex-shrink-0">
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-[1px] ${PLATFORM_COLOR[report.platform] ?? "text-muted-foreground border-border"}`}>
            {report.platform}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-mono text-foreground truncate">{report.error_step}</div>
          <div className="text-[9px] font-mono text-muted-foreground">{report.user_email ?? "unknown"}</div>
        </div>

        <div className="text-[9px] font-mono text-muted-foreground flex-shrink-0">{ts}</div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Admin controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={status}
              onChange={e => setStatus(e.target.value)}
              className="bg-background border border-border rounded px-2 py-1 text-[10px] font-mono text-foreground"
              onClick={e => e.stopPropagation()}
            >
              {["new", "reviewed", "resolved"].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Admin notes..."
              className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-[10px] font-mono text-foreground placeholder:text-muted-foreground"
              onClick={e => e.stopPropagation()}
            />
            <button
              onClick={e => { e.stopPropagation(); save(); }}
              disabled={saving}
              className="px-3 py-1 bg-cyan/10 border border-cyan/40 hover:border-cyan rounded text-[10px] font-mono text-cyan transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>

          {/* Log */}
          {report.log_content ? (
            <div className="relative">
              <div className="text-[9px] font-mono text-muted-foreground mb-1 uppercase tracking-[1.5px]">Install Log</div>
              <pre className="bg-background border border-border rounded p-3 text-[9px] font-mono text-muted-foreground overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">
                {report.log_content}
              </pre>
            </div>
          ) : (
            <div className="text-[10px] font-mono text-muted-foreground italic">No log content uploaded.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function InstallReports() {
  const { user } = useAuth();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");

  const load = async () => {
    setLoading(true);
    try {
      const data = await base44.entities.InstallReport.list("-created_date");
      setReports(data ?? []);
    } catch { /* stay with what we have */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  if (user?.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground font-mono text-sm">
        ⚠ Admin access required.
      </div>
    );
  }

  const filtered = filter === "all" ? reports : reports.filter(r => r.status === filter);
  const counts = { new: 0, reviewed: 0, resolved: 0 };
  for (const r of reports) { if (counts[r.status] !== undefined) counts[r.status]++; }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">
            Install Reports
          </h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
            Logs uploaded automatically when a user's installer fails
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-muted-foreground hover:text-cyan transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {[
          { key: "all", label: `All (${reports.length})` },
          { key: "new", label: `New (${counts.new})` },
          { key: "reviewed", label: `Reviewed (${counts.reviewed})` },
          { key: "resolved", label: `Resolved (${counts.resolved})` },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`px-3 py-1.5 rounded-md text-[9px] tracking-[1.5px] uppercase font-mono transition-colors border
              ${filter === t.key
                ? "bg-cyan/20 text-cyan border-cyan/40"
                : "bg-card text-muted-foreground border-border hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        {/* Column headers */}
        <div className="grid grid-cols-[16px_128px_80px_1fr_80px] gap-3 px-4 py-2 border-b border-border">
          <div />
          <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground font-mono">Status</div>
          <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground font-mono">Platform</div>
          <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground font-mono">Step / User</div>
          <div className="text-[9px] tracking-[1.5px] uppercase text-muted-foreground font-mono text-right">Time</div>
        </div>

        {loading && filtered.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-[11px] font-mono text-muted-foreground">
            No install reports yet.
          </div>
        ) : (
          filtered.map(r => (
            <ReportRow key={r.id} report={r} onUpdate={load} />
          ))
        )}
      </div>
    </div>
  );
}
