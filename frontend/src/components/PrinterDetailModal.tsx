"use client";

import { useEffect, useState } from "react";

import { FilamentSwatches } from "@/components/FilamentSwatches";
import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  stateEmoji,
  stateLabel,
} from "@/lib/printerLabels";
import type { Printer, PrinterGroup } from "@/lib/types";

const MANUAL_STATUSES = [
  { value: "idle", label: "Вільний 💤" },
  { value: "printing", label: "Друкує 🖨️" },
  { value: "in_maintenance", label: "Обслуговування 🔧" },
  { value: "error", label: "Помилка 🛑" },
];

function MoonrakerControls({
  printer,
  onUpdated,
}: {
  printer: Printer;
  onUpdated: (p: Printer) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function act(action: "pause" | "resume" | "cancel") {
    setBusy(action);
    setErr(null);
    try {
      await api(`/api/printers/${printer.id}/${action}`, { method: "POST" });
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

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-3 gap-2">
        {isPrinting && (
          <button
            type="button"
            onClick={() => act("pause")}
            disabled={busy !== null}
            className="rounded-md bg-amber-500 px-2 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {busy === "pause" ? "…" : "⏸ Пауза"}
          </button>
        )}
        {isPaused && (
          <button
            type="button"
            onClick={() => act("resume")}
            disabled={busy !== null}
            className="rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy === "resume" ? "…" : "▶ Продовжити"}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (confirm("Скасувати поточний друк? Це не скасується автоматично.")) act("cancel");
          }}
          disabled={busy !== null}
          className="col-span-2 rounded-md border border-red-300 px-2 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          {busy === "cancel" ? "…" : "✕ Скасувати друк"}
        </button>
      </div>
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
    </div>
  );
}


// ── SimplyPrint controls ─────────────────────────────────────────────────────

function SimplyPrintControls({
  printer,
  onUpdated,
}: {
  printer: Printer;
  onUpdated: (p: Printer) => void;
}) {
  const user = useUser();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gcodeInput, setGcodeInput] = useState("");
  const [gcodeOpen, setGcodeOpen] = useState(false);

  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const needsBedClear =
    printer.state === "operational" || printer.state === "awaiting_bed_clear";

  async function act(action: string, body?: object) {
    setBusy(action);
    setErr(null);
    try {
      await api(`/api/printers/${printer.id}/sp/${action}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      const refreshed = await api<Printer[]>("/api/printers");
      const updated = refreshed.find((p) => p.id === printer.id);
      if (updated) onUpdated(updated);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  async function sendGcode() {
    const lines = gcodeInput
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    await act("gcode", { gcode: lines });
    setGcodeInput("");
    setGcodeOpen(false);
  }

  return (
    <div className="space-y-2">
      {/* state-specific action buttons */}
      <div className="flex flex-wrap gap-2">
        {isPrinting && (
          <button
            type="button"
            onClick={() => act("pause")}
            disabled={busy !== null}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {busy === "pause" ? "…" : "⏸ Пауза"}
          </button>
        )}
        {isPaused && (
          <button
            type="button"
            onClick={() => act("resume")}
            disabled={busy !== null}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy === "resume" ? "…" : "▶ Продовжити"}
          </button>
        )}
        {(isPrinting || isPaused) && (
          <button
            type="button"
            onClick={() => {
              if (confirm("Скасувати поточний друк?")) act("cancel");
            }}
            disabled={busy !== null}
            className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            {busy === "cancel" ? "…" : "✕ Скасувати"}
          </button>
        )}
        {needsBedClear && (
          <button
            type="button"
            onClick={() => act("clear-bed", { success: true })}
            disabled={busy !== null}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy === "clear-bed" ? "…" : "✓ Стіл очищено"}
          </button>
        )}
      </div>

      {/* raw G-code sender — admin only */}
      {user.role === "admin" && (
        <div className="border-t border-neutral-200 pt-2 dark:border-neutral-800">
          {gcodeOpen ? (
            <div className="space-y-2">
              <textarea
                rows={3}
                value={gcodeInput}
                onChange={(e) => setGcodeInput(e.target.value)}
                placeholder={"G28 XY\nM109 S200"}
                className="w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={sendGcode}
                  disabled={busy !== null || !gcodeInput.trim()}
                  className="rounded-md bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  {busy === "gcode" ? "…" : "Надіслати G-code"}
                </button>
                <button
                  type="button"
                  onClick={() => { setGcodeOpen(false); setGcodeInput(""); }}
                  className="rounded-md px-3 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Скасувати
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setGcodeOpen(true)}
              className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              {"</>"} Надіслати G-code…
            </button>
          )}
        </div>
      )}

      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
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
        <span className="mb-1 block text-xs text-neutral-500">
          Moonraker / Mainsail URL
        </span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.31.210"
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>
      <div className="flex justify-end gap-2 text-xs">
        {saved && <span className="text-emerald-600 dark:text-emerald-400">✓ Збережено</span>}
        <button
          onClick={save}
          disabled={busy || (url.trim() === (printer.moonraker_url ?? ""))}
          className="rounded bg-neutral-900 px-2 py-1 text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
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
      <span className="mb-1 block text-xs text-neutral-500">Група</span>
      <select
        value={printer.group_id ?? ""}
        disabled={busy}
        onChange={(e) => assignGroup(e.target.value ? Number(e.target.value) : null)}
        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-950 disabled:opacity-50"
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
  const user = useUser();
  const isManual = printer?.kind !== "simplyprint";
  const canEdit =
    isManual && (user.role === "admin" || user.role === "operator");

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
    <Modal
      open={!!printer}
      onClose={() => !busy && onClose()}
      title={printer.name}
    >
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-neutral-500">
          <span>{kindLabel(printer.kind)}</span>
          <span>
            {stateEmoji(printer.state)} {stateLabel(printer.state)}
          </span>
          {printer.group_name && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              📁 {printer.group_name}
            </span>
          )}
          {printer.flags.map((f) => (
            <span
              key={f}
              className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
            >
              {flagLabel(f)}
            </span>
          ))}
        </div>

        {(user.role === "admin" || user.role === "operator") && (
          <GroupPicker printer={printer} onUpdated={onUpdated} />
        )}

        {printer.moonraker_url && (
          <>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => window.open(printer.moonraker_url!, "_blank", "noopener,noreferrer")}
                className="rounded-md border border-blue-300 px-2 py-1 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/30"
              >
                🔗 Відкрити в Mainsail
              </button>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(printer.moonraker_url!);
                }}
                className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                title="Скопіювати URL"
              >
                ⧉ копіювати
              </button>
            </div>

            {(printer.state === "printing" || printer.state === "paused") && canEdit && (
              <MoonrakerControls printer={printer} onUpdated={onUpdated} />
            )}

            {(printer.progress_pct != null ||
              printer.extruder_temp != null ||
              printer.bed_temp != null ||
              printer.current_filament_meta) && (
              <div className="space-y-2 rounded-md border border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
                {printer.progress_pct != null && printer.state === "printing" && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-neutral-500">Прогрес</span>
                      <span className="font-medium">{printer.progress_pct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                      <div
                        className="h-full rounded-full bg-emerald-500"
                        style={{ width: `${printer.progress_pct}%` }}
                      />
                    </div>
                  </>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-neutral-600 dark:text-neutral-400">
                  {printer.extruder_temp != null && (
                    <span>
                      🌡 Сопло: {Math.round(printer.extruder_temp)}°
                      {printer.extruder_target
                        ? ` → ${Math.round(printer.extruder_target)}°`
                        : ""}
                    </span>
                  )}
                  {printer.bed_temp != null && (
                    <span>
                      ▣ Стіл: {Math.round(printer.bed_temp)}°
                      {printer.bed_target ? ` → ${Math.round(printer.bed_target)}°` : ""}
                    </span>
                  )}
                </div>
                {printer.current_filament_meta && (
                  <div>
                    <div className="mb-1 text-neutral-500">Завантажений пластик</div>
                    <FilamentSwatches
                      meta={printer.current_filament_meta}
                      size={14}
                      showLabel
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {isManual && printer.kind !== "bambu" && user.role === "admin" && (
          <MoonrakerUrlEditor printer={printer} onUpdated={onUpdated} />
        )}

        {!isManual && (
          <div className="space-y-3">
            <p className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              Дані тягнуться з SimplyPrint автоматично.
              {printer.job && (
                <>
                  <br />
                  Поточний друк: <b>{printer.job}</b>
                </>
              )}
            </p>
            {(user.role === "admin" || user.role === "operator") && (
              <SimplyPrintControls printer={printer} onUpdated={onUpdated} />
            )}
          </div>
        )}

        {canEdit && (
          <>
            {printer.state === "idle" || !printer.job ? (
              <form onSubmit={takeJob} className="space-y-3">
                <h3 className="font-medium">Зайняти принтер</h3>
                <label className="block">
                  <span className="mb-1 block text-xs text-neutral-500">
                    Що друкуємо
                  </span>
                  <input
                    type="text"
                    required
                    value={job}
                    onChange={(e) => setJob(e.target.value)}
                    placeholder="Деталь / задача"
                    className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-neutral-500">
                    Скільки часу залишилось (хв)
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={eta}
                    onChange={(e) => setEta(e.target.value)}
                    placeholder="напр. 240"
                    className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-md bg-emerald-600 px-3 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy ? "Зберігаю…" : "Зайняти"}
                </button>
              </form>
            ) : (
              <div className="space-y-3">
                <div className="rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
                  <div className="text-xs text-neutral-500">Поточний друк</div>
                  <div className="font-medium">{printer.job}</div>
                  {printer.eta_minutes != null && printer.eta_minutes > 0 && (
                    <div className="text-xs text-neutral-500">
                      Залишилось ≈ {printer.eta_minutes} хв
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={release}
                  disabled={busy}
                  className="w-full rounded-md bg-neutral-900 px-3 py-2 font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                >
                  {busy ? "Зберігаю…" : "Звільнити (друк завершено)"}
                </button>
              </div>
            )}

            <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <span className="mb-1 block text-xs text-neutral-500">
                Або встановити стан вручну
              </span>
              <select
                value={status}
                onChange={(e) => setManualStatus(e.target.value)}
                disabled={busy}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950"
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
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {isManual && user.role === "admin" && onDeleted && (
          <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <button
              type="button"
              onClick={async () => {
                if (!confirm(`Видалити ${printer.name}? Усі записи плану з ним теж видаляться.`))
                  return;
                try {
                  await api(`/api/printers/${printer.id}`, { method: "DELETE" });
                  onDeleted(printer.id);
                  onClose();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : "Помилка видалення");
                }
              }}
              className="w-full rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              🗑 Видалити принтер
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
