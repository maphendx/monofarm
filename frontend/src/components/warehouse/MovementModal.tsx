"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { CellCombobox } from "@/components/warehouse/CellCombobox";

export type MovementType = "PRODUCTION_IN" | "PRODUCTION_OUT" | "SALE_OUT" | "PURCHASE_IN" | "DEFECT" | "ADJUSTMENT" | "TRANSFER" | "RETURN_IN" | "WRITE_OFF";

export const TYPE_META: Record<MovementType, { label: string; cls: string; needsFrom: boolean; needsTo: boolean; needsPrice: boolean }> = {
  PURCHASE_IN:    { label: "Отримання",    cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400",      needsFrom: false, needsTo: true,  needsPrice: true  },
  SALE_OUT:       { label: "Продаж",       cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)]",              needsFrom: true,  needsTo: false, needsPrice: false },
  TRANSFER:       { label: "Переміщення",  cls: "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]",          needsFrom: true,  needsTo: true,  needsPrice: false },
  ADJUSTMENT:     { label: "Коригування",  cls: "bg-[var(--surface-hi)] text-[var(--text-muted)]",             needsFrom: false, needsTo: true,  needsPrice: false },
  DEFECT:         { label: "Брак",         cls: "bg-[rgba(239,68,68,.08)] text-[var(--state-error)]",          needsFrom: true,  needsTo: true,  needsPrice: false },
  WRITE_OFF:      { label: "Списання",     cls: "bg-[rgba(239,68,68,.08)] text-[var(--state-error)]",          needsFrom: true,  needsTo: false, needsPrice: false },
  RETURN_IN:      { label: "Повернення",   cls: "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]",          needsFrom: false, needsTo: true,  needsPrice: false },
  PRODUCTION_IN:  { label: "Виробництво+", cls: "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]",             needsFrom: false, needsTo: true,  needsPrice: false },
  PRODUCTION_OUT: { label: "Сировина−",   cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)]",              needsFrom: true,  needsTo: false, needsPrice: false },
};

export type Movement = {
  id: number; type: MovementType; direction: "in" | "out" | "transfer";
  product_name: string;
  quantity: string; unit: string; unit_cost: string | null; total_cost: string | null;
  warehouse_from_id: number | null; warehouse_to_id: number | null;
  reason: string | null; created_at: string;
};

type Product      = { id: number; name: string; sku: string; unit: string; sale_price: string | null; cost_price: string | null };
type Warehouse    = { id: number; name: string; type: string };
type Counterparty = { id: number; name: string; type: string };
type FlatCell     = { id: number; label: string };

type LineItem = {
  _key:      string;
  productId: string;
  search:    string;   // what's typed in the search box
  quantity:  string;
  unit:      string;
  unitCost:  string;
};

function newLine(): LineItem {
  return { _key: Math.random().toString(36).slice(2), productId: "", search: "", quantity: "1", unit: "шт", unitCost: "" };
}

// ── ProductSearch — per-row searchable product picker ─────────────────────────

function ProductSearch({
  products, value, search, onSelect,
}: {
  products: Product[];
  value:    string;   // selected product_id
  search:   string;
  onSelect: (p: Product | null, text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref  = useRef<HTMLDivElement>(null);
  const selected = products.find((p) => String(p.id) === value);

  const q       = search.toLowerCase().trim();
  const filtered = q.length < 1
    ? products.slice(0, 50)
    : products.filter((p) =>
        p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
      ).slice(0, 50);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={selected ? selected.name : search}
        placeholder="Назва або SKU…"
        autoComplete="off"
        className="input w-full pr-6"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onSelect(null, e.target.value);
          setOpen(true);
        }}
      />
      {selected && (
        <button
          type="button"
          onClick={() => { onSelect(null, ""); setOpen(true); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-faint)] hover:text-[var(--text)]"
        >×</button>
      )}
      {open && !selected && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-52 w-full min-w-[260px] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl">
          {filtered.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-[var(--text-faint)]">Нічого не знайдено</p>
          ) : filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-hi)]"
              onMouseDown={(e) => { e.preventDefault(); onSelect(p, p.name); setOpen(false); }}
            >
              <span className="flex-1 truncate font-medium">{p.name}</span>
              <span className="shrink-0 font-mono text-xs text-[var(--text-faint)]">{p.sku}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

type InitialLine = { productId: string; quantity: string };

