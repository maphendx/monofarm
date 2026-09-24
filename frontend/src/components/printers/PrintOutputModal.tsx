"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, PackageCheck, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Modal } from "@/components/ui/Modal";
import { api, apiAll, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useUser } from "@/lib/auth-context";
import type { Printer } from "@/lib/types";

export interface PrintOutputReport {
  items: { product_id: number | null; product_name: string | null; pieces_ok: number; pieces_defective: number }[];
  warehouse_id: number | null;
  defect_reason: string | null;
  recorded_at: string;
  accounting_state?: string | null;
  plan?: unknown;
}

export interface HistoryOutputTarget {
  id: number;
  file_name: string | null;
}

interface OutputPlanItem { product_id: number; product_name: string | null; planned_qty: number }
interface OutputPlan { warehouse_id: number | null; production_batch_id: number | null; items: OutputPlanItem[] }
interface OutputContext {
  history_id: number | null;
  file_name: string | null;
  output: PrintOutputReport | null;
  plan: OutputPlan | null;
  filament_g?: number | null;
  material_cost?: number | null;
}
interface ProductOption { id: number; sku: string; name: string }
interface WarehouseOption { id: number; name: string; type: string; is_active: boolean }
interface OutputRow { key: number; productId: string; good: string; defective: string; plannedQty?: number; productName?: string | null }

export function validOutputCount(value: string): boolean {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 1_000_000;
}

