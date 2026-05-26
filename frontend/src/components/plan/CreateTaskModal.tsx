"use client";

import { useRef, useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api, getToken } from "@/lib/api";
import type { PrintTask } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export function CreateTaskModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: PrintTask) => void;
}) {
  const [title, setTitle] = useState("");
  const [qty, setQty] = useState("1");
  const [filamentType, setFilamentType] = useState("");
  const [filamentColor, setFilamentColor] = useState("");
  const [etaMin, setEtaMin] = useState("");
  const [deadline, setDeadline] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle(""); setQty("1"); setFilamentType("");
    setFilamentColor(""); setEtaMin(""); setDeadline("");
    setFile(null); setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const task = await api<PrintTask>("/api/tasks/print", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          quantity: parseInt(qty) || 1,
          filament_type: filamentType || null,
          filament_color: filamentColor || null,
          estimated_minutes: etaMin ? parseInt(etaMin) : null,
          deadline: deadline || null,
        }),
      });

      // Upload file (if any) — multipart, separate request
      let final = task;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const resp = await fetch(`${API_URL}/api/tasks/print/${task.id}/file`, {
          method: "POST",
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd,
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new ApiError(resp.status, data.detail ?? "Не вдалося завантажити файл");
        }
        final = (await resp.json()) as PrintTask;
      }

      onCreated(final);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) { reset(); onClose(); } }}
      title="Нова задача на друк"
      footer={
        <>
          <button type="button" onClick={() => { reset(); onClose(); }} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
            Скасувати
          </button>
          <button type="submit" form="create-task-form" disabled={busy || !title.trim()}
            className="rounded-md bg-[var(--surface)] px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50  ">
            {busy ? "Зберігаю…" : "Додати"}
          </button>
        </>
      }
    >
      <form id="create-task-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block">Назва / деталь</span>
          <input type="text" required value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Корпус для проєкту X"
            className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-neutral-900  "
            autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Кількість</span>
            <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)}
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-neutral-900  " />
          </label>
          <label className="block">
            <span className="mb-1 block">Час друку (хв)</span>
            <input type="number" min={0} value={etaMin} onChange={e => setEtaMin(e.target.value)}
              placeholder="240"
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-neutral-900  " />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Пластик</span>
            <input type="text" value={filamentType} onChange={e => setFilamentType(e.target.value)}
              placeholder="PLA, PETG…"
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-neutral-900  " />
          </label>
          <label className="block">
            <span className="mb-1 block">Колір</span>
            <input type="text" value={filamentColor} onChange={e => setFilamentColor(e.target.value)}
              placeholder="Чорний"
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-neutral-900  " />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block">Дедлайн (опційно)</span>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
            className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-neutral-900  " />
        </label>
        <label className="block">
          <span className="mb-1 block">
            Файл друку <span className="text-[var(--text-faint)]">(.gcode, .3mf, опційно)</span>
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".gcode,.gco,.g,.3mf,.bgcode"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-[var(--text-muted)] file:mr-3 file:rounded-md file:border-0 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-xs file:text-white file:hover:bg-neutral-700  dark:file:bg-neutral-100 dark:file:text-neutral-900"
          />
          {file && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {file.name} · {(file.size / 1024).toFixed(0)} КБ
            </p>
          )}
        </label>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}
