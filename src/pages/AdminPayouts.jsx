import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Plus, Play, Trash2, RefreshCw, Clock, CheckCircle, XCircle } from "lucide-react";
import { format } from "date-fns";
import StatusTag from "../components/shared/StatusTag";
import SectionTitle from "../components/shared/SectionTitle";

const FREQ_OPTIONS = ["daily", "weekly", "monthly"];
const TYPE_OPTIONS = ["sol", "token"];

const DEFAULT_FORM = {
  label: "",
  frequency: "daily",
  payout_type: "sol",
  pool_amount: "",
  min_holder_balance: 1000,
  is_active: true,
};

export default function AdminPayouts() {
  const { user } = useAuth();
  const [schedules, setSchedules] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState(null);
  const [runResult, setRunResult] = useState(null);

  const load = async () => {
    const data = await base44.entities.PayoutSchedule.list("-created_date");
    setSchedules(data);
  };

  useEffect(() => { load(); }, []);

  if (user?.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground font-mono text-sm">
        ⚠ Admin access required.
      </div>
    );
  }

  const save = async () => {
    if (!form.label || !form.pool_amount) return;
    setSaving(true);
    await base44.entities.PayoutSchedule.create({
      ...form,
      pool_amount: parseFloat(form.pool_amount),
      min_holder_balance: parseInt(form.min_holder_balance) || 1000,
    });
    setForm(DEFAULT_FORM);
    setShowForm(false);
    await load();
    setSaving(false);
  };

  const toggle = async (s) => {
    await base44.entities.PayoutSchedule.update(s.id, { is_active: !s.is_active });
    await load();
  };

  const remove = async (id) => {
    await base44.entities.PayoutSchedule.delete(id);
    await load();
  };

  const triggerNow = async (s) => {
    setTriggering(s.id);
    setRunResult(null);
    const r = await base44.functions.invoke("scheduledPayout", {});
    setRunResult(r.data);
    await load();
    setTriggering(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Token Payout Scheduler</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 border border-border rounded-md text-muted-foreground hover:text-cyan hover:border-cyan/50 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-4 py-2 bg-cyan text-background text-[10px] tracking-[2px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" /> New Schedule
          </button>
        </div>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 px-4 py-3 bg-cyan/5 border border-cyan/20 rounded-md text-[10px] font-mono text-muted-foreground">
        <Clock className="w-4 h-4 text-cyan flex-shrink-0 mt-0.5" />
        <span>
          Scheduled payouts run automatically via the <span className="text-cyan">scheduledPayout</span> backend function.
          The active schedule's config is picked up at each run. Only one active schedule is used at a time.
          Contract: <span className="text-neon-green">2ZkHDUequTHPWQtmJj2AjBAuE1TjuZoWKewnn2Hb6H9p</span>
        </span>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-card border border-cyan/30 rounded-md p-5 glow-cyan relative card-gradient-top space-y-4">
          <SectionTitle>New Payout Schedule</SectionTitle>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Label</label>
              <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Weekly SOL Payout"
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-cyan/50 outline-none" />
            </div>

            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Frequency</label>
              <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-cyan/50 outline-none">
                {FREQ_OPTIONS.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
              </select>
            </div>

            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Payout Type</label>
              <select value={form.payout_type} onChange={e => setForm(f => ({ ...f, payout_type: e.target.value }))}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-cyan/50 outline-none">
                {TYPE_OPTIONS.map(o => <option key={o} value={o}>{o.toUpperCase()}</option>)}
              </select>
            </div>

            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">
                Pool Amount {form.payout_type === "sol" ? "(lamports)" : "(token units)"}
              </label>
              <input type="number" value={form.pool_amount} onChange={e => setForm(f => ({ ...f, pool_amount: e.target.value }))}
                placeholder={form.payout_type === "sol" ? "e.g. 1000000000" : "e.g. 50000"}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-cyan/50 outline-none" />
            </div>

            <div>
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground block mb-1">Min Holder Balance (tokens)</label>
              <input type="number" value={form.min_holder_balance} onChange={e => setForm(f => ({ ...f, min_holder_balance: e.target.value }))}
                className="w-full bg-input border border-border rounded-md px-3 py-2 text-[11px] font-mono focus:border-cyan/50 outline-none" />
            </div>

            <div className="flex items-center gap-3 pt-5">
              <label className="text-[9px] tracking-[2px] uppercase text-muted-foreground">Active</label>
              <button onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
                className={`w-10 h-5 rounded-full transition-colors ${form.is_active ? "bg-neon-green" : "bg-muted"}`}>
                <div className={`w-4 h-4 rounded-full bg-white mx-0.5 transition-transform ${form.is_active ? "translate-x-5" : "translate-x-0"}`} />
              </button>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={save} disabled={saving || !form.label || !form.pool_amount}
              className="px-5 py-2 bg-cyan text-background text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:opacity-80 transition-opacity disabled:opacity-50">
              {saving ? "Saving..." : "Save Schedule"}
            </button>
            <button onClick={() => setShowForm(false)}
              className="px-5 py-2 border border-border text-muted-foreground text-[10px] tracking-[1px] uppercase font-mono rounded-md hover:border-cyan/50 hover:text-cyan transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Run result */}
      {runResult && (
        <div className={`px-4 py-3 rounded-md text-[10px] font-mono border ${runResult.error ? "bg-pulse-red/10 border-pulse-red/30 text-pulse-red" : "bg-neon-green/10 border-neon-green/30 text-neon-green"}`}>
          {runResult.error ? `✗ ${runResult.error}` : `✓ ${runResult.message} — ${runResult.success || 0} txns sent, ${runResult.total_holders || 0} holders scanned`}
        </div>
      )}

      {/* Schedules table */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <SectionTitle>Payout Schedules</SectionTitle>
          <span className="text-[9px] text-muted-foreground font-mono">{schedules.length} schedule{schedules.length !== 1 ? "s" : ""}</span>
        </div>

        {schedules.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted-foreground text-[11px] font-mono">
            No payout schedules yet. Create one above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {["Label", "Frequency", "Type", "Pool", "Min Balance", "Status", "Last Run", ""].map(h => (
                    <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 text-[11px] font-mono text-foreground">{s.label}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 bg-purple/10 border border-purple/30 rounded text-[9px] font-mono text-purple uppercase tracking-[1px]">
                        {s.frequency}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[10px] font-mono text-cyan uppercase">{s.payout_type}</td>
                    <td className="px-4 py-3 text-[11px] font-mono text-neon-green">
                      {Number(s.pool_amount).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-[10px] font-mono text-muted-foreground">
                      {Number(s.min_holder_balance).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => toggle(s)}>
                        <StatusTag status={s.is_active ? "active" : "paused"} />
                      </button>
                    </td>
                    <td className="px-4 py-3 text-[10px] font-mono text-muted-foreground">
                      {s.last_run_at ? (
                        <div className="flex items-center gap-1.5">
                          {s.last_run_status === "success"
                            ? <CheckCircle className="w-3 h-3 text-neon-green" />
                            : <XCircle className="w-3 h-3 text-pulse-red" />}
                          <span>{format(new Date(s.last_run_at), "MMM d HH:mm")}</span>
                          {s.last_run_tx_count != null && (
                            <span className="text-cyan">({s.last_run_tx_count} txns)</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/50">Never run</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => triggerNow(s)}
                          disabled={triggering === s.id}
                          title="Run Now"
                          className="p-1.5 border border-neon-green/30 rounded text-neon-green hover:bg-neon-green/10 transition-colors disabled:opacity-50"
                        >
                          {triggering === s.id
                            ? <div className="w-3.5 h-3.5 border-2 border-neon-green border-t-transparent rounded-full animate-spin" />
                            : <Play className="w-3.5 h-3.5" />}
                        </button>
                        <button onClick={() => remove(s.id)} title="Delete"
                          className="p-1.5 border border-pulse-red/30 rounded text-pulse-red hover:bg-pulse-red/10 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}