"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useConfirm } from "@/hooks/useConfirm";
import { CellCombobox } from "@/components/warehouse/CellCombobox";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";
import { WarehouseLabelModal, type WarehouseLabelItem } from "@/components/warehouse/WarehouseLabelModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type WarehouseType = "raw" | "wip" | "finished" | "defect";
type Warehouse = { id: number; name: string; type: WarehouseType; location: string | null; is_active: boolean };

type Zone = { id: number; name: string; rows: number; cols: number; sort_order: number; cell_count: number };
type CellStockItem = { product_id: number; product_name: string; product_sku: string; quantity: string; image_url?: string | null };
type Cell = { id: number; code: string; notes: string | null; stock: CellStockItem[] };
type ZoneWithCells = Zone & { cells: Cell[] };

type Unassigned = { product_id: number; product_name: string; product_sku: string; unit: string; unassigned: string };
type FlatCell = { id: number; label: string; zone?: string };

const TYPE_LABEL: Record<WarehouseType, string> = {
  finished: "Готова продукція", raw: "Сировина", wip: "В процесі", defect: "Брак",
};

const num = (s: string) => parseFloat(s) || 0;

// ── ZoneModal — create / edit ─────────────────────────────────────────────────

function ZoneModal({
  zone, onClose, onSaved,
}: {
  zone: Zone | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const params = useParams<{ id: string }>();
  const [name,  setName]  = useState(zone?.name ?? "");
  const [rows,  setRows]  = useState(zone?.rows  ?? 5);
  const [cols,  setCols]  = useState(zone?.cols  ?? 5);
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState<string | null>(null);

  const willResize = zone && (rows !== zone.rows || cols !== zone.cols);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      // Only send rows/cols when they actually change, so renaming a zone with
      // stocked cells isn't blocked and cell notes aren't wiped.
      const body: Record<string, unknown> = { name: name.trim() };
      if (!zone || willResize) { body.rows = rows; body.cols = cols; }
      await (zone
        ? api(`/api/warehouse/warehouses/${params.id}/zones/${zone.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : api(`/api/warehouse/warehouses/${params.id}/zones`, { method: "POST", body: JSON.stringify(body) }));
      onSaved();
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

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

// ── PutawayModal — assign unassigned floor stock into a cell ───────────────────

function PutawayModal({
  item, cells, onClose, onDone,
}: {
  item: Unassigned;
  cells: FlatCell[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [cellId, setCellId] = useState<string>(cells[0] ? String(cells[0].id) : "");
  const [qty,    setQty]    = useState(item.unassigned);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState<string | null>(null);
  const inFlight = useRef(false);
  const max = num(item.unassigned);

  async function save() {
    if (inFlight.current || !cellId) return;
    inFlight.current = true; setBusy(true); setErr(null);
    try {
      await api(`/api/warehouse/cells/${cellId}/putaway`, {
        method: "POST",
        body: JSON.stringify({ product_id: item.product_id, quantity: num(qty) }),
      });
      onDone(); onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Помилка");
    } finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-2xl space-y-4 text-sm">
        <div>
          <h2 className="font-semibold">Розкласти товар</h2>
          <p className="text-xs text-[var(--text-faint)]">{item.product_name} · нерозкладено {item.unassigned} {item.unit}</p>
        </div>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Комірка</span>
          <CellCombobox cells={cells} value={cellId} onChange={setCellId} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Кількість</span>
          <input type="number" min="0" max={max} step="0.01" value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-right font-mono outline-none focus:border-[var(--border-strong)]" />
        </label>
        {err && <p className="text-[var(--state-error)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="btn btn-ghost">Скасувати</button>
          <button onClick={save} disabled={busy || !cellId || num(qty) <= 0 || num(qty) > max}
            className="btn btn-primary disabled:opacity-50">{busy ? "…" : "Розкласти"}</button>
        </div>
      </div>
    </div>
  );
}

// ── RelocateModal — move a product between cells ───────────────────────────────

function RelocateModal({
  productId, productName, fromCellId, available, cells, onClose, onDone,
}: {
  productId: number;
  productName: string;
  fromCellId: number;
  available: number;
  cells: FlatCell[];
  onClose: () => void;
  onDone: () => void;
}) {
  const targets = cells.filter((c) => c.id !== fromCellId);
  const [toId, setToId] = useState<string>(targets[0] ? String(targets[0].id) : "");
  const [qty,  setQty]  = useState(String(available));
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);
  const inFlight = useRef(false);

  async function save() {
    if (inFlight.current || !toId) return;
    inFlight.current = true; setBusy(true); setErr(null);
    try {
      await api(`/api/warehouse/cells/relocate`, {
        method: "POST",
        body: JSON.stringify({ product_id: productId, from_cell_id: fromCellId, to_cell_id: parseInt(toId), quantity: num(qty) }),
      });
      onDone(); onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Помилка");
    } finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-2xl space-y-4 text-sm">
        <div>
          <h2 className="font-semibold">Перемістити в іншу комірку</h2>
          <p className="text-xs text-[var(--text-faint)]">{productName} · у комірці {available}</p>
        </div>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Куди</span>
          <CellCombobox cells={targets} value={toId} onChange={setToId} placeholder="Комірка призначення…" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Кількість</span>
          <input type="number" min="0" max={available} step="0.01" value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-right font-mono outline-none focus:border-[var(--border-strong)]" />
        </label>
        {err && <p className="text-[var(--state-error)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="btn btn-ghost">Скасувати</button>
          <button onClick={save} disabled={busy || !toId || num(qty) <= 0 || num(qty) > available}
            className="btn btn-primary disabled:opacity-50">{busy ? "…" : "Перемістити"}</button>
        </div>
      </div>
    </div>
  );
}

// ── CellModal — manage stock inside one cell ───────────────────────────────────

type AllProduct = { id: number; name: string; sku: string; unit: string };

function CellModal({
  cell, zoneName, unassigned, flatCells, onClose, onChanged,
}: {
  cell: Cell;
  zoneName: string;
  unassigned: Unassigned[];
  flatCells: FlatCell[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [stock,          setStock]          = useState<CellStockItem[]>(cell.stock);
  const [addPid,         setAddPid]         = useState<string>("");
  const [addQty,         setAddQty]         = useState("1");
  const [busy,           setBusy]           = useState(false);
  const [removeBusy,     setRemoveBusy]     = useState<number | null>(null);
  const [relocate,       setRelocate]       = useState<CellStockItem | null>(null);
  const [notes,          setNotes]          = useState(cell.notes ?? "");
  const [err,            setErr]            = useState<string | null>(null);
  const [showLabelModal, setShowLabelModal] = useState(false);

  // assign any product (not just unassigned pool)
  const [assignOpen,   setAssignOpen]   = useState(false);
  const [allProducts,  setAllProducts]  = useState<AllProduct[]>([]);
  const [assignSearch, setAssignSearch] = useState("");
  const [assignPid,    setAssignPid]    = useState<number | null>(null);
  const [assignQty,    setAssignQty]    = useState("1");
  const [assignBusy,   setAssignBusy]   = useState(false);

  const inFlight = useRef(false);

  function saveNotes() {
    if ((notes.trim() || null) === (cell.notes ?? null)) return;
    api(`/api/warehouse/cells/${cell.id}`, { method: "PATCH", body: JSON.stringify({ notes: notes.trim() }) })
      .then(() => onChanged())
      .catch(() => {});
  }

  function openAssign() {
    setAssignOpen(true);
    setAssignSearch(""); setAssignPid(null); setAssignQty("1");
    if (allProducts.length === 0)
      api<AllProduct[]>("/api/warehouse/products").then(setAllProducts).catch(() => {});
  }

  async function submitAssign() {
    if (!assignPid || assignBusy) return;
    setAssignBusy(true); setErr(null);
    try {
      const item = await api<CellStockItem>(`/api/warehouse/cells/${cell.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ product_id: assignPid, quantity: parseFloat(assignQty) || 0 }),
      });
      setStock((prev) => {
        const idx = prev.findIndex((s) => s.product_id === item.product_id);
        return idx >= 0 ? prev.map((s, i) => i === idx ? item : s) : [...prev, item];
      });
      setAssignOpen(false); setAssignPid(null); setAssignQty("1");
      onChanged();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Помилка");
    } finally { setAssignBusy(false); }
  }

  const usedIds = new Set(stock.map((s) => s.product_id));
  const addable = unassigned.filter((u) => num(u.unassigned) > 0 && !usedIds.has(u.product_id));
  const addCap  = addPid ? num(unassigned.find((u) => u.product_id === parseInt(addPid))?.unassigned ?? "0") : 0;

  function setQty(pid: number, qty: number) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setErr(null);
    api<CellStockItem>(`/api/warehouse/cells/${cell.id}/stock`, {
      method: "PUT",
      body: JSON.stringify({ product_id: pid, quantity: qty }),
    }).then((updated) => {
      setStock((prev) => prev.map((s) => s.product_id === pid ? updated : s));
      onChanged();
    }).catch((e: unknown) => {
      setErr(e instanceof Error ? e.message : "Помилка");
    }).finally(() => { inFlight.current = false; setBusy(false); });
  }

  function addProduct(pid: number, qty: number) {
    if (inFlight.current || !pid) return;
    inFlight.current = true; setBusy(true); setErr(null);
    api<CellStockItem>(`/api/warehouse/cells/${cell.id}/putaway`, {
      method: "POST",
      body: JSON.stringify({ product_id: pid, quantity: qty }),
    }).then((updated) => {
      setStock((prev) => {
        const idx = prev.findIndex((s) => s.product_id === pid);
        return idx >= 0 ? prev.map((s, i) => i === idx ? updated : s) : [...prev, updated];
      });
      setAddPid(""); setAddQty("1");
      onChanged();
    }).catch((e: unknown) => {
      setErr(e instanceof Error ? e.message : "Помилка");
    }).finally(() => { inFlight.current = false; setBusy(false); });
  }

  async function removeProduct(pid: number) {
    setRemoveBusy(pid);
    try {
      await api(`/api/warehouse/cells/${cell.id}/stock/${pid}`, { method: "DELETE" });
      setStock((prev) => prev.filter((s) => s.product_id !== pid));
      onChanged();
    } finally { setRemoveBusy(null); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl">

        {/* Header */}
        <div className="flex items-start justify-between border-b border-[var(--border)] px-5 py-4 gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            {/* QR code — click opens label modal */}
            <div className="shrink-0 cursor-pointer" title="Налаштувати та надрукувати мітку"
              onClick={() => setShowLabelModal(true)}>
              <QRCode value={`CELL:${cell.id}`} size={64} level="M" />
              <p className="mt-0.5 text-center font-mono text-[9px] text-[var(--text-faint)]">🏷 мітка</p>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">Комірка {cell.code}</h2>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={saveNotes}
                placeholder="Нотатка (напр. верхня полиця)…"
                className="mt-0.5 w-full bg-transparent text-xs text-[var(--text-faint)] outline-none placeholder:text-[var(--text-faint)] focus:text-[var(--text)]"
              />
            </div>
          </div>
          <button onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">×</button>
        </div>

        {/* Current stock */}
        <div className="px-5 py-4 space-y-2">
          {stock.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">Комірка порожня</p>
          ) : (
            <div className="space-y-1">
              {stock.map((s) => (
                <div key={s.product_id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
                  {s.image_url && (
                    <img src={s.image_url} alt="" loading="lazy" decoding="async" className="size-10 shrink-0 rounded object-contain" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">{s.product_name}</p>
                    <p className="font-mono text-xs text-[var(--text-faint)]">{s.product_sku}</p>
                  </div>
                  <input
                    type="number" min="0" step="0.01"
                    defaultValue={num(s.quantity)}
                    onBlur={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v !== num(s.quantity)) setQty(s.product_id, v);
                    }}
                    className="w-20 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={() => setRelocate(s)} title="Перемістити в іншу комірку"
                    className="flex size-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
                    </svg>
                  </button>
                  <button
                    onClick={() => removeProduct(s.product_id)}
                    disabled={removeBusy === s.product_id} title="Прибрати (повернути в нерозкладене)"
                    className="flex size-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)] disabled:opacity-40">
                    {removeBusy === s.product_id ? "…" : "×"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add from the unassigned pool */}
          {addable.length > 0 ? (
            <div className="flex gap-2 pt-1">
              <select
                value={addPid}
                onChange={(e) => { setAddPid(e.target.value); setAddQty("1"); }}
                className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]">
                <option value="">+ Розкласти сюди…</option>
                {addable.map((u) => (
                  <option key={u.product_id} value={u.product_id}>{u.product_name} ({u.unassigned})</option>
                ))}
              </select>
              {addPid && (
                <>
                  <input
                    type="number" min="0" max={addCap} step="0.01" value={addQty}
                    onChange={(e) => setAddQty(e.target.value)}
                    className="w-20 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={() => addProduct(parseInt(addPid), num(addQty))}
                    disabled={busy || num(addQty) <= 0 || num(addQty) > addCap}
                    className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50">
                    {busy ? "…" : "OK"}
                  </button>
                </>
              )}
            </div>
          ) : (
            <p className="pt-1 text-xs text-[var(--text-faint)]">
              Немає нерозкладеного товару на цьому складі — спершу зробіть «Отримання».
            </p>
          )}

          {/* Assign any product from catalog */}
          {!assignOpen ? (
            <button
              type="button"
              onClick={openAssign}
              className="mt-1 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-2 text-xs text-[var(--text-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
            >
              <span className="text-base leading-none">+</span>
              Призначити номенклатуру
            </button>
          ) : (
            <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg)] p-3 space-y-2">
              <p className="text-xs font-medium text-[var(--text-muted)]">Призначити номенклатуру</p>
              <input
                type="search"
                autoFocus
                placeholder="Пошук товару…"
                value={assignSearch}
                onChange={(e) => { setAssignSearch(e.target.value); setAssignPid(null); }}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]"
              />
              {assignSearch.trim().length >= 1 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]">
                  {allProducts
                    .filter((p) => {
                      const q = assignSearch.toLowerCase();
                      return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
                    })
                    .slice(0, 20)
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setAssignPid(p.id); setAssignSearch(`${p.sku} · ${p.name}`); }}
                        className={[
                          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-hi)]",
                          assignPid === p.id ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "",
                        ].join(" ")}
                      >
                        <span className="font-mono text-xs text-[var(--text-faint)]">{p.sku}</span>
                        <span className="truncate">{p.name}</span>
                      </button>
                    ))}
                  {allProducts.filter((p) => {
                    const q = assignSearch.toLowerCase();
                    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
                  }).length === 0 && (
                    <p className="px-3 py-2 text-xs text-[var(--text-faint)]">Нічого не знайдено</p>
                  )}
                </div>
              )}
              {assignPid && (
                <div className="flex gap-2">
                  <input
                    type="number" min="0" step="0.01" value={assignQty}
                    onChange={(e) => setAssignQty(e.target.value)}
                    className="w-24 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-right font-mono text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    type="button"
                    onClick={submitAssign}
                    disabled={assignBusy || !(parseFloat(assignQty) >= 0)}
                    className="flex-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {assignBusy ? "…" : "Призначити"}
                  </button>
                  <button type="button" onClick={() => setAssignOpen(false)}
                    className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
                    ✕
                  </button>
                </div>
              )}
            </div>
          )}

          {err && <p className="text-sm text-[var(--state-error)]">{err}</p>}
        </div>

        <div className="flex justify-end border-t border-[var(--border)] px-5 py-3">
          <button onClick={onClose} className="btn btn-primary">Готово</button>
        </div>
      </div>

      {relocate && (
        <RelocateModal
          productId={relocate.product_id}
          productName={relocate.product_name}
          fromCellId={cell.id}
          available={num(relocate.quantity)}
          cells={flatCells}
          onClose={() => setRelocate(null)}
          onDone={() => { setRelocate(null); onChanged(); onClose(); }}
        />
      )}

      {showLabelModal && (
        <WarehouseLabelModal
          items={[{ type: "cell", id: cell.id, code: cell.code, zone_name: zoneName, notes: cell.notes }]}
          onClose={() => setShowLabelModal(false)}
        />
      )}
    </div>
  );
}

