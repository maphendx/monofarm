"use client";

import { useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import type { PrintTask } from "@/lib/types";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle(""); setQty("1"); setFilamentType("");
    setFilamentColor(""); setEtaMin(""); setDeadline(""); setError(null);
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
      onCreated(task);
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
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Скасувати
          </button>
          <button type="submit" form="create-task-form" disabled={busy || !title.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
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
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Кількість</span>
            <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
          <label className="block">
            <span className="mb-1 block">Час друку (хв)</span>
            <input type="number" min={0} value={etaMin} onChange={e => setEtaMin(e.target.value)}
              placeholder="240"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Пластик</span>
            <input type="text" value={filamentType} onChange={e => setFilamentType(e.target.value)}
              placeholder="PLA, PETG…"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
          <label className="block">
            <span className="mb-1 block">Колір</span>
            <input type="text" value={filamentColor} onChange={e => setFilamentColor(e.target.value)}
              placeholder="Чорний"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block">Дедлайн (опційно)</span>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}
