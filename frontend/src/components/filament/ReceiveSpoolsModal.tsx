"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Modal } from "@/components/ui/Modal";
import { api, apiAll, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { FilamentColor } from "@/lib/types";

interface ProductOption { id: number; sku: string; name: string; unit: string }
interface WarehouseOption { id: number; name: string; type: string; is_active: boolean }
interface SpoolRow { key: number; grams: string; count: string }

/** Receive filament: one warehouse PURCHASE_IN + physical spool records. */
export function ReceiveSpoolsModal({ onClose, onSaved, productId: initialProductId, defaults }: {
  productId?: number;
  defaults?: { material: string; color: string; brand: string | null; hex_color?: string | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [products, setProducts] = useState<ProductOption[] | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [productId, setProductId] = useState(initialProductId ? String(initialProductId) : "");
  const [material, setMaterial] = useState(defaults?.material ?? "PLA");
  const [color, setColor] = useState(defaults?.color ?? "");
  const [hexColor, setHexColor] = useState(defaults?.hex_color ?? "");
  const [savedColors, setSavedColors] = useState<FilamentColor[]>([]);
  const [brand, setBrand] = useState(defaults?.brand ?? "");
  const [price, setPrice] = useState("");
  const requestId = useRef<string | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [warehouseName, setWarehouseName] = useState("");
  const [convertToGrams, setConvertToGrams] = useState(false);
  const [rows, setRows] = useState<SpoolRow[]>([{ key: 0, grams: "1000", count: "1" }]);
  const nextKey = useRef(1);
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
      const raw = locations.filter(w => w.is_active);
      setWarehouses(raw);
      const rawFirst = raw.find(w => w.type === "raw") ?? raw[0];
      if (rawFirst) setWarehouseId(String(rawFirst.id));
    }).catch(err => {
      if (active) setCatalogError(err instanceof ApiError ? err.message : t("common.error"));
    });
    return () => { active = false; };
  }, [t]);

  useEffect(() => {
    let active = true;
    api<FilamentColor[]>("/api/filament-colors")
      .then(colors => { if (active) setSavedColors(colors); })
      .catch(() => { /* The built-in palette and custom picker remain available. */ });
    return () => { active = false; };
  }, []);

  const baseColors = [
    { name: t("materialStock.colorBlack"), hex_color: "#202020" },
    { name: t("materialStock.colorWhite"), hex_color: "#FFFFFF" },
    { name: t("materialStock.colorGray"), hex_color: "#808080" },
    { name: t("materialStock.colorRed"), hex_color: "#E53935" },
    { name: t("materialStock.colorOrange"), hex_color: "#FB8C00" },
    { name: t("materialStock.colorYellow"), hex_color: "#FDD835" },
    { name: t("materialStock.colorGreen"), hex_color: "#43A047" },
    { name: t("materialStock.colorBlue"), hex_color: "#1E88E5" },
  ];
  const palette = [...savedColors, ...baseColors.filter(base => !savedColors.some(saved => saved.hex_color.toLowerCase() === base.hex_color.toLowerCase()))];

  const selectedProduct = products?.find(p => String(p.id) === productId);
  const needsUnitChange = !!selectedProduct && !["г", "g", "кг", "kg", "gram", "grams"].includes(selectedProduct.unit.trim().toLowerCase());
  const newWarehouse = warehouses.length === 0;
  const rowsValid = rows.every(r => /^\d+$/.test(r.grams) && Number(r.grams) > 0
    && /^\d+$/.test(r.count) && Number(r.count) >= 1);
  const canSave = products !== null && !!productId && (newWarehouse ? !!warehouseName.trim() : !!warehouseId) && (!needsUnitChange || convertToGrams) && rowsValid
    && rows.length > 0 && !!material.trim() && !!color.trim() && !busy && !catalogError;

  function updateRow(key: number, field: keyof Omit<SpoolRow, "key">, value: string) {
    setRows(current => current.map(row => row.key === key ? { ...row, [field]: value } : row));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      requestId.current ??= crypto.randomUUID();
      await api("/api/materials/receive", {
        method: "POST",
        body: JSON.stringify({
          product_id: Number(productId),
          request_id: requestId.current,
          material: material.trim(), color: color.trim(), hex_color: hexColor || null, brand: brand.trim() || null,
          cost_per_kg: price !== "" ? Number(price) : null,
          warehouse_id: newWarehouse ? null : Number(warehouseId),
          warehouse_name: newWarehouse ? warehouseName.trim() : null,
          convert_to_grams: needsUnitChange && convertToGrams,
          spools: rows.map(r => ({ grams: Number(r.grams), count: Number(r.count) })),
        }),
      });
      toast.success(t("spoolReceive.saved"));
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => { if (!inFlight.current) onClose(); }} title={t("spoolReceive.title")} size="md"
      footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button type="submit" form="receive-spools-form" className="btn btn-primary" disabled={!canSave}>
          {busy ? t("common.saving") : <><Check size={16} />{t("spoolReceive.save")}</>}
        </button>
      </div>}>
      <form id="receive-spools-form" onSubmit={submit} className="space-y-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs leading-snug text-[var(--text-muted)]">
          {t("materialStock.receiveHint")}
        </div>

        {catalogError && <div role="alert" className="text-sm text-[var(--state-error)]">{catalogError}</div>}
        {!products && !catalogError && <p role="status" className="text-sm text-[var(--text-muted)]">{t("common.loading")}</p>}

        {products && <>
          <label className="block text-xs text-[var(--text-muted)]">{t("spoolReceive.product")}
            <select className="input mt-1 w-full" value={productId} disabled={initialProductId !== undefined} onChange={e => { setProductId(e.target.value); setConvertToGrams(false); }}>
              <option value="">{t("spoolReceive.selectProduct")}</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.sku} · {p.name} ({p.unit})</option>)}
            </select>
          </label>
          {needsUnitChange && <div className="space-y-2 rounded-lg border border-[var(--border)] p-3 text-sm">
            <p className="text-[var(--text-muted)]">{t("materialStock.unitHint")} ({selectedProduct?.unit})</p>
            <label className="flex items-start gap-2"><input type="checkbox" checked={convertToGrams} onChange={e => setConvertToGrams(e.target.checked)} />{t("materialStock.convertUnit")}</label>
          </div>}
          {newWarehouse ? <label className="block text-xs text-[var(--text-muted)]">{t("materialStock.newWarehouse")}
            <input required className="input mt-1 w-full" maxLength={100} value={warehouseName} onChange={e => setWarehouseName(e.target.value)} placeholder={t("materialStock.warehousePlaceholder")} />
            <span className="mt-1 block">{t("materialStock.warehouseHint")}</span>
          </label> : <label className="block text-xs text-[var(--text-muted)]">{t("spoolReceive.warehouse")}
            <select className="input mt-1 w-full" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>}

          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-[var(--text-muted)]">{t("materialStock.material")}
              <input className="input mt-1 w-full" required maxLength={40} value={material} onChange={e => setMaterial(e.target.value)} />
            </label>
            <fieldset className="col-span-2 min-w-0 space-y-2">
              <legend className="mb-2 text-xs text-[var(--text-muted)]">{t("materialStock.color")}</legend>
              <div className="flex flex-wrap gap-2">
                {palette.map((item, index) => <button key={`${item.hex_color}-${index}`} type="button"
                  aria-pressed={hexColor.toLowerCase() === item.hex_color.toLowerCase() && color === item.name}
                  onClick={() => { setColor(item.name.slice(0, 40)); setHexColor(item.hex_color); }}
                  className={`flex items-center gap-1.5 rounded-lg border px-2 py-2 text-xs ${hexColor.toLowerCase() === item.hex_color.toLowerCase() && color === item.name ? "border-[var(--accent)] bg-[var(--surface-hi)]" : "border-[var(--border)]"}`}>
                  <span className="size-4 shrink-0 rounded-full border border-[var(--border-strong)]" style={{ backgroundColor: item.hex_color }} />
                  {item.name}
                </button>)}
              </div>
              <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-2">
                <input type="color" value={hexColor || "#202020"} aria-label={t("materialStock.customShade")}
                  onChange={e => { setHexColor(e.target.value); if (!color.trim()) setColor(e.target.value); }}
                  className="h-10 w-full cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-1" />
                <label className="min-w-0 text-xs text-[var(--text-muted)]">{t("materialStock.colorName")}
                  <input className="input mt-1 w-full" required maxLength={40} value={color} onChange={e => setColor(e.target.value)} />
                </label>
              </div>
            </fieldset>
            <label className="text-xs text-[var(--text-muted)]">{t("materialStock.brand")}
              <input className="input mt-1 w-full" maxLength={80} value={brand} onChange={e => setBrand(e.target.value)} />
            </label>
            <label className="text-xs text-[var(--text-muted)]">{t("materialStock.price")}
              <input className="input mt-1 w-full" type="number" min="0" step="1" value={price} onChange={e => setPrice(e.target.value)} />
            </label>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-[var(--text-muted)]"><span>{t("materialStock.weight")}</span><span>{t("materialStock.count")}</span></div>
            {rows.map((row, index) => (
              <div key={row.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_1.75rem] items-center gap-2">
                <span className="w-5 shrink-0 text-xs text-[var(--text-muted)]">{index + 1}</span>
                <input type="number" inputMode="numeric" min="1" step="1" required
                  className="input min-w-0 flex-1 tabular-nums" value={row.grams}
                  onChange={e => updateRow(row.key, "grams", e.target.value)}
                  aria-label={t("spoolReceive.grams")} />
                <input type="number" inputMode="numeric" min="1" max="1000" step="1" required
                  className="input min-w-0 tabular-nums" value={row.count}
                  onChange={e => updateRow(row.key, "count", e.target.value)}
                  aria-label={t("spoolReceive.count")} />
                <button type="button" className="btn btn-ghost btn-sm" aria-label={t("common.delete")}
                  disabled={rows.length === 1}
                  onClick={() => setRows(current => current.filter(item => item.key !== row.key))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost btn-sm"
              onClick={() => setRows(current => [...current, { key: nextKey.current++, grams: "1000", count: "1" }])}>
              <Plus size={14} />{t("spoolReceive.addRow")}
            </button>
          </div>
          <p className="text-sm tabular-nums">{t("materialStock.receiptTotal")}: {rows.reduce((sum, row) => sum + (Number(row.grams) || 0) * (Number(row.count) || 0), 0).toLocaleString()} {t("materialStock.grams")}</p>
          {!rowsValid && <p className="text-xs text-[var(--state-error)]">{t("spoolReceive.invalid")}</p>}
        </>}

        {error && <p role="alert" className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}
