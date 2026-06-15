"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import type { PrintTask, Printer } from "@/lib/types";

type DistributeResult = {
  sent: { task_id: number; printer_id: number; printer_name: string }[];
  skipped: { task_id: number; reason: string }[];
};

export function AutoDispatchModal({
  printers,
  onClose,
}: {
  printers: Printer[];
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<PrintTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DistributeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    api<PrintTask[]>("/api/queue")
      .then((all) => setTasks(all.filter((t) => t.status === "queued" && t.gcode_file_id != null)))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Помилка завантаження"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const idlePrinters = printers.filter(
    (p) => p.is_active && (p.state === "idle" || p.state === "operational") &&
      (p.moonraker_url || (p.kind === "bambu" && p.bambu_dev_id)),
  );

  async function dispatch() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await api<DistributeResult>("/api/queue/bulk-distribute", {
        method: "POST",
        body: JSON.stringify({ task_ids: null }),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Помилка");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  const canDispatch = !loading && tasks.length > 0 && idlePrinters.length > 0 && !result;
  const willSend = Math.min(tasks.length, idlePrinters.length);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Авто-розподіл</h2>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)]"
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {loading ? (
            <p className="py-8 text-center text-sm text-[var(--text-faint)]">Завантаження…</p>
          ) : result ? (
            <>
              {result.sent.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Запущено ({result.sent.length})</p>
                  <div className="space-y-1.5">
                    {result.sent.map((s) => {
                      const task = tasks.find((t) => t.id === s.task_id);
                      return (
                        <div key={s.task_id} className="flex items-center gap-2 rounded-lg border border-[rgba(34,197,94,.2)] bg-[rgba(34,197,94,.06)] px-3 py-2 text-xs">
                          <span className="text-[var(--state-ok)]">✓</span>
                          <span className="flex-1 truncate">{task?.title ?? `Завдання ${s.task_id}`}</span>
                          <span className="shrink-0 text-[var(--text-muted)]">→ {s.printer_name}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {result.skipped.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Пропущено ({result.skipped.length})</p>
                  <div className="space-y-1.5">
                    {result.skipped.map((s) => {
                      const task = tasks.find((t) => t.id === s.task_id);
                      return (
                        <div key={s.task_id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
                          <span className="text-[var(--text-faint)]">–</span>
                          <span className="flex-1 truncate text-[var(--text-muted)]">{task?.title ?? `Завдання ${s.task_id}`}</span>
                          <span className="shrink-0 text-[var(--text-faint)]">{s.reason}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {result.sent.length === 0 && result.skipped.length === 0 && (
                <p className="py-4 text-center text-sm text-[var(--text-faint)]">Нічого не розподілено</p>
              )}
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-2xl font-bold">{tasks.length}</p>
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">завдань у черзі</p>
                </div>
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-2xl font-bold text-[var(--state-ok)]">{idlePrinters.length}</p>
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">вільних принтерів</p>
                </div>
              </div>

              {tasks.length === 0 ? (
                <p className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-sm text-[var(--text-faint)]">
                  У черзі немає завдань з файлами для друку.
                </p>
              ) : idlePrinters.length === 0 ? (
                <p className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-sm text-[var(--text-faint)]">
                  Немає вільних принтерів.
                </p>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">
                  Система підбере файли та призначить їх вільним принтерам з урахуванням сумісності матеріалів.
                </p>
              )}

              {tasks.length > 0 && (
                <div className="space-y-1.5">
                  {tasks.slice(0, 6).map((t) => (
                    <div key={t.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                      <span className="flex-1 truncate">{t.title}</span>
                      {t.file_name && (
                        <span className="shrink-0 text-[var(--text-faint)]">
                          {t.file_name.split(".").pop()?.toUpperCase()}
                        </span>
                      )}
                    </div>
                  ))}
                  {tasks.length > 6 && (
                    <p className="text-center text-[11px] text-[var(--text-faint)]">+{tasks.length - 6} ще</p>
                  )}
                </div>
              )}
            </>
          )}

          {error && (
            <div className="rounded-lg border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] px-3 py-2 text-sm text-[var(--state-error)]">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <button onClick={onClose} className="btn btn-ghost">
            {result ? "Закрити" : "Скасувати"}
          </button>
          {!result && (
            <button
              onClick={dispatch}
              disabled={!canDispatch || busy}
              className="btn btn-primary disabled:opacity-40"
            >
              {busy ? "Розподіляю…" : `▶ Розподілити ${willSend}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
