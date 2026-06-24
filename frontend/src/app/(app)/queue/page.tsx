"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";

import { AmountStepper } from "@/components/queue/AmountStepper";
import { CreateTaskModal } from "@/components/plan/CreateTaskModal";
import { SendModal } from "@/components/files/SendModal";
import { Modal } from "@/components/ui/Modal";
import { ApiError, api, getPlanCalendar } from "@/lib/api";
import { formatDuration, formatRelativeDate, sumArray } from "@/lib/format";
import { useUser } from "@/lib/auth-context";
import type { CalendarLane, Filament, GcodeFile, PrintTask, PrintTaskStatus, Printer } from "@/lib/types";
import { useQueueStream } from "@/hooks/useQueueStream";
import { usePrinterStream } from "@/hooks/usePrinterStream";
import { usePageTitle } from "@/lib/usePageTitle";
import { KanbanSkeleton } from "@/components/ui/ContentSkeleton";
import { ScheduleCalendar } from "@/components/schedule/ScheduleCalendar";
import { ScheduleBacklog } from "@/components/schedule/ScheduleBacklog";
import { ScheduleModal } from "@/components/schedule/ScheduleModal";
import type { ScheduleModalMode } from "@/components/schedule/ScheduleModal";
import { getMondayOfWeek, isoDateStr, getWeekDates } from "@/components/schedule/utils";

// ── mascot ────────────────────────────────────────────────────────────────────

function Mascot() {
  const B = "#0891b2";
  const S = "#0e7490";
  const F = "#cffafe";
  const E = "#083344";
  const A = "#22d3ee";
  return (
    <svg width={90} height={117} viewBox="0 0 10 13" shapeRendering="crispEdges"
      style={{ imageRendering: "pixelated" }} aria-hidden>
      <rect x="4" y="0" width="2" height="1" fill={A} />
      <rect x="4" y="1" width="2" height="1" fill={B} />
      <rect x="2" y="2" width="6" height="1" fill={F} />
      <rect x="1" y="3" width="8" height="3" fill={F} />
      <rect x="2" y="6" width="6" height="1" fill={F} />
      <rect x="2" y="4" width="2" height="2" fill={E} />
      <rect x="6" y="4" width="2" height="2" fill={E} />
      <rect x="3" y="4" width="1" height="1" fill="white" opacity="0.65" />
      <rect x="7" y="4" width="1" height="1" fill="white" opacity="0.65" />
      <rect x="1" y="5" width="1" height="1" fill="#f9a8d4" opacity="0.6" />
      <rect x="8" y="5" width="1" height="1" fill="#f9a8d4" opacity="0.6" />
      <rect x="3" y="6" width="4" height="1" fill={S} opacity="0.5" />
      <rect x="2" y="7" width="6" height="3" fill={B} />
      <rect x="3" y="8" width="4" height="1" fill={S} opacity="0.35" />
      <rect x="0" y="7" width="2" height="2" fill={B} />
      <rect x="8" y="7" width="2" height="2" fill={B} />
      <rect x="3" y="10" width="2" height="2" fill={S} />
      <rect x="5" y="11" width="2" height="2" fill={S} />
    </svg>
  );
}

// ── tabs config ───────────────────────────────────────────────────────────────

type StatusTab = PrintTaskStatus;

const TABS: { id: StatusTab; label: string; dot: string }[] = [
  { id: "queued",      label: "В черзі",   dot: "bg-[var(--accent)]" },
  { id: "in_progress", label: "В процесі", dot: "bg-[var(--state-warn)]" },
  { id: "done",        label: "Виконано",  dot: "bg-[var(--state-ok)]" },
  { id: "cancelled",   label: "Скасовано", dot: "bg-[var(--state-idle)]" },
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
    tags: [],
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
          <span key={i} className="h-3 w-3 rounded-full border border-[var(--border)]"
            style={{ background: c, marginLeft: i > 0 ? -4 : 0 }} />
        ))}
      </div>
      <span className="text-[var(--text-muted)]">{total > 0 ? `${total.toFixed(1)} г` : "—"}</span>
    </div>
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
    <div className="flex flex-col items-center justify-center gap-5 py-20 text-center">
      <div className="opacity-60">
        <Mascot />
      </div>
      <div>
        <p className="text-sm font-medium text-[var(--text-muted)]">{messages[status]}</p>
        {status === "queued" && (
          <p className="mt-1 text-xs text-[var(--text-faint)]">Натисніть + щоб додати нове завдання</p>
        )}
      </div>
      {status === "queued" && (
        <button onClick={onAdd}
          className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90">
          + Нове завдання
        </button>
      )}
    </div>
  );
}