// ── ZoneAccordion ─────────────────────────────────────────────────────────────

// ── fill-level helpers ────────────────────────────────────────────────────────

type FillLevel = 0 | 1 | 2 | 3 | 4 | "r";

function cellFillLevel(cell: Cell): FillLevel {
  if (cell.stock.length === 0) return 0;
  const total = cell.stock.reduce((s, i) => s + num(i.quantity), 0);
  if (total === 0) return "r";
  if (total <= 5)  return 1;
  if (total <= 20) return 2;
  if (total <= 80) return 3;
  return 4;
}

const FILL_CELL_CLS: Record<string, string> = {
  "0": "border-dashed border-[var(--border)] bg-transparent hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]",
  "r": "border-[rgba(245,158,11,.28)] bg-[rgba(245,158,11,.05)] hover:bg-[rgba(245,158,11,.09)]",
  "1": "border-[rgba(34,211,238,.22)] bg-[rgba(34,211,238,.04)] hover:bg-[rgba(34,211,238,.09)]",
  "2": "border-[rgba(34,211,238,.42)] bg-[rgba(34,211,238,.08)] hover:bg-[rgba(34,211,238,.13)]",
  "3": "border-[rgba(34,211,238,.65)] bg-[rgba(34,211,238,.13)] hover:bg-[rgba(34,211,238,.19)]",
  "4": "border-[var(--accent)] bg-[rgba(34,211,238,.20)] hover:bg-[rgba(34,211,238,.27)]",
};

