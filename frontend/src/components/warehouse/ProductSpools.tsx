"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiAll, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useUser } from "@/lib/auth-context";
import type { Filament } from "@/lib/types";
import { ReceiveSpoolsModal } from "@/components/filament/ReceiveSpoolsModal";
import { CorrectSpoolModal } from "@/components/filament/CorrectSpoolModal";
import { SpoolUsageSheet } from "@/components/filament/SpoolUsageSheet";

export function ProductSpools({ productId, version, onChanged }: {
  productId: number; version: number; onChanged: () => void;
}) {
  const t = useT();
  const user = useUser();
  const canEdit = user?.role === "admin" || user?.role === "operator";
  const [spools, setSpools] = useState<Filament[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receive, setReceive] = useState(false);
  const [correct, setCorrect] = useState<Filament | null>(null);
  const [usage, setUsage] = useState<Filament | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () => apiAll<Filament>(`/api/warehouse/products/${productId}/spools`)
      .then(rows => { if (active) { setSpools(rows); setError(null); } })
      .catch(err => { if (active) setError(err instanceof ApiError ? err.message : t("common.error")); });
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [productId, version, revision, t]);
  const refresh = useCallback(() => { setRevision(r => r + 1); onChanged(); }, [onChanged]);
  const total = (spools ?? []).reduce((n, f) => n + f.grams_remaining, 0);
  const loaded = (spools ?? []).filter(f => f.location).reduce((n, f) => n + f.grams_remaining, 0);
  const available = (spools ?? []).filter(f => f.status === "in_stock").reduce((n, f) => n + (f.available_g ?? f.grams_remaining), 0);
  return <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">{t("materialStock.title")}{spools ? ` · ${spools.length}` : ""}</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{t("materialStock.sync")}</p></div>
      {canEdit && <button className="btn btn-primary" onClick={() => setReceive(true)}>{t("materialStock.receive")}</button>}
    </div>
    {error && <p role="alert" className="text-sm text-[var(--state-error)]">{error}</p>}
    {!spools && !error && <p role="status">{t("common.loading")}</p>}
    {spools && <>
      <div className="grid grid-cols-3 gap-3">
        {[{ label: t("materialStock.total"), value: total }, { label: t("materialStock.loaded"), value: loaded }, { label: t("materialStock.available"), value: available }].map(item =>
          <div key={item.label}><p className="text-xs text-[var(--text-muted)]">{item.label}</p><p className="mt-1 font-semibold tabular-nums">{item.value.toLocaleString()} {t("materialStock.grams")}</p></div>)}
      </div>
      {spools.length === 0 && <p className="py-4 text-sm text-[var(--text-muted)]">{t("materialStock.empty")}</p>}
      <ul className="divide-y divide-[var(--border)]">{spools.map(f => <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <button className="min-w-0 text-left" onClick={() => setUsage(f)}>
          <span className="text-sm font-medium">{f.label_id ?? f.sku} · {f.material} · {f.color}</span>
          <span className="mt-1 block text-xs text-[var(--text-muted)]">{f.location ? `${f.location.printer_name} · ${f.location.slot_index === 254 ? t("materialStock.external") : `${t("materialStock.slot")} ${f.location.slot_index + 1}`}` : f.warehouse_name ?? t("materialStock.shelf")}{f.status === "retired" ? ` · ${t("materialStock.archived")}` : ""}</span>
        </button>
        <div className="flex items-center gap-3"><span className="text-sm tabular-nums">{f.grams_remaining.toLocaleString()} {t("materialStock.grams")}</span>
          {canEdit && <button className="btn btn-ghost btn-sm" onClick={() => setCorrect(f)}>{t("materialStock.correct")}</button>}
        </div>
      </li>)}</ul>
    </>}
    <Link className="text-sm text-[var(--accent)]" href={`/warehouse/movements?product_id=${productId}`}>{t("materialStock.history")} →</Link>
    {receive && <ReceiveSpoolsModal productId={productId} defaults={spools?.[0]} onClose={() => setReceive(false)} onSaved={() => { setReceive(false); refresh(); }} />}
    {correct && <CorrectSpoolModal filament={correct} onClose={() => setCorrect(null)} onSaved={refresh} />}
    {usage && <SpoolUsageSheet filament={usage} onClose={() => setUsage(null)} />}
  </section>;
}
