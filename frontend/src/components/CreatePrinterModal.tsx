"use client";

import { useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import type { Printer, PrinterKind } from "@/lib/types";

const KINDS: { value: PrinterKind; label: string }[] = [
  { value: "snapmaker_u1", label: "Snapmaker U1" },
  { value: "bambu", label: "Bambu Lab" },
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
  const [moonrakerUrl, setMoonrakerUrl] = useState("");
  const [bambuDevId, setBambuDevId] = useState("");
  const [bambuAccessCode, setBambuAccessCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setKind("snapmaker_u1");
    setMoonrakerUrl("");
    setBambuDevId("");
    setBambuAccessCode("");
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<Printer>("/api/printers", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          kind,
          moonraker_url: moonrakerUrl.trim() || null,
          bambu_dev_id: bambuDevId.trim() || null,
          bambu_access_code: bambuAccessCode.trim() || null,
        }),
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
        {kind !== "bambu" && (
          <label className="block">
            <span className="mb-1 block text-sm">
              Moonraker / Mainsail URL{" "}
              <span className="text-neutral-400">(опційно, для U1)</span>
            </span>
            <input
              type="url"
              value={moonrakerUrl}
              onChange={(e) => setMoonrakerUrl(e.target.value)}
              placeholder="http://192.168.31.210"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>
        )}
        {kind === "bambu" && (
          <>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Bambu-принтери автоматично імпортуються з Bambu Cloud акаунту.
              Заповнюйте вручну, лише якщо потрібно додати принтер окремо.
            </p>
            <label className="block">
              <span className="mb-1 block text-sm">
                Serial / Dev ID{" "}
                <span className="text-neutral-400">(опційно)</span>
              </span>
              <input
                type="text"
                value={bambuDevId}
                onChange={(e) => setBambuDevId(e.target.value)}
                placeholder="01P09C321100123"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm">
                Access Code{" "}
                <span className="text-neutral-400">(опційно)</span>
              </span>
              <input
                type="text"
                value={bambuAccessCode}
                onChange={(e) => setBambuAccessCode(e.target.value)}
                placeholder="12345678"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </label>
          </>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </form>
    </Modal>
  );
}