const FILL_BAR_COLOR: Record<string, string> = {
  "0": "", "r": "rgba(245,158,11,.55)",
  "1": "rgba(34,211,238,.40)", "2": "rgba(34,211,238,.58)",
  "3": "rgba(34,211,238,.76)", "4": "var(--accent)",
};

// mini-map dot color per fill level
const MM_DOT: Record<string, string> = {
  "0": "rgba(255,255,255,.06)",
  "r": "rgba(245,158,11,.55)",
  "1": "rgba(34,211,238,.30)",
  "2": "rgba(34,211,238,.50)",
  "3": "rgba(34,211,238,.72)",
  "4": "rgb(34,211,238)",
};

function ZoneAccordion({
  zone, unassigned, flatCells, onEdit, onDelete, onChanged,
}: {
  zone: ZoneWithCells;
  unassigned: Unassigned[];
  flatCells: FlatCell[];
  onEdit: (z: Zone) => void;
  onDelete: (id: number) => void;
  onChanged: () => void;
}) {
  const [open,        setOpen]       = useState(true);
  const [activeCell,  setActiveCell] = useState<Cell | null>(null);
  const [search,      setSearch]     = useState("");
  const [density,     setDensity]    = useState<"compact" | "comfy">("compact");
  const [labelItems,  setLabelItems] = useState<WarehouseLabelItem[] | null>(null);

  const cells = zone.cells;
  const q = search.trim().toLowerCase();

  function cellMatches(cell: Cell) {
    if (!q) return false;
    return cell.stock.some(
      (s) => s.product_name.toLowerCase().includes(q) || s.product_sku.toLowerCase().includes(q)
    );
  }

  const hasSearch  = q.length > 0;
  const matchCount = hasSearch ? cells.filter(cellMatches).length : 0;
  const filledCount = cells.filter((c) => c.stock.length > 0).length;
  const fillPct = zone.cell_count > 0 ? Math.round((filledCount / zone.cell_count) * 100) : 0;

  // compact cell size
  const cellW = density === "compact" ? 90 : 140;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setOpen((v) => !v)} className="flex flex-1 items-center gap-2.5 text-left min-w-0">
          <span className={["text-[10px] text-[var(--text-faint)] transition-transform shrink-0", open ? "rotate-90" : ""].join(" ")}>▶</span>
          <span className="font-semibold truncate">{zone.name}</span>
          <span className="text-xs text-[var(--text-faint)] shrink-0">{zone.rows}×{zone.cols}</span>

          {/* mini-map */}
          <div
            className="hidden sm:grid gap-px shrink-0"
            style={{ gridTemplateColumns: `repeat(${Math.min(zone.cols, 24)}, 4px)` }}
          >
            {cells.slice(0, zone.rows * Math.min(zone.cols, 24)).map((c) => (
              <span key={c.id} style={{ width: 4, height: 4, borderRadius: 1, background: MM_DOT[String(cellFillLevel(c))] }} />
            ))}
          </div>

          {/* fill bar + stat */}
          <div className="hidden md:flex items-center gap-2 shrink-0">
            <div className="w-20 h-[5px] rounded-full bg-[var(--surface-hi)] overflow-hidden">
              <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${fillPct}%` }} />
            </div>
            <span className="font-mono text-[10.5px] text-[var(--text-faint)] whitespace-nowrap">
              <b className="text-[var(--text-hi)]">{filledCount}</b>/{zone.cell_count} · {fillPct}%
            </span>
          </div>
        </button>

        {/* actions */}
        <button onClick={() => onEdit(zone)} title="Редагувати"
          className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] shrink-0">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button title="Мітки QR для всіх комірок"
          onClick={() => setLabelItems(cells.map(c => ({ type: "cell" as const, id: c.id, code: c.code, zone_name: zone.name, notes: c.notes })))}
          className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] shrink-0">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
            <rect x="6" y="14" width="12" height="8"/>
          </svg>
        </button>
        <button onClick={() => onDelete(zone.id)} title="Видалити"
          className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)] shrink-0">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>

      {/* ── Body ── */}
      {open && (
        <div className="border-t border-[var(--border)] p-4 space-y-3">
          {/* toolbar: search + density toggle */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
                width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input type="search" placeholder="Знайти товар…" value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] pl-7 pr-3 text-xs outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]"
              />
              {hasSearch && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-faint)]">
                  {matchCount > 0 ? `${matchCount}` : "—"}
                </span>
              )}
            </div>
            {/* density toggle */}
            <div className="flex rounded-md border border-[var(--border)] overflow-hidden shrink-0">
              <button onClick={() => setDensity("compact")} title="Компактно"
                className={`px-2 py-1.5 text-xs transition ${density === "compact" ? "bg-[var(--surface-2)] text-[var(--text-hi)]" : "text-[var(--text-faint)] hover:bg-[var(--surface-hi)]"}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              </button>
              <button onClick={() => setDensity("comfy")} title="Детально"
                className={`px-2 py-1.5 text-xs transition border-l border-[var(--border)] ${density === "comfy" ? "bg-[var(--surface-2)] text-[var(--text-hi)]" : "text-[var(--text-faint)] hover:bg-[var(--surface-hi)]"}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="7" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/></svg>
              </button>
            </div>
            {/* fill legend */}
            <div className="hidden lg:flex items-center gap-1 shrink-0">
              <span className="text-[10px] text-[var(--text-faint)]">порожня</span>
              {["0","1","2","3","4"].map((l) => (
                <span key={l} style={{ width: 10, height: 10, borderRadius: 2, background: MM_DOT[l], border: l === "0" ? "1px dashed rgba(255,255,255,.12)" : "none" }} />
              ))}
              <span className="text-[10px] text-[var(--text-faint)]">заповнена</span>
            </div>
          </div>

          {/* grid with row/col headers */}
          <div className="overflow-x-auto">
            <div
              className="w-fit grid gap-1"
              style={{ gridTemplateColumns: `22px repeat(${zone.cols}, minmax(${cellW}px, 1fr))` }}
            >
              {/* column headers */}
              <div /> {/* corner */}
              {Array.from({ length: zone.cols }, (_, i) => (
                <div key={i} className="text-center font-mono text-[10px] text-[var(--text-faint)] pb-0.5">{i + 1}</div>
              ))}

              {/* rows */}
              {Array.from({ length: zone.rows }, (_, rowIdx) => {
                const rowLetter = String.fromCharCode(65 + rowIdx);
                return [
                  // row label
                  <div key={`r${rowIdx}`} className="flex items-center justify-center font-mono text-[10px] font-semibold text-[var(--text-faint)]">
                    {rowLetter}
                  </div>,
                  // cells in this row
                  ...Array.from({ length: zone.cols }, (_, colIdx) => {
                    const colNum = colIdx + 1;
                    const cell = cells.find((c) => c.code === `${rowLetter}${colNum}`);
                    if (!cell) return <div key={`${rowIdx}-${colIdx}`} className="rounded-lg border border-dashed border-[var(--border)] opacity-30" />;

                    const lvl      = cellFillLevel(cell);
                    const matched  = hasSearch && cellMatches(cell);
                    const dimmed   = hasSearch && !matched;
                    const filled   = cell.stock.length > 0;
                    const multi    = cell.stock.length > 1;
                    const totalQty = cell.stock.reduce((s, i) => s + num(i.quantity), 0);
                    const barW     = Math.min(totalQty / 100 * 100, 100);
                    const isLow    = filled && totalQty > 0 && totalQty <= 5;
                    const title    = filled
                      ? cell.stock.map((s) => `${s.product_name}: ${num(s.quantity)}`).join(", ")
                      : cell.code;

                    return (
                      <button
                        key={cell.id}
                        onClick={() => setActiveCell(cell)}
                        title={title}
                        className={[
                          "group relative flex flex-col justify-between rounded-lg border text-left transition-all overflow-hidden",
                          density === "compact" ? "min-h-[62px] p-2" : "min-h-[80px] p-2",
                          matched
                            ? "border-[var(--state-ok)] bg-[rgba(34,197,94,.12)] ring-1 ring-[var(--state-ok)]"
                            : FILL_CELL_CLS[String(lvl)],
                          dimmed ? "opacity-20 pointer-events-none" : "",
                        ].join(" ")}
                      >
                        {/* top row: code + badges */}
                        <div className="flex items-center justify-between gap-1 leading-none">
                          <span className="font-mono text-[9.5px] font-semibold text-[var(--text-faint)]">{cell.code}</span>
                          <span className="flex items-center gap-1">
                            {isLow && <span className="size-[5px] rounded-full bg-[var(--state-warn)] shrink-0" title="Залишок закінчується" />}
                            {multi && (
                              <span className="rounded-full bg-[var(--accent)] px-1 text-[8.5px] font-bold leading-[13px] text-[#06181c]">
                                {cell.stock.length}
                              </span>
                            )}
                          </span>
                        </div>

                        {/* body */}
                        {filled ? (
                          density === "comfy" ? (
                            <div className="flex items-center gap-1.5 mt-1 min-w-0">
                              {cell.stock[0].image_url && (
                                <img src={cell.stock[0].image_url} alt="" loading="lazy" decoding="async"
                                  className="size-7 shrink-0 rounded object-contain" />
                              )}
                              <div className="min-w-0 flex-1">
                                <p className="line-clamp-2 text-[10px] font-medium leading-tight text-[var(--text)]">
                                  {cell.stock[0].product_name}
                                  {multi && <span className="text-[var(--text-faint)]"> +{cell.stock.length - 1}</span>}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 mt-1 min-w-0">
                              {cell.stock[0].image_url && (
                                <img src={cell.stock[0].image_url} alt="" loading="lazy" decoding="async"
                                  className="size-6 shrink-0 rounded object-contain" />
                              )}
                              <div className="min-w-0">
                                <p className="truncate text-[10.5px] font-medium leading-tight text-[var(--text)]">
                                  {cell.stock[0].product_name}
                                  {multi && <span className="text-[var(--text-faint)]"> +{cell.stock.length - 1}</span>}
                                </p>
                                <p className="font-mono text-[10px] text-[var(--accent)]">{totalQty} шт</p>
                              </div>
                            </div>
                          )
                        ) : (
                          <span className="text-[10px] text-[var(--text-faint)] opacity-0 group-hover:opacity-60 transition-opacity">+</span>
                        )}

                        {/* fill bar at bottom */}
                        {filled && totalQty > 0 && (
                          <div className="absolute bottom-0 left-0 right-0 h-[2.5px]" style={{ background: "rgba(255,255,255,.05)" }}>
                            <div className="h-full transition-all" style={{ width: `${barW}%`, background: FILL_BAR_COLOR[String(lvl)] }} />
                          </div>
                        )}
                      </button>
                    );
                  }),
                ];
              })}
            </div>
          </div>
        </div>
      )}

      {activeCell && (
        <CellModal
          cell={activeCell}
          zoneName={zone.name}
          unassigned={unassigned}
          flatCells={flatCells}
          onClose={() => setActiveCell(null)}
          onChanged={onChanged}
        />
      )}

      {labelItems && (
        <WarehouseLabelModal items={labelItems} onClose={() => setLabelItems(null)} />
      )}
    </div>
  );
}

// ── UnassignedPanel ────────────────────────────────────────────────────────────

function UnassignedPanel({
  items, cells, onPutaway,
}: {
  items: Unassigned[];
  cells: FlatCell[];
  onPutaway: (item: Unassigned) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-[rgba(245,158,11,.3)] bg-[rgba(245,158,11,.05)] p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-[var(--state-warn)] text-[10px] font-bold text-black">
          {items.length}
        </span>
        <h2 className="text-sm font-semibold">Нерозкладено на складі</h2>
        <span className="text-xs text-[var(--text-faint)]">потребує розкладки по комірках</span>
      </div>
      <div className="space-y-1">
        {items.map((it) => (
          <div key={it.product_id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium">{it.product_name}</p>
              <p className="font-mono text-xs text-[var(--text-faint)]">{it.product_sku}</p>
            </div>
            <span className="font-mono text-sm font-semibold tabular-nums">{it.unassigned} {it.unit}</span>
            <button
              onClick={() => onPutaway(it)}
              disabled={cells.length === 0}
              className="btn btn-ghost text-xs disabled:opacity-40"
              title={cells.length === 0 ? "Спершу створіть стелаж" : undefined}>
              Розкласти
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WarehouseDetailPage() {
  const params  = useParams<{ id: string }>();
  const router  = useRouter();
  const { confirm, dialog } = useConfirm();
  const whId    = parseInt(params.id);

  const [warehouse,  setWarehouse]  = useState<Warehouse | null>(null);
  const [zones,      setZones]      = useState<ZoneWithCells[]>([]);
  const [unassigned, setUnassigned] = useState<Unassigned[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [zoneModal,  setZoneModal]  = useState<Zone | null | "create">(null);
  const [putaway,    setPutaway]    = useState<Unassigned | null>(null);

  const loadZones = useCallback(async () => {
    const zs = await api<Zone[]>(`/api/warehouse/warehouses/${whId}/zones`);
    const full = await Promise.all(
      zs.map((z) => api<ZoneWithCells>(`/api/warehouse/zones/${z.id}/cells`))
    );
    setZones(full);
  }, [whId]);

  const loadUnassigned = useCallback(async () => {
    setUnassigned(await api<Unassigned[]>(`/api/warehouse/warehouses/${whId}/unassigned`));
  }, [whId]);

  const load = useCallback(async () => {
    try {
      const whs = await api<Warehouse[]>("/api/warehouse/warehouses");
      setWarehouse(whs.find((w) => w.id === whId) ?? null);
      await Promise.all([loadZones(), loadUnassigned()]);
    } finally {
      setLoading(false);
    }
  }, [whId, loadZones, loadUnassigned]);

  useEffect(() => { load(); }, [load]);

  // After any cell change, refresh cell quantities and the unassigned pool.
  const refresh = useCallback(() => { loadZones(); loadUnassigned(); }, [loadZones, loadUnassigned]);

  // Listen for scanner updates from other tabs.
  useEffect(() => {
    const ch = new BroadcastChannel("wh_cell_updated");
    ch.onmessage = () => refresh();
    return () => ch.close();
  }, [refresh]);

  const flatCells: FlatCell[] = useMemo(
    () => zones.flatMap((z) => z.cells.map((c) => ({ id: c.id, label: c.code, zone: z.name }))),
    [zones]
  );

  async function deleteZone(id: number) {
    if (!await confirm({ message: "Видалити стелаж і всі його комірки?", variant: "danger" })) return;
    try {
      await api(`/api/warehouse/warehouses/${whId}/zones/${id}`, { method: "DELETE" });
      setZones((prev) => prev.filter((z) => z.id !== id));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Помилка видалення");
    }
  }

  if (loading) return <PageSkeleton cols={5} rows={6} />;
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

      <UnassignedPanel items={unassigned} cells={flatCells} onPutaway={(it) => setPutaway(it)} />

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
              unassigned={unassigned}
              flatCells={flatCells}
              onEdit={(zone) => setZoneModal(zone)}
              onDelete={deleteZone}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {zoneModal !== null && (
        <ZoneModal
          zone={zoneModal === "create" ? null : zoneModal}
          onClose={() => setZoneModal(null)}
          onSaved={() => { loadZones(); }}
        />
      )}

      {putaway && (
        <PutawayModal
          item={putaway}
          cells={flatCells}
          onClose={() => setPutaway(null)}
          onDone={refresh}
        />
      )}
      {dialog}
    </div>
  );
}
