"use client";

import { useEffect, useState } from "react";

import { FilamentSwatches } from "@/components/filament/FilamentSwatches";
import { SlotStrip } from "@/components/printers/SlotStrip";
import { Modal } from "@/components/ui/Modal";
import { useConfirm } from "@/hooks/useConfirm";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  stateLabel,
} from "@/lib/printerLabels";
import type { Printer, PrinterGroup } from "@/lib/types";

const MANUAL_STATUSES = [
  { value: "idle", label: "Вільний" },
  { value: "printing", label: "Друкує" },
  { value: "in_maintenance", label: "Обслуговування" },
  { value: "error", label: "Помилка" },
];

function PrintControls({
  printer,
  onUpdated,
}: {
  printer: Printer;
  onUpdated: (p: Printer) => void;
}) {
  const { confirm: confirmDialog, dialog: confirmDialogNode } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function act(action: "pause" | "resume" | "cancel" | "clear-error") {
    setBusy(action);
    setErr(null);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      // Refresh printer state — server's cache for this URL is invalidated
      const refreshed = await api<Printer[]>("/api/printers");
      const updated = refreshed.find((p) => p.id === printer.id);
      if (updated) onUpdated(updated);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  const isPaused = printer.state === "paused";
  const isPrinting = printer.state === "printing";
  const isError = printer.state === "error";

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-3 gap-2">
        {isPrinting && (
          <button
            type="button"
            onClick={() => act("pause")}
            disabled={busy !== null}
            className="rounded-md border border-[var(--state-warn)] bg-[rgba(245,158,11,.10)] px-2 py-1.5 text-xs font-medium text-[var(--state-warn)] hover:bg-[rgba(245,158,11,.15)] disabled:opacity-50"
          >
            {busy === "pause" ? "…" : "Пауза"}
          </button>
        )}
        {isPaused && (
          <button
            type="button"
            onClick={() => act("resume")}
            disabled={busy !== null}
            className="rounded-md border border-[var(--state-ok)] bg-[rgba(34,197,94,.10)] px-2 py-1.5 text-xs font-medium text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.15)] disabled:opacity-50"
          >
            {busy === "resume" ? "…" : "▶ Продовжити"}
          </button>
        )}
        {isError && (
          <button
            type="button"
            onClick={() => act("clear-error")}
            disabled={busy !== null}
            className="rounded-md border border-[var(--state-warn)] bg-[rgba(245,158,11,.10)] px-2 py-1.5 text-xs font-medium text-[var(--state-warn)] hover:bg-[rgba(245,158,11,.15)] disabled:opacity-50"
          >
            {busy === "clear-error" ? "…" : "Скинути помилку"}
          </button>
        )}
        <button
          type="button"
          onClick={async () => {
            if (await confirmDialog({ message: "Скасувати поточний друк? Це не скасується автоматично.", variant: "warn" })) act("cancel");
          }}
          disabled={busy !== null}
          className={[
            "rounded-md border border-[var(--state-error)] bg-[rgba(239,68,68,.10)] px-2 py-1.5 text-xs font-medium text-[var(--state-error)] hover:bg-[rgba(239,68,68,.15)] disabled:opacity-50",
            isPrinting || isPaused || isError ? "col-span-2" : "col-span-3",
          ].join(" ")}
        >
          {busy === "cancel" ? "…" : "✕ Скасувати друк"}
        </button>
      </div>
      {err && <p className="text-xs text-[var(--state-error)]">{err}</p>}
      {confirmDialogNode}
    </div>
  );
}




function MoonrakerUrlEditor({
  printer,
  onUpdated,
}: {
  printer: Printer;
  onUpdated: (p: Printer) => void;
}) {
  const [url, setUrl] = useState(printer.moonraker_url ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setUrl(printer.moonraker_url ?? "");
  }, [printer.moonraker_url]);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      const updated = await api<Printer>(`/api/printers/${printer.id}`, {
        method: "PATCH",
        body: JSON.stringify({ moonraker_url: url.trim() }),
      });
      onUpdated(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--text-muted)]">
          Moonraker / Mainsail URL
        </span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.31.210"
          className="input"
        />
      </label>
      <div className="flex justify-end gap-2 text-xs">
        {saved && <span className="text-[var(--state-ok)]">✓ Збережено</span>}
        <button
          onClick={save}
          disabled={busy || (url.trim() === (printer.moonraker_url ?? ""))}
          className="btn btn-primary btn-sm disabled:opacity-50"
        >
          {busy ? "…" : "Зберегти URL"}
        </button>
      </div>
    </div>
  );
}

