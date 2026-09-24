"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Filament } from "@/lib/types";
import { Modal } from "@/components/ui/Modal";

export function CorrectSpoolModal({ filament, onClose, onSaved }: {
  filament: Filament; onClose: () => void; onSaved: (filament: Filament) => void;
}) {
  const t = useT();
  const [grams, setGrams] = useState(String(filament.grams_remaining));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const valid = /^\d+$/.test(grams) && Number(grams) <= 1_000_000;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !valid) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const saved = await api<Filament>(`/api/materials/${filament.id}/remaining`, {
        method: "POST", body: JSON.stringify({ grams_remaining: Number(grams), expected_grams: filament.grams_remaining }),
      });
      toast.success(t("materialStock.saved"));
      onSaved(saved); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <Modal open onClose={() => { if (!inFlight.current) onClose(); }} title={t("materialStock.correct")} size="md"
    footer={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
      <button form="correct-spool" type="submit" className="btn btn-primary" disabled={busy || !valid || Number(grams) === filament.grams_remaining}>{busy ? t("common.saving") : t("common.save")}</button></>}>
    <form id="correct-spool" onSubmit={submit} className="space-y-4">
      <p className="text-sm">{filament.label_id} · {filament.material} · {filament.color}</p>
      <label className="block text-sm">{t("materialStock.remaining")}
        <input autoFocus type="number" inputMode="numeric" min="0" max="1000000" step="1" required className="input mt-2 w-full" value={grams} onChange={e => setGrams(e.target.value)} />
      </label>
      <p className="text-xs text-[var(--text-muted)]">{t("materialStock.correctionHint")}</p>
      {error && <p role="alert" className="text-sm text-[var(--state-error)]">{error}</p>}
    </form>
  </Modal>;
}
