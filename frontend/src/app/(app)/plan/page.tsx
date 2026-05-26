"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AmountStepper } from "@/components/queue/AmountStepper";
import { CreateTaskModal } from "@/components/plan/CreateTaskModal";
import { SendModal } from "@/components/SendModal";
import { ApiError, api } from "@/lib/api";
import { formatDuration, formatRelativeDate, sumArray } from "@/lib/format";
import { useUser } from "@/lib/auth-context";
import type { GcodeFile, PrintTask, Printer } from "@/lib/types";

// ── helpers ────────────────────────────────────────────────────────────────

function printerModelLabel(p: Printer): string {
  if (p.kind === "bambu" && p.bambu_model) return `Bambu ${p.bambu_model}`;
  if (p.kind === "snapmaker_u1") return "Snapmaker U1";
  return "Other";
}

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

  // deduplicate by type+color pair
  const seen = new Set<string>();
  const chips: { type: string; color: string }[] = [];
  for (let i = 0; i < count; i++) {
    const t = types[i] ?? "";
    const c = colors[i] ?? "";
    const key = `${t}|${c}`;
    if (!seen.has(key)) {
      seen.add(key);
      chips.push({ type: t, color: c });
    }
  }

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((ch, i) => (
        <span
          key={i}
          className="flex items-center gap-1 rounded-full border border-[var(--border-strong)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
        >
          {ch.color && (
            <span
              className="h-2 w-2 shrink-0 rounded-full border border-white/20"
              style={{ background: ch.color }}
            />
          )}
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
          <span
            key={i}
            className="h-3 w-3 rounded-full border border-[var(--border)]"
            style={{ background: c, marginLeft: i > 0 ? -4 : 0 }}
          />
        ))}
      </div>
      <span className="text-[var(--text-muted)]">{total > 0 ? `${total.toFixed(1)} g` : "—"}</span>
    </div>
  );
}

function PrinterCell({
  printerId,
  printerName,
}: {
  printerId: number | null;
  printerName: string | null;
}) {
  if (!printerId || !printerName) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }
  return (
    <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
      <span className="text-base">🖨️</span>
      <span className="truncate max-w-[80px]">{printerName}</span>
    </span>
  );
}

// ── main page ─────────────────────────────────────────────────────────────