export function PrintOutputModal({ printer, historyEntry, onClose, onSaved }: {
  printer?: Printer;
  historyEntry?: HistoryOutputTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const user = useUser();
  const canReceive = ["starter", "pro", "farm"].includes(user.org_plan ?? "free");
  const [context, setContext] = useState<OutputContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [catalogReload, setCatalogReload] = useState(0);
  const [rows, setRows] = useState<OutputRow[]>([{ key: 0, productId: "", good: "1", defective: "0" }]);
  const nextKey = useRef(1);
  // Prefill happens once: operator edits must never be overwritten by a refetch.
  const prefilledRef = useRef(false);
  const [receiveStock, setReceiveStock] = useState(false);
  const [warehouseId, setWarehouseId] = useState("");
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Keep the exact request across an ambiguous network failure. Retrying the
  // accepted request must not increment stock or clear a subsequent print.
  const pendingRequest = useRef<string | null>(null);
  const [retryOnly, setRetryOnly] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const historyMode = !printer;
  const contextPath = printer
    ? `/api/printers/${printer.id}/print/output-context`
    : `/api/history/${historyEntry?.id}/output-context`;
  const submitPath = printer
    ? `/api/printers/${printer.id}/print/clear-bed`
    : `/api/history/${historyEntry?.id}/output`;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { previous?.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    api<OutputContext>(contextPath)
      .then(value => { if (active) { setContext(value); setContextError(null); } })
      .catch(err => { if (active) setContextError(err instanceof ApiError ? err.message : t("common.error")); });
    return () => { active = false; };
  }, [contextPath, reload, t]);

  // Prefill rows and warehouse from the run's frozen production plan.
  useEffect(() => {
    if (!context || prefilledRef.current) return;
    prefilledRef.current = true;
    const plan = context.plan;
    if (context.output?.items.length) {
      setRows(context.output.items.map((item, index) => ({ key: index, productId: item.product_id ? String(item.product_id) : "", good: String(item.pieces_ok), defective: String(item.pieces_defective), productName: item.product_name })));
      nextKey.current = context.output.items.length;
      setReason(context.output.defect_reason ?? "");
      setReceiveStock(canReceive && !plan?.production_batch_id);
      if (plan?.warehouse_id) setWarehouseId(String(plan.warehouse_id));
    } else if (plan?.items.length) {
      setRows(plan.items.map((item, index) => ({
        key: index,
        productId: String(item.product_id),
        good: String(item.planned_qty),
        defective: "0",
        plannedQty: item.planned_qty,
        productName: item.product_name,
      })));
      nextKey.current = plan.items.length;
      if (plan.warehouse_id) setWarehouseId(String(plan.warehouse_id));
    }
  }, [context, canReceive]);

  const plan = context?.plan ?? null;
  const batchMode = !!plan?.production_batch_id;
  // A configured receipt stays required even if the operator clears the warehouse.
  const planPrefill = canReceive && !!plan?.items.length;
  const receiving = canReceive && !batchMode && (receiveStock || planPrefill);

  useEffect(() => {
    if (!receiving) return;
    let active = true;
    setCatalogLoading(true);
    setCatalogError(null);
    Promise.all([
      apiAll<ProductOption>("/api/warehouse/products/options"),
      api<WarehouseOption[]>("/api/warehouse/warehouses"),
    ]).then(([catalog, locations]) => {
      if (!active) return;
      setProducts(catalog);
      setWarehouses(locations.filter(w => w.is_active && w.type === "finished"));
    }).catch(err => {
      if (active) setCatalogError(err instanceof ApiError ? err.message : t("common.error"));
    }).finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [receiving, catalogReload, t]);

  useEffect(() => {
    if (context) formRef.current?.querySelector<HTMLInputElement>('input[name="good-0"]')?.select();
  }, [context]);

  const countsValid = rows.every(row => validOutputCount(row.good) && validOutputCount(row.defective));
  const good = rows.reduce((sum, row) => sum + (validOutputCount(row.good) ? Number(row.good) : 0), 0);
  const defective = rows.reduce((sum, row) => sum + (validOutputCount(row.defective) ? Number(row.defective) : 0), 0);
  const receiptValid = !receiving || (!!warehouseId && !catalogLoading && !catalogError
    && rows.every(row => Number(row.good) === 0 || row.productId));
  const canSave = !!context && countsValid && receiptValid && !busy;

  const productName = (row: OutputRow): string =>
    products.find(p => p.id === Number(row.productId))?.name
    || row.productName
    || (row.productId ? `#${row.productId}` : "");
  const receiptRows = rows.filter(row => row.productId && Number(row.good) > 0);
  const receiptSummary = receiving && receiptRows.length
    ? receiptRows.map(row => `${productName(row)} — ${Number(row.good)} ${t("printOutput.unitsShort")}`).join(", ")
    : "";

  function updateRow(key: number, field: keyof Omit<OutputRow, "key">, value: string) {
    setRows(current => current.map(row => row.key === key ? { ...row, [field]: value, ...(field === "productId" ? { productName: null } : {}) } : row));
  }

  async function submit(event?: React.FormEvent, defer = false) {
    event?.preventDefault();
    if (inFlight.current || !context || (!defer && !retryOnly && !canSave)) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    if (!pendingRequest.current) {
      const output = JSON.stringify({
        items: rows.map(row => ({
          product_id: row.productId ? Number(row.productId) : null,
          pieces_ok: Number(row.good), pieces_defective: Number(row.defective),
        })),
        warehouse_id: receiving ? Number(warehouseId) : null,
        defect_reason: defective > 0 ? reason.trim() || null : null,
      });
      pendingRequest.current = historyMode
        ? JSON.stringify({ request_id: crypto.randomUUID(), output: JSON.parse(output) })
        : JSON.stringify({
            request_id: crypto.randomUUID(),
            history_id: context.history_id,
            file_name: context.file_name ?? printer?.job ?? null,
            output: defer ? null : JSON.parse(output),
          });
    }
    try {
      await api(submitPath, { method: "POST", body: pendingRequest.current });
      toast.success(t(historyMode ? "printOutput.savedAttach" : JSON.parse(pendingRequest.current).output ? "printOutput.saved" : "printOutput.deferred"));
      onSaved();
    } catch (err) {
      // A validation/conflict response means nothing was committed. A network
      // or server error may have occurred after commit: replay the same body.
      const ambiguous = !(err instanceof ApiError) || err.status >= 500;
      if (!ambiguous) pendingRequest.current = null;
      setRetryOnly(ambiguous);
      setError(ambiguous ? t("printOutput.retryHint") : err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("printOutput.title")}
      onClick={e => e.stopPropagation()} onKeyDown={e => {
        e.stopPropagation();
        if (e.key === "Escape" && !inFlight.current) { onClose(); return; }
        if (e.key !== "Tab") return;
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
        ) ?? []).filter(el => !el.closest("fieldset:disabled"));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }}>
      <Modal open onClose={() => { if (!inFlight.current) onClose(); }} title={t("printOutput.title")} size="xl"
        footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
          {receiptSummary && <p aria-live="polite" className="w-full pb-1 text-xs text-[var(--state-ok)]">{t("printOutput.willReceive")}: <strong>{receiptSummary}</strong></p>}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          {!historyMode && <button type="button" className="btn btn-ghost" disabled={!context || busy || retryOnly} onClick={() => void submit(undefined, true)}>{t("printOutput.defer")}</button>}
          <button type="submit" form="print-output-form" className="btn btn-primary" disabled={busy || (!retryOnly && !canSave)}>
            {busy ? t("common.saving") : <><Check size={16} />{t(retryOnly ? "printOutput.retry" : historyMode ? "printOutput.saveAttach" : "printOutput.save")}</>}
          </button>
        </div>}>
        <form id="print-output-form" ref={formRef} onSubmit={event => void submit(event)} className="space-y-5">
          <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <PackageCheck size={22} className="mt-0.5 shrink-0 text-[var(--state-ok)]" />
            <div className="min-w-0">
              <p className="font-medium text-[var(--text)]">
                {printer ? printer.name : t("printOutput.recorded")}
              </p>
              <p className="break-words text-xs text-[var(--text-muted)]">
                {context?.file_name ?? printer?.job ?? historyEntry?.file_name ?? t("printOutput.untracked")}
              </p>
              {context && (context.filament_g != null || context.material_cost != null) && (
                <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums text-[var(--text-muted)]" aria-live="polite">
                  {context.filament_g != null && (
                    <span>{t("printOutput.materialUsed")}: <strong className="font-semibold text-[var(--text)]">{Math.round(context.filament_g)} г</strong></span>
                  )}
                  {context.material_cost != null && (
                    <span>{t("printOutput.materialCost")}: <strong className="font-semibold text-[var(--text)]">≈ {context.material_cost.toFixed(2)} ₴</strong></span>
                  )}
                </p>
              )}
              <p className="mt-1 text-xs text-[var(--text-muted)]">{t(historyMode ? "printOutput.attachHint" : "printOutput.hint")}</p>
            </div>
          </div>
          {!context && !contextError && <p role="status" className="text-sm text-[var(--text-muted)]">{t("common.loading")}</p>}
          {contextError && <div role="alert" className="text-sm text-[var(--state-error)]">{contextError}
            <button type="button" className="btn btn-ghost ml-2" onClick={() => setReload(n => n + 1)}>{t("printOutput.retry")}</button>
          </div>}
          {context && <fieldset disabled={busy || retryOnly} className="space-y-4 disabled:opacity-70">
            {rows.map((row, index) => <div key={row.key} className="space-y-3 rounded-xl border border-[var(--border)] p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-muted)]">{t("printOutput.item")} {index + 1}</span>
                {!batchMode && rows.length > 1 && <button type="button" className="btn btn-ghost btn-sm" aria-label={`${t("common.delete")} ${index + 1}`}
                  onClick={() => setRows(current => current.filter(item => item.key !== row.key))}><Trash2 size={14} /></button>}
              </div>
              {!batchMode && (receiving || !row.productId) && <label className="block text-xs text-[var(--text-muted)]">{t("printOutput.product")}
                <select className="input mt-1 w-full" value={row.productId} onChange={e => updateRow(row.key, "productId", e.target.value)}>
                  <option value="">{t("printOutput.selectProduct")}</option>
                  {row.productId && !catalogLoading && !products.some(p => p.id === Number(row.productId)) && (
                    <option value={row.productId}>{row.productName ?? `#${row.productId}`}</option>
                  )}
                  {products.filter(p => !rows.some(other => other.key !== row.key && Number(other.productId) === p.id)).map(p => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
                </select>
              </label>}
              {batchMode && <p className="text-sm font-medium">{productName(row)}</p>}
              {row.plannedQty != null && <p className="text-xs text-[var(--text-muted)]">
                {t("printOutput.planned")}: <strong className="tabular-nums">{row.plannedQty}</strong>
              </p>}
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs text-[var(--text-muted)]">{t("printOutput.good")}
                  <input name={`good-${row.key}`} type="number" inputMode="numeric" min="0" max="1000000" step="1" required
                    className="input mt-1 w-full text-lg tabular-nums" value={row.good}
                    aria-invalid={!validOutputCount(row.good)} onChange={e => updateRow(row.key, "good", e.target.value)} />
                </label>
                <label className="block text-xs text-[var(--text-muted)]">{t("printOutput.defective")}
                  <input type="number" inputMode="numeric" min="0" max="1000000" step="1" required
                    className="input mt-1 w-full text-lg tabular-nums" value={row.defective}
                    aria-invalid={!validOutputCount(row.defective)} onChange={e => updateRow(row.key, "defective", e.target.value)} />
                </label>
              </div>
            </div>)}
            {!countsValid && <p className="text-xs text-[var(--state-error)]">{t("printOutput.invalidCount")}</p>}
            {!batchMode && <button type="button" className="btn btn-ghost btn-sm" disabled={rows.length >= 100}
              onClick={() => setRows(current => [...current, { key: nextKey.current++, productId: "", good: "1", defective: "0" }])}>
              <Plus size={14} />{t("printOutput.addItem")}
            </button>}
            {defective > 0 && <label className="block text-xs text-[var(--text-muted)]">{t("printOutput.reason")}
              <textarea className="input mt-1 w-full" rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
            </label>}
            {batchMode && <p className="text-sm text-[var(--text-muted)]">{t("printOutput.batchHint")}</p>}
            {canReceive && !batchMode && <div className="space-y-3 border-t border-[var(--border)] pt-4">
              {!planPrefill && <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={receiveStock} onChange={e => setReceiveStock(e.target.checked)} />
                {t("printOutput.receive")}
              </label>}
              {(receiving || planPrefill) && <>
                {catalogLoading ? <p role="status" className="text-xs text-[var(--text-muted)]">{t("common.loading")}</p> :
                  <label className="block text-xs text-[var(--text-muted)]">{t("printOutput.warehouse")}
                    <select className="input mt-1 w-full" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
                      <option value="">{t("printOutput.selectWarehouse")}</option>
                      {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </label>}
                {!catalogLoading && !catalogError && (!products.length || !warehouses.length) &&
                  <p className="text-xs text-[var(--text-muted)]">{t("printOutput.catalogEmpty")}</p>}
                {catalogError && <div role="alert" className="text-xs text-[var(--state-error)]">{catalogError}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCatalogReload(n => n + 1)}>{t("printOutput.retry")}</button>
                </div>}
                <p className="text-xs text-[var(--text-muted)]">
                  {plan?.production_batch_id ? t("printOutput.batchHint") : t("printOutput.stockHint")}
                </p>
              </>}
            </div>}
          </fieldset>}
          {context && <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-lg bg-[var(--surface)] px-3 py-2 text-sm" aria-live="polite">
            <span className="text-[var(--state-ok)]">{t("printOutput.good")}: <strong>{good}</strong></span>
            <span className="text-[var(--text-muted)]">{t("printOutput.defective")}: <strong>{defective}</strong></span>

          </div>}
          {error && <p role="alert" className="text-sm text-[var(--state-error)]">{error}</p>}
        </form>
      </Modal>
    </div>, document.body,
  );
}
