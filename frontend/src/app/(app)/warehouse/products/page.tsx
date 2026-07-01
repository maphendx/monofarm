"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { matchTokens } from "@/lib/search";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { useConfirm } from "@/hooks/useConfirm";
import { BulkActionBar } from "@/components/ui/BulkActionBar";
import { AuthImage } from "@/components/ui/AuthImage";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";
import { useBodyScrollLock } from "@/components/ui/Modal";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";
import { WarehouseLabelModal, type WarehouseLabelItem } from "@/components/warehouse/WarehouseLabelModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type Product = {
  id: number; name: string; sku: string; barcode: string | null; categories: string[];
  unit: string; description: string | null; is_active: boolean;
  sale_price: string | null; cost_price: string | null;
  direct_cost: string | null; full_cost: string | null;
  min_stock: number | null; desired_stock: number | null; cell_limit: number | null;
  image_url: string | null;
};

type ProductImage = { id: number; image_url: string; is_primary: boolean; sort_order: number };
type StockEntry = { product_id: number; available: string };
type ProductCat = { id: number; name: string; color: string | null };

type Spec = {
  id: number; product_id: number; version: number; name: string; is_default: boolean;
  notes: string | null;
  components: SpecComponent[];
  operations: SpecOperation[];
};
type SpecComponent = {
  id: number; name: string; quantity: string; unit: string;
  unit_price: string | null; waste_pct: string; sort_order: number;
  material_id: number | null; product_id: number | null; product_name: string | null;
};
type SpecOperation = {
  id: number; type: string; name: string; sort_order: number;
  print_time_min: string | null; power_watts: number | null;
  labor_minutes: string | null; labor_rate_per_hour: string | null;
  explicit_cost: string | null; notes: string | null;
};
type CostBreakdown = {
  material_cost: string; electricity_cost: string;
  labor_cost: string; other_cost: string;
  total: string; print_time_min: string; margin_pct: string | null;
};
type CatalogItem = {
  id: number; name: string; sku: string; unit: string; cost_price: string | null;
};

type SortKey = "name" | "sku" | "stock" | "full_cost" | "sale_price" | "margin" | "margin_currency";
type SortDir = "asc" | "desc";

type ImportPreview = {
  headers:  string[];
  rows:     string[][];
  mapping:  Record<string, string | null>;
  summary:  { new: number; existing: number; missing: number };
};
type ActionNew      = "import" | "skip";
type ActionExisting = "update"  | "skip";
type ActionMissing  = "nothing" | "hide";
type BarcodeFilter  = "all" | "has" | "none";
type SpecImportResult = { updated: number; skipped: number; errors: { sku: string; reason: string }[] };
const PAGE_SIZES = [25, 50, 100] as const;

const COLS: ColDef[] = [
  { key: "image",      label: "Фото" },
  { key: "name",       label: "Назва",        required: true },
  { key: "sku",        label: "Артикул" },
  { key: "barcode",    label: "Штрих-код" },
  { key: "categories", label: "Категорія" },
  { key: "unit",       label: "Од." },
  { key: "stock",      label: "Залишок" },
  { key: "full_cost",  label: "Собівартість" },
  { key: "sale_price", label: "Ціна" },
  { key: "margin",     label: "Маржа %" },
  { key: "margin_currency", label: "Маржа ₴" },
];

// ── PhotoPreview ──────────────────────────────────────────────────────────────

