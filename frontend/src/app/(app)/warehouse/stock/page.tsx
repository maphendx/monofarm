"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { matchTokens } from "@/lib/search";
import { toast } from "sonner";
import { API_URL, api, apiAll, getToken } from "@/lib/api";
import Link from "next/link";
import { CreateMovementModal, MovementType } from "@/components/warehouse/MovementModal";
import { CreateBatchModal } from "@/components/warehouse/CreateBatchModal";
import { FilterDropdown } from "@/components/warehouse/FilterDropdown";
import { Modal, useBodyScrollLock } from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";

// ── Types ─────────────────────────────────────────────────────────────────────

type CellLocation = { name: string; quantity: string };

type StockEntry = {
  id:                 number;
  product_id:         number;
  product_name:       string;
  product_sku:        string;
  product_barcode:    string | null;
  product_categories: string[];
  image_url:          string | null;
  product_unit:       string;
  warehouse_id:       number;
  warehouse_name:     string;
  locations:          CellLocation[];
  assigned_qty:       string;
  unassigned_qty:     string;
  quantity:           string;
  reserved_qty:       string;
  available:          string;
  total_stock:        string;
  full_cost:          string | null;
  min_stock:          number | null;
  desired_stock:      number | null;
  cell_limit:         number | null;
  in_production_qty:  number;
  updated_at:         string;
};

type StockStatus = "out" | "low" | "ok" | "desired" | "production";

type ProductSettings = {
  id:            number;
  name:          string;
  sku:           string;
  barcode:       string | null;
  categories:    string[];
  unit:          string;
  min_stock:     number | null;
  desired_stock: number | null;
  cell_limit:    number | null;
  image_url:     string | null;
};

function getStatus(e: StockEntry): StockStatus {
  const avail  = parseFloat(e.available);
  const inProd = e.in_production_qty > 0;
  // Товар нижче мінімуму, але по ньому вже відкрита партія — не алярмимо, показуємо «у виробництві».
  if (avail <= 0) return inProd ? "production" : "out";
  if (e.min_stock != null && avail < e.min_stock) return inProd ? "production" : "low";
  if (e.desired_stock != null && avail >= e.desired_stock) return "desired";
  return "ok";
}

const STATUS_META: Record<StockStatus, { label: string; dot: string; row: string }> = {
  out:        { label: "Немає",         dot: "bg-[var(--state-error)]",      row: "bg-[rgba(239,68,68,.04)]" },
  low:        { label: "Мало",          dot: "bg-[var(--state-warn)]",       row: "bg-[rgba(245,158,11,.04)]" },
  ok:         { label: "Норма",         dot: "bg-[var(--state-ok)]",         row: "" },
  desired:    { label: "Цільовий",      dot: "bg-[var(--accent)]",           row: "" },
  production: { label: "У виробництві", dot: "bg-[var(--state-production)]", row: "bg-[rgba(139,92,246,.06)]" },
};

// ── Column defs ───────────────────────────────────────────────────────────────

const COLS: ColDef[] = [
  { key: "name",          label: "Назва",                  required: true },
  { key: "barcode",       label: "Штрих-код" },
  { key: "history",       label: "Історія" },
  { key: "categories",    label: "Категорії" },
  { key: "warehouse",     label: "Склад" },
  { key: "location",      label: "Локація" },
  { key: "quantity",      label: "В наявності" },
  { key: "total_cost",    label: "Вартість" },
  { key: "reserved",      label: "Резерв" },
  { key: "available",     label: "Доступний залишок" },
  { key: "total_stock",   label: "Загальний залишок" },
  { key: "unit_cost",     label: "Собівартість за од." },
  { key: "min_stock",     label: "Мін ✎" },
  { key: "desired_stock", label: "Бажаний ✎" },
  { key: "cell_limit",    label: "Ліміт комірки ✎" },
  { key: "order",         label: "Замовити" },
];

// ── Inline threshold editor ───────────────────────────────────────────────────

function ThresholdCell({
  value, productId, field, onSaved,
}: {
  value:     number | null;
  productId: number;
  field:     "min_stock" | "desired_stock" | "cell_limit";
  onSaved:   (pid: number, field: string, val: number | null) => void;
}) {
  "use memo";
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value != null ? String(value) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  async function commit() {
    setEditing(false);
    const parsed = draft.trim() === "" ? null : parseInt(draft);
    if (parsed === value) return;
    try {
      await api(`/api/warehouse/products/${productId}/thresholds`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: parsed }),
      });
      onSaved(productId, field, parsed);
    } catch { /* revert silently */ }
  }

  if (editing) {
    return (
      <input
        ref={inputRef} type="number" min={0} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className="w-16 rounded border border-[var(--accent)] bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-xs outline-none text-right"
      />
    );
  }

  return (
    <button onClick={() => { setDraft(value != null ? String(value) : ""); setEditing(true); }}
      className="group inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--surface-hi)]"
      title="Клік щоб змінити">
      <span className="font-mono text-xs tabular-nums">
        {value != null ? value : <span className="text-[var(--text-faint)]">—</span>}
      </span>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
        className="opacity-0 group-hover:opacity-40 transition-opacity">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>
    </button>
  );
}

