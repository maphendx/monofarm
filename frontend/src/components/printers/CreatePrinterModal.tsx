"use client";

import { useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { ApiError, api } from "@/lib/api";
import type { Printer, PrinterKind } from "@/lib/types";

const KINDS: { value: PrinterKind; label: string }[] = [
  { value: "snapmaker_u1", label: "Snapmaker U1" },
  { value: "bambu", label: "Bambu Lab" },
  { value: "other", label: "Інший (Klipper / ручний)" },
];

const FEATURE_LABELS: Record<string, string> = {
  exclude_object:  "Exclude Object",
  input_shaper:    "Input Shaper",
  skew_correction: "Skew Correction",
  bed_mesh:        "Bed Mesh",
  multi_extruder:  "Multi-Extruder",
};

interface CheckResult {
  ok: boolean;
  error?: string;
  firmware_version?: string | null;
  hostname?: string | null;
  features?: Record<string, boolean | null>;
}

interface Discovered {
  url: string;
  name: string;
}

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

  // Moonraker discovery + verification state
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);

  function reset() {
    setName("");
    setKind("snapmaker_u1");
    setMoonrakerUrl("");
    setBambuDevId("");
    setBambuAccessCode("");
    setError(null);
    setDiscovered([]);
    setCheckResult(null);
  }

  function handleUrlChange(url: string) {
    setMoonrakerUrl(url);
    setCheckResult(null);
  }

  async function scanLan() {
    setScanning(true);
    setDiscovered([]);
    try {
      const devices = await api<Discovered[]>("/api/printers/moonraker/discovered");
      setDiscovered(devices);
    } catch {
      // ignore — agent might be slow
    } finally {
      setScanning(false);
    }
  }

  async function verify() {
    if (!moonrakerUrl.trim()) return;
    setVerifying(true);
    setCheckResult(null);
    try {
      const result = await api<CheckResult>("/api/printers/moonraker/check", {
        method: "POST",
        body: JSON.stringify({ url: moonrakerUrl.trim() }),
      });
      setCheckResult(result);
      if (result.ok && result.hostname && !name.trim()) {
        setName(result.hostname);
      }
    } catch (err) {
      setCheckResult({ ok: false, error: err instanceof ApiError ? err.message : "Помилка" });
    } finally {
      setVerifying(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let p: Printer;
      if (kind !== "bambu" && moonrakerUrl.trim()) {
        // Use claim endpoint for Moonraker — handles plan limits, accepts firmware_version
        p = await api<Printer>("/api/printers/moonraker/claim", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            kind,
            url: moonrakerUrl.trim(),
            firmware_version: checkResult?.ok ? checkResult.firmware_version : undefined,
          }),
        });
      } else {
        p = await api<Printer>("/api/printers", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            kind,
            moonraker_url: moonrakerUrl.trim() || null,
            bambu_dev_id: bambuDevId.trim() || null,
            bambu_access_code: bambuAccessCode.trim() || null,
          }),
        });
      }
      onCreated(p);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка створення");
    } finally {
      setBusy(false);
    }
  }

  const isMoonraker = kind !== "bambu";

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) { reset(); onClose(); } }}
      title="Додати принтер"
      footer={
        <>
          <button
            type="button"
            onClick={() => { reset(); onClose(); }}
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
          <span className="mb-1 block text-sm">Тип</span>
          <select
            value={kind}
            onChange={(e) => { setKind(e.target.value as PrinterKind); setCheckResult(null); }}
            className="input"
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>

        {/* ── Moonraker / Klipper ───────────────────────────────────────── */}
        {isMoonraker && (
          <>
            {/* LAN scan */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={scanLan}
                disabled={scanning}
                className="btn btn-sm text-xs disabled:opacity-50"
              >
                {scanning ? "Сканую…" : "Знайти в мережі"}
              </button>
              {discovered.length > 0 && (
                <span className="text-xs text-[var(--text-muted)]">
                  {discovered.length} знайдено
                </span>
              )}
            </div>

            {discovered.length > 0 && (
              <div className="rounded border border-[var(--border)] divide-y divide-[var(--border)] max-h-36 overflow-y-auto">
                {discovered.map((d) => (
                  <button
                    key={d.url}
                    type="button"
                    onClick={() => {
                      handleUrlChange(d.url);
                      if (!name.trim()) setName(d.name);
                    }}
                    className={[
                      "w-full flex items-center justify-between px-2 py-1.5 text-left text-xs hover:bg-[var(--surface-hi)] transition",
                      moonrakerUrl === d.url ? "bg-[var(--surface-hi)]" : "",
                    ].join(" ")}
                  >
                    <span className="font-medium truncate">{d.name}</span>
                    <span className="text-[var(--text-muted)] ml-2 shrink-0">{d.url}</span>
                  </button>
                ))}
              </div>
            )}

            {/* URL input + verify */}
            <label className="block">
              <span className="mb-1 block text-sm">Moonraker URL</span>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={moonrakerUrl}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  placeholder="http://192.168.1.10:7125"
                  className="input flex-1"
                />
                <button
                  type="button"
                  onClick={verify}
                  disabled={verifying || !moonrakerUrl.trim()}
                  className="btn btn-sm shrink-0 disabled:opacity-50"
                >
                  {verifying ? "…" : "Перевірити"}
                </button>
              </div>
            </label>

            {/* Verification result */}
            {checkResult && (
              <div className={[
                "rounded px-2.5 py-2 text-xs space-y-1.5",
                checkResult.ok
                  ? "bg-[rgba(34,197,94,.08)] border border-[rgba(34,197,94,.2)]"
                  : "bg-[rgba(239,68,68,.08)] border border-[rgba(239,68,68,.2)]",
              ].join(" ")}>
                {checkResult.ok ? (
                  <>
                    <div className="flex items-center gap-1.5 font-medium text-[var(--state-ok)]">
                      <span>✓</span>
                      <span>
                        {checkResult.hostname || "Klipper Printer"}
                        {checkResult.firmware_version && (
                          <span className="ml-1.5 font-normal text-[var(--text-muted)]">
                            {checkResult.firmware_version}
                          </span>
                        )}
                      </span>
                    </div>
                    {checkResult.features && (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(checkResult.features).map(([k, v]) => (
                          <span
                            key={k}
                            title={`${FEATURE_LABELS[k] ?? k}: ${v === null ? "невідомо" : v ? "підтримується" : "не підтримується"}`}
                            className={[
                              "rounded px-1.5 py-0.5",
                              v === true
                                ? "bg-[rgba(34,197,94,.12)] text-[var(--state-ok)]"
                                : v === false
                                  ? "bg-[rgba(239,68,68,.10)] text-[var(--state-error)]"
                                  : "bg-[var(--surface-hi)] text-[var(--text-muted)]",
                            ].join(" ")}
                          >
                            {FEATURE_LABELS[k] ?? k}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-[var(--state-error)]">✗ {checkResult.error}</span>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Bambu ─────────────────────────────────────────────────────── */}
        {kind === "bambu" && (
          <>
            <p className="text-xs text-[var(--text-muted)]">
              Bambu-принтери автоматично імпортуються з Bambu Cloud акаунту.
              Заповнюйте вручну, лише якщо потрібно додати принтер окремо.
            </p>
            <label className="block">
              <span className="mb-1 block text-sm">
                Serial / Dev ID <span className="text-[var(--text-faint)]">(опційно)</span>
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
                Access Code <span className="text-[var(--text-faint)]">(опційно)</span>
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

        <label className="block">
          <span className="mb-1 block text-sm">Назва</span>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "snapmaker_u1" ? "U1-01" : kind === "bambu" ? "P1S-01" : "Printer-01"}
            className="input"
            autoFocus
          />
        </label>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}