function PhotoPreview({ src, alt, children }: { src: string; alt: string; children: React.ReactNode }) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!rect) return;
    const hide = () => setRect(null);
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", hide, { capture: true });
  }, [rect]);

  return (
    <div
      onMouseEnter={(e) => setRect(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setRect(null)}
    >
      {children}
      {rect && (
        <div
          className="pointer-events-none fixed z-[9999] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl"
          style={{
            left: rect.right + 12,
            top:  rect.top + rect.height / 2,
            transform: "translateY(-50%)",
          }}
        >
          <AuthImage src={src} alt={alt} className="size-52 object-contain" />
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(v: string | null) {
  if (!v || parseFloat(v) === 0) return "—";
  return `${parseFloat(v).toFixed(2)} ₴`;
}
function calcMargin(sale: string | null, cost: string | null): number | null {
  if (!sale || !cost || parseFloat(sale) === 0) return null;
  return ((parseFloat(sale) - parseFloat(cost)) / parseFloat(sale)) * 100;
}
function fmtMin(min: number) {
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}г ${m}хв` : `${m}хв`;
}

// ── FormRow — label-left / input-right like Ordg ───────────────────────────────

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-36 shrink-0 pt-2 text-right text-sm text-[var(--text-muted)] ">
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

const INPUT = "w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]   ";
const SEC   = "flex flex-col gap-3.5 px-6 py-4";
const HR    = "border-[var(--border)] ";

// ── CategoryInput ─────────────────────────────────────────────────────────────

function CategoryInput({
  value, onChange, existing = [],
}: {
  value: string[];
  onChange: (v: string[]) => void;
  existing?: string[];
}) {
  const [input, setInput] = useState("");
  const [open,  setOpen]  = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const suggestions = existing.filter(
    (c) => !value.includes(c) && (input.trim() === "" || c.toLowerCase().includes(input.toLowerCase())),
  );

  function add(raw: string) {
    const tag = raw.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setInput("");
  }
  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input); }
    if (e.key === "Backspace" && !input && value.length) onChange(value.slice(0, -1));
    if (e.key === "Escape") setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 focus-within:border-[var(--border-strong)]">
        {value.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded bg-[var(--surface-hi)] px-2 py-0.5 text-xs">
            {t}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== t))}
              className="text-[var(--text-faint)] hover:text-[var(--text)]">×</button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          onBlur={() => { setTimeout(() => { add(input); setOpen(false); }, 150); }}
          placeholder={value.length === 0 ? "Вибрати або ввести…" : ""}
          className="flex-1 min-w-24 bg-transparent text-sm outline-none placeholder:text-[var(--text-faint)]"
        />
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-0.5 max-h-52 w-full overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1 shadow-xl">
          {suggestions.map((c) => (
            <button
              key={c}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); add(c); }}
              className="flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-hi)]"
            >
              {c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ProductModal ──────────────────────────────────────────────────────────────

function ProductModal({
  product, prefill, existingCats = [], onClose, onSaved,
}: {
  product: Product | null;  // null = create mode
  prefill?: Partial<Product> | null;
  existingCats?: string[];
  onClose: () => void;
  onSaved: (p: Product) => void;
}) {
  useBodyScrollLock(true);

  const { confirm, dialog } = useConfirm();
  const isEdit = product !== null;
  const src = product ?? prefill;  // for field defaults

  const [name,         setName]         = useState(src?.name    ?? "");
  const [sku,          setSku]          = useState(src?.sku     ?? "");
  const [barcode,      setBarcode]      = useState(product?.barcode ?? "");
  const [cats,         setCats]         = useState<string[]>(src?.categories ?? []);
  const [unit,         setUnit]         = useState(src?.unit    ?? "шт");
  const [price,        setPrice]        = useState(src?.sale_price ? parseFloat(src.sale_price).toString() : "");
  const [desc,         setDesc]         = useState(src?.description ?? "");
  const [minStock,     setMinStock]     = useState(src?.min_stock?.toString() ?? "");
  const [desiredStock, setDesiredStock] = useState(src?.desired_stock?.toString() ?? "");
  const [cellLimit,    setCellLimit]    = useState(src?.cell_limit?.toString() ?? "");
  const [busy,      setBusy]      = useState(false);
  const [err,       setErr]       = useState<string | null>(null);
  const [images,    setImages]    = useState<ProductImage[]>([]);
  const [imgBusy,   setImgBusy]   = useState(false);
  const [dragOver,  setDragOver]  = useState(false);
  const imageRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!product) return;
    api<ProductImage[]>(`/api/warehouse/products/${product.id}/images`)
      .then(setImages).catch(() => {});
  }, [product?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshProduct() {
    if (!product) return;
    const updated = await api<Product>(`/api/warehouse/products/${product.id}`);
    onSaved(updated);
  }

  async function uploadImage(file: File) {
    if (!product) return;
    setImgBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const list = await api<ProductImage[]>(`/api/warehouse/products/${product.id}/images`, { method: "POST", body: form });
      setImages(list);
      await refreshProduct();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Помилка завантаження");
    } finally {
      setImgBusy(false);
    }
  }

  async function deleteImage(imgId: number) {
    if (!product || !await confirm({ message: "Видалити фото?", variant: "danger" })) return;
    setImgBusy(true);
    try {
      await api(`/api/warehouse/products/${product.id}/images/${imgId}`, { method: "DELETE" });
      setImages((prev) => prev.filter((i) => i.id !== imgId));
      await refreshProduct();
    } finally {
      setImgBusy(false);
    }
  }

  async function setPrimary(imgId: number) {
    if (!product) return;
    setImgBusy(true);
    try {
      const list = await api<ProductImage[]>(`/api/warehouse/products/${product.id}/images/${imgId}/set-primary`, { method: "PATCH" });
      setImages(list);
      await refreshProduct();
    } finally {
      setImgBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = {
        name: name.trim(), sku: sku.trim(), barcode: barcode.trim() || null,
        categories: cats, unit: unit.trim() || "шт",
        sale_price: price ? parseFloat(price) : null,
        description: desc.trim() || null,
        min_stock:     minStock     ? parseInt(minStock)     : null,
        desired_stock: desiredStock ? parseInt(desiredStock) : null,
        cell_limit:    cellLimit    ? parseInt(cellLimit)    : null,
      };
      const p = isEdit
        ? await api<Product>(`/api/warehouse/products/${product!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<Product>("/api/warehouse/products", { method: "POST", body: JSON.stringify(body) });
      onSaved(p);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка збереження. Перевірте поля.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl  ">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4 ">
          <h2 className="font-semibold text-[var(--text-hi)] ">
            {isEdit ? "Редагувати номенклатуру" : "Нова номенклатура"}
          </h2>
          <button onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ">
            ×
          </button>
        </div>

        {/* Body */}
        <form id="product-form" onSubmit={save} className="flex-1 overflow-y-auto">

          {/* Photo gallery — edit mode only */}
          {isEdit && (
            <>
              <div className={SEC}>
                <input
                  ref={imageRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    files.forEach((f) => uploadImage(f));
                  }}
                />

                <div
                  className={[
                    "rounded-xl border-2 border-dashed p-3 transition-colors",
                    dragOver ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)]",
                    imgBusy ? "opacity-60 pointer-events-none" : "",
                  ].join(" ")}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault(); setDragOver(false);
                    Array.from(e.dataTransfer.files).forEach((f) => uploadImage(f));
                  }}
                >
                  {/* Grid of thumbnails */}
                  <div className="flex flex-wrap gap-2">
                    {images.map((img) => (
                      <div key={img.id} className="group relative size-20 shrink-0">
                        <div className="size-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-hi)]">
                          <AuthImage src={img.image_url} alt="" className="size-full object-cover" />
                        </div>
                        {/* Primary badge */}
                        {img.is_primary && (
                          <span className="absolute left-1 top-1 rounded bg-[var(--accent)] px-1 py-0.5 text-[9px] font-bold leading-none text-white">
                            ★
                          </span>
                        )}
                        {/* Hover actions */}
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-lg bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                          {!img.is_primary && (
                            <button
                              type="button"
                              onClick={() => setPrimary(img.id)}
                              title="Зробити головним"
                              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white bg-[var(--accent)]/80 hover:bg-[var(--accent)]"
                            >
                              ★ головне
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => deleteImage(img.id)}
                            title="Видалити"
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white bg-[rgba(239,68,68,.7)] hover:bg-[var(--state-error)]"
                          >
                            × видалити
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* Upload tile */}
                    <button
                      type="button"
                      onClick={() => imageRef.current?.click()}
                      className="flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-[var(--border)] text-[var(--text-faint)] hover:border-[var(--border-strong)] hover:text-[var(--text-muted)] transition-colors"
                    >
                      {imgBusy
                        ? <span className="text-xs">…</span>
                        : <>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                              <path d="M12 5v14M5 12h14"/>
                            </svg>
                            <span className="text-[10px]">фото</span>
                          </>
                      }
                    </button>
                  </div>

                  {images.length === 0 && !imgBusy && (
                    <p className="mt-2 text-center text-xs text-[var(--text-faint)]">
                      Перетягніть або клікніть «+» щоб додати фото
                    </p>
                  )}
                  <p className="mt-1.5 text-[10px] text-[var(--text-faint)]">JPEG, PNG або WebP · макс. 8 МБ · можна кілька</p>
                </div>
              </div>
              <hr className={HR} />
            </>
          )}

          {/* Section 1: identification */}
          <div className={SEC}>
            <FormRow label="Назва">
              <input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
                className={INPUT} />
            </FormRow>
            <FormRow label="SKU">
              <input required value={sku} onChange={(e) => setSku(e.target.value)}
                className={INPUT} />
            </FormRow>
            <FormRow label="Штрих-код">
              <input value={barcode} onChange={(e) => setBarcode(e.target.value)}
                placeholder="EAN-13, QR або будь-який"
                className={INPUT} />
            </FormRow>
            <FormRow label="Категорії">
              <CategoryInput value={cats} onChange={setCats} existing={existingCats} />
            </FormRow>
          </div>

          <hr className={HR} />

          {/* Section 2: pricing */}
          <div className={SEC}>
            <FormRow label="Ціна роздрібна">
              <div className="relative">
                <input type="number" step="0.01" min="0" value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className={`${INPUT} pr-6`} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--text-faint)]">₴</span>
              </div>
            </FormRow>
            {isEdit && product!.cost_price && (
              <FormRow label="Сер. ціна">
                <div className="flex items-center gap-2 py-2 text-sm text-[var(--text-muted)]">
                  <span className="tabular-nums">{parseFloat(product!.cost_price).toFixed(2)} ₴</span>
                  <span className="text-xs text-[var(--text-faint)]">(середньозважена з рухів/імпорту)</span>
                </div>
              </FormRow>
            )}
            {isEdit && product!.full_cost && (
              <FormRow label="Собівартість">
                <div className="flex items-center gap-2 py-2 text-sm text-[var(--text-muted)]">
                  <span className="tabular-nums">{parseFloat(product!.full_cost).toFixed(2)} ₴</span>
                  <span className="text-xs text-[var(--text-faint)]">(розраховується зі специфікації)</span>
                </div>
              </FormRow>
            )}
          </div>

          <hr className={HR} />

          {/* Section 3: unit */}
          <div className={SEC}>
            <FormRow label="Одиниця">
              <select value={unit} onChange={(e) => setUnit(e.target.value)}
                className={`${INPUT} cursor-pointer`}>
                {["шт", "г", "кг", "м", "см", "мм", "л", "мл", "пара"].map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
                {!["шт","г","кг","м","см","мм","л","мл","пара"].includes(unit) && (
                  <option value={unit}>{unit}</option>
                )}
              </select>
            </FormRow>
          </div>

          <hr className={HR} />

          {/* Section 4: stock thresholds */}
          <div className={SEC}>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-faint)]">Управління запасами</p>
            <FormRow label="Мін. залишок">
              <input type="number" min="0" step="1" value={minStock}
                onChange={(e) => setMinStock(e.target.value)}
                placeholder="сигнал поповнення"
                className={INPUT} />
            </FormRow>
            <FormRow label="Бажаний залишок">
              <input type="number" min="0" step="1" value={desiredStock}
                onChange={(e) => setDesiredStock(e.target.value)}
                placeholder="цільовий рівень"
                className={INPUT} />
            </FormRow>
            <FormRow label="Ліміт комірки">
              <input type="number" min="1" step="1" value={cellLimit}
                onChange={(e) => setCellLimit(e.target.value)}
                placeholder="шт / комірка"
                className={INPUT} />
            </FormRow>
          </div>

          <hr className={HR} />

          {/* Section 5: description */}
          <div className={SEC}>
            <FormRow label="Опис">
              <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)}
                className={`${INPUT} resize-none`} />
            </FormRow>
          </div>

          {err && <p className="px-6 pb-4 text-sm text-[var(--state-error)]">{err}</p>}
        </form>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4 ">
          <button type="button" onClick={onClose} disabled={busy}
            className="btn btn-ghost">
            Скасувати
          </button>
          <button type="submit" form="product-form" disabled={busy || !name.trim() || !sku.trim()}
            className="btn btn-primary disabled:opacity-50">
            {busy ? "Зберігаю…" : isEdit ? "Змінити" : "Додати"}
          </button>
        </div>
      </div>
      {dialog}
    </div>
  );
}

// ── SpecModal ─────────────────────────────────────────────────────────────────

const OP_TYPE_LABELS: Record<string, string> = { print: "Друк", manual: "Ручна", postprocess: "Постобробка" };

