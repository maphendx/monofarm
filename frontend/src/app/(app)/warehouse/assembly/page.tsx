"use client";

/**
 * Assembly page — universal production session tracker.
 *
 * Worker view  : see assigned batches, start/stop sessions, report units.
 * Manager view : per-worker stats, date filter, session history.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { usePageTitle } from "@/lib/usePageTitle";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";

// ── types ─────────────────────────────────────────────────────────────────────

interface Batch {
  id: number;
  product_name: string;
  target_qty: number;
  good_qty: number;
  defect_qty: number;
  printed_qty: number;
  status: "draft" | "active" | "paused" | "done" | "cancelled";
  assigned_to_id: number | null;
  assigned_to_name: string | null;
  due_date: string | null;
  notes: string | null;
}

interface Session {
  id: number;
  batch_id: number;
  product_name: string;
  worker_id: number;
  worker_name: string;
  started_at: string;
  closed_at: string | null;
  units_good: number;
  units_defective: number;
  notes: string | null;
  duration_minutes: number | null;
}

interface WorkerStats {
  worker_id: number;
  worker_name: string;
  worker_email: string;
  total_sessions: number;
  total_minutes: number;
  total_good: number;
  total_defective: number;
  defect_rate_pct: number;
  products: { product_id: number; product_name: string; units_good: number }[];
}

interface OrgUser { id: number; name: string; email: string; role: string }

// ── helpers ───────────────────────────────────────────────────────────────────

const WORK_BATCH_STATUSES = new Set<Batch["status"]>(["draft", "active", "paused"]);

function fmtMin(m: number | null): string {
  if (!m) return "—";
  const h = Math.floor(m / 60), min = m % 60;
  return h > 0 ? `${h}г ${min}хв` : `${min}хв`;
}

function fmtDt(iso: string): string {
  return new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

// ── live timer ────────────────────────────────────────────────────────────────

function useTimer(startedAt: string | null): string {
  const [elapsed, setElapsed] = useState("0:00");
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const diff = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60;
      setElapsed(h > 0
        ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
        : `${m}:${String(s).padStart(2,"0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return elapsed;
}

// ── ActiveSessionCard ─────────────────────────────────────────────────────────

function ActiveSessionCard({ session, onClose }: { session: Session; onClose: (s: Session) => void }) {
  const elapsed = useTimer(session.started_at);
  const [good,  setGood]  = useState(String(session.units_good));
  const [bad,   setBad]   = useState(String(session.units_defective));
  const [notes, setNotes] = useState(session.notes ?? "");
  const [busy,  setBusy]  = useState(false);
  const saveRef = useRef(false);

  async function save() {
    if (saveRef.current) return; saveRef.current = true;
    try {
      await api(`/api/warehouse/batches/${session.batch_id}/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ units_good: parseInt(good)||0, units_defective: parseInt(bad)||0, notes: notes||null }),
      });
    } finally { saveRef.current = false; }
  }

  async function finish() {
    if (busy) return; setBusy(true);
    try {
      const closed = await api<Session>(`/api/warehouse/batches/${session.batch_id}/sessions/${session.id}/close`, {
        method: "POST",
        body: JSON.stringify({ units_good: parseInt(good)||0, units_defective: parseInt(bad)||0, notes: notes||null }),
      });
      onClose(closed);
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-2xl border-2 border-[var(--accent)] bg-[var(--bg-elevated)] p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10.5px] font-semibold text-[var(--accent)] uppercase tracking-wide">Активна сесія</p>
          <p className="text-base font-semibold text-[var(--text-hi)] mt-0.5">{session.product_name}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="font-mono text-2xl font-bold text-[var(--accent)]">{elapsed}</p>
          <p className="text-[10px] text-[var(--text-faint)]">час роботи</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-[var(--text-muted)] block mb-1">✓ Готових</span>
          <input type="number" min="0" value={good}
            onChange={e => setGood(e.target.value)} onBlur={save}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xl text-center outline-none focus:border-[var(--accent)]" />
        </label>
        <label className="block">
          <span className="text-xs text-[var(--text-muted)] block mb-1">✗ Брак</span>
          <input type="number" min="0" value={bad}
            onChange={e => setBad(e.target.value)} onBlur={save}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xl text-center outline-none focus:border-[var(--accent)]" />
        </label>
      </div>

      <input placeholder="Нотатка…" value={notes}
        onChange={e => setNotes(e.target.value)} onBlur={save}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]" />

      <button onClick={finish} disabled={busy}
        className="w-full rounded-xl bg-[var(--accent)] py-2.5 font-semibold text-[#06181c] hover:opacity-90 disabled:opacity-50">
        {busy ? "…" : "⏹ Завершити сесію"}
      </button>
    </div>
  );
}

// ── BatchCard (worker) ────────────────────────────────────────────────────────

function BatchCard({ batch, activeSession, onStart, onSessionClose }: {
  batch: Batch; activeSession: Session | null;
  onStart: (b: Batch) => void; onSessionClose: (s: Session) => void;
}) {
  const pct = batch.target_qty > 0 ? Math.min(100, Math.round((batch.good_qty / batch.target_qty) * 100)) : 0;
  const hasMySession = activeSession?.batch_id === batch.id;

  return (
    <div className={["rounded-xl border bg-[var(--bg-elevated)] p-4 space-y-3",
      hasMySession ? "border-[var(--accent)] shadow-[0_0_0_1px_var(--accent)]" : "border-[var(--border)]"
    ].join(" ")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold truncate">{batch.product_name}</p>
          <p className="text-xs text-[var(--text-faint)] mt-0.5">
            {batch.due_date ? `Дедлайн: ${batch.due_date}` : "Без дедлайну"}
            {batch.notes && <> · {batch.notes}</>}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
          batch.status === "done" ? "badge badge-ok" : batch.status === "active" ? "badge badge-print" : "badge badge-offline"
        }`}>{batch.status === "done" ? "Закрита" : batch.status === "active" ? "В роботі" : "Чернетка"}</span>
      </div>

      <div>
        <div className="flex justify-between text-xs text-[var(--text-faint)] mb-1">
          <span>Прогрес</span>
          <span className="font-mono"><b className="text-[var(--text-hi)]">{batch.good_qty}</b> / {batch.target_qty} · {pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-[var(--surface-hi)] overflow-hidden">
          <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
        </div>
        {batch.defect_qty > 0 && <p className="text-[10.5px] text-[var(--state-warn)] mt-1">Брак: {batch.defect_qty}</p>}
      </div>

      {hasMySession
        ? <ActiveSessionCard session={activeSession!} onClose={onSessionClose} />
        : batch.status !== "done" && (
          <button onClick={() => onStart(batch)}
            className="w-full rounded-lg border border-[var(--accent)] py-2 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[#06181c] transition-colors">
            ▶ Почати сесію
          </button>
        )
      }
    </div>
  );
}

// ── StatsTable ────────────────────────────────────────────────────────────────

function StatsTable({ stats }: { stats: WorkerStats[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!stats.length) return <p className="text-sm text-[var(--text-faint)] py-6 text-center">За цей період немає завершених сесій</p>;

  return (
    <div className="space-y-2">
      {stats.map(w => (
        <div key={w.worker_id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden">
          <button className="w-full flex items-center gap-4 px-5 py-3.5 text-left hover:bg-[var(--surface-hi)]"
            onClick={() => setExpanded(expanded === w.worker_id ? null : w.worker_id)}>
            <div className="size-9 rounded-full bg-[var(--accent-soft)] flex items-center justify-center text-sm font-bold text-[var(--accent)] shrink-0">
              {(w.worker_name || w.worker_email)[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold">{w.worker_name || w.worker_email}</p>
              <p className="text-xs text-[var(--text-faint)]">{w.total_sessions} сесій · {fmtMin(w.total_minutes)}</p>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <div className="text-right">
                <p className="font-mono text-lg font-bold text-[var(--state-ok)]">{w.total_good}</p>
                <p className="text-[10px] text-[var(--text-faint)]">готових</p>
              </div>
              {w.total_defective > 0 && (
                <div className="text-right">
                  <p className="font-mono font-semibold text-[var(--state-warn)]">{w.total_defective}</p>
                  <p className="text-[10px] text-[var(--text-faint)]">брак {w.defect_rate_pct}%</p>
                </div>
              )}
              <span className="text-[var(--text-faint)] text-xs">{expanded === w.worker_id ? "▲" : "▼"}</span>
            </div>
          </button>

          {expanded === w.worker_id && (
            <div className="border-t border-[var(--border)] px-5 py-3 bg-[var(--bg)] space-y-1.5">
              <p className="text-xs font-medium text-[var(--text-faint)] mb-2">По виробах</p>
              {w.products.map(p => (
                <div key={p.product_id} className="flex items-center gap-3">
                  <span className="flex-1 text-sm truncate">{p.product_name}</span>
                  <span className="font-mono text-sm font-semibold text-[var(--accent)]">{p.units_good} шт</span>
                  <div className="w-24 h-1.5 rounded-full bg-[var(--surface-hi)] overflow-hidden">
                    <div className="h-full rounded-full bg-[var(--accent)]"
                      style={{ width: `${Math.min(100, (p.units_good / Math.max(1, w.total_good)) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── AssignModal ───────────────────────────────────────────────────────────────

function AssignModal({ batch, users, onClose, onAssigned }: {
  batch: Batch; users: OrgUser[]; onClose: () => void; onAssigned: (b: Batch) => void;
}) {
  const [selected, setSelected] = useState<string>(batch.assigned_to_id ? String(batch.assigned_to_id) : "");
  const [busy, setBusy] = useState(false);
  const operators = users.filter(u => u.role !== "manager");

  async function save() {
    setBusy(true);
    try {
      const updated = await api<Batch>(`/api/warehouse/batches/${batch.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ assigned_to_id: selected ? parseInt(selected) : null }),
      });
      onAssigned(updated); onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-2xl space-y-4">
        <h2 className="font-semibold">Призначити робітника</h2>
        <p className="text-sm text-[var(--text-faint)]">{batch.product_name}</p>
        <select value={selected} onChange={e => setSelected(e.target.value)}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]">
          <option value="">— Не призначено —</option>
          {operators.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
        </select>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">Скасувати</button>
          <button onClick={save} disabled={busy} className="btn btn-primary">{busy ? "…" : "Зберегти"}</button>
        </div>
      </div>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function AssemblyPage() {
  usePageTitle("nav.warehouse");
  const me = useUser();
  const isManager = me.role === "admin" || me.role === "manager";

  const [tab, setTab] = useState<"work" | "stats" | "history">(isManager ? "stats" : "work");

  const [batches,       setBatches]       = useState<Batch[]>([]);
  const [mgrBatches,    setMgrBatches]    = useState<Batch[]>([]);
  const [allUsers,      setAllUsers]      = useState<OrgUser[]>([]);
  const [assignBatch,   setAssignBatch]   = useState<Batch | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [sessions,      setSessions]      = useState<Session[]>([]);
  const [stats,         setStats]         = useState<WorkerStats[]>([]);
  const [loading,       setLoading]       = useState(true);

  const [dateFrom, setDateFrom] = useState(() => isoDate(new Date(Date.now() - 6 * 86_400_000)));
  const [dateTo,   setDateTo]   = useState(() => isoDate(new Date()));

  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (isManager) {
      const [b, u] = await Promise.all([
        api<Batch[]>("/api/warehouse/batches"),
        api<OrgUser[]>("/api/users"),
      ]);
      setMgrBatches(b.filter((x) => WORK_BATCH_STATUSES.has(x.status))); setAllUsers(u);
    } else {
      const [b, s] = await Promise.all([
        api<Batch[]>("/api/warehouse/batches"),
        api<Session[]>("/api/warehouse/assembly/sessions?open_only=true"),
      ]);
      setBatches(b.filter(x => x.assigned_to_id === me.id && WORK_BATCH_STATUSES.has(x.status)));
      setActiveSession(s.find(x => x.worker_id === me.id) ?? null);
    }
    setLoading(false);
  }, [isManager, me.id]);

  const loadStats = useCallback(async () => {
    const [st, se] = await Promise.all([
      api<WorkerStats[]>(`/api/warehouse/assembly/stats?date_from=${dateFrom}&date_to=${dateTo}`),
      api<Session[]>(`/api/warehouse/assembly/sessions?date_from=${dateFrom}&date_to=${dateTo}`),
    ]);
    setStats(st); setSessions(se);
  }, [dateFrom, dateTo]);

  const { version } = useWarehouseStream();
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    if (isManager && (tab === "stats" || tab === "history")) loadStats();
  }, [isManager, tab, loadStats]);

  async function startSession(b: Batch) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const s = await api<Session>(`/api/warehouse/batches/${b.id}/sessions`, { method: "POST" });
      setActiveSession(s);
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Помилка"); }
    finally { inFlight.current = false; }
  }

  function onSessionClosed(s: Session) {
    setActiveSession(null);
    setBatches(prev => prev.map(b => b.id === s.batch_id
      ? { ...b, good_qty: b.good_qty + s.units_good, defect_qty: b.defect_qty + s.units_defective }
      : b));
  }

  if (loading) return <div className="text-sm text-[var(--text-muted)] p-4">Завантаження…</div>;

  // ── Worker ───────────────────────────────────────────────────────────────────
  if (!isManager) return (
    <div className="space-y-4 max-w-lg">
      <div>
        <h1 className="text-xl font-bold text-[var(--text-hi)]">Мої завдання</h1>
        <p className="text-sm text-[var(--text-faint)] mt-0.5">Відкривай сесію, вноси кількість і завершуй</p>
      </div>
      {batches.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-16 text-center">
          <p className="text-sm text-[var(--text-muted)]">Немає призначених партій</p>
          <p className="text-xs text-[var(--text-faint)] mt-1">Зверніться до керівника</p>
        </div>
      ) : (
        <div className="space-y-3">
          {batches.map(b => (
            <BatchCard key={b.id} batch={b}
              activeSession={activeSession?.batch_id === b.id ? activeSession : null}
              onStart={startSession} onSessionClose={onSessionClosed} />
          ))}
        </div>
      )}
    </div>
  );

  // ── Manager / Admin ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-hi)]">Збірка та виробництво</h1>
          <p className="text-sm text-[var(--text-faint)]">Статистика робітників, партії, сесії</p>
        </div>
        <a href="/warehouse/production" className="btn btn-ghost btn-sm text-xs">→ Всі партії</a>
      </div>

      {/* tabs */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        {([["stats","Статистика"],["work","Партії у роботі"],["history","Сесії"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}>{label}</button>
        ))}
      </div>

      {/* stats */}
      {tab === "stats" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-[var(--text-muted)]">Період:</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
            <span className="text-[var(--text-faint)]">—</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
          </div>
          <StatsTable stats={stats} />
        </div>
      )}

      {/* batches */}
      {tab === "work" && (
        mgrBatches.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-12 text-center text-sm text-[var(--text-muted)]">
            Немає відкритих партій
          </div>
        ) : (
          <div className="ds-table">
            <table>
              <thead><tr>
                <th>Виріб</th><th>Призначено</th><th className="text-right">Ціль</th>
                <th className="text-right">Готових</th><th className="text-right">Брак</th>
                <th>Дедлайн</th><th>Прогрес</th>
              </tr></thead>
              <tbody>
                {mgrBatches.map(b => {
                  const pct = b.target_qty > 0 ? Math.min(100, Math.round((b.good_qty / b.target_qty) * 100)) : 0;
                  return (
                    <tr key={b.id}>
                      <td className="font-medium">{b.product_name}</td>
                      <td>{b.assigned_to_name
                        ? <span className="badge badge-print">{b.assigned_to_name}</span>
                        : <span className="text-[var(--text-faint)] text-xs">не призначено</span>}</td>
                      <td className="text-right font-mono">{b.target_qty}</td>
                      <td className="text-right font-mono font-semibold text-[var(--state-ok)]">{b.good_qty}</td>
                      <td className="text-right font-mono">{b.defect_qty > 0
                        ? <span className="text-[var(--state-warn)]">{b.defect_qty}</span> : "—"}</td>
                      <td className="text-xs">{b.due_date ?? "—"}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 rounded-full bg-[var(--surface-hi)] overflow-hidden">
                            <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="font-mono text-xs text-[var(--text-faint)]">{pct}%</span>
                          <button onClick={() => setAssignBatch(b)}
                            className="text-xs text-[var(--accent)] hover:underline whitespace-nowrap">
                            {b.assigned_to_id ? "змінити" : "призначити"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* history */}
      {tab === "history" && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-[var(--text-muted)]">Період:</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
            <span className="text-[var(--text-faint)]">—</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
          </div>
          {sessions.filter(s => s.closed_at).length === 0 ? (
            <p className="text-sm text-[var(--text-faint)] py-4">Немає завершених сесій за цей період.</p>
          ) : (
            <div className="ds-table">
              <table>
                <thead><tr>
                  <th>Робітник</th><th>Виріб</th><th>Початок</th>
                  <th>Тривалість</th><th className="text-right">Готових</th>
                  <th className="text-right">Брак</th><th>Нотатка</th>
                </tr></thead>
                <tbody>
                  {sessions.filter(s => s.closed_at).map(s => (
                    <tr key={s.id}>
                      <td className="font-medium">{s.worker_name}</td>
                      <td className="text-[var(--text-muted)]">{s.product_name}</td>
                      <td className="font-mono text-xs">{fmtDt(s.started_at)}</td>
                      <td className="font-mono text-xs">{fmtMin(s.duration_minutes)}</td>
                      <td className="text-right font-mono font-semibold text-[var(--state-ok)]">{s.units_good}</td>
                      <td className="text-right font-mono">{s.units_defective > 0
                        ? <span className="text-[var(--state-warn)]">{s.units_defective}</span> : "—"}</td>
                      <td className="text-xs text-[var(--text-faint)]">{s.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {assignBatch && (
        <AssignModal batch={assignBatch} users={allUsers} onClose={() => setAssignBatch(null)}
          onAssigned={updated => setMgrBatches(prev => prev.map(b => b.id === updated.id ? updated : b))} />
      )}
    </div>
  );
}