export default function PlanPage() {
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";

  const [tasks, setTasks] = useState<PrintTask[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // filter / search
  const [activeTab, setActiveTab] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);

  // selection
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // modals
  const [createOpen, setCreateOpen] = useState(false);
  const [sendTask, setSendTask] = useState<PrintTask | null>(null);

  // 1-click busy guard
  const distributeRef = useRef(false);
  const [distributeResult, setDistributeResult] = useState<{
    sent: { task_id: number; printer_name: string }[];
    skipped: { task_id: number; reason: string }[];
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, p] = await Promise.all([
        api<PrintTask[]>("/api/tasks/print?status=queued"),
        api<Printer[]>("/api/printers"),
      ]);
      setTasks(t);
      setPrinters(p);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // derive model tabs from printer list
  const modelTabs = useMemo(() => {
    const labels = new Map<string, number>();
    for (const p of printers) {
      const label = printerModelLabel(p);
      labels.set(label, (labels.get(label) ?? 0) + 1);
    }
    return Array.from(labels.entries());
  }, [printers]);

  // collect unique filament types for the Type filter
  const allTypes = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) {
      for (const ty of t.filament_meta?.types ?? []) {
        if (ty) s.add(ty);
      }
    }
    return Array.from(s).sort();
  }, [tasks]);

  // filtered tasks
  const visible = useMemo(() => {
    let list = tasks;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.file_name ?? "").toLowerCase().includes(q),
      );
    }
    if (typeFilter) {
      list = list.filter((t) =>
        t.filament_meta?.types?.some((ty) => ty === typeFilter),
      );
    }
    return list;
  }, [tasks, search, typeFilter]);

  // stats over visible tasks
  const stats = useMemo(() => {
    const jobs = visible.length;
    const totalMin = visible.reduce((s, t) => s + (t.estimated_minutes ?? 0), 0);
    const totalCost = visible.reduce((s, t) => s + (t.material_cost_uah ?? 0), 0);
    const totalG = visible.reduce((s, t) => s + sumArray(t.filament_meta?.used_g), 0);
    return { jobs, totalMin, totalCost, totalG };
  }, [visible]);

  // select-all checkbox state
  const allChecked =
    visible.length > 0 && visible.every((t) => selected.has(t.id));
  const someChecked = !allChecked && visible.some((t) => selected.has(t.id));

  function toggleAll() {
    if (allChecked) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visible.map((t) => t.id)));
    }
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleTaskUpdated(updated: PrintTask) {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function handleDelete(taskId: number) {
    try {
      await api(`/api/tasks/print/${taskId}`, { method: "DELETE" });
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
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
      }>("/api/tasks/print/bulk-distribute", {
        method: "POST",
        body: JSON.stringify({ task_ids: taskIds ?? null }),
      });
      setDistributeResult(res);
      // refresh tasks to pick up new assigned_printer fields
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      distributeRef.current = false;
    }
  }

  if (loading) {
    return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">Print queue</h1>
          <span
            className="flex h-5 w-5 cursor-default items-center justify-center rounded-full border border-[var(--border-strong)] text-[11px] text-[var(--text-faint)]"
            title="Черга друку: всі завдання зі статусом 'queued'. 1-CLICK PRINT розподіляє їх по вільних принтерах."
          >
            ?
          </span>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <button
              onClick={handle1Click}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--surface-2)]"
            >
              <span>≡</span> 1-CLICK PRINT
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setCreateOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-lg font-bold text-white hover:bg-accent/90"
            >
              +
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {distributeResult && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
          Розподілено: {distributeResult.sent.length} завдань
          {distributeResult.skipped.length > 0 &&
            ` · Пропущено: ${distributeResult.skipped.length} (${distributeResult.skipped.map((s) => s.reason).join(", ")})`}
        </div>
      )}

      {/* ── Model tabs ── */}
      <div className="flex items-center gap-0 overflow-x-auto border-b border-[var(--border)] pb-0">
        {[{ key: "all", label: "All", count: tasks.length }, ...modelTabs.map(([label, count]) => ({ key: label, label, count }))].map(
          (tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={[
                "flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-2 text-sm transition-colors",
                activeTab === tab.key
                  ? "border-accent text-accent"
                  : "border-transparent text-[var(--text-faint)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {tab.label}
              <span
                className={[
                  "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  activeTab === tab.key
                    ? "bg-accent/20 text-accent"
                    : "bg-[var(--surface-2)] text-[var(--text-muted)]",
                ].join(" ")}
              >
                {tab.count}
              </span>
            </button>
          ),
        )}
      </div>

      {/* ── Stats bar ── */}
      <div className="flex flex-wrap gap-6 rounded-lg border border-[var(--border)] bg-[var(--surface)]/60 px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">≡ Jobs:</span>
          <span className="font-medium text-[var(--text-hi)]">{stats.jobs}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">⏱ Print time:</span>
          <span className="font-medium text-[var(--text-hi)]">
            {stats.totalMin >= 60
              ? `${Math.floor(stats.totalMin / 60 / 24)}d ${Math.floor((stats.totalMin / 60) % 24)}h ${stats.totalMin % 60}m`
              : formatDuration(stats.totalMin)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">$ Cost:</span>
          <span className="font-medium text-[var(--text-hi)]">
            {stats.totalCost > 0 ? `${stats.totalCost.toFixed(2)} UAH` : "—"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">▲ Material:</span>
          <span className="font-medium text-[var(--text-hi)]">
            {stats.totalG > 0
              ? stats.totalG >= 1000
                ? `${(stats.totalG / 1000).toFixed(2)} kg`
                : `${stats.totalG.toFixed(1)} g`
              : "—"}
          </span>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Search all data…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-48 rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] placeholder-[var(--text-dim)] outline-none focus:border-accent"
        />

        {/* Type filter */}
        <div className="relative">
          <button
            onClick={() => setTypeMenuOpen((v) => !v)}
            className={[
              "flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm",
              typeFilter
                ? "border-accent bg-accent/10 text-accent"
                : "border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-faint)] hover:text-[var(--text)]",
            ].join(" ")}
          >
            ● TYPE{typeFilter ? `: ${typeFilter}` : ""}
            <span className="text-[10px]">▾</span>
          </button>
          {typeMenuOpen && (
            <div className="absolute left-0 top-full z-20 mt-1 w-36 rounded-md border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-lg">
              <button
                onClick={() => { setTypeFilter(""); setTypeMenuOpen(false); }}
                className="w-full px-3 py-1.5 text-left text-sm text-[var(--text-faint)] hover:bg-[var(--surface-hi)]"
              >
                Всі типи
              </button>
              {allTypes.map((ty) => (
                <button
                  key={ty}
                  onClick={() => { setTypeFilter(ty); setTypeMenuOpen(false); }}
                  className="w-full px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hi)]"
                >
                  {ty}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--surface)]/80 text-xs text-[var(--text-muted)]">
              <th className="w-8 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked;
                  }}
                  onChange={toggleAll}
                  className="accent-[var(--accent)] cursor-pointer"
                />
              </th>
              <th className="w-8 px-2 py-2.5 text-left">#</th>
              <th className="px-3 py-2.5 text-left">File</th>
              <th className="px-3 py-2.5 text-left">Tags: printer-matching</th>
              <th className="px-3 py-2.5 text-right">Print cost</th>
              <th className="px-3 py-2.5 text-right">Print time</th>
              <th className="px-3 py-2.5 text-left">Material</th>
              <th className="px-3 py-2.5 text-right">Printed</th>
              <th className="px-3 py-2.5 text-center">Amount</th>
              <th className="px-3 py-2.5 text-left">User</th>
              <th className="px-3 py-2.5 text-left">Added</th>
              <th className="px-3 py-2.5 text-left">Printer</th>
              <th className="w-8 px-2 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={13}
                  className="px-3 py-12 text-center text-[var(--text-muted)]"
                >
                  {tasks.length === 0
                    ? "Черга порожня — натисніть + щоб додати завдання"
                    : "Нічого не знайдено"}
                </td>
              </tr>
            ) : (
              visible.map((task, idx) => (
                <QueueRow
                  key={task.id}
                  index={idx + 1}
                  task={task}
                  printers={printers}
                  selected={selected.has(task.id)}
                  onToggle={() => toggleOne(task.id)}
                  onUpdated={handleTaskUpdated}
                  onDelete={() => handleDelete(task.id)}
                  onSend={() => setSendTask(task)}
                  canEdit={canEdit}
                />
              ))
            )}
          </tbody>
        </table>
        <div className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
          {selected.size} of {visible.length} row(s) selected.
        </div>
      </div>

      {/* ── Modals ── */}
      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(t) => setTasks((prev) => [t, ...prev])}
      />

      {sendTask && sendTask.gcode_file_id && (
        <SendModal
          file={taskToGcodeFile(sendTask)}
          printers={printers}
          defaultPrinterId={sendTask.assigned_printer_id ?? undefined}
          onClose={() => {
            setSendTask(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ── QueueRow ──────────────────────────────────────────────────────────────

function QueueRow({
  index,
  task,
  printers,
  selected,
  onToggle,
  onUpdated,
  onDelete,
  onSend,
  canEdit,
}: {
  index: number;
  task: PrintTask;
  printers: Printer[];
  selected: boolean;
  onToggle: () => void;
  onUpdated: (t: PrintTask) => void;
  onDelete: () => void;
  onSend: () => void;
  canEdit: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const thumbSrc =
    task.has_thumbnail && task.gcode_file_id
      ? `${apiUrl}/api/files/${task.gcode_file_id}/thumbnail`
      : null;

  return (
    <tr
      className={[
        "border-b border-[var(--border)]/60 transition-colors",
        selected ? "bg-accent/5" : "hover:bg-[var(--surface-hi)]/30",
      ].join(" ")}
    >
      {/* checkbox */}
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="accent-[var(--accent)] cursor-pointer"
        />
      </td>

      {/* # */}
      <td className="px-2 py-2 text-[var(--text-muted)]">{index}.</td>

      {/* File */}
      <td className="max-w-[180px] px-3 py-2">
        <div className="flex items-center gap-2">
          {thumbSrc ? (
            <img
              src={thumbSrc}
              alt=""
              className="h-8 w-8 shrink-0 rounded object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--surface-2)] text-[var(--text-muted)] text-xs">
              3mf
            </div>
          )}
          <span className="truncate text-accent hover:underline cursor-default">
            {task.file_name ?? task.title}
          </span>
        </div>
      </td>

      {/* Tags */}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1 flex-wrap">
          <FilamentChips meta={task.filament_meta} />
          <button
            className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[var(--border-strong)] text-[10px] text-[var(--text-muted)] hover:border-neutral-400"
            title="Додати тег"
          >
            +
          </button>
        </div>
      </td>

      {/* Print cost */}
      <td className="px-3 py-2 text-right text-[var(--text-muted)]">
        {task.material_cost_uah
          ? `${task.material_cost_uah.toFixed(2)} UAH`
          : "—"}
      </td>

      {/* Print time */}
      <td className="px-3 py-2 text-right text-[var(--text-muted)]">
        {formatDuration(task.estimated_minutes)}
      </td>

      {/* Material */}
      <td className="px-3 py-2">
        <MaterialCell meta={task.filament_meta} />
      </td>

      {/* Printed */}
      <td className="px-3 py-2 text-right text-[var(--text-muted)]">
        {task.printed_count ?? 0}
      </td>

      {/* Amount */}
      <td className="px-3 py-2">
        {canEdit ? (
          <AmountStepper
            taskId={task.id}
            value={task.quantity}
            onChange={(v) => onUpdated({ ...task, quantity: v })}
          />
        ) : (
          <span className="text-[var(--text-muted)]">{task.quantity}</span>
        )}
      </td>

      {/* User */}
      <td className="px-3 py-2 text-[var(--text-faint)] max-w-[100px] truncate">
        {task.created_by_name ?? "—"}
      </td>

      {/* Added */}
      <td className="px-3 py-2 text-[var(--text-faint)] whitespace-nowrap">
        {formatRelativeDate(task.created_at)}
      </td>

      {/* Printer */}
      <td className="px-3 py-2">
        <PrinterCell
          printerId={task.assigned_printer_id}
          printerName={task.assigned_printer_name}
        />
      </td>

      {/* Actions */}
      <td className="relative px-2 py-2">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        >
          ···
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-lg"
            onMouseLeave={() => setMenuOpen(false)}
          >
            {task.gcode_file_id && canEdit && (
              <button
                onClick={() => { setMenuOpen(false); onSend(); }}
                className="w-full px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-hi)]"
              >
                Надіслати на принтер
              </button>
            )}
            {canEdit && (
              <button
                onClick={() => { setMenuOpen(false); onDelete(); }}
                className="w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-[var(--surface-hi)]"
              >
                Видалити
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
