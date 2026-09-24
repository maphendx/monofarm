"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Filament, Printer } from "@/lib/types";
import { Modal } from "@/components/ui/Modal";

export function AssignSpoolModal({ printer, slotIndex, onClose, onSaved }: {
  printer: Printer; slotIndex: number; onClose: () => void; onSaved: (printer: Printer) => void;
}) {
  const t = useT();
  const [spools, setSpools] = useState<Filament[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    api<Filament[]>("/api/materials").then(rows => { if (active) setSpools(rows); })
      .catch(err => { if (active) setError(err instanceof ApiError ? err.message : t("common.error")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [t]);
  const label = slotIndex === 254 ? t("materialStock.external") : `AMS ${Math.floor(slotIndex / 4) + 1} · ${t("materialStock.slot")} ${slotIndex % 4 + 1}`;
  async function assign(id: number | null) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      await api(`/api/printers/${printer.id}/slots/${slotIndex}`, { method: "PUT", body: JSON.stringify({ filament_id: id, sync_printer: false }) });
      const updated = await api<Printer>(`/api/printers/${printer.id}`);
      onSaved(updated); onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const query = search.trim().toLowerCase();
  const visible = spools.filter(f => f.status !== "retired" && f.status !== "empty" && f.grams_remaining > 0)
    .filter(f => [f.label_id, f.material, f.color, f.brand].join(" ").toLowerCase().includes(query));
  return <Modal open title={`${t("materialStock.assignSpool")} · ${label}`} onClose={() => { if (!inFlight.current) onClose(); }}
    footer={<button className="btn btn-ghost" disabled={busy} onClick={() => assign(null)}>{t("materialStock.unassignSpool")}</button>}>
    <div className="space-y-3">
      <input autoFocus className="input w-full" aria-label={t("materialStock.searchSpools")} placeholder={t("materialStock.searchSpools")} value={search} onChange={e => setSearch(e.target.value)} />
      {error && <p role="alert" className="text-sm text-[var(--state-error)]">{error}</p>}
      {loading ? <p role="status">{t("common.loading")}</p> : visible.length === 0 ? <p className="text-sm text-[var(--text-muted)]">{t("materialStock.noAvailableSpools")}</p> :
        <div className="space-y-2">{visible.map(f => {
          const elsewhere = f.location && (f.location.printer_id !== printer.id || f.location.slot_index !== slotIndex);
          return <button key={f.id} type="button" disabled={busy || !!elsewhere} onClick={() => assign(f.id)}
            className="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] p-3 text-left hover:bg-[var(--surface-hi)] disabled:opacity-50">
            <span className="size-5 shrink-0 rounded-full border border-[var(--border-strong)]" style={{ backgroundColor: f.hex_color ?? "var(--surface-hi)" }} />
            <span className="min-w-0 flex-1 text-sm">{f.label_id} · {f.material} · {f.color}
              {elsewhere && <span className="block text-xs text-[var(--text-muted)]">{f.location?.printer_name}</span>}</span>
            <span className="shrink-0 text-sm tabular-nums">{f.grams_remaining} {t("materialStock.grams")}</span>
          </button>;
        })}</div>}
    </div>
  </Modal>;
}