// ── printer slot (in_progress view) ──────────────────────────────────────────

function PrinterSlot({
  printer, task, onSend, onComplete, canEdit,
}: {
  printer: Printer;
  task: PrintTask | null;
  onSend: (t: PrintTask) => void;
  onComplete: (t: PrintTask) => void;
  canEdit: boolean;
}) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const thumbSrc = task?.has_thumbnail && task?.gcode_file_id
    ? `${apiUrl}/api/files/${task.gcode_file_id}/thumbnail` : null;

  if (!task) {
    return (
      <div className="flex min-h-[80px] items-center justify-center rounded-lg border-2 border-dashed border-[var(--state-ok)]/40 bg-[var(--bg-elevated)] px-4 py-3">
        <div className="text-center">
          <p className="text-xs font-medium text-[var(--state-ok)]/70">{printer.name}</p>
          <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">Вільний</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
      <div className="flex items-start gap-2">
        {thumbSrc ? (
          <img src={thumbSrc} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[var(--surface-hi)] text-[10px] text-[var(--text-faint)]">3mf</div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-[var(--accent)]">{task.file_name ?? task.title}</p>
          <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">{printer.name}</p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <MaterialCell meta={task.filament_meta} />
        {task.estimated_minutes ? (
          <span className="ml-auto text-[10px] text-[var(--text-faint)]">{formatDuration(task.estimated_minutes)}</span>
        ) : null}
      </div>
      {canEdit && (
        <div className="flex gap-1.5 border-t border-[var(--border)]/60 pt-2">
          {task.gcode_file_id && (
            <button onClick={() => onSend(task)}
              className="flex-1 rounded border border-[var(--border-strong)] bg-[var(--surface-hi)] py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">
              Відправити
            </button>
          )}
          <button onClick={() => onComplete(task)}
            className="flex-1 rounded border border-[rgba(34,197,94,.3)] bg-[rgba(34,197,94,.07)] py-1 text-[10px] text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.12)]">
            Завершити ✓
          </button>
        </div>
      )}
    </div>
  );
}

// ── complete modal ────────────────────────────────────────────────────────────

const DEFECT_PRESETS = ["Варпінг", "Відшарування шарів", "Забій сопла", "Збій живлення", "Помилка налаштувань", "Інше"];

function CompleteModal({ task, onClose, onDone }: {
  task: PrintTask | null; onClose: () => void; onDone: (updated: PrintTask) => void;
}) {
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
                    defectPreset === p
                      ? "border-[rgba(239,68,68,.4)] bg-[rgba(239,68,68,.08)] text-[var(--state-error)]"
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
              Котушки (~{actualPrinted} шт. × {Math.round(usedG.reduce((s, g) => s + g, 0) / plannedQty)}г)
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
            {costPerOk != null && <p className="text-xs text-[var(--text-muted)]">{costPerOk.toFixed(2)} грн/шт. для {piecesOk} добрих</p>}
          </div>
        )}
        {task.product_name && piecesOk > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--state-ok)]/20 bg-[var(--state-ok)]/5 px-3 py-2 text-xs text-[var(--state-ok)]">
            <span>→</span>
            <span>
              {piecesOk} шт. <strong>{task.product_name}</strong>
              {" "}— оновить партію або піде на склад готової продукції
            </span>
          </div>
        )}
        {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
      </div>
    </Modal>
  );
}

// ── queue row (table view) ────────────────────────────────────────────────────

