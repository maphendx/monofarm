"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AmountStepper } from "@/components/queue/AmountStepper";
import { CreateTaskModal } from "@/components/plan/CreateTaskModal";
import { SendModal } from "@/components/files/SendModal";
import { Modal } from "@/components/ui/Modal";
import { ApiError, api } from "@/lib/api";
import { formatDuration, formatRelativeDate, sumArray } from "@/lib/format";
import { useUser } from "@/lib/auth-context";
import type { Filament, GcodeFile, PrintTask, PrintTaskStatus, Printer } from "@/lib/types";
import { usePageTitle } from "@/lib/usePageTitle";

// ── status tabs config ────────────────────────────────────────────────────────

type StatusTab = PrintTaskStatus;

const TABS: { id: StatusTab; labelUk: string; labelEn: string }[] = [
  { id: "queued",      labelUk: "В черзі",   labelEn: "Queued" },
  { id: "in_progress", labelUk: "В процесі", labelEn: "In Progress" },
  { id: "done",        labelUk: "Виконано",  labelEn: "Completed" },
  { id: "cancelled",   labelUk: "Скасовано", labelEn: "Cancelled" },
];

// ── helpers ───────────────────────────────────────────────────────────────────

function taskToGcodeFile(task: PrintTask): GcodeFile {
  return {
    id: task.gcode_file_id ?? 0,
    original_name: task.file_name ?? task.title,
    stored_name: "",
    size_bytes: task.file_size ?? 0,
    notes: null,
    filament_meta: task.filament_meta as GcodeFile["filament_meta"],
    has_thumbnail: task.has_thumbnail,
    uploaded_at: task.created_at,
    uploaded_by_name: task.created_by_name,
    folder_id: null,
  };
}

function FilamentChips({ meta }: { meta: PrintTask["filament_meta"] }) {
  if (!meta) return null;
  const types = meta.types ?? [];
  const colors = meta.colors ?? [];
  const count = Math.max(types.length, colors.length);
  if (count === 0) return null;
  const seen = new Set<string>();
  const chips: { type: string; color: string }[] = [];
  for (let i = 0; i < count; i++) {
    const t = types[i] ?? "";
    const c = colors[i] ?? "";
    const key = `${t}|${c}`;
    if (!seen.has(key)) { seen.add(key); chips.push({ type: t, color: c }); }
  }
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((ch, i) => (
        <span key={i} className="flex items-center gap-1 rounded-full border border-[var(--border-strong)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
          {ch.color && <span className="h-2 w-2 shrink-0 rounded-full border border-white/20" style={{ background: ch.color }} />}
          {ch.type || ch.color}
        </span>
      ))}
    </div>
  );
}

function MaterialCell({ meta }: { meta: PrintTask["filament_meta"] }) {
  if (!meta) return <span className="text-[var(--text-muted)]">—</span>;
  const colors = meta.colors ?? [];
  const usedG = meta.used_g ?? [];
  const total = sumArray(usedG);
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex">
        {colors.slice(0, 3).map((c, i) => (
          <span key={i} className="h-3 w-3 rounded-full border border-[var(--border)]" style={{ background: c, marginLeft: i > 0 ? -4 : 0 }} />
        ))}
      </div>
      <span className="text-[var(--text-muted)]">{total > 0 ? `${total.toFixed(1)} g` : "—"}</span>
    </div>
  );
}

function PrinterCell({ printerId, printerName }: { printerId: number | null; printerName: string | null }) {
  if (!printerId || !printerName) return <span className="text-[var(--text-muted)]">—</span>;
  return (
    <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
      <span className="text-base">🖨️</span>
      <span className="truncate max-w-[80px]">{printerName}</span>
    </span>
  );
}

// ── empty state ───────────────────────────────────────────────────────────────

