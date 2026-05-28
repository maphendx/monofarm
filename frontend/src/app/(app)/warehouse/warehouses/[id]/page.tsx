"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type WarehouseType = "raw" | "wip" | "finished" | "defect";
type Warehouse = { id: number; name: string; type: WarehouseType; location: string | null; is_active: boolean };

type Zone = { id: number; name: string; rows: number; cols: number; sort_order: number; cell_count: number };
type CellStockItem = { product_id: number; product_name: string; product_sku: string; quantity: string };
type Cell = { id: number; code: string; notes: string | null; stock: CellStockItem[] };
type ZoneWithCells = Zone & { cells: Cell[] };

type Product = { id: number; name: string; sku: string };

const TYPE_LABEL: Record<WarehouseType, string> = {
  finished: "Готова продукція", raw: "Сировина", wip: "В процесі", defect: "Брак",
};

// ── ZoneModal — create / edit ─────────────────────────────────────────────────

function ZoneModal({
  zone, onClose, onSaved,
}: {
  zone: Zone | null;
  onClose: () => void;
  onSaved: (z: Zone) => void;
}) {
  const params = useParams<{ id: string }>();
  const [name,  setName]  = useState(zone?.name ?? "");
  const [rows,  setRows]  = useState(zone?.rows  ?? 5);
  const [cols,  setCols]  = useState(zone?.cols  ?? 5);
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = { name: name.trim(), rows, cols };
      const saved = zone
        ? await api<Zone>(`/api/warehouse/warehouses/${params.id}/zones/${zone.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<Zone>(`/api/warehouse/warehouses/${params.id}/zones`, { method: "POST", body: JSON.stringify(body) });
      onSaved(saved);
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  const willResize = zone && (rows !== zone.rows || cols !== zone.cols);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-2xl">
        <h2 className="mb-4 font-semibold">{zone ? "Редагувати стелаж" : "Новий стелаж"}</h2>
        <form onSubmit={save} className="space-y-4 text-sm">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Назва</span>
            <input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-[var(--border-strong)]" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)]">Рядки</span>
              <input type="number" min={1} max={50} value={rows} onChange={(e) => setRows(parseInt(e.target.value) || 1)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-[var(--border-strong)]" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)]">Стовпці</span>
              <input type="number" min={1} max={50} value={cols} onChange={(e) => setCols(parseInt(e.target.value) || 1)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-[var(--border-strong)]" />
            </label>
          </div>
          <p className="text-xs text-[var(--text-faint)]">
            Буде {zone ? "залишено" : "згенеровано"} {rows * cols} комірок: A1…{String.fromCharCode(64 + cols)}{rows}
          </p>
          {willResize && (
            <div className="rounded-lg border border-[rgba(239,68,68,.3)] bg-[rgba(239,68,68,.06)] px-3 py-2 text-xs text-[var(--state-error)]">
              Зміна розміру видалить усі поточні комірки. Якщо в них є товари — отримаєш помилку. Спочатку очистіть комірки.
            </div>
          )}
          {err && <p className="text-[var(--state-error)] text-sm">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost">Скасувати</button>
            <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary disabled:opacity-50">
              {busy ? "Зберігаю…" : zone ? "Зберегти" : "Створити"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── CellModal — multi-product per cell ────────────────────────────────────────

function CellModal({
  cell, products, onClose, onSaved,
}: {
  cell: Cell;
  products: Product[];
  onClose: () => void;
  onSaved: (cell: Cell) => void;
}) {
  const [stock,      setStock]      = useState<CellStockItem[]>(cell.stock);
  const [addPid,     setAddPid]     = useState<string>("");
  const [addQty,     setAddQty]     = useState("1");
  const [busy,       setBusy]       = useState(false);
  const [removeBusy, setRemoveBusy] = useState<number | null>(null);
  const [err,        setErr]        = useState<string | null>(null);
  const inFlight = useRef(false);

  const usedIds = new Set(stock.map((s) => s.product_id));
  const available = products.filter((p) => !usedIds.has(p.id));

  async function addOrUpdate(pid: number, qty: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setErr(null);
    try {
      const updated = await api<CellStockItem>(`/api/warehouse/cells/${cell.id}/stock`, {
        method: "PUT",
        body: JSON.stringify({ product_id: pid, quantity: qty }),
      });
      setStock((prev) => {
        const idx = prev.findIndex((s) => s.product_id === pid);
        return idx >= 0 ? prev.map((s, i) => i === idx ? updated : s) : [...prev, updated];
      });
      setAddPid(""); setAddQty("1");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Помилка збереження");
    } finally { inFlight.current = false; setBusy(false); }
  }

  async function removeProduct(pid: number) {
    setRemoveBusy(pid);
    try {
      await api(`/api/warehouse/cells/${cell.id}/stock/${pid}`, { method: "DELETE" });
      setStock((prev) => prev.filter((s) => s.product_id !== pid));
    } finally { setRemoveBusy(null); }
  }

  function handleClose() {
    onSaved({ ...cell, stock });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="font-semibold">Комірка {cell.code}</h2>
            {cell.notes && <p className="text-xs text-[var(--text-faint)]">{cell.notes}</p>}
          </div>
          <button onClick={handleClose}
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">×</button>
        </div>

        {/* Current stock */}
        <div className="px-5 py-4 space-y-2">
          {stock.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">Комірка порожня</p>
          ) : (
            <div className="space-y-1">
              {stock.map((s) => (
                <div key={s.product_id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">{s.product_name}</p>
                    <p className="font-mono text-xs text-[var(--text-faint)]">{s.product_sku}</p>
                  </div>
                  <input
                    type="number" min="0" step="0.01"
                    defaultValue={parseFloat(s.quantity)}
                    onBlur={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v !== parseFloat(s.quantity)) addOrUpdate(s.product_id, v);
                    }}
                    className="w-20 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={() => removeProduct(s.product_id)}
                    disabled={removeBusy === s.product_id}
                    className="flex size-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)] disabled:opacity-40">
                    {removeBusy === s.product_id ? "…" : "×"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add product */}
          {available.length > 0 && (
            <div className="flex gap-2 pt-1">
              <select
                value={addPid}
                onChange={(e) => setAddPid(e.target.value)}
                className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]">
                <option value="">+ Додати товар…</option>
                {available.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {addPid && (
                <>
                  <input
                    type="number" min="0" step="0.01" value={addQty}
                    onChange={(e) => setAddQty(e.target.value)}
                    className="w-20 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={() => addOrUpdate(parseInt(addPid), parseFloat(addQty) || 0)}
                    disabled={busy}
                    className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50">
                    {busy ? "…" : "OK"}
                  </button>
                </>
              )}
            </div>
          )}

          {err && <p className="text-sm text-[var(--state-error)]">{err}</p>}
        </div>

        <div className="flex justify-end border-t border-[var(--border)] px-5 py-3">
          <button onClick={handleClose} className="btn btn-primary">Готово</button>
        </div>
      </div>
    </div>
  );
}

// ── ZoneAccordion ─────────────────────────────────────────────────────────────

function ZoneAccordion({
  zone: initialZone, products,
  onEdit, onDelete,
}: {
  zone: Zone;
  products: Product[];
  onEdit: (z: Zone) => void;
  onDelete: (id: number) => void;
}) {
  const [open,       setOpen]       = useState(false);
  const [zoneData,   setZoneData]   = useState<ZoneWithCells | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [activeCell, setActiveCell] = useState<Cell | null>(null);
  const [search,     setSearch]     = useState("");

  async function load() {
    if (zoneData) return;
    setLoading(true);
    try {
      const data = await api<ZoneWithCells>(`/api/warehouse/zones/${initialZone.id}/cells`);
      setZoneData(data);
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (!open) load();
    setOpen((v) => !v);
  }

  function handleCellSaved(updated: Cell) {
    setZoneData((prev) => prev
      ? { ...prev, cells: prev.cells.map((c) => c.id === updated.id ? updated : c) }
      : prev
    );
  }

  const cells = zoneData?.cells ?? [];
  const q = search.trim().toLowerCase();

  function cellMatches(cell: Cell) {
    if (!q) return false;
    return cell.stock.some(
      (s) => s.product_name.toLowerCase().includes(q) || s.product_sku.toLowerCase().includes(q)
    );
  }

  const hasSearch = q.length > 0;
  const matchCount = hasSearch ? cells.filter(cellMatches).length : 0;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5">
        <button onClick={toggle} className="flex flex-1 items-center gap-3 text-left">
          <span className={["text-xs transition-transform", open ? "rotate-90" : ""].join(" ")}>▶</span>
          <span className="font-medium">{initialZone.name}</span>
          <span className="text-xs text-[var(--text-faint)]">
            {initialZone.rows} × {initialZone.cols} = {initialZone.cell_count} комірок
          </span>
        </button>
        <button onClick={() => onEdit(initialZone)} title="Редагувати"
          className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button onClick={() => onDelete(initialZone.id)} title="Видалити"
          className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>

      {/* Grid */}
      {open && (
        <div className="border-t border-[var(--border)] p-4 space-y-3">
          {/* Search */}
          <div className="relative">
            <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="search"
              placeholder="Знайти товар у стелажі…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]"
            />
            {hasSearch && (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-faint)]">
                {matchCount > 0 ? `${matchCount} комірок` : "не знайдено"}
              </span>
            )}
          </div>

          {loading ? (
            <p className="text-sm text-[var(--text-faint)]">Завантаження…</p>
          ) : (
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${initialZone.cols}, minmax(0, 1fr))` }}
            >
              {cells.map((cell) => {
                const matched = hasSearch && cellMatches(cell);
                const dimmed  = hasSearch && !matched;
                const filled  = cell.stock.length > 0;
                const multi   = cell.stock.length > 1;

                return (
                  <button
                    key={cell.id}
                    onClick={() => setActiveCell(cell)}
                    className={[
                      "group relative flex min-h-[56px] flex-col items-start justify-between rounded-lg border p-2 text-left transition-all",
                      matched
                        ? "border-[var(--state-ok)] bg-[rgba(34,197,94,.10)] ring-1 ring-[var(--state-ok)]"
                        : filled
                          ? "border-[var(--accent)] bg-[rgba(34,211,238,.06)] hover:bg-[rgba(34,211,238,.10)]"
                          : "border-[var(--border)] bg-[var(--bg)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]",
                      dimmed ? "opacity-30" : "",
                    ].join(" ")}
                  >
                    <div className="flex w-full items-start justify-between">
                      <span className="font-mono text-[10px] font-semibold text-[var(--text-faint)]">{cell.code}</span>
                      {multi && (
                        <span className="rounded-full bg-[var(--accent)] px-1.5 text-[9px] font-bold text-white leading-4">
                          {cell.stock.length}
                        </span>
                      )}
                    </div>
                    {filled ? (
                      <div className="w-full min-w-0">
                        <p className="truncate text-[11px] font-medium leading-tight text-[var(--text)]">
                          {cell.stock[0].product_name}
                          {multi && <span className="text-[var(--text-faint)]">{" "}+{cell.stock.length - 1}</span>}
                        </p>
                        <p className="font-mono text-[10px] text-[var(--accent)]">
                          {cell.stock.reduce((s, i) => s + parseFloat(i.quantity), 0)} шт
                        </p>
                      </div>
                    ) : (
                      <span className="text-[10px] text-[var(--text-faint)] opacity-0 group-hover:opacity-100">+</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeCell && (
        <CellModal
          cell={activeCell}
          products={products}
          onClose={() => setActiveCell(null)}
          onSaved={(updated) => { handleCellSaved(updated); setActiveCell(null); }}
        />
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WarehouseDetailPage() {
  const params  = useParams<{ id: string }>();
  const router  = useRouter();
  const whId    = parseInt(params.id);

  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [zones,     setZones]     = useState<Zone[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [zoneModal, setZoneModal] = useState<Zone | null | "create">(null);

  const load = useCallback(async () => {
    try {
      const [whs, zs, prods] = await Promise.all([
        api<Warehouse[]>("/api/warehouse/warehouses"),
        api<Zone[]>(`/api/warehouse/warehouses/${whId}/zones`),
        api<Product[]>("/api/warehouse/products"),
      ]);
      setWarehouse(whs.find((w) => w.id === whId) ?? null);
      setZones(zs);
      setProducts(prods);
    } finally {
      setLoading(false);
    }
  }, [whId]);

  useEffect(() => { load(); }, [load]);

  async function deleteZone(id: number) {
    if (!window.confirm("Видалити стелаж і всі його комірки?")) return;
    try {
      await api(`/api/warehouse/warehouses/${whId}/zones/${id}`, { method: "DELETE" });
      setZones((prev) => prev.filter((z) => z.id !== id));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Помилка видалення");
    }
  }

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;
  if (!warehouse) return <div className="text-sm text-[var(--state-error)]">Склад не знайдено</div>;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()}
          className="flex size-8 items-center justify-center rounded-lg text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
          ←
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold truncate">{warehouse.name}</h1>
          <p className="text-xs text-[var(--text-faint)]">
            {TYPE_LABEL[warehouse.type]}{warehouse.location ? ` · ${warehouse.location}` : ""}
          </p>
        </div>
        <button onClick={() => setZoneModal("create")} className="btn btn-primary">
          + Стелаж
        </button>
      </div>

      {/* Zones */}
      {zones.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-16 text-center">
          <p className="text-sm text-[var(--text-muted)]">Стелажів ще немає</p>
          <button onClick={() => setZoneModal("create")} className="mt-3 btn btn-primary">
            Додати перший стелаж
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {zones.map((z) => (
            <ZoneAccordion
              key={z.id}
              zone={z}
              products={products}
              onEdit={(zone) => setZoneModal(zone)}
              onDelete={deleteZone}
            />
          ))}
        </div>
      )}

      {zoneModal !== null && (
        <ZoneModal
          zone={zoneModal === "create" ? null : zoneModal}
          onClose={() => setZoneModal(null)}
          onSaved={(saved) => {
            setZones((prev) => {
              const idx = prev.findIndex((z) => z.id === saved.id);
              return idx >= 0 ? prev.map((z) => z.id === saved.id ? saved : z) : [...prev, saved];
            });
            setZoneModal(null);
          }}
        />
      )}
    </div>
  );
}