function QueueRow({
  index, task, status, selected, onToggle, onUpdated, onDelete, onSend, onComplete, onRestore, canEdit,
}: {
  index: number; task: PrintTask; status: StatusTab;
  selected: boolean; onToggle: () => void;
  onUpdated: (t: PrintTask) => void; onDelete: () => void;
  onSend: () => void; onComplete: () => void; onRestore: () => void;
  canEdit: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const thumbSrc = task.has_thumbnail && task.gcode_file_id
    ? `${apiUrl}/api/files/${task.gcode_file_id}/thumbnail` : null;

  return (
    <tr className={["border-b border-[var(--border)]/60 transition-colors",
      selected ? "bg-[var(--accent)]/5" : "hover:bg-[var(--surface-hi)]/30"].join(" ")}>
      <td className="px-3 py-2">
        <input type="checkbox" checked={selected} onChange={onToggle} className="accent-[var(--accent)] cursor-pointer" />
      </td>
      <td className="px-2 py-2 text-[var(--text-faint)]">{index}.</td>

      <td className="max-w-[200px] px-3 py-2">
        <div className="flex items-center gap-2">
          {thumbSrc ? (
            <img src={thumbSrc} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--surface-hi)] text-[10px] text-[var(--text-faint)]">3mf</div>
          )}
          <div className="min-w-0">
            <span className="block truncate text-[var(--accent)]">{task.file_name ?? task.title}</span>
            {task.product_name && (
              <span className="inline-block mt-0.5 rounded bg-[var(--state-ok)]/10 px-1 py-px text-[10px] text-[var(--state-ok)]" title="Прив'язано до товару">
                {task.product_name}
              </span>
            )}
          </div>
        </div>
      </td>

      <td className="px-3 py-2"><FilamentChips meta={task.filament_meta} /></td>
      <td className="px-3 py-2 text-right text-[var(--text-muted)]">
        {task.material_cost_uah ? `${task.material_cost_uah.toFixed(2)} грн` : "—"}
      </td>
      <td className="px-3 py-2 text-right text-[var(--text-muted)]">{formatDuration(task.estimated_minutes)}</td>
      <td className="px-3 py-2"><MaterialCell meta={task.filament_meta} /></td>

      {status === "done" ? (
        <td className="px-3 py-2">
          {task.pieces_ok != null ? (
            <div className="flex flex-col gap-0.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[var(--state-ok)]">✓ {task.pieces_ok}</span>
                {(task.pieces_defective ?? 0) > 0 && (
                  <span className="text-[var(--state-error)]" title={task.defect_reason ?? ""}>✕ {task.pieces_defective}</span>
                )}
              </div>
              {task.product_name && task.pieces_ok > 0 && (
                <span className="text-[10px] text-[var(--state-ok)] opacity-70">+{task.pieces_ok} на склад</span>
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

      <td className="max-w-[100px] truncate px-3 py-2 text-[var(--text-faint)]">{task.created_by_name ?? "—"}</td>
      <td className="whitespace-nowrap px-3 py-2 text-[var(--text-faint)]">{formatRelativeDate(task.created_at)}</td>

      {status !== "in_progress" && (
        <td className="px-3 py-2 text-[var(--text-muted)]">
          {task.assigned_printer_name ?? "—"}
        </td>
      )}

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

function QueuePageInner() {
  usePageTitle("nav.plan");
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = (searchParams.get("view") ?? "calendar") as "list" | "calendar";

  function setView(v: "list" | "calendar") {
    const p = new URLSearchParams(searchParams.toString());
    p.set("view", v);
    router.replace(`/queue?${p.toString()}`);
  }

  // ── Real-time streams ──
  const { version: queueVersion } = useQueueStream();
  const { printers: livePrinters } = usePrinterStream();

  // ── List-view state ──
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

  // ── Calendar-view state ──
  const [weekStart, setWeekStart] = useState<Date>(() => getMondayOfWeek());
  const [calendarLanes, setCalendarLanes] = useState<CalendarLane[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [scheduleModal, setScheduleModal] = useState<ScheduleModalMode | null>(null);

  const scheduledTaskIds = useMemo<Set<number>>(() => {
    const ids = new Set<number>();
    for (const lane of calendarLanes) {
      for (const day of lane.days) {
        for (const entry of day.entries) {
          ids.add(entry.task_id);
        }
      }
    }
    return ids;
  }, [calendarLanes]);

  const backlogTasks = useMemo(
    () => tasks.filter(t => t.status === "queued" && !scheduledTaskIds.has(t.id)),
    [tasks, scheduledTaskIds],
  );

  const loadCalendar = useCallback(async () => {
    setCalendarLoading(true);
    try {
      const weekDates = getWeekDates(weekStart);
      const start = isoDateStr(weekDates[0]);
      const end   = isoDateStr(weekDates[6]);
      const lanes = await getPlanCalendar(start, end);
      setCalendarLanes(lanes);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally { setCalendarLoading(false); }
  }, [weekStart]);

  // Silent refresh — updates calendar data without showing the loading skeleton.
  // Used after drag-drop so the grid doesn't flicker.
  const loadCalendarSilent = useCallback(async () => {
    try {
      const weekDates = getWeekDates(weekStart);
      const lanes = await getPlanCalendar(isoDateStr(weekDates[0]), isoDateStr(weekDates[6]));
      setCalendarLanes(lanes);
    } catch { /* ignore */ }
  }, [weekStart]);

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

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (view === "calendar") loadCalendar();
  }, [view, loadCalendar]);

  const refreshQueueSurface = useCallback(async () => {
    await Promise.all([load(), loadCalendarSilent()]);
  }, [load, loadCalendarSilent]);

  // Auto-refresh on WebSocket queue events
  useEffect(() => {
    if (queueVersion === 0) return;
    if (view === "list") {
      load();
      return;
    }
    refreshQueueSurface();
  }, [queueVersion, view, load, refreshQueueSurface]);

  // Keep printers in sync with live WS stream
  useEffect(() => {
    if (livePrinters.length > 0) setPrinters(livePrinters);
  }, [livePrinters]);

  const counts = useMemo(
    () => tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    [tasks],
  );

  const visible = useMemo(() => {
    let list = tasks.filter(t => t.status === activeTab);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t => t.title.toLowerCase().includes(q) || (t.file_name ?? "").toLowerCase().includes(q));
    }
    return list;
  }, [tasks, activeTab, search]);

  const stats = useMemo(() => ({
    jobs: visible.length,
    totalMin: visible.reduce((s, t) => s + (t.estimated_minutes ?? 0), 0),
    totalG: visible.reduce((s, t) => s + sumArray(t.filament_meta?.used_g), 0),
    totalCost: visible.reduce((s, t) => s + (t.material_cost_uah ?? 0), 0),
  }), [visible]);

  // in_progress: map printer → task
  const printerTaskMap = useMemo(() => {
    const map = new Map<number, PrintTask>();
    for (const t of tasks.filter(t => t.status === "in_progress")) {
      if (t.assigned_printer_id) map.set(t.assigned_printer_id, t);
    }
    return map;
  }, [tasks]);

  const activePrinters = printers.filter(p => p.is_active);

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

  if (loading) {
    if (view === "calendar") {
      return (
        <div className="-mx-6 -mt-6 -mb-6 flex flex-col h-dvh">
          <div className="shrink-0 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-6 py-3">
            <div className="skeleton h-5 w-32 rounded" />
            <div className="flex gap-2">
              <div className="skeleton h-8 w-20 rounded" />
              <div className="skeleton h-8 w-20 rounded" />
            </div>
          </div>
          <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
            <div className="flex gap-3">
              <div className="skeleton h-4 w-24 rounded" />
              <div className="skeleton h-4 w-20 rounded" />
              <div className="skeleton h-4 w-32 rounded" />
            </div>
          </div>
          <div className="flex-1 overflow-hidden p-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex border-b border-[var(--border)]" style={{ animationDelay: `${i * 60}ms` }}>
                <div className="w-[152px] shrink-0 border-r border-[var(--border)] bg-[var(--bg-elevated)] p-3">
                  <div className="skeleton h-3 w-16 rounded" />
                  <div className="skeleton mt-1.5 h-2 w-10 rounded" />
                </div>
                {Array.from({ length: 7 }).map((_, j) => (
                  <div key={j} className="flex-1 border-r border-[var(--border)] bg-[var(--bg-elevated)]" style={{ minHeight: 80 }}>
                    {j === 2 && i < 5 && <div className="skeleton mx-1 mt-4 h-4 rounded" style={{ width: `${30 + Math.random() * 40}%` }} />}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }
    return <KanbanSkeleton columns={4} cardsPerCol={3} />;
  }

  return (
    <div className="-mx-6 -mt-6 -mb-6 flex flex-col h-dvh">

      {/* ── Header ── */}
      <div className="relative z-10 shrink-0 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-semibold">Черга друку</h1>
          {view === "list" && (activeTab === "queued" || activeTab === "in_progress") && stats.jobs > 0 && (
            <div className="hidden items-center gap-4 text-xs text-[var(--text-muted)] sm:flex">
              <span>{stats.jobs} завдань</span>
              {stats.totalMin > 0 && (
                <span>{stats.totalMin >= 60 ? `${Math.floor(stats.totalMin / 60)}г ${stats.totalMin % 60}хв` : `${stats.totalMin}хв`}</span>
              )}
              {stats.totalG > 0 && (
                <span>{stats.totalG >= 1000 ? `${(stats.totalG / 1000).toFixed(2)} кг` : `${stats.totalG.toFixed(1)} г`}</span>
              )}
              {stats.totalCost > 0 && <span>{stats.totalCost.toFixed(0)} грн</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex rounded-md border border-[var(--border-strong)] bg-[var(--bg)] p-0.5">
            {(["list", "calendar"] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={[
                  "flex items-center gap-1 rounded px-3 py-1 text-xs font-medium transition-colors",
                  view === v
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {v === "list" ? "≡ Список" : "⊟ Календар"}
              </button>
            ))}
          </div>

          {canEdit && (
            <button onClick={() => setCreateOpen(true)}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-sm font-semibold text-white hover:opacity-90">
              + Нове завдання
            </button>
          )}
        </div>
      </div>

      {/* ── Calendar view ── */}
      {view === "calendar" && (
        <div className="flex flex-1 overflow-hidden relative z-0">
          <div className="flex-1 overflow-hidden">
            <ScheduleCalendar
              lanes={calendarLanes}
              weekStart={weekStart}
              loading={calendarLoading}
              livePrinters={livePrinters.length > 0 ? livePrinters : printers}
              onPrevWeek={() => {
                const d = new Date(weekStart);
                d.setDate(d.getDate() - 7);
                setWeekStart(d);
              }}
              onNextWeek={() => {
                const d = new Date(weekStart);
                d.setDate(d.getDate() + 7);
                setWeekStart(d);
              }}
              onPrevDay={() => {
                const d = new Date(weekStart);
                d.setDate(d.getDate() - 1);
                setWeekStart(d);
              }}
              onNextDay={() => {
                const d = new Date(weekStart);
                d.setDate(d.getDate() + 1);
                setWeekStart(d);
              }}
              onToday={() => {
                const d = new Date();
                d.setHours(0, 0, 0, 0);
                setWeekStart(d);
              }}
              onDateChange={date => {
                const d = new Date(date);
                d.setHours(0, 0, 0, 0);
                setWeekStart(d);
              }}
              onOpenModal={setScheduleModal}
              onRefresh={refreshQueueSurface}
              onSendToPrint={entry => {
                const task = tasks.find(t => t.id === entry.task_id) ?? entry.task;
                if (task.gcode_file_id) setSendTask(task);
              }}
            />
          </div>
          <div className="w-72 shrink-0 border-l border-[var(--border)] overflow-y-auto">
            <ScheduleBacklog
              tasks={backlogTasks}
              onSchedule={task => setScheduleModal({ type: "schedule", task })}
            />
          </div>
        </div>
      )}

      {/* ── List view ── */}
      {view === "list" && (
        <div className="flex flex-col flex-1 overflow-y-auto bg-[var(--bg)] relative z-0">
          {/* Tab bar */}
          <div className="sticky top-0 z-10 flex items-center gap-0.5 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4">
            {TABS.map(tab => (
              <button key={tab.id}
                onClick={() => { setActiveTab(tab.id); setSelected(new Set()); setSearch(""); }}
                className={[
                  "flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors",
                  activeTab === tab.id
                    ? "border-[var(--accent)] font-medium text-[var(--text)]"
                    : "border-transparent text-[var(--text-faint)] hover:text-[var(--text-muted)]",
                ].join(" ")}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${tab.dot}`} />
                {tab.label}
                <span className={[
                  "rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums",
                  activeTab === tab.id ? "bg-[var(--surface-hi)] text-[var(--text-muted)]" : "text-[var(--text-faint)]",
                ].join(" ")}>
                  {counts[tab.id] ?? 0}
                </span>
              </button>
            ))}

            <div className="ml-auto flex items-center gap-2 py-1.5">
              <input type="text" placeholder="Пошук…" value={search} onChange={e => setSearch(e.target.value)}
                className="h-7 w-40 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2.5 text-xs text-[var(--text)] placeholder-[var(--text-faint)] outline-none focus:border-[var(--accent)]" />
            </div>
          </div>

          {/* Alerts */}
          {(error || distributeResult) && (
            <div className="px-6 pt-3">
              {error && (
                <div className="rounded-md border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] px-3 py-2 text-sm text-[var(--state-error)]">{error}</div>
              )}
              {distributeResult && (
                <div className="rounded-md border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] px-3 py-2 text-sm text-[var(--state-ok)]">
                  Розподілено: {distributeResult.sent.length} завдань
                  {distributeResult.skipped.length > 0 && ` · Пропущено: ${distributeResult.skipped.length} (${distributeResult.skipped.map(s => s.reason).join(", ")})`}
                </div>
              )}
            </div>
          )}

          {/* Content */}
          <div className="flex-1 px-6 py-4">

            {/* In Progress: printer slot grid */}
            {activeTab === "in_progress" && (
              visible.length === 0 && activePrinters.length === 0 ? (
                <EmptyState status="in_progress" onAdd={() => setCreateOpen(true)} />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                  {activePrinters.map(p => (
                    <PrinterSlot key={p.id} printer={p} task={printerTaskMap.get(p.id) ?? null}
                      onSend={setSendTask} onComplete={setCompleteTask} canEdit={canEdit} />
                  ))}
                  {/* unassigned in_progress tasks */}
                  {visible.filter(t => !t.assigned_printer_id).map(t => (
                    <div key={t.id} className="rounded-lg border border-[var(--state-warn)]/40 bg-[var(--bg-elevated)] p-3">
                      <p className="truncate text-xs font-medium text-[var(--accent)]">{t.file_name ?? t.title}</p>
                      <p className="mt-1 text-[10px] text-[var(--text-faint)]">Без принтера</p>
                      {canEdit && (
                        <button onClick={() => setCompleteTask(t)}
                          className="mt-2 w-full rounded border border-[rgba(34,197,94,.3)] bg-[rgba(34,197,94,.07)] py-1 text-[10px] text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.12)]">
                          Завершити ✓
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )
            )}

            {/* All other tabs: table */}
            {activeTab !== "in_progress" && (
              visible.length === 0 ? (
                <EmptyState status={activeTab} onAdd={() => setCreateOpen(true)} />
              ) : (
                <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                  <table className="w-full min-w-[900px] text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] bg-[var(--bg-elevated)]/80 text-xs text-[var(--text-muted)]">
                        <th className="w-8 px-3 py-2.5">
                          <input type="checkbox" checked={allChecked}
                            ref={el => { if (el) el.indeterminate = someChecked; }}
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
                          key={task.id} index={idx + 1} task={task} status={activeTab}
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
              )
            )}
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      <CreateTaskModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={t => { setTasks(prev => [t, ...prev]); if (view === "calendar") loadCalendarSilent(); }} />

      {sendTask && sendTask.gcode_file_id && (
        <SendModal file={taskToGcodeFile(sendTask)} printers={printers} defaultPrinterId={sendTask.assigned_printer_id ?? undefined}
          onClose={() => { setSendTask(null); load(); }} />
      )}

      <CompleteModal task={completeTask} onClose={() => setCompleteTask(null)}
        onDone={t => { handleTaskUpdated(t); setCompleteTask(null); }} />

      {scheduleModal && (
        <ScheduleModal
          mode={scheduleModal}
          printers={printers}
          onClose={() => setScheduleModal(null)}
          onSaved={async () => { setScheduleModal(null); await refreshQueueSurface(); }}
        />
      )}
    </div>
  );
}

export default function QueuePage() {
  return (
    <Suspense>
      <QueuePageInner />
    </Suspense>
  );
}