function EmptyState({ status, onAdd }: { status: StatusTab; onAdd: () => void }) {
  const messages: Record<StatusTab, string> = {
    queued:      "В черзі немає завдань",
    in_progress: "Немає завдань у процесі",
    done:        "Виконаних завдань ще немає",
    cancelled:   "Скасованих завдань немає",
  };
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className="text-[var(--text-faint)]">
        <rect x="8" y="20" width="48" height="28" rx="4" stroke="currentColor" strokeWidth="2" />
        <rect x="18" y="28" width="28" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 30h48" stroke="currentColor" strokeWidth="1.5" />
        <rect x="22" y="48" width="20" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="26" y="54" width="12" height="4" rx="1" fill="currentColor" opacity="0.3" />
        <circle cx="20" cy="24" r="2" fill="currentColor" opacity="0.4" />
        <circle cx="28" cy="24" r="2" fill="currentColor" opacity="0.4" />
      </svg>
      <div>
        <p className="text-sm font-medium text-[var(--text-muted)]">{messages[status]}</p>
        {status === "queued" && (
          <p className="mt-1 text-xs text-[var(--text-faint)]">Натисніть + щоб додати нове завдання</p>
        )}
      </div>
      {status === "queued" && (
        <button
          onClick={onAdd}
          className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          + Нове завдання
        </button>
      )}
    </div>
  );
}

// ── complete modal ────────────────────────────────────────────────────────────

const DEFECT_PRESETS = ["Варпінг", "Відшарування шарів", "Забій сопла", "Збій живлення", "Помилка налаштувань", "Інше"];