// ── StockBar ──────────────────────────────────────────────────────────────────

function StockBar({ avail, min, desired, inProduction = false }: { avail: number; min: number | null; desired: number | null; inProduction?: boolean }) {
  "use memo";
  if (!desired) return null;
  const pct   = Math.min(100, (avail / desired) * 100);
  const lowOrOut = avail <= 0 || (min != null && avail < min);
  const color = inProduction && lowOrOut ? "var(--state-production)"
    : avail <= 0                    ? "var(--state-error)"
    : min != null && avail < min    ? "var(--state-warn)"
    : avail >= desired              ? "var(--accent)"
    : "var(--state-ok)";
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-hi)]">
      <div className="h-full rounded-full transition-[width,background-color]" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function fmt(n: string | number | null): string {
  if (n == null) return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v) ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 });
}

// ── Product settings ─────────────────────────────────────────────────────────

function CategoryTagsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState("");

  function add(raw: string) {
    const tag = raw.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(input);
    }
    if (e.key === "Backspace" && !input && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 focus-within:border-[var(--border-focus)]">
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((x) => x !== tag))}
            className="text-[var(--text-faint)] hover:text-[var(--text)]"
            title="Прибрати категорію"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => add(input)}
        placeholder={value.length === 0 ? "Категорія, Enter щоб додати…" : ""}
        className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-faint)]"
      />
    </div>
  );
}

