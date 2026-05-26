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
            className="btn btn-ghost"
          >
            Скасувати
          </button>
          <button
            type="submit"
            form="create-printer-form"
            disabled={busy || !name.trim()}
            className="btn btn-primary disabled:opacity-50"
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
            className="input"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm">Тип</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as PrinterKind)}
            className="input"
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
              <span className="text-[var(--text-faint)]">(опційно, для U1)</span>
            </span>
            <input
              type="url"
              value={moonrakerUrl}
              onChange={(e) => setMoonrakerUrl(e.target.value)}
              placeholder="http://192.168.31.210"
              className="input"
            />
          </label>
        )}
        {kind === "bambu" && (
          <>
            <p className="text-xs text-[var(--text-muted)] ">
              Bambu-принтери автоматично імпортуються з Bambu Cloud акаунту.
              Заповнюйте вручну, лише якщо потрібно додати принтер окремо.
            </p>
            <label className="block">
              <span className="mb-1 block text-sm">
                Serial / Dev ID{" "}
                <span className="text-[var(--text-faint)]">(опційно)</span>
              </span>
              <input
                type="text"
                value={bambuDevId}
                onChange={(e) => setBambuDevId(e.target.value)}
                placeholder="01P09C321100123"
                className="input"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm">
                Access Code{" "}
                <span className="text-[var(--text-faint)]">(опційно)</span>
              </span>
              <input
                type="text"
                value={bambuAccessCode}
                onChange={(e) => setBambuAccessCode(e.target.value)}
                placeholder="12345678"
                className="input"
              />
            </label>
          </>
        )}
        {error && (
          <p className="text-sm text-[var(--state-error)]">{error}</p>
        )}
      </form>
    </Modal>
  );
}
