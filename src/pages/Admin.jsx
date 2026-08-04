import { useState, useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import StatCard from "../components/shared/StatCard";
import SectionTitle from "../components/shared/SectionTitle";
import { Users, Cpu, ShieldAlert, RefreshCw } from "lucide-react";
import { format } from "date-fns";

export default function Admin() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [gpus, setGpus] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const [u, g] = await Promise.all([
      base44.entities.User.list().catch(() => []),
      base44.entities.GPU.list().catch(() => []),
    ]);
    setUsers(u || []);
    setGpus(g || []);
    setLoading(false);
  };

  useEffect(() => { if (user?.role === "admin") load(); }, [user]);

  if (user?.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <ShieldAlert className="w-10 h-10 text-pulse-red mx-auto mb-3" />
          <div className="text-[11px] font-mono text-muted-foreground">Admin access required</div>
        </div>
      </div>
    );
  }

  const activeGPUs = gpus.filter(g => g.status === "active").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-pulse-red animate-pulse-glow" />
          <h1 className="font-display font-bold text-xl tracking-[3px] uppercase text-foreground">Admin Panel</h1>
          <span className="px-2 py-0.5 bg-pulse-red/10 border border-pulse-red/30 rounded text-[9px] tracking-[2px] uppercase font-mono text-pulse-red">restricted</span>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 border border-border text-muted-foreground text-[9px] tracking-[1.5px] uppercase font-mono rounded-md hover:text-cyan hover:border-cyan/50 transition-colors">
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Total Users" value={users.length.toString()} color="primary" icon={Users} />
        <StatCard label="Active GPUs" value={activeGPUs.toString()} color="accent" icon={Cpu} />
      </div>

      {/* Users */}
      <div className="bg-card border border-border rounded-md overflow-hidden relative card-gradient-top">
        <div className="px-4 py-3 border-b border-border"><SectionTitle>Users</SectionTitle></div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {["Email", "Name", "Role", "Joined"].map(h => (
                  <th key={h} className="px-4 py-2 text-[9px] tracking-[1.5px] uppercase text-muted-foreground text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-[10px] font-mono text-muted-foreground">No users found</td></tr>
              ) : users.map(u => (
                <tr key={u.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 text-[10px] font-mono text-foreground">{u.email}</td>
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">{u.full_name || "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[9px] tracking-[1.5px] uppercase font-mono ${u.role === "admin" ? "text-amber" : "text-cyan"}`}>{u.role || "user"}</span>
                  </td>
                  <td className="px-4 py-2.5 text-[10px] font-mono text-muted-foreground">
                    {u.created_date ? format(new Date(u.created_date), "MMM d, yyyy") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}