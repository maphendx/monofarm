"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Package, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Modal } from "@/components/ui/Modal";
import { api, apiAll, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { validOutputCount } from "@/components/printers/PrintOutputModal";
import type { GcodeFile } from "@/lib/types";

interface ProductOption { id: number; sku: string; name: string }
interface WarehouseOption { id: number; name: string; type: string; is_active: boolean }
interface OutputRow { key: number; productId: string; qty: string; plate: string }

function validPlate(value: string): boolean {
  return value === "" || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1_000);
}

export function FileOutputsModal({ file, onClose, onSaved }: {
  file: GcodeFile;
  onClose: () => void;
  onSaved: (file: GcodeFile) => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<OutputRow[]>(() =>
    file.outputs?.length
      ? file.outputs.map((o, i) => ({
          key: i, productId: String(o.product_id), qty: String(o.qty_per_run),
          plate: o.plate != null ? String(o.plate) : "",
        }))
      : [{ key: 0, productId: "", qty: "1", plate: "" }],
  );
  const nextKey = useRef(Math.max(file.outputs?.length ?? 0, 1));
  const [warehouseId, setWarehouseId] = useState(
    file.output_warehouse_id != null ? String(file.output_warehouse_id) : "",
  );
  const [products, setProducts] = useState<ProductOption[] | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiAll<ProductOption>("/api/warehouse/products/options"),
      api<WarehouseOption[]>("/api/warehouse/warehouses"),
    ]).then(([catalog, locations]) => {
      if (!active) return;
      setProducts(catalog);
      setWarehouses(locations.filter(w => w.is_active && w.type === "finished"));
    }).catch(err => {
      if (active) setCatalogError(err instanceof ApiError ? err.message : t("common.error"));
    });
    return () => { active = false; };
  }, [t]);

  const filteredProducts = useMemo(() => {
    if (!products) return [];
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(p =>
      p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
  }, [products, search]);

  const countsValid = rows.every(r => validOutputCount(r.qty) && Number(r.qty) >= 1 && validPlate(r.plate));
  const positions = rows.filter(r => r.productId);
  const duplicate = new Set(positions.map(r => `${r.productId}:${r.plate}`)).size !== positions.length;
  const canSave = products !== null && countsValid && positions.length === rows.length && !duplicate && !busy && catalogError === null;

  function updateRow(key: number, field: keyof Omit<OutputRow, "key">, value: string) {
    setRows(current => current.map(row => row.key === key ? { ...row, [field]: value } : row));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<GcodeFile>(`/api/files/${file.id}/outputs`, {
        method: "PUT",
        body: JSON.stringify({
          warehouse_id: warehouseId ? Number(warehouseId) : null,
          items: rows
            .filter(r => r.productId)
            .map(r => ({
              product_id: Number(r.productId),
              qty_per_run: Number(r.qty),
              plate: r.plate ? Number(r.plate) : null,
            })),
        }),
      });
      toast.success(t("fileOutputs.saved"));
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => { if (!inFlight.current) onClose(); }} title={t("fileOutputs.title")} size="lg"
      footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button type="submit" form="file-outputs-form" className="btn btn-primary" disabled={!canSave}>
          {busy ? t("common.saving") : <><Check size={16} />{t("common.save")}</>}
        </button>
      </div>}>
      <form id="file-outputs-form" onSubmit={submit} className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <Package size={20} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0">
            <p className="break-words text-sm font-medium text-[var(--text)]">{file.original_name}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{t("fileOutputs.hint")}</p>
          </div>
        </div>

        {catalogError && <div role="alert" className="text-sm text-[var(--state-error)]">{catalogError}</div>}
        {!products && !catalogError && <p role="status" className="text-sm text-[var(--text-muted)]">{t("common.loading")}</p>}
        {products && products.length === 0 && (
          <p className="text-sm text-[var(--text-muted)]">{t("fileOutputs.catalogEmpty")}</p>
        )}

        {products && products.length > 0 && <fieldset disabled={busy} className="space-y-3">
          {products.length > 8 && <label className="block text-xs text-[var(--text-muted)]">
            {t("fileOutputs.searchProduct")}
            <input type="search" className="input mt-1 w-full" value={search}
              onChange={e => setSearch(e.target.value)} placeholder={t("fileOutputs.searchProduct")} />
          </label>}
          {rows.map((row, index) => <div key={row.key} className="space-y-3 rounded-xl border border-[var(--border)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-muted)]">{t("printOutput.item")} {index + 1}</span>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`${t("common.delete")} ${index + 1}`}
                onClick={() => setRows(current => current.filter(item => item.key !== row.key))}>
                <Trash2 size={14} />
              </button>
            </div>
            <label className="block text-xs text-[var(--text-muted)]">{t("fileOutputs.product")}
              <select className="input mt-1 w-full" value={row.productId}
                onChange={e => updateRow(row.key, "productId", e.target.value)}>
                <option value="">{t("printOutput.selectProduct")}</option>
                {row.productId && !filteredProducts.some(p => p.id === Number(row.productId)) && <option value={row.productId}>{products?.find(p => p.id === Number(row.productId))?.name ?? file.outputs?.find(o => o.product_id === Number(row.productId))?.product_name ?? `#${row.productId}`}</option>}
                {filteredProducts.map(p => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-[var(--text-muted)]">{t("fileOutputs.qtyPerRun")}
                <input type="number" inputMode="numeric" min="1" max="1000000" step="1" required
                  className="input mt-1 w-full tabular-nums" value={row.qty}
                  onChange={e => updateRow(row.key, "qty", e.target.value)} />
              </label>
              <label className="block text-xs text-[var(--text-muted)]">{t("fileOutputs.plate")}
                <input type="number" inputMode="numeric" min="1" max="1000" step="1"
                  className="input mt-1 w-full tabular-nums" value={row.plate}
                  placeholder={t("fileOutputs.plateAny")}
                  onChange={e => updateRow(row.key, "plate", e.target.value)} />
              </label>
            </div>
          </div>)}
          {duplicate && <p className="text-xs text-[var(--state-error)]">{t("fileOutputs.duplicate")}</p>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={rows.length >= 100}
            onClick={() => setRows(current => [...current, { key: nextKey.current++, productId: "", qty: "1", plate: "" }])}>
            <Plus size={14} />{t("fileOutputs.addPosition")}
          </button>

          <label className="block border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">
            {t("fileOutputs.warehouse")}
            <select className="input mt-1 w-full" value={warehouseId}
              onChange={e => setWarehouseId(e.target.value)}>
              <option value="">{t("printOutput.selectWarehouse")}</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        </fieldset>}
        {error && <p role="alert" className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}