export function CreateMovementModal({
  open, onClose, onCreated, initialType = "PURCHASE_IN", initialProductId, initialQuantity, initialLines: initialLinesProp,
}: {
  open:               boolean;
  onClose:            () => void;
  onCreated:          (m: Movement) => void;
  initialType?:       MovementType;
  initialProductId?:  string;
  initialQuantity?:   string;
  initialLines?:      InitialLine[];
}) {
  const [products,      setProducts]      = useState<Product[]>([]);
  const [warehouses,    setWarehouses]    = useState<Warehouse[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);

  const [mType,         setMType]         = useState<MovementType>(initialType);
  const [whFromId,      setWhFromId]      = useState("");
  const [whToId,        setWhToId]        = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [lines,         setLines]         = useState<LineItem[]>(() => {
    if (initialLinesProp?.length) {
      return initialLinesProp.map((l) => ({ ...newLine(), productId: l.productId, quantity: l.quantity }));
    }
    const first = newLine();
    if (initialProductId) {
      first.productId = initialProductId;
      first.quantity  = initialQuantity || "1";
    }
    return [first];
  });
  const [reason,        setReason]        = useState("");
  const [cellId,        setCellId]        = useState("");
  const [cells,         setCells]         = useState<FlatCell[]>([]);
  const [busy,          setBusy]          = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    Promise.all([
      api<Product[]>("/api/warehouse/products"),
      api<Warehouse[]>("/api/warehouse/warehouses"),
      api<Counterparty[]>("/api/warehouse/counterparties"),
    ]).then(([p, w, c]) => {
      setProducts(p);
      setWarehouses(w);
      setCounterparties(c);
      // fill in product names/units for pre-filled lines
      setLines((prev) => prev.map((l) => {
        if (!l.productId) return l;
        const prod = p.find((x) => String(x.id) === l.productId);
        return prod ? { ...l, search: prod.name, unit: prod.unit } : l;
      }));
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = TYPE_META[mType];

  // Optional bin picker, only meaningful for a single product line. Prefer the
  // destination warehouse (put away) for inbound/transfer, else the source.
  const cellWh    = meta.needsTo ? whToId : (meta.needsFrom ? whFromId : "");
  const cellField = meta.needsTo ? "cell_to_id" : "cell_from_id";
  const showCell  = !!cellWh && lines.length === 1;

  useEffect(() => {
    if (!cellWh) return;
    let cancelled = false;
    api<{ id: number }[]>(`/api/warehouse/warehouses/${cellWh}/zones`)
      .then((zones) => Promise.all(
        zones.map((z) =>
          api<{ name: string; cells: { id: number; code: string }[] }>(`/api/warehouse/zones/${z.id}/cells`)
            .then((zc) => zc.cells.map((c) => ({ id: c.id, label: `${zc.name} ${c.code}` })))
        )
      ))
      .then((perZone) => { if (!cancelled) setCells(perZone.flat()); })
      .catch(() => { if (!cancelled) setCells([]); });
    return () => { cancelled = true; };
  }, [cellWh]);

  function setLine(key: string, patch: Partial<LineItem>) {
    setLines((prev) => prev.map((l) => l._key === key ? { ...l, ...patch } : l));
  }

  function removeLine(key: string) {
    setLines((prev) => prev.length > 1 ? prev.filter((l) => l._key !== key) : prev);
  }

  function handleProductSelect(key: string, p: Product | null, text: string) {
    if (p) {
      const autoPrice =
        meta.needsPrice
          ? (mType === "PURCHASE_IN" ? p.cost_price : p.sale_price) ?? ""
          : (mType === "SALE_OUT" ? p.sale_price : "") ?? "";
      setLine(key, {
        productId: String(p.id),
        search:    p.name,
        unit:      p.unit,
        unitCost:  autoPrice ? parseFloat(autoPrice).toFixed(2) : "",
      });
    } else {
      setLine(key, { productId: "", search: text });
    }
  }

  const validLines = lines.filter((l) =>
    l.productId && parseFloat(l.quantity) > 0 &&
    (!meta.needsPrice || parseFloat(l.unitCost) > 0)
  );

  const total = validLines.reduce(
    (s, l) => s + parseFloat(l.quantity) * (parseFloat(l.unitCost) || 0), 0
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || validLines.length === 0) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const results = await Promise.all(validLines.map((l) => {
        const body: Record<string, unknown> = {
          type:       mType,
          product_id: parseInt(l.productId),
          quantity:   parseFloat(l.quantity),
          unit:       l.unit || "шт",
        };
        if (meta.needsFrom && whFromId)      body.warehouse_from_id = parseInt(whFromId);
        if (meta.needsTo   && whToId)        body.warehouse_to_id   = parseInt(whToId);
        if (showCell && cellId)              body[cellField]        = parseInt(cellId);
        if (l.unitCost)                      body.unit_cost         = parseFloat(l.unitCost);
        if (counterpartyId)                  body.counterparty_id   = parseInt(counterpartyId);
        if (reason.trim())                   body.reason            = reason.trim();
        return api<Movement>("/api/warehouse/movements", { method: "POST", body: JSON.stringify(body) });
      }));
      results.forEach((m) => onCreated(m));
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Помилка збереження");
    } finally { inFlight.current = false; setBusy(false); }
  }

  const showCounterparty = mType === "PURCHASE_IN" || mType === "SALE_OUT" || mType === "RETURN_IN";
  const cpLabel = mType === "PURCHASE_IN" ? "Постачальник" : "Контрагент";
  const cpFilter = mType === "PURCHASE_IN" ? "supplier" : "customer";
  const filteredCp = counterparties.filter((c) => c.type === cpFilter);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Рух товару"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost">
            Скасувати
          </button>
          <button
            type="submit" form="movement-form"
            disabled={busy || validLines.length === 0}
            className="btn btn-primary disabled:opacity-50"
          >
            {busy ? "Зберігаю…" : `Зафіксувати${validLines.length > 1 ? ` (${validLines.length})` : ""}`}
          </button>
        </>
      }
    >
      <form id="movement-form" onSubmit={submit} className="space-y-4 text-sm">

        {/* Type tabs */}
        <div className="flex flex-wrap gap-1">
          {(Object.keys(TYPE_META) as MovementType[]).map((t) => (
            <button key={t} type="button" onClick={() => { setMType(t); setCellId(""); }}
              className={[
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                mType === t
                  ? TYPE_META[t].cls + " ring-1 ring-current"
                  : "bg-[var(--surface-hi)] text-[var(--text-muted)] hover:text-[var(--text)]",
              ].join(" ")}>
              {TYPE_META[t].label}
            </button>
          ))}
        </div>

        {/* Warehouses */}
        <div className={`grid gap-3 ${meta.needsFrom && meta.needsTo ? "grid-cols-[1fr_16px_1fr]" : "grid-cols-1"}`}>
          {meta.needsFrom && (
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)]">Звідки</span>
              <select value={whFromId} onChange={(e) => { setWhFromId(e.target.value); setCellId(""); }} className="input">
                <option value="">— склад —</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
          )}
          {meta.needsFrom && meta.needsTo && (
            <div className="flex items-end pb-2.5 justify-center text-[var(--text-faint)]">→</div>
          )}
          {meta.needsTo && (
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)]">Куди</span>
              <select value={whToId} onChange={(e) => { setWhToId(e.target.value); setCellId(""); }} className="input">
                <option value="">— склад —</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
          )}
        </div>

        {/* Optional bin (single line only) */}
        {showCell && cells.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">
              {meta.needsTo ? "Розкласти в комірку" : "Відібрати з комірки"}
              <span className="ml-1 text-[var(--text-faint)]">— опційно</span>
            </span>
            <CellCombobox cells={cells} value={cellId} onChange={setCellId} emptyLabel="автоматично" />
          </label>
        )}

        {/* Counterparty */}
        {showCounterparty && filteredCp.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">{cpLabel}</span>
            <select value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)} className="input">
              <option value="">— не вказано —</option>
              {filteredCp.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}

        {/* Product lines */}
        <div className="space-y-2">
          <div className="grid items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-faint)]"
            style={{ gridTemplateColumns: "1fr 72px 56px 80px 24px" }}>
            <span>Товар</span>
            <span className="text-right">К-сть</span>
            <span className="text-center">Од.</span>
            <span className="text-right">
              Ціна/од.{meta.needsPrice && <span className="ml-0.5 text-[var(--state-error)]">*</span>}
            </span>
            <span />
          </div>

          {lines.map((line) => (
            <div key={line._key} className="grid items-center gap-2"
              style={{ gridTemplateColumns: "1fr 72px 56px 80px 24px" }}>
              <ProductSearch
                products={products}
                value={line.productId}
                search={line.search}
                onSelect={(p, text) => handleProductSelect(line._key, p, text)}
              />
              <input
                type="number" min="0.001" step="any" value={line.quantity}
                onChange={(e) => setLine(line._key, { quantity: e.target.value })}
                className="input text-right"
              />
              <select value={line.unit} onChange={(e) => setLine(line._key, { unit: e.target.value })} className="input px-1">
                {["шт","г","кг","м","см","мм","л","мл","пара"].map((u) => <option key={u}>{u}</option>)}
                {!["шт","г","кг","м","см","мм","л","мл","пара"].includes(line.unit) && (
                  <option value={line.unit}>{line.unit}</option>
                )}
              </select>
              <input
                type="number" min="0" step="0.01" value={line.unitCost}
                onChange={(e) => setLine(line._key, { unitCost: e.target.value })}
                required={meta.needsPrice}
                placeholder="₴"
                className="input text-right"
              />
              <button
                type="button"
                onClick={() => removeLine(line._key)}
                disabled={lines.length === 1}
                className="flex size-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)] disabled:opacity-20"
              >×</button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, newLine()])}
            className="flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] w-full justify-center"
          >
            + Додати рядок
          </button>
        </div>

        {/* Total */}
        {total > 0 && (
          <div className="flex items-center justify-between rounded-lg bg-[var(--bg)] px-3 py-2 text-sm">
            <span className="text-[var(--text-muted)]">
              {validLines.length} {validLines.length === 1 ? "позиція" : "позиції"} · разом
            </span>
            <span className="font-semibold tabular-nums">
              {total.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} ₴
            </span>
          </div>
        )}

        {/* Comment */}
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Коментар</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="input" />
        </label>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}