// ── group picker ─────────────────────────────────────────────────────────────

function GroupPicker({
  printer,
  onUpdated,
}: {
  printer: Printer;
  onUpdated: (p: Printer) => void;
}) {
  const [groups, setGroups] = useState<PrinterGroup[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PrinterGroup[]>("/api/printer-groups").then(setGroups).catch(() => {});
  }, []);

  async function assignGroup(groupId: number | null) {
    setBusy(true);
    try {
      const updated = await api<Printer>(`/api/printers/${printer.id}/group`, {
        method: "POST",
        body: JSON.stringify({ group_id: groupId }),
      });
      onUpdated(updated);
    } catch {
      // ignore; the select will revert visually on next render
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <span className="mb-1 block text-xs text-[var(--text-muted)]">Група</span>
      <select
        value={printer.group_id ?? ""}
        disabled={busy}
        onChange={(e) => assignGroup(e.target.value ? Number(e.target.value) : null)}
        className="input disabled:opacity-50"
      >
        <option value="">— Без групи —</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
    </div>
  );
}


export function PrinterDetailModal({
  printer,
  onClose,
  onUpdated,
  onDeleted,
}: {
  printer: Printer | null;
  onClose: () => void;
  onUpdated: (p: Printer) => void;
  onDeleted?: (id: number) => void;
}) {
  const { confirm, dialog } = useConfirm();
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";
  const isManual = printer?.kind === "other";

  const [status, setStatus] = useState("idle");
  const [job, setJob] = useState("");
  const [eta, setEta] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (printer) {
      setStatus(printer.state ?? "idle");
      setJob(printer.job ?? "");
      setEta(printer.eta_minutes ? String(printer.eta_minutes) : "");
      setError(null);
    }
  }, [printer]);

  if (!printer) return null;

  async function save(payload: {
    status?: string;
    job?: string;
    eta_minutes?: number | null;
  }) {
    if (!printer) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Printer>(
        `/api/printers/${printer.id}/manual`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
      onUpdated(updated);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  function takeJob(e: React.FormEvent) {
    e.preventDefault();
    save({
      status: "printing",
      job: job.trim() || "Друк",
      eta_minutes: eta ? parseInt(eta, 10) : null,
    });
  }

  function release() {
    save({ status: "idle", job: "", eta_minutes: null });
  }

  function setManualStatus(newStatus: string) {
    save({ status: newStatus });
  }

  return (
    <>
    <Modal
      open={!!printer}
      onClose={() => !busy && onClose()}
      title={printer.name}
    >
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--text-muted)]">
          <span>{kindLabel(printer.kind)}</span>
          <span>{stateLabel(printer.state)}</span>
          {printer.firmware_version && (
            <span
              title="Версія Klipper"
              className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-xs font-mono text-[var(--text-muted)]"
            >
              {printer.firmware_version}
            </span>
          )}
          {printer.group_name && (
            <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-xs text-[var(--text-muted)]  ">
              {printer.group_name}
            </span>
          )}
          {printer.flags.map((f) => (
            <span
              key={f}
              className="badge badge-warn text-xs"
            >
              {flagLabel(f)}
            </span>
          ))}
        </div>

        {(user.role === "admin" || user.role === "operator") && (
          <GroupPicker printer={printer} onUpdated={onUpdated} />
        )}

        {canEdit && (printer.kind === "bambu" || printer.moonraker_url) &&
          ["printing", "paused", "error", "pausing", "resuming", "cancelling"].includes(printer.state ?? "") && (
            <PrintControls printer={printer} onUpdated={onUpdated} />
          )}

        {printer.moonraker_url && (
          <>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => window.open(printer.moonraker_url!, "_blank", "noopener,noreferrer")}
                className="rounded-md border border-[var(--accent)] bg-[rgba(34,211,238,.08)] px-2 py-1 text-[var(--accent)] hover:bg-[rgba(34,211,238,.14)]"
              >
                🔗 Відкрити в Mainsail
              </button>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(printer.moonraker_url!);
                }}
                className="text-[var(--text-muted)] hover:text-[var(--text-hi)] "
                title="Скопіювати URL"
              >
                ⧉ копіювати
              </button>
            </div>

            {(printer.progress_pct != null ||
              printer.extruder_temp != null ||
              printer.bed_temp != null ||
              printer.current_filament_meta) && (
              <div className="space-y-2 rounded-md border border-[var(--border)] px-3 py-2 text-xs ">
                {printer.progress_pct != null && printer.state === "printing" && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--text-muted)]">Прогрес</span>
                      <span className="font-medium">{printer.progress_pct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-hi)] ">
                      <div
                        className="h-full rounded-full"
                        style={{ background: "var(--state-print)", width: `${printer.progress_pct}%` }}
                      />
                    </div>
                  </>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--text-muted)] ">
                  {printer.extruder_temp != null && (
                    <span>
                      Сопло: {Math.round(printer.extruder_temp)}°
                      {printer.extruder_target
                        ? ` → ${Math.round(printer.extruder_target)}°`
                        : ""}
                    </span>
                  )}
                  {printer.bed_temp != null && (
                    <span>
                      Стіл: {Math.round(printer.bed_temp)}°
                      {printer.bed_target ? ` → ${Math.round(printer.bed_target)}°` : ""}
                    </span>
                  )}
                </div>
                {printer.current_filament_meta && (
                  <div>
                    <div className="mb-1 text-[var(--text-muted)]">Завантажений пластик</div>
                    <FilamentSwatches
                      meta={printer.current_filament_meta}
                      size={14}
                      showLabel
                    />
                  </div>
                )}
                {printer.slots && printer.slots.length > 0 && (
                  <div>
                    <div className="mb-1 text-[var(--text-muted)]">Слоти</div>
                    <SlotStrip
                      slots={printer.slots}
                      kind={printer.kind}
                      editable={canEdit}
                      printerId={printer.id}
                      onSlotUpdated={(updated) =>
                        onUpdated({
                          ...printer,
                          slots: (printer.slots ?? []).map((s) =>
                            s.slot_index === updated.slot_index ? updated : s,
                          ),
                        })
                      }
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {printer.kind !== "bambu" && user.role === "admin" && (
          <MoonrakerUrlEditor printer={printer} onUpdated={onUpdated} />
        )}

        {canEdit && (
          <>
            {printer.state === "idle" || !printer.job ? (
              <form onSubmit={takeJob} className="space-y-3">
                <h3 className="font-medium">Зайняти принтер</h3>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--text-muted)]">
                    Що друкуємо
                  </span>
                  <input
                    type="text"
                    required
                    value={job}
                    onChange={(e) => setJob(e.target.value)}
                    placeholder="Деталь / задача"
                    className="input"
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--text-muted)]">
                    Скільки часу залишилось (хв)
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={eta}
                    onChange={(e) => setEta(e.target.value)}
                    placeholder="напр. 240"
                    className="input"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="btn btn-primary w-full"
                >
                  {busy ? "Зберігаю…" : "Зайняти"}
                </button>
              </form>
            ) : (
              <div className="space-y-3">
                <div className="rounded-md bg-[var(--surface-hi)] px-3 py-2 ">
                  <div className="text-xs text-[var(--text-muted)]">Поточний друк</div>
                  <div className="font-medium">{printer.job}</div>
                  {printer.eta_minutes != null && printer.eta_minutes > 0 && (
                    <div className="text-xs text-[var(--text-muted)]">
                      Залишилось ≈ {printer.eta_minutes} хв
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={release}
                  disabled={busy}
                  className="btn btn-primary w-full disabled:opacity-50"
                >
                  {busy ? "Зберігаю…" : "Звільнити (друк завершено)"}
                </button>
              </div>
            )}

            <div className="border-t border-[var(--border)] pt-3 ">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">
                Або встановити стан вручну
              </span>
              <select
                value={status}
                onChange={(e) => setManualStatus(e.target.value)}
                disabled={busy}
                className="input"
              >
                {MANUAL_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {error && (
          <p className="text-sm text-[var(--state-error)]">{error}</p>
        )}

        {isManual && user.role === "admin" && onDeleted && (
          <div className="border-t border-[var(--border)] pt-3 ">
            <button
              type="button"
              onClick={async () => {
                if (!await confirm({ message: `Видалити ${printer.name}? Усі записи плану з ним теж видаляться.`, variant: "danger" }))
                  return;
                try {
                  await api(`/api/printers/${printer.id}`, { method: "DELETE" });
                  onDeleted(printer.id);
                  onClose();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : "Помилка видалення");
                }
              }}
              className="btn btn-danger w-full"
            >
              Видалити принтер
            </button>
          </div>
        )}
      </div>
    </Modal>
    {dialog}
    </>
  );
}
