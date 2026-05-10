"use client";

import { useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import type { Printer, PrinterKind } from "@/lib/types";

const KINDS: { value: PrinterKind; label: string }[] = [
  { value: "snapmaker_u1", label: "Snapmaker U1" },
  { value: "other", label: "Інший (ручний)" },
];

export function CreatePrinterModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: Printer) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PrinterKind>("snapmaker_u1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setKind("snapmaker_u1");
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<Printer>("/api/printers", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), kind }),
      });
      onCreated(p);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка створення");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) {
          reset();
          onClose();
        }
      }}
      title="Додати принтер"
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Скасувати
          </button>
          <button
            type="submit"
            form="create-printer-form"
            disabled={busy || !name.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {busy ? "Додаю…" : "Додати"}
          </button>
        </>
      }
    >
      <form id="create-printer-form" onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm">Назва</span>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="U1-01"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm">Тип</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as PrinterKind)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </form>
    </Modal>
  );
}