function CompleteModal({ task, onClose, onDone }: { task: PrintTask | null; onClose: () => void; onDone: (updated: PrintTask) => void }) {
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [piecesOk, setPiecesOk] = useState(1);
  const [piecesDefective, setPiecesDefective] = useState(0);
  const [defectPreset, setDefectPreset] = useState("");
  const [defectOther, setDefectOther] = useState("");
  const [slotFilament, setSlotFilament] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!task) return;
    setPiecesOk(task.quantity);
    setPiecesDefective(0);
    setDefectPreset("");
    setDefectOther("");
    setSlotFilament({});
    setError(null);
    api<Filament[]>("/api/materials").then(setFilaments).catch(() => {});
  }, [task]);

  if (!task) return null;

  const meta = task.filament_meta;
  const usedG: number[] = meta?.used_g ?? [];
  const slotTypes: string[] = meta?.types ?? [];
  const slotColors: string[] = meta?.colors ?? [];
  const plannedQty = task.quantity || 1;
  const actualPrinted = piecesOk + piecesDefective;
  const scale = actualPrinted > 0 ? actualPrinted / plannedQty : 1;

  const consumptions = usedG.map((g, i) => {
    const filId = slotFilament[i] ?? null;
    const actualG = Math.round(g * scale);
    const fil = filId != null ? filaments.find(f => f.id === filId) : null;
    const cost = fil?.cost_per_kg != null ? (actualG * fil.cost_per_kg) / 1000 : null;
    return { slot: i, filament_id: filId, grams: actualG, cost };
  });

  const totalCost = consumptions.reduce((s, c) => s + (c.cost ?? 0), 0);
  const costPerOk = piecesOk > 0 && totalCost > 0 ? totalCost / piecesOk : null;
  const defectReason = defectPreset === "Інше" ? defectOther.trim() || "Інше" : defectPreset || null;

  async function submit() {
    if (!task) return;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { status: "done", pieces_ok: piecesOk, pieces_defective: piecesDefective };
      if (defectReason) body.defect_reason = defectReason;
      const valid = consumptions.filter(c => c.filament_id != null && c.grams > 0);
      if (valid.length > 0) body.filament_consumptions = valid.map(c => ({ filament_id: c.filament_id!, grams: c.grams }));
      const updated = await api<PrintTask>(`/api/queue/${task.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onDone(updated);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Помилка"); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={!!task} onClose={() => { if (!busy) onClose(); }} title={`Завершити: ${task.title}`}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost disabled:opacity-50">Скасувати</button>
        <button onClick={submit} disabled={busy || piecesOk < 0} className="btn btn-primary disabled:opacity-50">{busy ? "Зберігаю…" : "Виконано ✓"}</button>
      </>}>
      <div className="space-y-4 text-sm">
        <div>
          <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Результат (планувалось {plannedQty} шт.)</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="mb-1 block text-xs text-[var(--text-muted)]">Добрих ✓</span>
              <input type="number" min={0} value={piecesOk} onChange={e => setPiecesOk(Math.max(0, Number(e.target.value)))} className="input" /></label>
            <label className="block"><span className="mb-1 block text-xs text-[var(--text-muted)]">Брак ✕</span>
              <input type="number" min={0} value={piecesDefective} onChange={e => setPiecesDefective(Math.max(0, Number(e.target.value)))} className="input" /></label>
          </div>
        </div>
        {piecesDefective > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Причина браку</p>
            <div className="flex flex-wrap gap-1.5">
              {DEFECT_PRESETS.map(p => (
                <button key={p} type="button" onClick={() => setDefectPreset(p)}
                  className={["rounded-full border px-2.5 py-1 text-xs transition",
                    defectPreset === p ? "border-[rgba(239,68,68,.4)] bg-[rgba(239,68,68,.08)] text-[var(--state-error)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"].join(" ")}>
                  {p}
                </button>
              ))}
            </div>
            {defectPreset === "Інше" && (
              <input type="text" value={defectOther} onChange={e => setDefectOther(e.target.value)}
                placeholder="Опишіть причину…" className="input mt-2" autoFocus />
            )}
          </div>
        )}
        {usedG.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">
              Котушки (фактично ~{actualPrinted} шт. × {Math.round(usedG.reduce((s, g) => s + g, 0) / plannedQty)}г)
            </p>
            <div className="space-y-2">
              {usedG.map((g, i) => {
                const actualG = Math.round(g * scale);
                return (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      {slotColors[i] && <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: slotColors[i] }} />}
                      <span className="truncate text-xs text-[var(--text-muted)]">Слот {i + 1}{slotTypes[i] ? ` · ${slotTypes[i]}` : ""} · {actualG}г</span>
                    </div>
                    <select value={slotFilament[i] ?? ""} onChange={e => setSlotFilament(prev => ({ ...prev, [i]: Number(e.target.value) }))}
                      className="w-40 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 text-xs outline-none">
                      <option value="">— не вказано —</option>
                      {filaments.map(f => (
                        <option key={f.id} value={f.id}>{f.material} {f.color}{f.brand ? ` (${f.brand})` : ""}{f.sku ? ` [${f.sku}]` : ""}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {totalCost > 0 && (
          <div className="rounded-lg bg-[var(--bg)] px-4 py-3">
            <p className="text-xs text-[var(--text-muted)]">Собівартість матеріалів</p>
            <p className="mt-1 text-lg font-semibold">{totalCost.toFixed(2)} грн</p>
            {costPerOk != null && <p className="text-xs text-[var(--text-muted)]">{costPerOk.toFixed(2)} грн/шт. (для {piecesOk} добрих)</p>}
          </div>
        )}
        {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
      </div>
    </Modal>
  );
}

// ── queue row ─────────────────────────────────────────────────────────────────

function QueueRow({
  index, task, printers, status, selected, onToggle, onUpdated, onDelete, onSend, onComplete, onRestore, canEdit,
}: {
  index: number; task: PrintTask; printers: Printer[]; status: StatusTab;
  selected: boolean; onToggle: () => void;
  onUpdated: (t: PrintTask) => void; onDelete: () => void;
  onSend: () => void; onComplete: () => void; onRestore: () => void;
  canEdit: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const thumbSrc = task.has_thumbnail && task.gcode_file_id ? `${apiUrl}/api/files/${task.gcode_file_id}/thumbnail` : null;

  return (
    <tr className={["border-b border-[var(--border)]/60 transition-colors", selected ? "bg-[var(--accent)]/5" : "hover:bg-[var(--surface-hi)]/30"].join(" ")}>
      <td className="px-3 py-2">
        <input type="checkbox" checked={selected} onChange={onToggle} className="accent-[var(--accent)] cursor-pointer" />
      </td>
      <td className="px-2 py-2 text-[var(--text-muted)]">{index}.</td>

      {/* File */}
      <td className="max-w-[180px] px-3 py-2">
        <div className="flex items-center gap-2">
          {thumbSrc ? (
            <img src={thumbSrc} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--surface-hi)] text-[var(--text-muted)] text-xs">3mf</div>
          )}
          <span className="truncate text-[var(--accent)]">{task.file_name ?? task.title}</span>
        </div>
      </td>

      {/* Tags */}
      <td className="px-3 py-2">
        <FilamentChips meta={task.filament_meta} />
      </td>

      {/* Cost */}
      <td className="px-3 py-2 text-right text-[var(--text-muted)]">
        {task.material_cost_uah ? `${task.material_cost_uah.toFixed(2)} UAH` : "—"}
      </td>

      {/* Time */}
      <td className="px-3 py-2 text-right text-[var(--text-muted)]">
        {formatDuration(task.estimated_minutes)}
      </td>

      {/* Material */}
      <td className="px-3 py-2"><MaterialCell meta={task.filament_meta} /></td>

      {/* Amount or Result */}
      {status === "done" ? (
        <td className="px-3 py-2">
          {task.pieces_ok != null ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[var(--state-ok)]">✓ {task.pieces_ok}</span>
              {(task.pieces_defective ?? 0) > 0 && (
                <span className="text-[var(--state-error)]" title={task.defect_reason ?? ""}>✕ {task.pieces_defective}</span>
              )}
            </div>
          ) : <span className="text-[var(--text-muted)]">×{task.quantity}</span>}
        </td>
      ) : (
        <td className="px-3 py-2">
          {canEdit && status === "queued" ? (
            <AmountStepper taskId={task.id} value={task.quantity} onChange={(v) => onUpdated({ ...task, quantity: v })} />
          ) : (
            <span className="text-[var(--text-muted)]">×{task.quantity}</span>
          )}
        </td>
      )}

      {/* User */}
      <td className="max-w-[100px] truncate px-3 py-2 text-[var(--text-faint)]">{task.created_by_name ?? "—"}</td>

      {/* Added */}
      <td className="whitespace-nowrap px-3 py-2 text-[var(--text-faint)]">{formatRelativeDate(task.created_at)}</td>

      {/* Printer */}
      <td className="px-3 py-2"><PrinterCell printerId={task.assigned_printer_id} printerName={task.assigned_printer_name} /></td>

      {/* Actions */}
      <td className="relative px-2 py-2">
        <button onClick={() => setMenuOpen(v => !v)}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
          ···
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-lg"
            onMouseLeave={() => setMenuOpen(false)}>
            {status === "queued" && task.gcode_file_id && canEdit && (
              <button onClick={() => { setMenuOpen(false); onSend(); }}
                className="w-full px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hi)]">
                Надіслати на принтер
              </button>
            )}
            {status === "in_progress" && canEdit && (
              <button onClick={() => { setMenuOpen(false); onComplete(); }}
                className="w-full px-3 py-1.5 text-left text-sm text-[var(--state-ok)] hover:bg-[var(--surface-hi)]">
                Завершити ✓
              </button>
            )}
            {status === "cancelled" && canEdit && (
              <button onClick={() => { setMenuOpen(false); onRestore(); }}
                className="w-full px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hi)]">
                Відновити в чергу
              </button>
            )}
            {canEdit && (
              <button onClick={() => { setMenuOpen(false); onDelete(); }}
                className="w-full px-3 py-1.5 text-left text-sm text-[var(--state-error)] hover:bg-[var(--surface-hi)]">
                Видалити
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function QueuePage() {
  usePageTitle("nav.plan");
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";

  const [tasks, setTasks] = useState<PrintTask[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<StatusTab>("queued");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [sendTask, setSendTask] = useState<PrintTask | null>(null);
  const [completeTask, setCompleteTask] = useState<PrintTask | null>(null);

  const distributeRef = useRef(false);
  const [distributeResult, setDistributeResult] = useState<{
    sent: { task_id: number; printer_name: string }[];
    skipped: { task_id: number; reason: string }[];
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, p] = await Promise.all([
        api<PrintTask[]>("/api/queue"),
        api<Printer[]>("/api/printers"),
      ]);
      setTasks(t); setPrinters(p);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // counts per status
  const counts = useMemo(
    () => tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    [tasks],
  );

  // tasks for current tab, filtered by search
  const visible = useMemo(() => {
    let list = tasks.filter(t => t.status === activeTab);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t => t.title.toLowerCase().includes(q) || (t.file_name ?? "").toLowerCase().includes(q));
    }
    return list;
  }, [tasks, activeTab, search]);

  // stats (queued / in_progress tabs)
  const stats = useMemo(() => ({
    jobs: visible.length,
    totalMin: visible.reduce((s, t) => s + (t.estimated_minutes ?? 0), 0),
    totalG: visible.reduce((s, t) => s + sumArray(t.filament_meta?.used_g), 0),
    totalCost: visible.reduce((s, t) => s + (t.material_cost_uah ?? 0), 0),
  }), [visible]);

  const allChecked = visible.length > 0 && visible.every(t => selected.has(t.id));
  const someChecked = !allChecked && visible.some(t => selected.has(t.id));

  function toggleAll() {
    allChecked ? setSelected(new Set()) : setSelected(new Set(visible.map(t => t.id)));
  }
  function toggleOne(id: number) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function handleTaskUpdated(updated: PrintTask) {
    setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
  }

  async function handleDelete(taskId: number) {
    try {
      await api(`/api/queue/${taskId}`, { method: "DELETE" });
      setTasks(prev => prev.filter(t => t.id !== taskId));
      setSelected(prev => { const n = new Set(prev); n.delete(taskId); return n; });
    } catch (err) { if (err instanceof ApiError) setError(err.message); }
  }

  async function handleRestore(taskId: number) {
    try {
      const updated = await api<PrintTask>(`/api/queue/${taskId}`, { method: "PATCH", body: JSON.stringify({ status: "queued" }) });
      handleTaskUpdated(updated);
    } catch (err) { if (err instanceof ApiError) setError(err.message); }
  }

  async function handle1Click() {
    if (distributeRef.current) return;
    distributeRef.current = true;
    setDistributeResult(null);
    try {
      const taskIds = selected.size > 0 ? Array.from(selected) : undefined;
      const res = await api<{
        sent: { task_id: number; printer_id: number; printer_name: string }[];
        skipped: { task_id: number; reason: string }[];
      }>("/api/queue/bulk-distribute", { method: "POST", body: JSON.stringify({ task_ids: taskIds ?? null }) });
      setDistributeResult(res);
      await load();
    } catch (err) { if (err instanceof ApiError) setError(err.message); }
    finally { distributeRef.current = false; }
  }

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="flex flex-col gap-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Черга друку</h1>
        <div className="flex items-center gap-2">
          {canEdit && activeTab === "queued" && (
            <button onClick={handle1Click}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--surface-hi)]">
              <span>≡</span> 1-CLICK PRINT
            </button>
          )}
          {canEdit && (
            <button onClick={() => setCreateOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent)] text-lg font-bold text-white hover:opacity-90">
              +
            </button>
          )}
        </div>
      </div>

      {/* ── Status tabs ── */}
      <div className="flex items-center overflow-x-auto border-b border-[var(--border)]">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setSelected(new Set()); setSearch(""); }}
            className={[
              "flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm transition-colors",
              activeTab === tab.id
                ? "border-[var(--accent)] font-medium text-[var(--accent)]"
                : "border-transparent text-[var(--text-faint)] hover:text-[var(--text)]",
            ].join(" ")}>
            {tab.labelUk}
            <span className={[
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              activeTab === tab.id ? "bg-[var(--accent)]/20 text-[var(--accent)]" : "bg-[var(--surface-hi)] text-[var(--text-muted)]",
            ].join(" ")}>
              {counts[tab.id] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {/* ── Alerts ── */}
      {error && (
        <div className="rounded-md border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] px-3 py-2 text-sm text-[var(--state-error)]">{error}</div>
      )}
      {distributeResult && (
        <div className="rounded-md border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] px-3 py-2 text-sm text-[var(--state-ok)]">
          Розподілено: {distributeResult.sent.length} завдань
          {distributeResult.skipped.length > 0 && ` · Пропущено: ${distributeResult.skipped.length} (${distributeResult.skipped.map(s => s.reason).join(", ")})`}
        </div>
      )}

      {/* ── Stats bar (queued / in_progress) ── */}
      {(activeTab === "queued" || activeTab === "in_progress") && (
        <div className="flex flex-wrap gap-6 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/60 px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-muted)]">Завдань:</span>
            <span className="font-medium text-[var(--text)]">{stats.jobs}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-muted)]">Час друку:</span>
            <span className="font-medium text-[var(--text)]">
              {stats.totalMin >= 60 ? `${Math.floor(stats.totalMin / 60)}г ${stats.totalMin % 60}хв` : `${stats.totalMin}хв`}
            </span>
          </div>
          {stats.totalG > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)]">Матеріал:</span>
              <span className="font-medium text-[var(--text)]">
                {stats.totalG >= 1000 ? `${(stats.totalG / 1000).toFixed(2)} кг` : `${stats.totalG.toFixed(1)} г`}
              </span>
            </div>
          )}
          {stats.totalCost > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)]">Вартість:</span>
              <span className="font-medium text-[var(--text)]">{stats.totalCost.toFixed(2)} UAH</span>
            </div>
          )}
        </div>
      )}

      {/* ── Search ── */}
      <div className="flex items-center gap-2">
        <input type="text" placeholder="Пошук…" value={search} onChange={e => setSearch(e.target.value)}
          className="h-8 w-48 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 text-sm text-[var(--text)] placeholder-[var(--text-faint)] outline-none focus:border-[var(--accent)]" />
      </div>

      {/* ── Content ── */}
      {visible.length === 0 ? (
        <EmptyState status={activeTab} onAdd={() => setCreateOpen(true)} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full min-w-[1000px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg-elevated)]/80 text-xs text-[var(--text-muted)]">
                <th className="w-8 px-3 py-2.5">
                  <input type="checkbox" checked={allChecked} ref={el => { if (el) el.indeterminate = someChecked; }}
                    onChange={toggleAll} className="accent-[var(--accent)] cursor-pointer" />
                </th>
                <th className="w-8 px-2 py-2.5 text-left">#</th>
                <th className="px-3 py-2.5 text-left">Файл</th>
                <th className="px-3 py-2.5 text-left">Теги</th>
                <th className="px-3 py-2.5 text-right">Вартість</th>
                <th className="px-3 py-2.5 text-right">Час</th>
                <th className="px-3 py-2.5 text-left">Матеріал</th>
                <th className="px-3 py-2.5 text-center">{activeTab === "done" ? "Результат" : "К-сть"}</th>
                <th className="px-3 py-2.5 text-left">Користувач</th>
                <th className="px-3 py-2.5 text-left">Додано</th>
                <th className="px-3 py-2.5 text-left">Принтер</th>
                <th className="w-8 px-2 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {visible.map((task, idx) => (
                <QueueRow
                  key={task.id} index={idx + 1} task={task} printers={printers} status={activeTab}
                  selected={selected.has(task.id)} onToggle={() => toggleOne(task.id)}
                  onUpdated={handleTaskUpdated} onDelete={() => handleDelete(task.id)}
                  onSend={() => setSendTask(task)} onComplete={() => setCompleteTask(task)}
                  onRestore={() => handleRestore(task.id)} canEdit={canEdit}
                />
              ))}
            </tbody>
          </table>
          <div className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
            {selected.size > 0 ? `${selected.size} з ${visible.length} вибрано` : `${visible.length} завдань`}
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      <CreateTaskModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={t => setTasks(prev => [t, ...prev])} />

      {sendTask && sendTask.gcode_file_id && (
        <SendModal file={taskToGcodeFile(sendTask)} printers={printers} defaultPrinterId={sendTask.assigned_printer_id ?? undefined}
          onClose={() => { setSendTask(null); load(); }} />
      )}

      <CompleteModal task={completeTask} onClose={() => setCompleteTask(null)}
        onDone={t => { handleTaskUpdated(t); setCompleteTask(null); }} />
    </div>
  );
}