function SpecModal({ product, onClose }: { product: Product; onClose: () => void }) {
  useBodyScrollLock(true);

  const [spec,     setSpec]     = useState<Spec | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [cost,     setCost]     = useState<CostBreakdown | null>(null);
  const [costBusy, setCostBusy] = useState(false);

  // Add component form state
  const [addComp, setAddComp] = useState(false);
  const [cName,   setCName]   = useState("");
  const [cQty,    setCQty]    = useState("");
  const [cUnit,   setCUnit]   = useState("г");
  const [cPrice,  setCPrice]  = useState("");
  const [cWaste,  setCWaste]  = useState("0");
  const [cProductId, setCProductId] = useState<number | null>(null);
  const [catalog,    setCatalog]    = useState<CatalogItem[]>([]);
  const [cSearch,    setCSearch]    = useState("");
  const [cDropOpen,  setCDropOpen]  = useState(false);
  const [cBusy,   setCBusy]   = useState(false);

  // Add operation form state
  const [addOp,   setAddOp]   = useState(false);
  const [oType,   setOType]   = useState<"print"|"manual"|"postprocess">("print");
  const [oName,   setOName]   = useState("Друк");
  const [oMin,    setOMin]    = useState("");
  const [oLabMin, setOLabMin] = useState("");
  const [oExp,    setOExp]    = useState("");
  const [oBusy,   setOBusy]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const specs = await api<Spec[]>(`/api/warehouse/products/${product.id}/specs`);
      const def   = specs.find((s) => s.is_default) ?? specs[0] ?? null;
      if (!def) {
        // Auto-create default spec
        const created = await api<Spec>(`/api/warehouse/products/${product.id}/specs`, {
          method: "POST",
          body: JSON.stringify({ product_id: product.id, name: "Основна" }),
        });
        setSpec(created);
      } else {
        setSpec(def);
      }
    } finally {
      setLoading(false);
    }
  }, [product.id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (addComp && catalog.length === 0) {
      api<CatalogItem[]>("/api/warehouse/products/options").then(setCatalog).catch(() => {});
    }
    if (!addComp) { setCSearch(""); setCDropOpen(false); }
  }, [addComp, catalog.length]);

  function pickCatalog(item: CatalogItem) {
    setCName(item.name);
    setCProductId(item.id);
    setCUnit(item.unit || "г");
    setCPrice(item.cost_price ? parseFloat(item.cost_price).toFixed(4) : "");
    setCSearch(item.name);
    setCDropOpen(false);
  }

  async function computeCost() {
    if (!spec) return;
    setCostBusy(true);
    try {
      const c = await api<CostBreakdown>(`/api/warehouse/products/${product.id}/cost`);
      setCost(c);
    } finally { setCostBusy(false); }
  }

  async function deleteComponent(compId: number) {
    if (!spec) return;
    await api(`/api/warehouse/specs/${spec.id}/components/${compId}`, { method: "DELETE" });
    setSpec((s) => s ? { ...s, components: s.components.filter((c) => c.id !== compId) } : s);
    setCost(null);
  }

  async function deleteOperation(opId: number) {
    if (!spec) return;
    await api(`/api/warehouse/specs/${spec.id}/operations/${opId}`, { method: "DELETE" });
    setSpec((s) => s ? { ...s, operations: s.operations.filter((o) => o.id !== opId) } : s);
    setCost(null);
  }

  async function submitComponent(e: React.FormEvent) {
    e.preventDefault();
    if (!spec) return;
    setCBusy(true);
    try {
      const updated = await api<Spec>(`/api/warehouse/specs/${spec.id}/components`, {
        method: "POST",
        body: JSON.stringify({
          name: cName.trim(), quantity: parseFloat(cQty), unit: cUnit.trim() || "г",
          product_id: cProductId,
          unit_price: cPrice ? parseFloat(cPrice) : null,
          waste_pct: parseFloat(cWaste) || 0, sort_order: spec.components.length,
        }),
      });
      setSpec(updated);
      setCName(""); setCProductId(null); setCQty(""); setCUnit("г"); setCPrice(""); setCWaste("0"); setCSearch("");
      setAddComp(false);
      setCost(null);
    } finally { setCBusy(false); }
  }

  async function submitOperation(e: React.FormEvent) {
    e.preventDefault();
    if (!spec) return;
    setOBusy(true);
    try {
      const updated = await api<Spec>(`/api/warehouse/specs/${spec.id}/operations`, {
        method: "POST",
        body: JSON.stringify({
          type: oType, name: oName.trim(),
          print_time_min: oType === "print" && oMin  ? parseFloat(oMin)    : null,
          labor_minutes:  oType !== "print" && oLabMin ? parseFloat(oLabMin) : null,
          explicit_cost:  oExp ? parseFloat(oExp) : null,
          sort_order: spec.operations.length,
        }),
      });
      setSpec(updated);
      setOName("Друк"); setOMin(""); setOLabMin(""); setOExp("");
      setAddOp(false);
      setCost(null);
    } finally { setOBusy(false); }
  }

  const totalCost = cost ? parseFloat(cost.total) : null;
  const catalogHits = cDropOpen && cSearch.trim().length > 0
    ? (() => {
        return catalog.filter((c) => matchTokens(`${c.name} ${c.sku}`, cSearch)).slice(0, 8);
      })()
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl  ">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4 ">
          <div>
            <h2 className="font-semibold text-[var(--text-hi)] ">Специфікація</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{product.name} · {product.sku}</p>
          </div>
          <button onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-6 py-10 text-center text-sm text-[var(--text-faint)]">Завантаження…</div>
          ) : !spec ? null : (
            <div className="space-y-0 divide-y divide-[var(--border)]">

              {/* ── Materials ── */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Матеріали</p>
                  <button onClick={() => setAddComp((v) => !v)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] ">
                    <span className="text-base leading-none">+</span> Додати
                  </button>
                </div>

                {spec.components.length === 0 && !addComp ? (
                  <p className="text-sm text-[var(--text-faint)]">Матеріалів ще немає</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                    <table className="min-w-[440px] w-full text-sm">
                      <thead className="bg-[var(--bg)] text-xs text-[var(--text-faint)] ">
                        <tr>
                          <th className="px-4 py-2.5 text-left font-medium">Матеріал</th>
                          <th className="px-3 py-2.5 text-right font-medium">К-сть</th>
                          <th className="px-3 py-2.5 text-right font-medium">Од.</th>
                          <th className="px-3 py-2.5 text-right font-medium">Ціна/од. ₴</th>
                          <th className="px-3 py-2.5 text-right font-medium">Відходи %</th>
                          <th className="w-8 px-2 py-2.5" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {spec.components.map((c) => (
                          <tr key={c.id} className="group">
                            <td className="px-4 py-2.5">
                              <div className="flex flex-col gap-1">
                                <span>{c.product_name ?? c.name}</span>
                                <span className="w-fit rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]">
                                  номенклатура
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{parseFloat(c.quantity).toFixed(3)}</td>
                            <td className="px-3 py-2.5 text-right text-[var(--text-muted)]">{c.unit}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-muted)]">{c.unit_price ? parseFloat(c.unit_price).toFixed(4) : "—"}</td>
                            <td className="px-3 py-2.5 text-right text-[var(--text-faint)]">{parseFloat(c.waste_pct) > 0 ? `${c.waste_pct}%` : "—"}</td>
                            <td className="px-2 py-2.5">
                              <button onClick={() => deleteComponent(c.id)}
                                className="opacity-0 group-hover:opacity-100 flex size-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]  transition-opacity">
                                −
                              </button>
                            </td>
                          </tr>
                        ))}

                        {/* Add component form row */}
                        {addComp && (
                          <tr className="bg-[var(--bg)] ">
                            <td className="relative px-4 py-2">
                              <input
                                autoFocus
                                value={cSearch}
                                onChange={(e) => {
                                  setCSearch(e.target.value);
                                  setCName(e.target.value);
                                  setCProductId(null);
                                  setCDropOpen(true);
                                }}
                                onFocus={() => setCDropOpen(true)}
                                onBlur={() => setTimeout(() => setCDropOpen(false), 150)}
                                placeholder="Назва або SKU…"
                                className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none focus:border-[var(--border-strong)]  "
                              />
                              {catalogHits.length > 0 && (
                                <div className="absolute left-0 top-full z-30 mt-0.5 w-72 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1 shadow-xl">
                                  {catalogHits.map((item) => (
                                    <button
                                      key={item.id}
                                      type="button"
                                      onMouseDown={() => pickCatalog(item)}
                                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-hi)]"
                                    >
                                      <span className="flex-1 truncate">{item.name}</span>
                                      <span className="shrink-0 font-mono text-[10px] text-[var(--text-faint)]">{item.sku}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" step="0.001" min="0" value={cQty} onChange={(e) => setCQty(e.target.value)}
                                placeholder="0"
                                className="w-20 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-3 py-2">
                              <input value={cUnit} onChange={(e) => setCUnit(e.target.value)}
                                className="w-12 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" step="0.0001" min="0" value={cPrice} onChange={(e) => setCPrice(e.target.value)}
                                placeholder="—"
                                className="w-24 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" step="0.1" min="0" max="100" value={cWaste} onChange={(e) => setCWaste(e.target.value)}
                                className="w-16 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right text-sm outline-none focus:border-[var(--border-strong)]  " />
                            </td>
                            <td className="px-2 py-2">
                              <form onSubmit={submitComponent} className="flex gap-1">
                                <button type="submit" disabled={cBusy || !cName.trim() || !cQty}
                                  className="flex size-6 items-center justify-center rounded bg-[rgba(34,197,94,.08)]0 text-white hover:bg-[var(--state-ok)] disabled:opacity-40 text-sm">
                                  ✓
                                </button>
                              </form>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ── Operations ── */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Операції</p>
                  <button onClick={() => setAddOp((v) => !v)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] ">
                    <span className="text-base leading-none">+</span> Додати
                  </button>
                </div>

                <div className="space-y-2">
                  {spec.operations.map((op) => (
                    <div key={op.id}
                      className="group flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3.5  ">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-xs text-[var(--text-muted)] ">
                            {OP_TYPE_LABELS[op.type] ?? op.type}
                          </span>
                          <span className="font-medium text-sm">{op.name}</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--text-faint)]">
                          {op.print_time_min && <span>⏱ {fmtMin(parseFloat(op.print_time_min))}</span>}
                          {op.labor_minutes  && <span>👷 {op.labor_minutes} хв</span>}
                          {op.explicit_cost  && <span>₴ {parseFloat(op.explicit_cost).toFixed(2)}</span>}
                          {op.notes          && <span className="italic">{op.notes}</span>}
                        </div>
                      </div>
                      <button onClick={() => deleteOperation(op.id)}
                        className="opacity-0 group-hover:opacity-100 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]  transition-opacity">
                        −
                      </button>
                    </div>
                  ))}

                  {spec.operations.length === 0 && !addOp && (
                    <p className="text-sm text-[var(--text-faint)]">Операцій ще немає</p>
                  )}

                  {/* Add operation form */}
                  {addOp && (
                    <form onSubmit={submitOperation}
                      className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 space-y-3  ">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Тип</label>
                          <select value={oType} onChange={(e) => {
                            const t = e.target.value as typeof oType;
                            setOType(t);
                            setOName(OP_TYPE_LABELS[t] ?? "");
                          }} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm  ">
                            <option value="print">Друк</option>
                            <option value="manual">Ручна</option>
                            <option value="postprocess">Постобробка</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Назва</label>
                          <input required value={oName} onChange={(e) => setOName(e.target.value)}
                            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  " />
                        </div>
                        {oType === "print" ? (
                          <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">Час друку (хв)</label>
                            <input type="number" step="0.1" min="0" value={oMin} onChange={(e) => setOMin(e.target.value)}
                              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  " />
                          </div>
                        ) : (
                          <div>
                            <label className="mb-1 block text-xs text-[var(--text-muted)]">Трудозатрати (хв)</label>
                            <input type="number" step="0.1" min="0" value={oLabMin} onChange={(e) => setOLabMin(e.target.value)}
                              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  " />
                          </div>
                        )}
                        <div>
                          <label className="mb-1 block text-xs text-[var(--text-muted)]">Додаткові витрати ₴</label>
                          <input type="number" step="0.01" min="0" value={oExp} onChange={(e) => setOExp(e.target.value)}
                            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  " />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setAddOp(false)}
                          className="btn btn-ghost">
                          Скасувати
                        </button>
                        <button type="submit" disabled={oBusy || !oName.trim()}
                          className="btn btn-primary disabled:opacity-50">
                          {oBusy ? "Зберігаю…" : "Додати"}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>

              {/* ── Cost ── */}
              <div className="px-6 py-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Собівартість</p>
                  <button onClick={computeCost} disabled={costBusy}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50 ">
                    ↻ {costBusy ? "Рахую…" : "Розрахувати"}
                  </button>
                </div>

                {cost ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: "Матеріали",    value: cost.material_cost },
                      { label: "Електрика",    value: cost.electricity_cost },
                      { label: "Праця",        value: cost.labor_cost },
                      { label: "Інше",         value: cost.other_cost },
                    ].map((row) => (
                      <div key={row.label} className="rounded-lg border border-[var(--border)] p-3 ">
                        <p className="text-xs text-[var(--text-faint)]">{row.label}</p>
                        <p className="mt-0.5 font-mono text-sm font-medium tabular-nums">
                          {parseFloat(row.value).toFixed(2)} ₴
                        </p>
                      </div>
                    ))}
                    <div className="col-span-2 sm:col-span-4 flex items-center justify-between rounded-lg border border-[var(--border-strong)] bg-[var(--accent)] px-4 py-3 text-white   ">
                      <span className="text-sm font-medium">Загалом / шт</span>
                      <span className="font-mono text-lg font-bold tabular-nums">
                        {totalCost?.toFixed(2)} ₴
                        {product.sale_price && totalCost && (
                          <span className="ml-3 text-sm font-normal opacity-70">
                            маржа {(((parseFloat(product.sale_price) - totalCost) / parseFloat(product.sale_price)) * 100).toFixed(0)}%
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-faint)]">
                    Натисни «↻ Розрахувати» щоб побачити розбивку собівартості
                  </p>
                )}
              </div>

            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end border-t border-[var(--border)] px-6 py-4 ">
          <button onClick={onClose}
            className="btn btn-primary">
            Закрити
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

function SortIndicator({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <span className="ml-1 text-[var(--text-muted)] ">↕</span>;
  return <span className="ml-1 text-[var(--accent)]">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

function Th({ col, sortKey, sortDir, onSort, children, className = "" }: {
  col: SortKey; sortKey: SortKey; sortDir: SortDir;
  onSort: (c: SortKey) => void; children: React.ReactNode; className?: string;
}) {
  return (
    <th onClick={() => onSort(col)}
      className={`cursor-pointer select-none px-4 py-3 font-medium hover:text-[var(--text)]  ${className}`}>
      {children}<SortIndicator col={col} sortKey={sortKey} sortDir={sortDir} />
    </th>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

// ── Import preview helpers ────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  name: "Назва", barcode: "Штрих-код", unit: "Одиниця",
  sale_price: "Роздрібна ціна", cost_price: "Сер. ціна",
  description: "Опис", categories: "Категорії",
};

const FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: "",            label: "Не імпортувати" },
  { value: "name",        label: "Назва виробу" },
  { value: "categories",  label: "Категорії" },
  { value: "sku",         label: "Артикул" },
  { value: "barcode",     label: "Штрих-код" },
  { value: "unit",        label: "Одиниця виміру" },
  { value: "cost_price",  label: "Середньозважена ціна" },
  { value: "sale_price",  label: "Роздрібна ціна" },
  { value: "description", label: "Опис" },
];

function ImportPreviewModal({
  preview, filename,
  colMapping, onColMappingChange,
  actionNew, setActionNew,
  actionExisting, setActionExisting,
  actionMissing, setActionMissing,
  onImport, onLoadOther, onClose, busy,
}: {
  preview: ImportPreview;
  filename: string;
  colMapping: Record<number, string>;
  onColMappingChange: (idx: number, field: string) => void;
  actionNew: ActionNew; setActionNew: (v: ActionNew) => void;
  actionExisting: ActionExisting; setActionExisting: (v: ActionExisting) => void;
  actionMissing: ActionMissing; setActionMissing: (v: ActionMissing) => void;
  onImport: () => void;
  onLoadOther: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  useBodyScrollLock(true);

  const { summary } = preview;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex w-full max-w-[1200px] max-h-[92vh] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">

        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-6 py-3.5">
          <h2 className="flex-1 text-base font-semibold">Попередній перегляд імпорту</h2>
          <button onClick={onLoadOther} disabled={busy} className="btn btn-ghost btn-sm">↑ Інший файл</button>
          <button onClick={onClose} disabled={busy} className="btn btn-ghost btn-sm">Скасувати</button>
          <button onClick={onImport} disabled={busy} className="btn btn-primary btn-sm disabled:opacity-50">
            {busy ? "Імпортуємо…" : "Імпортувати"}
          </button>
        </div>

        {/* File info */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-6 py-2 text-xs">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-[var(--text-faint)]">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <span className="font-mono text-[var(--text)]">{filename}</span>
          <span className="text-[var(--border-strong)]">·</span>
          <span className="text-[var(--text-muted)]">{preview.rows.length} рядків</span>
          {summary.new > 0 && <><span className="text-[var(--border-strong)]">·</span><span className="text-[var(--state-ok)]">{summary.new} нових</span></>}
          {summary.existing > 0 && <><span className="text-[var(--border-strong)]">·</span><span className="text-[var(--accent)]">{summary.existing} існуючих</span></>}
          {summary.missing > 0 && <><span className="text-[var(--border-strong)]">·</span><span className="text-[var(--text-faint)]">{summary.missing} відсутніх</span></>}
        </div>

        {/* Action strip */}
        <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-[var(--border)] bg-[var(--bg)] px-6 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--state-ok)] text-xs">●</span>
            <span className="text-xs text-[var(--text-muted)]">Нові:</span>
            {(["import", "skip"] as ActionNew[]).map((v) => (
              <button key={v} onClick={() => setActionNew(v)}
                className={["rounded-md px-2.5 py-1 text-xs transition-colors",
                  actionNew === v ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                ].join(" ")}>
                {v === "import" ? "Додати" : "Пропустити"}
              </button>
            ))}
          </div>
          <span className="text-[var(--border-strong)] text-xs">|</span>
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--accent)] text-xs">●</span>
            <span className="text-xs text-[var(--text-muted)]">Існуючі:</span>
            {(["update", "skip"] as ActionExisting[]).map((v) => (
              <button key={v} onClick={() => setActionExisting(v)}
                className={["rounded-md px-2.5 py-1 text-xs transition-colors",
                  actionExisting === v ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                ].join(" ")}>
                {v === "update" ? "Оновити" : "Пропустити"}
              </button>
            ))}
          </div>
          <span className="text-[var(--border-strong)] text-xs">|</span>
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-faint)] text-xs">●</span>
            <span className="text-xs text-[var(--text-muted)]">Відсутні у файлі:</span>
            {(["nothing", "hide"] as ActionMissing[]).map((v) => (
              <button key={v} onClick={() => setActionMissing(v)}
                className={["rounded-md px-2.5 py-1 text-xs transition-colors",
                  actionMissing === v ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                ].join(" ")}>
                {v === "nothing" ? "Нічого" : "Приховати"}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10">
              {/* Column mapping dropdowns */}
              <tr className="border-b border-[var(--border)] bg-[var(--bg-elevated)]">
                <th className="w-9 border-r border-[var(--border)] px-2 py-1.5 text-xs text-[var(--text-faint)]">#</th>
                {preview.headers.map((_, ci) => (
                  <th key={ci} className="min-w-[120px] border-r border-[var(--border)] px-1.5 py-1.5 text-left font-normal last:border-r-0">
                    <select
                      value={colMapping[ci] ?? ""}
                      onChange={(e) => onColMappingChange(ci, e.target.value)}
                      className={[
                        "w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-xs outline-none focus:border-[var(--border-strong)]",
                        colMapping[ci] ? "text-[var(--accent)] font-medium" : "text-[var(--text-faint)]",
                      ].join(" ")}
                    >
                      {FIELD_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </th>
                ))}
              </tr>
              {/* Column name headers */}
              <tr className="border-b border-[var(--border)] bg-[var(--surface-hi)]">
                <td className="border-r border-[var(--border)] px-2 py-1" />
                {preview.headers.map((h, ci) => (
                  <td key={ci} className={[
                    "border-r border-[var(--border)] px-2 py-1 text-xs last:border-r-0 max-w-[200px] truncate",
                    colMapping[ci] ? "text-[var(--text-muted)]" : "text-[var(--text-faint)] opacity-50",
                  ].join(" ")} title={h}>
                    {h}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-[var(--border)] hover:bg-[var(--surface-hi)]">
                  <td className="border-r border-[var(--border)] px-2 py-1.5 text-center text-xs text-[var(--text-faint)]">
                    {ri + 1}
                  </td>
                  {row.map((cell, ci) => (
                    <td key={ci} className={[
                      "border-r border-[var(--border)] px-2 py-1.5 text-xs last:border-r-0 max-w-[200px] truncate",
                      colMapping[ci] ? "" : "opacity-30",
                    ].join(" ")} title={cell}>
                      {cell || <span className="text-[var(--text-faint)]">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── FilterDropdown ────────────────────────────────────────────────────────────

function FilterDropdown({
  categories, catColorMap, selectedCats, onCatsChange,
  barcodeFilter, onBarcodeChange,
}: {
  categories: string[];
  catColorMap: Map<string, string | null>;
  selectedCats: string[];
  onCatsChange: (v: string[]) => void;
  barcodeFilter: BarcodeFilter;
  onBarcodeChange: (v: BarcodeFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = selectedCats.length + (barcodeFilter !== "all" ? 1 : 0);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={["btn btn-ghost btn-sm flex items-center gap-1.5",
          active > 0 ? "!border-[var(--accent)] !text-[var(--accent)]" : "",
        ].join(" ")}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
        </svg>
        Фільтри
        {active > 0 && (
          <span className="flex size-4 items-center justify-center rounded-full bg-[var(--accent)] text-[9px] font-bold text-white leading-none">
            {active}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">

          {/* Categories */}
          <div className="p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Категорії</p>
            {categories.length === 0 ? (
              <p className="text-xs text-[var(--text-faint)]">Немає категорій</p>
            ) : (
              <div className="max-h-52 space-y-0.5 overflow-y-auto">
                {categories.map((c) => {
                  const color = catColorMap.get(c);
                  return (
                    <label key={c} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                      <input
                        type="checkbox"
                        checked={selectedCats.includes(c)}
                        onChange={(e) => {
                          if (e.target.checked) onCatsChange([...selectedCats, c]);
                          else onCatsChange(selectedCats.filter((x) => x !== c));
                        }}
                        className="rounded accent-[var(--accent)]"
                      />
                      {color && <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />}
                      <span className="text-sm">{c}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-[var(--border)] p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Штрих-код</p>
            <div className="space-y-0.5">
              {([ { value: "all" as BarcodeFilter, label: "Всі" },
                  { value: "has" as BarcodeFilter, label: "Є штрих-код" },
                  { value: "none" as BarcodeFilter, label: "Немає штрих-коду" },
              ]).map((opt) => (
                <label key={opt.value} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                  <input
                    type="radio"
                    name="barcode-filter"
                    checked={barcodeFilter === opt.value}
                    onChange={() => onBarcodeChange(opt.value)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          {active > 0 && (
            <div className="border-t border-[var(--border)] p-3">
              <button
                onClick={() => { onCatsChange([]); onBarcodeChange("all"); }}
                className="w-full rounded-md px-3 py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
              >
                Скинути фільтри
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProductsPage() {
  const { confirm, dialog } = useConfirm();
  const [products,   setProducts]   = useState<Product[]>([]);
  const [stock,      setStock]      = useState<StockEntry[]>([]);
  const [cats,       setCats]       = useState<ProductCat[]>([]);
  const [loading,    setLoading]    = useState(true);

  const [search,        setSearch]        = useState("");
  const [selectedCats,  setSelectedCats]  = useState<string[]>([]);
  const [barcodeFilter, setBarcodeFilter] = useState<BarcodeFilter>("all");
  const [sortKey,       setSortKey]       = useState<SortKey>("sku");
  const [sortDir,  setSortDir]  = useState<SortDir>("asc");
  const [pageSize, setPageSize] = useState<number>(25);
  const [page,     setPage]     = useState(1);
  const [selected,    setSelected]    = useState<Set<number>>(new Set());
  const [deleting,    setDeleting]    = useState(false);
  const [showArchive, setShowArchive] = useState(false);

  const colVis = useColumnVisibility("products", COLS);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);

  const [labelModal, setLabelModal] = useState(false);

  // Modal state
  const [editProduct,   setEditProduct]   = useState<Product | null | "create">(null);
  const [copyTemplate,  setCopyTemplate]  = useState<Partial<Product> | null>(null);
  const [specProduct,  setSpecProduct]  = useState<Product | null>(null);
  const [importResult, setImportResult] = useState<{ created: number; updated: number; skipped: number; hidden: number; new_categories: number } | null>(null);
  const [importing,    setImporting]    = useState(false);
  const [importPreview,  setImportPreview]  = useState<ImportPreview | null>(null);
  const [importFile,     setImportFile]     = useState<File | null>(null);
  const [actionNew,      setActionNew]      = useState<ActionNew>("import");
  const [actionExisting, setActionExisting] = useState<ActionExisting>("update");
  const [actionMissing,  setActionMissing]  = useState<ActionMissing>("nothing");
  const [colMapping,     setColMapping]     = useState<Record<number, string>>({});
  const importRef     = useRef<HTMLInputElement>(null);
  const specImportRef = useRef<HTMLInputElement>(null);
  const [specImporting,    setSpecImporting]    = useState(false);
  const [specImportResult, setSpecImportResult] = useState<SpecImportResult | null>(null);

  const load = useCallback(async (archived: boolean) => {
    try {
      const [prods, stk, cs] = await Promise.all([
        api<Product[]>(`/api/warehouse/products${archived ? "?archived=true" : ""}`),
        api<StockEntry[]>("/api/warehouse/stock/summary"),
        api<ProductCat[]>("/api/warehouse/categories"),
      ]);
      setProducts(prods);
      setStock(stk);
      setCats(cs);
    } finally { setLoading(false); }
  }, []);

  const refreshStock = useCallback(async () => {
    try {
      const stk = await api<StockEntry[]>("/api/warehouse/stock/summary");
      setStock(stk);
    } catch { /* silent */ }
  }, []);

  const { version } = useWarehouseStream();
  useEffect(() => { load(showArchive); }, [load, showArchive]);
  // Refresh stock on any warehouse mutation event
  useEffect(() => { refreshStock(); }, [refreshStock, version]);

  const stockByProduct = useMemo(() => {
    const map = new Map<number, number>();
    for (const s of stock) map.set(s.product_id, (map.get(s.product_id) ?? 0) + parseFloat(s.available));
    return map;
  }, [stock]);

  // Merge: API categories + any ad-hoc tags from products not yet in registry
  const allCategories = useMemo(() => {
    const fromApi   = cats.map((c) => c.name);
    const fromProds = Array.from(new Set(products.flatMap((p) => p.categories)));
    const extra     = fromProds.filter((n) => !fromApi.includes(n));
    return [...fromApi, ...extra.sort()];
  }, [cats, products]);

  const catColorMap = useMemo(() => {
    const m = new Map<string, string | null>();
    cats.forEach((c) => m.set(c.name, c.color));
    return m;
  }, [cats]);

  const filtered = useMemo(() => {
    return products.filter((p) => {
      if (selectedCats.length > 0 && !selectedCats.every((c) => p.categories.includes(c))) return false;
      if (barcodeFilter === "has"  && !p.barcode) return false;
      if (barcodeFilter === "none" &&  p.barcode) return false;
      if (search.trim() && !matchTokens(`${p.name} ${p.sku}`, search)) return false;
      return true;
    });
  }, [products, search, selectedCats, barcodeFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sortKey) {
        case "name":      return sortDir === "asc" ? a.name.localeCompare(b.name, "uk") : b.name.localeCompare(a.name, "uk");
        case "sku":       return sortDir === "asc" ? a.sku.localeCompare(b.sku) : b.sku.localeCompare(a.sku);
        default: {
          let av = 0, bv = 0;
          if (sortKey === "stock")      { av = stockByProduct.get(a.id) ?? 0; bv = stockByProduct.get(b.id) ?? 0; }
          if (sortKey === "full_cost")  { av = parseFloat(a.full_cost  ?? "0"); bv = parseFloat(b.full_cost  ?? "0"); }
          if (sortKey === "sale_price") { av = parseFloat(a.sale_price ?? "0"); bv = parseFloat(b.sale_price ?? "0"); }
          if (sortKey === "margin")     {
            av = calcMargin(a.sale_price, a.full_cost) ?? -Infinity;
            bv = calcMargin(b.sale_price, b.full_cost) ?? -Infinity;
          }
          if (sortKey === "margin_currency") {
            av = a.sale_price && a.full_cost ? parseFloat(a.sale_price) - parseFloat(a.full_cost) : -Infinity;
            bv = b.sale_price && b.full_cost ? parseFloat(b.sale_price) - parseFloat(b.full_cost) : -Infinity;
          }
          return sortDir === "asc" ? av - bv : bv - av;
        }
      }
    });
    return arr;
  }, [filtered, sortKey, sortDir, stockByProduct]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const paginated  = useMemo(() => sorted.slice((page - 1) * pageSize, page * pageSize), [sorted, page, pageSize]);

  useEffect(() => { setPage(1); }, [search, selectedCats, barcodeFilter, sortKey, sortDir, pageSize]);

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(col); setSortDir("asc"); }
  }

  const allPageSelected = paginated.length > 0 && paginated.every((p) => selected.has(p.id));
  function toggleAll() {
    if (allPageSelected) setSelected((s) => { const n = new Set(s); paginated.forEach((p) => n.delete(p.id)); return n; });
    else setSelected((s) => { const n = new Set(s); paginated.forEach((p) => n.add(p.id)); return n; });
  }
  function toggleOne(id: number) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function archiveSelected() {
    if (!await confirm({ message: `Архівувати ${selected.size} позицій?`, variant: "warn" })) return;
    setDeleting(true);
    try {
      await Promise.all([...selected].map((id) => api(`/api/warehouse/products/${id}/archive`, { method: "POST" })));
      setProducts((prev) => prev.filter((p) => !selected.has(p.id)));
      setSelected(new Set());
    } finally { setDeleting(false); }
  }

  async function restoreSelected() {
    setDeleting(true);
    try {
      await Promise.all([...selected].map((id) => api(`/api/warehouse/products/${id}/restore`, { method: "POST" })));
      setProducts((prev) => prev.filter((p) => !selected.has(p.id)));
      setSelected(new Set());
    } finally { setDeleting(false); }
  }

  async function hardDeleteSelected() {
    if (!await confirm({ message: `Видалити ${selected.size} позицій назавжди? Дію не можна скасувати.`, variant: "danger" })) return;
    setDeleting(true);
    const failed: string[] = [];
    try {
      await Promise.all([...selected].map(async (id) => {
        try {
          await api(`/api/warehouse/products/${id}`, { method: "DELETE" });
        } catch (e) {
          const p = products.find((x) => x.id === id);
          failed.push(p?.name ?? String(id));
        }
      }));
      setProducts((prev) => prev.filter((p) => !selected.has(p.id) || failed.includes(p.name)));
      setSelected(new Set());
      if (failed.length) toast.error(`Не вдалося видалити: ${failed.join(", ")}. Є рухи або замовлення — заархівуйте їх.`);
    } finally { setDeleting(false); }
  }

  async function archiveOne(id: number) {
    await api(`/api/warehouse/products/${id}/archive`, { method: "POST" });
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
  }

  async function restoreOne(id: number) {
    await api(`/api/warehouse/products/${id}/restore`, { method: "POST" });
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
  }

  function copyOne(p: Product) {
    setCopyTemplate({ name: p.name + " (копія)", sku: p.sku + "-copy", categories: p.categories, unit: p.unit, description: p.description, sale_price: p.sale_price, min_stock: p.min_stock, desired_stock: p.desired_stock, cell_limit: p.cell_limit });
    setEditProduct("create");
  }

  async function hardDeleteOne(id: number, name: string) {
    if (!await confirm({ message: `Видалити «${name}» назавжди?`, variant: "danger" })) return;
    try {
      await api(`/api/warehouse/products/${id}`, { method: "DELETE" });
      setProducts((prev) => prev.filter((p) => p.id !== id));
      setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast.error(e.message);
    }
  }

  async function printProductCards() {
    const sel = products.filter((p) => selected.has(p.id));
    if (!sel.length) return;
    const mod = await import("jsbarcode");
    const JsBarcode = (mod as { default: unknown }).default ?? mod;
    const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

    const cards = await Promise.all(sel.map(async (p) => {
      const barcodeText = p.barcode || `PROD:${p.id}`;
      let barcodeImg = "";
      try {
        const canvas = document.createElement("canvas");
        (JsBarcode as (el: HTMLCanvasElement, v: string, o: object) => void)(canvas, barcodeText, {
          format: "CODE128", displayValue: true, fontSize: 11, margin: 5,
          width: 2, height: 55, background: "#fff", lineColor: "#000",
        });
        barcodeImg = canvas.toDataURL("image/png");
      } catch { /* no barcode */ }
      const imgSrc = p.image_url
        ? (p.image_url.startsWith("/") ? `${API}${p.image_url}` : p.image_url)
        : "";
      return `
        <div style="display:inline-flex;flex-direction:column;width:160px;border:1px solid #ccc;border-radius:6px;overflow:hidden;page-break-inside:avoid;margin:4px">
          ${imgSrc ? `<img src="${imgSrc}" style="width:100%;height:100px;object-fit:cover" />` : ""}
          <div style="padding:8px;flex:1">
            <p style="font-size:12px;font-weight:600;margin:0 0 2px">${p.name}</p>
            <p style="font-size:10px;color:#666;margin:0 0 2px;font-family:monospace">${p.sku}</p>
            ${p.categories?.length ? `<p style="font-size:9px;color:#999;margin:0">${p.categories.slice(0,2).join(", ")}</p>` : ""}
            ${p.sale_price ? `<p style="font-size:11px;font-weight:600;color:#0891b2;margin:4px 0 0">${parseFloat(p.sale_price).toLocaleString("uk-UA")} ₴</p>` : ""}
          </div>
          ${barcodeImg ? `<div style="border-top:1px solid #eee;padding:4px;text-align:center"><img src="${barcodeImg}" style="height:45px;max-width:100%" /></div>` : ""}
        </div>`;
    }));

    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>Картки товарів</title><style>
      body{font-family:system-ui;margin:8mm}
      @media print{@page{margin:8mm}}
    </style></head><body>
      <div style="display:flex;flex-wrap:wrap">${cards.join("")}</div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 300);
  }

  function handleSaved(p: Product) {
    setProducts((prev) => {
      const idx = prev.findIndex((x) => x.id === p.id);
      return idx >= 0 ? prev.map((x) => x.id === p.id ? p : x) : [p, ...prev];
    });
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImporting(true);
    setImportResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const preview = await api<ImportPreview>("/api/warehouse/products/import/preview", { method: "POST", body });
      setImportFile(file);
      setImportPreview(preview);
      setActionNew("import");
      setActionExisting("update");
      setActionMissing("nothing");
      const initMap: Record<number, string> = {};
      Object.entries(preview.mapping).forEach(([k, v]) => { if (v) initMap[parseInt(k)] = v; });
      setColMapping(initMap);
    } catch {
      toast.error("Помилка читання файлу");
    } finally {
      setImporting(false);
    }
  }

  async function handleImportConfirm() {
    if (!importFile) return;
    setImporting(true);
    try {
      const body = new FormData();
      body.append("file", importFile);
      const params = new URLSearchParams({ action_new: actionNew, action_existing: actionExisting, action_missing: actionMissing });
      const result = await api<{ created: number; updated: number; skipped: number; hidden: number; new_categories: number }>(
        `/api/warehouse/products/import?${params}`,
        { method: "POST", body },
      );
      setImportResult(result);
      setImportPreview(null);
      setImportFile(null);
      await load(showArchive);
    } catch {
      toast.error("Помилка імпорту");
    } finally {
      setImporting(false);
    }
  }

  async function handleSpecImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setSpecImporting(true);
    setSpecImportResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const result = await api<SpecImportResult>("/api/warehouse/specs/import", { method: "POST", body });
      setSpecImportResult(result);
      await load(showArchive);
    } catch {
      toast.error("Помилка імпорту специфікацій");
    } finally {
      setSpecImporting(false);
    }
  }

  function handleExport() {
    const token = getToken();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const qs = new URLSearchParams({ fmt: "xlsx" });
    if (selected.size > 0) qs.set("ids", [...selected].join(","));
    fetch(`${API_URL}/api/warehouse/products/export?${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `номенклатури_${ts}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
      });
  }

  if (loading) return <PageSkeleton cols={10} />;

  return (
    <>
      <div className="space-y-4">

        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input type="search" placeholder="Назва або артикул…"
                value={search} onChange={(e) => setSearch(e.target.value)}
                className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] pl-8 pr-3 text-sm outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]" />
            </div>
            <FilterDropdown
              categories={allCategories}
              catColorMap={catColorMap}
              selectedCats={selectedCats}
              onCatsChange={setSelectedCats}
              barcodeFilter={barcodeFilter}
              onBarcodeChange={setBarcodeFilter}
            />
            {selectedCats.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedCats.map((c) => {
                  const color = catColorMap.get(c);
                  return (
                    <span key={c}
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                      style={color ? { background: color, color: "#111" } : { background: "var(--surface-hi)" }}>
                      {c}
                      <button onClick={() => setSelectedCats(selectedCats.filter((x) => x !== c))}
                        className="opacity-60 hover:opacity-100">×</button>
                    </span>
                  );
                })}
              </div>
            )}
            <span className="text-sm text-[var(--text-faint)]">{filtered.length} позицій</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={importRef}
              type="file"
              accept=".tsv,.csv,.txt,.xlsx,.xls"
              className="hidden"
              onChange={handleImport}
            />
            <input
              ref={specImportRef}
              type="file"
              accept=".xlsx,.tsv,.txt"
              className="hidden"
              onChange={handleSpecImport}
            />
            <button
              onClick={handleExport}
              className={["btn btn-sm", selected.size > 0 ? "btn-secondary" : "btn-ghost"].join(" ")}
              title={selected.size > 0 ? `Експорт ${selected.size} вибраних` : "Експорт всіх номенклатур"}
            >
              ↓ {selected.size > 0 ? `Експорт (${selected.size})` : "Експорт"}
            </button>
            <button
              onClick={() => importRef.current?.click()}
              disabled={importing}
              className="btn btn-ghost btn-sm disabled:opacity-50"
              title="Імпорт номенклатури TSV/CSV (Ordage)"
            >
              {importing ? "…" : "↑ Номенклатура"}
            </button>
            <button
              onClick={() => specImportRef.current?.click()}
              disabled={specImporting}
              className="btn btn-ghost btn-sm disabled:opacity-50"
              title="Імпорт специфікацій (Ordage TSV)"
            >
              {specImporting ? "…" : "↑ Специфікації"}
            </button>
            <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
            <button
              onClick={() => { setShowArchive((v) => !v); setSelected(new Set()); }}
              className={["btn btn-sm", showArchive ? "btn-primary" : "btn-ghost"].join(" ")}
              title="Показати архів"
            >
              {showArchive ? "← Активні" : "Архів"}
            </button>
            {!showArchive && (
              <button onClick={() => setEditProduct("create")} className="btn btn-primary">
                + Номенклатура
              </button>
            )}
          </div>
        </div>

        {/* Import result banner */}
        {importResult && (
          <div className="flex items-center gap-3 rounded-lg border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] px-4 py-2.5">
            <span className="text-sm text-[var(--state-ok)]">
              Імпорт завершено: додано {importResult.created}, оновлено {importResult.updated}{importResult.hidden ? `, сховано ${importResult.hidden}` : ""}{importResult.new_categories ? `, нових категорій ${importResult.new_categories}` : ""}, пропущено {importResult.skipped}
            </span>
            <button
              onClick={() => setImportResult(null)}
              className="ml-auto text-sm text-[var(--text-faint)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
        )}

        {/* Spec import result banner */}
        {specImportResult && (
          <div className="flex items-start gap-3 rounded-lg border border-[rgba(34,211,238,.25)] bg-[rgba(34,211,238,.06)] px-4 py-2.5">
            <div className="flex-1 text-sm">
              <span className="text-[var(--accent)]">
                Специфікації: оновлено {specImportResult.updated}
                {specImportResult.skipped > 0 && `, пропущено ${specImportResult.skipped}`}
              </span>
              {specImportResult.errors.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-[var(--text-faint)]">
                  {specImportResult.errors.slice(0, 5).map((e) => (
                    <li key={e.sku}>{e.sku} — {e.reason}</li>
                  ))}
                  {specImportResult.errors.length > 5 && (
                    <li>…ще {specImportResult.errors.length - 5}</li>
                  )}
                </ul>
              )}
            </div>
            <button
              onClick={() => setSpecImportResult(null)}
              className="text-sm text-[var(--text-faint)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
        )}


        {/* Table */}
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-sm">
              <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <input type="checkbox" checked={allPageSelected} onChange={toggleAll}
                      className="rounded border-[var(--border-strong)]" />
                  </th>
                  {colVis.orderedCols.map((col) => {
                    if (!colVis.isVisible(col.key)) return null;
                    switch (col.key) {
                      case "image":      return <th key="image" className="w-12 px-2 py-3" />;
                      case "name":       return <Th key="name" col="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Назва</Th>;
                      case "sku":        return <Th key="sku" col="sku" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Артикул</Th>;
                      case "barcode":    return <th key="barcode" className="px-4 py-3 font-medium">Штрих-код</th>;
                      case "categories": return <th key="categories" className="px-4 py-3 font-medium">Категорія</th>;
                      case "unit":       return <th key="unit" className="px-4 py-3 font-medium">Од.</th>;
                      case "stock":      return <Th key="stock" col="stock" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Залишок</Th>;
                      case "full_cost":  return <Th key="full_cost" col="full_cost" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Собів.</Th>;
                      case "sale_price": return <Th key="sale_price" col="sale_price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Ціна</Th>;
                      case "margin":     return <Th key="margin" col="margin" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Маржа %</Th>;
                      case "margin_currency": return <Th key="margin_currency" col="margin_currency" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Маржа ₴</Th>;
                      default: return null;
                    }
                  })}
                  <th className="w-20 px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {paginated.length === 0 ? (
                  <tr><td colSpan={2 + COLS.filter((c) => colVis.isVisible(c.key)).length} className="px-4 py-12 text-center text-sm text-[var(--text-faint)]">
                    {search || selectedCats.length > 0 || barcodeFilter !== "all" ? "Нічого не знайдено" : "Номенклатури ще немає"}
                  </td></tr>
                ) : paginated.map((p) => {
                  const avail  = stockByProduct.get(p.id) ?? 0;
                  const margin = calcMargin(p.sale_price, p.full_cost ?? p.cost_price);
                  const cost = parseFloat(p.full_cost ?? p.cost_price ?? "0") || 0;
                  const sale = parseFloat(p.sale_price ?? "0") || 0;
                  const marginUah = p.sale_price && (p.full_cost || p.cost_price) ? sale - cost : null;
                  const isOut  = avail === 0 && stock.some((s) => s.product_id === p.id);
                  return (
                    <tr key={p.id}
                      className={["group", selected.has(p.id) ? "bg-[var(--accent-soft)]/50" : "hover:bg-[var(--surface-hi)]/80"].join(" ")}>
                      <td className="w-10 px-2 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {!showArchive && (
                            <button
                              onClick={() => copyOne(p)}
                              title="Створити копію"
                              className="opacity-0 group-hover:opacity-100 flex size-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--accent)] transition-opacity"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                              </svg>
                            </button>
                          )}
                          <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)}
                            className="rounded border-[var(--border-strong)]" />
                        </div>
                      </td>
                      {colVis.orderedCols.map((col) => {
                        if (!colVis.isVisible(col.key)) return null;
                        switch (col.key) {
                          case "image": return (
                            <td key="image" className="px-2 py-2">
                              {p.image_url ? (
                                <PhotoPreview src={p.image_url} alt={p.name}>
                                  <button onClick={() => setEditProduct(p)}
                                    className="block size-9 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-hi)]">
                                    <AuthImage src={p.image_url} alt={p.name} className="size-full object-cover" />
                                  </button>
                                </PhotoPreview>
                              ) : (
                                <button onClick={() => setEditProduct(p)}
                                  className="block size-9 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-hi)]">
                                  <span className="flex size-full items-center justify-center text-[10px] text-[var(--text-faint)]">—</span>
                                </button>
                              )}
                            </td>
                          );
                          case "name": return (
                            <td key="name" className="px-4 py-3">
                              <button onClick={() => setEditProduct(p)}
                                className="text-left font-medium text-[var(--text-hi)] hover:text-[var(--accent)]">
                                {p.name}
                              </button>
                            </td>
                          );
                          case "sku": return (
                            <td key="sku" className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{p.sku}</td>
                          );
                          case "barcode": return (
                            <td key="barcode" className="px-4 py-3 font-mono text-xs text-[var(--text-faint)]">
                              {p.barcode || <span className="opacity-30">—</span>}
                            </td>
                          );
                          case "categories": return (
                            <td key="categories" className="px-4 py-3">
                              <div className="flex flex-wrap gap-1">
                                {p.categories.map((c) => {
                                  const color = catColorMap.get(c);
                                  return (
                                    <span key={c}
                                      onClick={() => setSelectedCats((prev) => prev.includes(c) ? prev : [...prev, c])}
                                      className={color
                                        ? "cursor-pointer rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80"
                                        : "cursor-pointer rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs hover:bg-[var(--surface-hi)] transition-opacity"}
                                      style={color ? { background: color, color: "#111" } : undefined}>
                                      {c}
                                    </span>
                                  );
                                })}
                              </div>
                            </td>
                          );
                          case "unit": return (
                            <td key="unit" className="px-4 py-3 text-xs text-[var(--text-muted)]">{p.unit}</td>
                          );
                          case "stock": return (
                            <td key="stock" className="px-4 py-3 text-right">
                              <span className={["font-mono text-sm tabular-nums",
                                isOut ? "font-semibold text-[var(--state-error)]"
                                  : avail < 5 ? "text-[var(--state-warn)]"
                                  : "text-[var(--text)]"].join(" ")}>
                                {Math.round(avail)}
                              </span>
                            </td>
                          );
                          case "full_cost": return (
                            <td key="full_cost" className="px-4 py-3 text-right text-sm tabular-nums">
                              {p.full_cost
                                ? <span className="text-[var(--text-muted)]">{fmtPrice(p.full_cost)}</span>
                                : p.cost_price
                                  ? <span className="text-[var(--text-faint)]" title="Середньозважена ціна">{fmtPrice(p.cost_price)}</span>
                                  : <span className="text-[var(--text-faint)]">—</span>}
                            </td>
                          );
                          case "sale_price": return (
                            <td key="sale_price" className="px-4 py-3 text-right text-sm tabular-nums font-medium">{fmtPrice(p.sale_price)}</td>
                          );
                          case "margin": return (
                            <td key="margin" className="px-4 py-3 text-right text-sm">
                              {margin !== null
                                ? <span className={["font-medium tabular-nums",
                                    margin >= 50 ? "text-[var(--state-ok)]"
                                      : margin >= 20 ? "text-[var(--state-warn)]"
                                      : "text-[var(--state-error)]"].join(" ")}>
                                    {margin.toFixed(0)}%
                                  </span>
                                : "—"}
                            </td>
                          );
                          case "margin_currency": return (
                            <td key="margin_currency" className="px-4 py-3 text-right text-sm">
                              {marginUah !== null
                                ? <span className={["font-medium tabular-nums",
                                    marginUah >= 0 ? "text-[var(--state-ok)]" : "text-[var(--state-error)]"].join(" ")}>
                                    {marginUah.toLocaleString("uk-UA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ₴
                                  </span>
                                : "—"}
                            </td>
                          );
                          default: return null;
                        }
                      })}
                      {/* Row actions */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          {showArchive ? (
                            <>
                              <button onClick={() => restoreOne(p.id)} title="Відновити"
                                className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-ok)]">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
                                </svg>
                              </button>
                              <button onClick={() => hardDeleteOne(p.id, p.name)} title="Видалити назавжди"
                                className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-error)]">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6m4-6v6"/><path d="M9 6V4h6v2"/>
                                </svg>
                              </button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => setEditProduct(p)} title="Редагувати"
                                className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                </svg>
                              </button>
                              <button onClick={() => setSpecProduct(p)} title="Специфікація"
                                className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                                  <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
                                </svg>
                              </button>
                              <button onClick={() => archiveOne(p.id)} title="Архівувати"
                                className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-warn)]">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                                  <rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>
                                </svg>
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {sorted.length > 0 && (
            <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3 ">
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <span>Рядків:</span>
                {PAGE_SIZES.map((s) => (
                  <button key={s} onClick={() => setPageSize(s)}
                    className={["rounded px-2 py-0.5 text-sm",
                      pageSize === s ? "bg-[var(--accent)] text-white  "
                        : "hover:bg-[var(--surface-hi)] "].join(" ")}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <span className="mr-2 text-sm text-[var(--text-faint)]">
                  {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} з {sorted.length}
                </span>
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                  className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-30 ">‹</button>
                {totalPages <= 7 && Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button key={p} onClick={() => setPage(p)}
                    className={["flex size-7 items-center justify-center rounded-md text-sm",
                      page === p ? "bg-[var(--accent)] text-white  "
                        : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] "].join(" ")}>
                    {p}
                  </button>
                ))}
                {totalPages > 7 && <span className="px-1 text-sm text-[var(--text-faint)]">{page} / {totalPages}</span>}
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-30 ">›</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import preview modal */}
      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          filename={importFile?.name ?? ""}
          colMapping={colMapping}
          onColMappingChange={(idx, field) => setColMapping((prev) => ({ ...prev, [idx]: field }))}
          actionNew={actionNew} setActionNew={setActionNew}
          actionExisting={actionExisting} setActionExisting={setActionExisting}
          actionMissing={actionMissing} setActionMissing={setActionMissing}
          onImport={handleImportConfirm}
          onLoadOther={() => importRef.current?.click()}
          onClose={() => { setImportPreview(null); setImportFile(null); }}
          busy={importing}
        />
      )}

      {/* Product modal */}
      {editProduct !== null && (
        <ProductModal
          product={editProduct === "create" ? null : editProduct}
          prefill={editProduct === "create" ? copyTemplate : null}
          existingCats={allCategories}
          onClose={() => { setEditProduct(null); setCopyTemplate(null); }}
          onSaved={handleSaved}
        />
      )}

      {/* Spec modal */}
      {specProduct !== null && (
        <SpecModal
          product={specProduct}
          onClose={() => setSpecProduct(null)}
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

      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={showArchive ? [
          { label: "Відновити",        onClick: restoreSelected,    disabled: deleting, variant: "default" },
          { label: "Видалити назавжди", onClick: hardDeleteSelected, disabled: deleting, variant: "danger"  },
        ] : [
          { label: "🏷 Мітки",   onClick: () => setLabelModal(true), disabled: deleting, variant: "ghost"  },
          { label: "Архівувати",  onClick: archiveSelected,          disabled: deleting, variant: "ghost"  },
          { label: "Видалити",    onClick: hardDeleteSelected,        disabled: deleting, variant: "danger"  },
        ]}
      />

      {labelModal && (() => {
        const labelItems: WarehouseLabelItem[] = products
          .filter(p => selected.has(p.id))
          .map(p => ({ type: "product" as const, id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, image_url: p.image_url, categories: p.categories, price: p.sale_price, cost: p.full_cost ?? p.cost_price }));
        return labelItems.length > 0
          ? <WarehouseLabelModal items={labelItems} onClose={() => setLabelModal(false)} />
          : null;
      })()}

      {dialog}
    </>
  );
}