function ProductSettingsModal({
  product, onClose, onSaved,
}: {
  product: ProductSettings | null;
  onClose: () => void;
  onSaved: (p: ProductSettings) => void;
}) {
  const [name,         setName]         = useState(product?.name ?? "");
  const [sku,          setSku]          = useState(product?.sku ?? "");
  const [barcode,      setBarcode]      = useState(product?.barcode ?? "");
  const [categories,   setCategories]   = useState<string[]>(product?.categories ?? []);
  const [unit,         setUnit]         = useState(product?.unit ?? "шт");
  const [minStock,     setMinStock]     = useState(product?.min_stock != null ? String(product.min_stock) : "");
  const [desiredStock, setDesiredStock] = useState(product?.desired_stock != null ? String(product.desired_stock) : "");
  const [cellLimit,    setCellLimit]    = useState(product?.cell_limit != null ? String(product.cell_limit) : "");
  const [busy,         setBusy]         = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  useEffect(() => {
    if (!product) return;
    setName(product.name);
    setSku(product.sku);
    setBarcode(product.barcode ?? "");
    setCategories(product.categories);
    setUnit(product.unit);
    setMinStock(product.min_stock != null ? String(product.min_stock) : "");
    setDesiredStock(product.desired_stock != null ? String(product.desired_stock) : "");
    setCellLimit(product.cell_limit != null ? String(product.cell_limit) : "");
    setError(null);
  }, [product]);

  function parseOptionalInt(value: string) {
    const trimmed = value.trim();
    return trimmed === "" ? null : Math.max(0, parseInt(trimmed, 10) || 0);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!product || busy) return;
    const cleanName = name.trim();
    const cleanSku = sku.trim();
    if (!cleanName || !cleanSku) {
      setError("Назва і SKU обовʼязкові");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body = {
        name: cleanName,
        sku: cleanSku,
        barcode: barcode.trim() || null,
        categories,
        unit: unit.trim() || "шт",
        min_stock: parseOptionalInt(minStock),
        desired_stock: parseOptionalInt(desiredStock),
        cell_limit: parseOptionalInt(cellLimit),
      };
      const updated = await api<ProductSettings>(`/api/warehouse/products/${product.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  if (!product) return null;

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)]";

  return (
    <Modal
      open
      onClose={onClose}
      title="Редагувати номенклатуру"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50"
          >
            Скасувати
          </button>
          <button
            type="submit"
            form="stock-product-settings-form"
            disabled={busy}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50"
          >
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
        </>
      }
    >
      <form id="stock-product-settings-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[72px_1fr]">
          <div>
            {product.image_url ? (
              <img
                src={product.image_url}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-16 w-16 rounded-md border border-[var(--border)] bg-[var(--surface-hi)] object-cover"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-hi)] font-mono text-xs font-semibold text-[var(--text-faint)]">
                SKU
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-[var(--text-muted)]">Назва</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)]">SKU</span>
              <input value={sku} onChange={(e) => setSku(e.target.value)} className={inputCls} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)]">Штрих-код</span>
              <input value={barcode} onChange={(e) => setBarcode(e.target.value)} className={inputCls} />
            </label>
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Категорії</span>
          <CategoryTagsInput value={categories} onChange={setCategories} />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Од.</span>
            <input value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Мін</span>
            <input type="number" min={0} value={minStock} onChange={(e) => setMinStock(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Бажаний</span>
            <input type="number" min={0} value={desiredStock} onChange={(e) => setDesiredStock(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Ліміт комірки</span>
            <input type="number" min={0} value={cellLimit} onChange={(e) => setCellLimit(e.target.value)} className={inputCls} />
          </label>
        </div>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Replenishment ─────────────────────────────────────────────────────────────

type ReplenishItem = {
  product_id:       number;
  product_name:     string;
  product_sku:      string;
  unit:             string;
  available:        number;
  min_stock:        number | null;
  desired_stock:    number | null;
  qty_needed:       number;
  kind:             "batch" | "purchase";
  specification_id: number | null;
  warehouse_id:     number | null;
  warehouse_name:   string | null;
};

function buildReplenishFallback(stock: StockEntry[]): ReplenishItem[] {
  const byProduct = new Map<number, ReplenishItem>();

  stock.forEach((e) => {
    const status = getStatus(e);
    if (status !== "out" && status !== "low") return;

    const available = parseFloat(e.available);
    const target = e.desired_stock ?? e.min_stock ?? 1;
    const item: ReplenishItem = {
      product_id: e.product_id,
      product_name: e.product_name,
      product_sku: e.product_sku,
      unit: e.product_unit,
      available,
      min_stock: e.min_stock,
      desired_stock: e.desired_stock,
      qty_needed: Math.max(1, Math.ceil(target - available)),
      kind: "batch",
      specification_id: null,
      warehouse_id: e.warehouse_id,
      warehouse_name: e.warehouse_name,
    };

    const existing = byProduct.get(e.product_id);
    if (!existing || item.available < existing.available) byProduct.set(e.product_id, item);
  });

  return Array.from(byProduct.values());
}

function ReplenishModal({
  fallbackItems, onClose, onDone,
}: {
  fallbackItems: ReplenishItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  useBodyScrollLock(true);

  const [items,    setItems]    = useState<ReplenishItem[]>([]);
  const [qtys,     setQtys]     = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [result,   setResult]   = useState<{ batches: number; movements: number } | null>(null);

  useEffect(() => {
    let ignore = false;

    function applyItems(data: ReplenishItem[]) {
      if (ignore) return;
      const source = data.length > 0 ? data : fallbackItems;
      setItems(source);
      const initQtys: Record<number, string> = {};
      const initSel = new Set<number>();
      source.forEach((it) => { initQtys[it.product_id] = String(it.qty_needed); initSel.add(it.product_id); });
      setQtys(initQtys);
      setSelected(initSel);
    }

    api<ReplenishItem[]>("/api/warehouse/stock/replenish-preview")
      .then(applyItems)
      .catch(() => applyItems(fallbackItems))
      .finally(() => { if (!ignore) setLoading(false); });

    return () => { ignore = true; };
  }, [fallbackItems]);

  async function confirm() {
    setBusy(true);
    try {
      const payload = items
        .filter((it) => selected.has(it.product_id))
        .map((it) => ({
          product_id:       it.product_id,
          qty:              parseInt(qtys[it.product_id] ?? "0") || 0,
          kind:             "batch",
          warehouse_id:     it.warehouse_id,
          specification_id: it.specification_id,
          unit_cost:        null,
        }))
        .filter((it) => it.qty > 0);
      const res = await api<{ batches: number; movements: number }>("/api/warehouse/stock/replenish", { method: "POST", body: JSON.stringify({ items: payload }) });
      setResult(res);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const selectedItems = items.filter((it) => selected.has(it.product_id));
  const batchCount    = selectedItems.filter((it) => it.kind === "batch").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div>
            <h2 className="font-semibold text-[var(--text-hi)]">Відправити на виробництво</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">Товари без залишку або нижче мінімального залишку</p>
          </div>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-6 py-12 text-center text-sm text-[var(--text-faint)]">Завантаження…</div>
          ) : items.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-[var(--text-faint)]">
              Немає дефіцитних товарів, які можна відправити у виробництво
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--bg)] text-xs uppercase tracking-wider text-[var(--text-faint)]">
                <tr>
                  <th className="w-9 px-4 py-3">
                    <input type="checkbox"
                      checked={selected.size === items.length && items.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.product_id)) : new Set())}
                      className="rounded accent-[var(--accent)]" />
                  </th>
                  <th className="px-3 py-3 text-left font-medium">Товар</th>
                  <th className="px-3 py-3 text-right font-medium">Наявно</th>
                  <th className="px-3 py-3 text-right font-medium">Мін / Бажаний</th>
                  <th className="px-3 py-3 text-right font-medium">К-сть у партію</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {items.map((it) => (
                  <tr key={it.product_id} className={selected.has(it.product_id) ? "bg-[var(--accent)]/5" : "opacity-40"}>
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selected.has(it.product_id)}
                        onChange={(e) => setSelected((prev) => { const n = new Set(prev); e.target.checked ? n.add(it.product_id) : n.delete(it.product_id); return n; })}
                        className="rounded accent-[var(--accent)]" />
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium text-[var(--text-hi)]">{it.product_name}</p>
                      <p className="text-xs text-[var(--text-faint)]">{it.product_sku}{it.warehouse_name ? ` · ${it.warehouse_name}` : ""}</p>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <span className={["font-mono tabular-nums text-xs", it.available <= 0 ? "text-[var(--state-error)]" : "text-[var(--state-warn)]"].join(" ")}>
                        {it.available.toFixed(0)} {it.unit}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-[var(--text-muted)]">
                      {it.min_stock ?? "—"}{it.desired_stock ? ` / ${it.desired_stock}` : ""}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <input
                        type="number" min="1" step="1"
                        value={qtys[it.product_id] ?? ""}
                        onChange={(e) => setQtys((prev) => ({ ...prev, [it.product_id]: e.target.value }))}
                        className="w-20 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t border-[var(--border)] px-6 py-4">
            <p className="text-xs text-[var(--text-muted)]">
              {selected.size} обрано
              {batchCount > 0 && <> · {batchCount} партій</>}
            </p>
            <div className="flex gap-2">
              <button onClick={onClose} className="btn btn-ghost btn-sm">Скасувати</button>
              <button onClick={confirm} disabled={busy || selected.size === 0} className="btn btn-primary btn-sm disabled:opacity-50">
                {busy ? "Створюю…" : "Створити партії"}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-[var(--border)] bg-[rgba(34,197,94,.06)] px-6 py-3">
            <span className="text-sm text-[var(--state-ok)]">
              Створено: {result.batches} партій
            </span>
            <button onClick={onClose} className="btn btn-ghost btn-sm">Закрити</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type FilterMode = "all" | "out" | "low" | "order" | "production";

export default function StockPage() {
  const [stock,    setStock]    = useState<StockEntry[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [whFilter, setWhFilter] = useState("Всі");
  const [mode,     setMode]     = useState<FilterMode>("all");
  const [search,   setSearch]   = useState("");

  const [selectedRows,      setSelectedRows]      = useState<Set<string>>(new Set());
  const [movementOpen,      setMovementOpen]      = useState(false);
  const [movementType,      setMovementType]      = useState<MovementType>("PURCHASE_IN");
  const [movementProductId, setMovementProductId] = useState<string | null>(null);
  const [movementQuantity,  setMovementQuantity]  = useState<string | null>(null);
  const [movementLines,     setMovementLines]     = useState<{ productId: string; quantity: string }[] | undefined>(undefined);
  const [batchProductId,    setBatchProductId]    = useState<string | null>(null);
  const [colSettingsOpen,   setColSettingsOpen]   = useState(false);
  const [hideZero,          setHideZero]          = useState(false);
  const [replenishOpen,     setReplenishOpen]     = useState(false);
  const [productSettings,   setProductSettings]   = useState<ProductSettings | null>(null);

  const colVis = useColumnVisibility("stock", COLS);
  const { version } = useWarehouseStream();

  const load = useCallback(async () => {
    try { setStock(await apiAll<StockEntry>("/api/warehouse/stock")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load, version]);

  function updateThreshold(pid: number, field: string, val: number | null) {
    setStock((prev) => prev.map((e) => e.product_id === pid ? { ...e, [field]: val } : e));
  }

  function openProductSettings(e: StockEntry) {
    setProductSettings({
      id: e.product_id,
      name: e.product_name,
      sku: e.product_sku,
      barcode: e.product_barcode,
      categories: e.product_categories ?? [],
      unit: e.product_unit,
      min_stock: e.min_stock,
      desired_stock: e.desired_stock,
      cell_limit: e.cell_limit,
      image_url: e.image_url,
    });
  }

  function handleProductSettingsSaved(product: ProductSettings) {
    setStock((prev) => prev.map((e) => e.product_id === product.id ? {
      ...e,
      product_name: product.name,
      product_sku: product.sku,
      product_barcode: product.barcode,
      product_categories: product.categories,
      product_unit: product.unit,
      min_stock: product.min_stock,
      desired_stock: product.desired_stock,
      cell_limit: product.cell_limit,
      image_url: product.image_url,
    } : e));
    toast.success("Номенклатуру оновлено");
  }

  function openMovement(type: MovementType) {
    setMovementLines(undefined);
    setMovementProductId(null);
    setMovementQuantity(null);
    setMovementType(type);
    setMovementOpen(true);
  }

  function openWriteOffSelected() {
    const lines = filtered
      .filter((e) => selectedRows.has(e.id + "_" + e.warehouse_id))
      .map((e) => ({ productId: String(e.product_id), quantity: e.available }));
    if (!lines.length) return;
    setMovementLines(lines);
    setMovementProductId(null);
    setMovementQuantity(null);
    setMovementType("WRITE_OFF");
    setMovementOpen(true);
  }

  const warehouses = ["Всі", ...Array.from(new Set(stock.map((s) => s.warehouse_name)))];
  const outCount   = stock.filter((e) => getStatus(e) === "out").length;
  const lowCount   = stock.filter((e) => getStatus(e) === "low").length;
  const prodCount  = stock.filter((e) => getStatus(e) === "production").length;
  const replenishCandidates = useMemo(() => buildReplenishFallback(stock), [stock]);

  const filtered = stock.filter((e) => {
    if (hideZero && parseFloat(e.quantity) === 0) return false;
    if (whFilter !== "Всі" && e.warehouse_name !== whFilter) return false;
    const st = getStatus(e);
    if (mode === "out"        && st !== "out") return false;
    if (mode === "low"        && (st !== "low" && st !== "out")) return false;
    if (mode === "production" && st !== "production") return false;
    if (search.trim() && !matchTokens(`${e.product_name} ${e.product_sku} ${e.product_barcode ?? ""}`, search)) return false;
    return true;
  });

  const colSpan = 1 + COLS.filter((c) => colVis.isVisible(c.key)).length;

  async function importStock(file: File) {
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await api<{ updated: number; skipped: number; errors: string[] }>(
        "/api/warehouse/stock/import", { method: "POST", body: form }
      );
      const msg = `Оновлено: ${res.updated}, пропущено: ${res.skipped}`;
      if (res.errors.length) {
        toast.warning(`${msg}. Помилки: ${res.errors.slice(0, 3).join("; ")}`);
      } else {
        toast.success(msg);
      }
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Помилка імпорту");
    }
  }

  if (loading) return <PageSkeleton cols={6} />;

  return (
    <div className="space-y-4">

      {/* Top Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold">Залишки на складі</h1>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost btn-sm flex items-center gap-1.5" onClick={async () => {
            const res = await fetch(`${API_URL}/api/warehouse/stock/export?fmt=xlsx`, {
              headers: { Authorization: `Bearer ${getToken()}` },
            });
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url;
            a.download = `залишки_${new Date().toISOString().slice(0,10)}.xlsx`;
            a.click(); URL.revokeObjectURL(url);
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Експорт
          </button>
          <label className="btn btn-ghost btn-sm flex cursor-pointer items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Імпорт
            <input type="file" accept=".xlsx,.tsv,.csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { importStock(f); e.target.value = ""; } }} />
          </label>
          <button onClick={() => setReplenishOpen(true)} className="btn btn-ghost btn-sm flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M12 2v20M2 12h20"/><path d="M17 7 12 2l-5 5"/>
            </svg>
            Відправити на виробництво
            {replenishCandidates.length > 0 && (
              <span className="flex size-4 items-center justify-center rounded-full bg-[var(--state-warn)] text-[9px] font-bold text-white leading-none">
                {replenishCandidates.length}
              </span>
            )}
          </button>
          <button onClick={() => openMovement("PURCHASE_IN")} className="btn btn-primary btn-sm">+ Отримання</button>
          <button onClick={() => openMovement("SALE_OUT")} className="btn btn-primary btn-sm">+ Продаж</button>
          <button onClick={() => openMovement("DEFECT")} className="btn btn-primary btn-sm bg-[var(--state-error)] hover:bg-red-600 border-none text-white">+ Списання</button>
          <button onClick={() => openMovement("TRANSFER")} className="btn btn-primary btn-sm bg-[var(--state-warn)] hover:bg-amber-600 border-none text-white">+ Переміщення</button>
        </div>
      </div>

      {/* Summary alert strip */}
      {(outCount > 0 || lowCount > 0 || prodCount > 0) && (
        <div className="flex flex-wrap gap-2">
          {outCount > 0 && (
            <button onClick={() => setMode(mode === "out" ? "all" : "out")}
              className={["flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                mode === "out"
                  ? "border-[var(--state-error)] bg-[rgba(239,68,68,.10)] text-[var(--state-error)]"
                  : "border-[rgba(239,68,68,.3)] text-[var(--state-error)] hover:bg-[rgba(239,68,68,.06)]",
              ].join(" ")}>
              <span className="size-2 rounded-full bg-[var(--state-error)]" />
              {outCount} немає на складі
            </button>
          )}
          {lowCount > 0 && (
            <button onClick={() => setMode(mode === "low" ? "all" : "low")}
              className={["flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                mode === "low"
                  ? "border-[var(--state-warn)] bg-[rgba(245,158,11,.10)] text-[var(--state-warn)]"
                  : "border-[rgba(245,158,11,.3)] text-[var(--state-warn)] hover:bg-[rgba(245,158,11,.06)]",
              ].join(" ")}>
              <span className="size-2 rounded-full bg-[var(--state-warn)]" />
              {lowCount} нижче мінімуму
            </button>
          )}
          {prodCount > 0 && (
            <button onClick={() => setMode(mode === "production" ? "all" : "production")}
              className={["flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                mode === "production"
                  ? "border-[var(--state-production)] bg-[rgba(139,92,246,.10)] text-[var(--state-production)]"
                  : "border-[rgba(139,92,246,.3)] text-[var(--state-production)] hover:bg-[rgba(139,92,246,.06)]",
              ].join(" ")}>
              <span className="size-2 rounded-full bg-[var(--state-production)]" />
              {prodCount} у виробництві
            </button>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input type="search" placeholder="Назва або код…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-64 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]" />
        </div>
        <FilterDropdown active={(whFilter !== "Всі" ? 1 : 0) + (mode !== "all" ? 1 : 0)}>
          <div className="p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Склад</p>
            <div className="space-y-0.5">
              {warehouses.map((w) => (
                <label key={w} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                  <input
                    type="radio"
                    name="wh-filter"
                    checked={whFilter === w}
                    onChange={() => setWhFilter(w)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-sm">{w}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="border-t border-[var(--border)] p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Статус</p>
            <div className="space-y-0.5">
              {([
                ["all",        "Всі"],
                ["out",        "Немає на складі"],
                ["low",        "Нижче мінімуму"],
                ["production", "У виробництві"],
                ["order",      "Потребують замовлення"],
              ] as const).map(([val, label]) => (
                <label key={val} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                  <input
                    type="radio"
                    name="mode-filter"
                    checked={mode === val}
                    onChange={() => setMode(val)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
            </div>
          </div>
          {(whFilter !== "Всі" || mode !== "all") && (
            <div className="border-t border-[var(--border)] p-3">
              <button
                onClick={() => { setWhFilter("Всі"); setMode("all"); }}
                className="w-full rounded-md px-3 py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
              >
                Скинути фільтри
              </button>
            </div>
          )}
        </FilterDropdown>
        <button
          onClick={() => setHideZero((v) => !v)}
          className={["rounded-md border px-2.5 py-1.5 text-xs transition-colors",
            hideZero
              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
          ].join(" ")}
        >
          {hideZero ? "✓ " : ""}Сховати нульові
        </button>
        <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
        <button onClick={load}
          className="ml-auto rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--surface-hi)]">
          ↻ Оновити
        </button>
        <span className="text-xs text-[var(--text-faint)]">{filtered.length} рядків</span>
      </div>

      {/* Bulk action bar */}
      {selectedRows.size > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2.5">
          <span className="text-sm text-[var(--text-muted)]">{selectedRows.size} обрано</span>
          <button onClick={openWriteOffSelected}
            className="btn btn-sm bg-[var(--state-error)] hover:bg-red-600 border-none text-white">
            Списати вибране
          </button>
          <button onClick={() => setSelectedRows(new Set())}
            className="ml-auto text-sm text-[var(--text-faint)] hover:text-[var(--text)]">
            Скасувати вибір
          </button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-faint)]">
              <tr>
                <th className="px-3 py-3 font-medium">
                  <input type="checkbox"
                    className="rounded bg-[var(--surface-hi)] border-[var(--border)] text-[var(--accent)]"
                    checked={filtered.length > 0 && filtered.every((e) => selectedRows.has(e.id + "_" + e.warehouse_id))}
                    onChange={(ev) => {
                      setSelectedRows(ev.target.checked
                        ? new Set(filtered.map((e) => e.id + "_" + e.warehouse_id))
                        : new Set());
                    }}
                  />
                </th>
                {colVis.isVisible("name")          && <th className="px-3 py-3 font-medium">Назва</th>}
                {colVis.isVisible("barcode")        && <th className="px-3 py-3 font-medium">Код</th>}
                {colVis.isVisible("history")        && <th className="px-2 py-3 font-medium" title="Історія рухів">Іст.</th>}
                {colVis.isVisible("categories")     && <th className="px-3 py-3 font-medium">Категорії</th>}
                {colVis.isVisible("warehouse")      && <th className="px-3 py-3 font-medium">Склад</th>}
                {colVis.isVisible("location")       && <th className="px-3 py-3 font-medium">Локація</th>}
                {colVis.isVisible("quantity")       && <th className="px-3 py-3 text-right font-medium">В наявності</th>}
                {colVis.isVisible("total_cost")     && <th className="px-3 py-3 text-right font-medium">Вартість</th>}
                {colVis.isVisible("reserved")       && <th className="px-3 py-3 text-right font-medium">Резерв</th>}
                {colVis.isVisible("available")      && <th className="px-3 py-3 text-right font-medium">Доступний залишок</th>}
                {colVis.isVisible("total_stock")    && <th className="px-3 py-3 text-right font-medium">Загальний залишок</th>}
                {colVis.isVisible("unit_cost")      && <th className="px-3 py-3 text-right font-medium">Собівартість за одиницю</th>}
                {colVis.isVisible("min_stock")      && <th className="px-3 py-3 text-right font-medium text-[var(--state-warn)]">Мін ✎</th>}
                {colVis.isVisible("desired_stock")  && <th className="px-3 py-3 text-right font-medium text-[var(--state-ok)]">Бажаний ✎</th>}
                {colVis.isVisible("cell_limit")     && <th className="px-3 py-3 text-right font-medium text-[var(--accent)]">Ліміт комірки ✎</th>}
                {colVis.isVisible("order")          && <th className="px-3 py-3 text-right font-medium">Замовити</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.length === 0 ? (
                <tr><td colSpan={colSpan} className="px-4 py-12 text-center text-sm text-[var(--text-faint)]">
                  {search || mode !== "all" || whFilter !== "Всі" ? "Нічого не знайдено" : "Залишків немає"}
                </td></tr>
              ) : filtered.map((e) => {
                const avail     = parseFloat(e.available);
                const status    = getStatus(e);
                const meta      = STATUS_META[status];
                const totalCost = e.full_cost ? parseFloat(e.quantity) * parseFloat(e.full_cost) : null;

                return (
                  <tr key={e.id} className={["transition-colors hover:bg-[var(--surface-hi)]", meta.row].join(" ")}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox"
                        className="rounded bg-[var(--surface-hi)] border-[var(--border)] text-[var(--accent)]"
                        checked={selectedRows.has(e.id + "_" + e.warehouse_id)}
                        onChange={(ev) => setSelectedRows((prev) => {
                          const next = new Set(prev);
                          ev.target.checked ? next.add(e.id + "_" + e.warehouse_id) : next.delete(e.id + "_" + e.warehouse_id);
                          return next;
                        })}
                      />
                    </td>
                    {colVis.isVisible("name") && (
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => openProductSettings(e)}
                          className="group flex min-w-[240px] max-w-full items-start gap-3 rounded-lg p-1 text-left transition-colors hover:bg-[var(--surface-hi)] focus:outline-none focus:ring-2 focus:ring-[var(--border-focus)]"
                          title="Редагувати номенклатуру"
                        >
                          {e.image_url ? (
                            <img
                              src={e.image_url}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              className="h-12 w-12 shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-hi)] object-cover"
                            />
                          ) : (
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-hi)] font-mono text-[10px] font-semibold text-[var(--text-faint)]">
                              SKU
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium leading-tight text-[var(--text-hi)] underline-offset-2 group-hover:underline" title={e.product_name}>{e.product_name}</p>
                            <p className="font-mono text-xs text-[var(--text-faint)]">{e.product_sku}</p>
                            {e.in_production_qty > 0 && (
                              <span className="mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                style={{ background: "rgba(139,92,246,.10)", color: "var(--state-production)" }}
                                title="Заплановано/друкується у виробничих партіях">
                                🛠 у вир-ві {fmt(e.in_production_qty)} {e.product_unit}
                              </span>
                            )}
                            <StockBar avail={avail} min={e.min_stock} desired={e.desired_stock} inProduction={status === "production"} />
                          </div>
                        </button>
                      </td>
                    )}
                    {colVis.isVisible("barcode") && (
                      <td className="px-3 py-2.5">
                        {e.product_barcode ? (
                          <div className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs text-[var(--text-muted)]">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                              <path d="M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14" />
                            </svg>
                            #{e.product_barcode}
                          </div>
                        ) : (
                          <span className="text-[var(--text-faint)] text-xs">—</span>
                        )}
                      </td>
                    )}
                    {colVis.isVisible("history") && (
                      <td className="px-2 py-2.5 text-center">
                        <Link href={`/warehouse/movements?search=${encodeURIComponent(e.product_sku)}`}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] transition-colors"
                          title="Історія рухів">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                            <path d="M3 3v5h5" /><path d="M12 7v5l4 2" />
                          </svg>
                        </Link>
                      </td>
                    )}
                    {colVis.isVisible("categories") && (
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1 max-w-[140px]">
                          {e.product_categories && e.product_categories.length > 0 ? (
                            e.product_categories.map((cat, i) => (
                              <span key={i} className="rounded-full bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                                {cat}
                              </span>
                            ))
                          ) : (
                            <span className="text-[var(--text-faint)]">—</span>
                          )}
                        </div>
                      </td>
                    )}
                    {colVis.isVisible("warehouse") && (
                      <td className="px-3 py-2.5">
                        <span className="text-sm font-medium">{e.warehouse_name}</span>
                      </td>
                    )}
                    {colVis.isVisible("location") && (
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {e.locations && e.locations.length > 0 && (
                            e.locations.map((loc, i) => (
                              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-hi)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-mono whitespace-nowrap">
                                <span className="text-[var(--text-muted)]">{loc.name}</span>
                                <span className="font-bold">{fmt(loc.quantity)} {e.product_unit}</span>
                              </span>
                            ))
                          )}
                          {parseFloat(e.unassigned_qty) > 0 && (
                            <span title="Нерозкладено по комірках"
                              className="inline-flex items-center gap-1 rounded-full border border-[rgba(245,158,11,.4)] bg-[rgba(245,158,11,.10)] px-1.5 py-0.5 text-[10px] font-mono whitespace-nowrap text-[var(--state-warn)]">
                              нерозкладено {fmt(e.unassigned_qty)}
                            </span>
                          )}
                          {(!e.locations || e.locations.length === 0) && parseFloat(e.unassigned_qty) <= 0 && (
                            <span className="text-[var(--text-faint)]">—</span>
                          )}
                        </div>
                      </td>
                    )}
                    {colVis.isVisible("quantity") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <span className={["font-mono text-sm font-semibold tabular-nums",
                          status === "out" ? "text-[var(--state-error)]" : status === "low" ? "text-[var(--state-warn)]" : status === "production" ? "text-[var(--state-production)]" : "text-[var(--text)]",
                        ].join(" ")}>
                          {fmt(e.quantity)}
                        </span>
                        <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                      </td>
                    )}
                    {colVis.isVisible("total_cost") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap font-mono tabular-nums text-sm">
                        {totalCost != null ? fmt(totalCost) : "—"}
                      </td>
                    )}
                    {colVis.isVisible("reserved") && (
                      <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-[var(--text-faint)] whitespace-nowrap">
                        {parseFloat(e.reserved_qty) > 0 ? fmt(e.reserved_qty) : "—"}
                      </td>
                    )}
                    {colVis.isVisible("available") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <span className="font-mono text-sm font-semibold tabular-nums text-[var(--text)]">
                          {fmt(e.available)}
                        </span>
                        <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                      </td>
                    )}
                    {colVis.isVisible("total_stock") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <span className="font-mono text-sm font-semibold tabular-nums text-[var(--text-muted)]">
                          {fmt(e.total_stock)}
                        </span>
                        <span className="ml-1 text-[10px] text-[var(--text-faint)]">{e.product_unit}</span>
                      </td>
                    )}
                    {colVis.isVisible("unit_cost") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap font-mono tabular-nums text-sm">
                        {e.full_cost != null ? fmt(e.full_cost) : "—"}
                      </td>
                    )}
                    {colVis.isVisible("min_stock") && (
                      <td className="px-3 py-2.5 text-right">
                        <ThresholdCell value={e.min_stock} productId={e.product_id} field="min_stock" onSaved={updateThreshold} />
                      </td>
                    )}
                    {colVis.isVisible("desired_stock") && (
                      <td className="px-3 py-2.5 text-right">
                        <ThresholdCell value={e.desired_stock} productId={e.product_id} field="desired_stock" onSaved={updateThreshold} />
                      </td>
                    )}
                    {colVis.isVisible("cell_limit") && (
                      <td className="px-3 py-2.5 text-right">
                        <ThresholdCell value={e.cell_limit} productId={e.product_id} field="cell_limit" onSaved={updateThreshold} />
                      </td>
                    )}
                    {colVis.isVisible("order") && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => setBatchProductId(e.product_id.toString())}
                            className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-white hover:border-transparent transition-colors"
                            title="Відправити у виробництво"
                          >
                            + Партія
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-[var(--text-faint)]">
        ✎ Клікніть Мін / Бажаний / Ліміт комірки щоб редагувати прямо в таблиці
      </p>

      {movementOpen && (
        <CreateMovementModal
          key={`${movementType}-${movementProductId ?? "bulk"}-${movementLines?.length ?? 0}`}
          open
          onClose={() => { setMovementOpen(false); setMovementProductId(null); setMovementQuantity(null); setMovementLines(undefined); }}
          initialType={movementType}
          initialProductId={movementProductId ?? undefined}
          initialQuantity={movementQuantity ?? undefined}
          initialLines={movementLines}
          onCreated={() => { load(); setSelectedRows(new Set()); }}
        />
      )}

      {batchProductId !== null && (
        <CreateBatchModal
          key={batchProductId}
          open
          onClose={() => setBatchProductId(null)}
          initialProductId={batchProductId}
          onCreated={() => load()}
        />
      )}

      {productSettings && (
        <ProductSettingsModal
          product={productSettings}
          onClose={() => setProductSettings(null)}
          onSaved={handleProductSettingsSaved}
        />
      )}

      <ColumnSettingsModal
        open={colSettingsOpen}
        onClose={() => setColSettingsOpen(false)}
        cols={colVis.cols}
        hidden={colVis.hidden}
        setVisibility={colVis.setVisibility}
        orderedCols={colVis.orderedCols}
        setOrder={colVis.setOrder}
      />

      {replenishOpen && (
        <ReplenishModal
          fallbackItems={replenishCandidates}
          onClose={() => setReplenishOpen(false)}
          onDone={() => { setReplenishOpen(false); load(); }}
        />
      )}
    </div>
  );
}
