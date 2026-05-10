"use client";

import { useEffect, useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  stateEmoji,
  stateLabel,
} from "@/lib/printerLabels";
import type { Printer } from "@/lib/types";

const MANUAL_STATUSES = [
  { value: "idle", label: "Вільний 💤" },
  { value: "printing", label: "Друкує 🖨️" },
  { value: "in_maintenance", label: "Обслуговування 🔧" },
  { value: "error", label: "Помилка 🛑" },
];

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

export function PrinterDetailModal({
  printer,
  onClose,
  onUpdated,
}: {
  printer: Printer | null;
  onClose: () => void;
  onUpdated: (p: Printer) => void;
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
          {printer.flags.map((f) => (
            <span
              key={f}
              className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
            >
              {flagLabel(f)}
            </span>
          ))}
        </div>

        {printer.moonraker_url && (
          <a
            href={printer.moonraker_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            🔗 Відкрити в Mainsail
          </a>
        )}

        {isManual && user.role === "admin" && (
          <MoonrakerUrlEditor printer={printer} onUpdated={onUpdated} />
        )}

        {!isManual && (
          <p className="rounded-md bg-neutral-100 px-3 py-2 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
            Дані тягнуться з SimplyPrint автоматично.
            {printer.job && (
              <>
                <br />
                Поточний друк: <b>{printer.job}</b>
              </>
            )}
          </p>
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
      </div>
    </Modal>
  );
}
