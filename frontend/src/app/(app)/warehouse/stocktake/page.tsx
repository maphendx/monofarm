"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiAll } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type StocktakeLine = {
  id:           number;
  product_id:   number;
  product_name: string;
  product_sku:  string | null;
  barcode:      string | null;
  unit:         string;
  image_url:    string | null;
  expected_qty: string;
  counted_qty:  string | null;
  diff:         string | null;
  diff_value:   string | null;
  counted_at:   string | null;
};

type Stocktake = {
  id:             number;
  warehouse_id:   number;
  warehouse_name: string;
  status:         string;
  scope:          string;
  note:           string | null;
  lines_total:    number;
  lines_counted:  number;
  diff_lines:     number;
  surplus_value:  string;
  shortage_value: string;
  created_at:     string;
  confirmed_at:   string | null;
  lines:          StocktakeLine[];
};

type Warehouse = { id: number; name: string };
type Category  = { id: number; name: string };

const STATUS_META: Record<string, { label: string; cls: string }> = {
  open:      { label: "Триває",    cls: "badge badge-print"   },
  confirmed: { label: "Проведено", cls: "badge badge-ok"      },
  cancelled: { label: "Скасовано", cls: "badge badge-neutral" },
};

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtMoney(s: string | null): string {
  if (s == null) return "—";
  const n = parseFloat(s);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + " ₴";
}

// ── Create modal ──────────────────────────────────────────────────────────────

function CreateModal({
  warehouses, categories, onClose, onCreated,
}: {
  warehouses: Warehouse[];
  categories: Category[];
  onClose:    () => void;
  onCreated:  (st: Stocktake) => void;
}) {
  const [whId, setWhId]     = useState<number | "">(warehouses[0]?.id ?? "");
  const [scope, setScope]   = useState<"full" | "partial">("full");
  const [catId, setCatId]   = useState<number | "">("");
  const [note, setNote]     = useState("");
  const [error, setError]   = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !whId) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const st = await api<Stocktake>("/api/warehouse/stocktakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouse_id: whId,
          scope,
          category_id: scope === "partial" && catId ? catId : null,
          note: note || null,
        }),
      });
      onCreated(st);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Помилка");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Нова інвентаризація</h2>
          <button type="button" onClick={onClose} className="text-[var(--text-faint)] hover:text-[var(--text)]">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-[var(--text-muted)]">Склад</label>
            <select className="input w-full" value={whId} onChange={e => setWhId(e.target.value ? Number(e.target.value) : "")} required>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs text-[var(--text-muted)]">Обсяг</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setScope("full")}
                className={scope === "full" ? "btn btn-primary flex-1" : "btn btn-secondary flex-1"}>
                Повна
              </button>
              <button type="button" onClick={() => setScope("partial")}
                className={scope === "partial" ? "btn btn-primary flex-1" : "btn btn-secondary flex-1"}>
                Часткова
              </button>
            </div>
          </div>

          {scope === "partial" && (
            <div>
              <label className="mb-1 block text-xs text-[var(--text-muted)]">Категорія</label>
              <select className="input w-full" value={catId} onChange={e => setCatId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— оберіть категорію —</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <p className="mt-1 text-xs text-[var(--text-faint)]">Порахуємо лише товари цієї категорії. Інші можна досканувати вручну.</p>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs text-[var(--text-muted)]">Коментар</label>
            <input className="input w-full" value={note} onChange={e => setNote(e.target.value)} placeholder="напр. планова місячна" />
          </div>

          {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn btn-ghost">Скасувати</button>
            <button type="submit" disabled={saving || !whId} className="btn btn-primary">
              {saving ? "Створюємо…" : "Почати підрахунок"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Count view (one open/closed session) ──────────────────────────────────────

function CountView({
  stocktake, onBack, onChanged,
}: {
  stocktake: Stocktake;
  onBack:    () => void;
  onChanged: (st: Stocktake) => void;
}) {
  const [st, setSt] = useState(stocktake);
  const [filter, setFilter] = useState<"all" | "uncounted" | "diff">("all");
  const [search, setSearch] = useState("");
  const [scanCode, setScanCode] = useState("");
  const [scanQty, setScanQty] = useState("1");
  const [plusOne, setPlusOne] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const isOpen = st.status === "open";

  useEffect(() => setSt(stocktake), [stocktake]);

  const refresh = useCallback(async () => {
    const fresh = await api<Stocktake>(`/api/warehouse/stocktakes/${st.id}`);
    setSt(fresh);
    onChanged(fresh);
  }, [st.id, onChanged]);

  async function countLine(productId: number, qty: number, mode: "set" | "add" = "set") {
    setError("");
    try {
      await api(`/api/warehouse/stocktakes/${st.id}/count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productId, quantity: qty, mode }),
      });
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Помилка");
    }
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    const code = scanCode.trim();
    if (!code || inFlight.current) return;
    inFlight.current = true;
    setError("");
    try {
      const qty = plusOne ? 1 : parseFloat(scanQty) || 0;
      await api(`/api/warehouse/stocktakes/${st.id}/count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, quantity: qty, mode: plusOne ? "add" : "set" }),
      });
      setScanCode("");
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Товар не знайдено");
    } finally {
      inFlight.current = false;
      scanRef.current?.focus();
    }
  }

  async function handleConfirm(uncounted: "skip" | "zero") {
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    try {
      const done = await api<Stocktake>(`/api/warehouse/stocktakes/${st.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uncounted }),
      });
      setSt(done);
      onChanged(done);
      setConfirmOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Помилка");
    } finally {
      inFlight.current = false;
    }
  }

  async function handleCancel() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await api(`/api/warehouse/stocktakes/${st.id}/cancel`, { method: "POST" });
      await refresh();
    } finally {
      inFlight.current = false;
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return st.lines.filter(ln => {
      if (filter === "uncounted" && ln.counted_qty !== null) return false;
      if (filter === "diff" && !(ln.diff && parseFloat(ln.diff) !== 0)) return false;
      if (q && !ln.product_name.toLowerCase().includes(q) &&
          !(ln.product_sku ?? "").toLowerCase().includes(q) &&
          !(ln.barcode ?? "").includes(q)) return false;
      return true;
    });
  }, [st.lines, filter, search]);

  const meta = STATUS_META[st.status] ?? STATUS_META.open;
  const progress = st.lines_total ? Math.round((st.lines_counted / st.lines_total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="btn btn-ghost btn-sm">← Назад</button>
        <h1 className="text-lg font-semibold">
          Інвентаризація №{st.id} · {st.warehouse_name}
        </h1>
        <span className={meta.cls}>{meta.label}</span>
        <span className="text-sm text-[var(--text-muted)]">
          {st.lines_counted}/{st.lines_total} позицій · розбіжностей: {st.diff_lines}
        </span>
        {isOpen && (
          <div className="ml-auto flex gap-2">
            <button onClick={handleCancel} className="btn btn-ghost btn-sm">Скасувати</button>
            <button onClick={() => setConfirmOpen(true)} className="btn btn-primary btn-sm">Провести</button>
          </div>
        )}
      </div>

      <div className="progress"><div className="progress-fill ok" style={{ width: `${progress}%` }} /></div>

      {/* Scanner input */}
      {isOpen && (
        <form onSubmit={handleScan} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <input
            ref={scanRef}
            className="input flex-1 min-w-48 font-mono"
            placeholder="Скануйте штрихкод або введіть SKU…"
            value={scanCode}
            onChange={e => setScanCode(e.target.value)}
            autoFocus
          />
          {!plusOne && (
            <input
              className="input w-24 text-right"
              type="number" step="any" min="0"
              value={scanQty}
              onChange={e => setScanQty(e.target.value)}
              title="Кількість"
            />
          )}
          <label className="check-row flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <input type="checkbox" checked={plusOne} onChange={e => setPlusOne(e.target.checked)} />
            +1 за скан
          </label>
          <button type="submit" className="btn btn-secondary">Зарахувати</button>
        </form>
      )}

      {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}

      {/* Summary for confirmed */}
      {!isOpen && (
        <div className="flex gap-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
          <div>Надлишок: <span className="font-semibold text-[var(--state-ok)]">{fmtMoney(st.surplus_value)}</span></div>
          <div>Нестача: <span className="font-semibold text-[var(--state-error)]">{fmtMoney(st.shortage_value)}</span></div>
          {st.confirmed_at && <div className="text-[var(--text-muted)]">Проведено {fmtDate(st.confirmed_at)}</div>}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-64" placeholder="Пошук: назва / SKU / штрихкод" value={search} onChange={e => setSearch(e.target.value)} />
        {([["all", "Всі"], ["uncounted", "Незлічені"], ["diff", "Розбіжності"]] as const).map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)}
            className={filter === key ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}>
            {label}
          </button>
        ))}
      </div>

      {/* Lines */}
      <div className="table-wrap">
        <table className="ds-table w-full">
          <thead>
            <tr>
              <th className="text-left">Товар</th>
              <th className="text-right">Облік</th>
              <th className="text-right">Факт</th>
              <th className="text-right">Розбіжність</th>
              <th className="text-right">Сума</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(ln => (
              <LineRow key={ln.id} line={ln} editable={isOpen} onCount={countLine} />
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={5} className="py-8 text-center text-[var(--text-faint)]">Немає позицій</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Confirm dialog */}
      {confirmOpen && (
        <div className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-xl">
            <h2 className="text-lg font-semibold">Провести інвентаризацію?</h2>
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              Розбіжності буде записано в журнал рухів: надлишок — оприбуткування, нестача — списання.
              Незліченими лишились {st.lines_total - st.lines_counted} позицій.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button onClick={() => handleConfirm("skip")} className="btn btn-primary">
                Провести · незлічені без змін
              </button>
              {st.lines_total - st.lines_counted > 0 && (
                <button onClick={() => handleConfirm("zero")} className="btn btn-danger">
                  Провести · незлічені = 0 (списати)
                </button>
              )}
              <button onClick={() => setConfirmOpen(false)} className="btn btn-ghost">Назад</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LineRow({
  line, editable, onCount,
}: {
  line:     StocktakeLine;
  editable: boolean;
  onCount:  (productId: number, qty: number) => Promise<void>;
}) {
  const [value, setValue] = useState(line.counted_qty ?? "");
  useEffect(() => setValue(line.counted_qty ?? ""), [line.counted_qty]);

  const diff = line.diff !== null ? parseFloat(line.diff) : null;
  const diffCls = diff === null || diff === 0
    ? "text-[var(--text-faint)]"
    : diff > 0 ? "text-[var(--state-ok)]" : "text-[var(--state-error)]";

  async function commit() {
    const qty = parseFloat(value);
    if (value === "" || Number.isNaN(qty)) return;
    if (line.counted_qty !== null && parseFloat(line.counted_qty) === qty) return;
    await onCount(line.product_id, qty);
  }

  return (
    <tr className={line.counted_qty === null ? "" : "bg-[var(--surface-2)]"}>
      <td>
        <div className="flex items-center gap-2">
          {line.image_url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={line.image_url} alt="" width={28} height={28} className="size-7 rounded object-cover" loading="lazy" />
          )}
          <div>
            <div className="text-sm text-[var(--text)]">{line.product_name}</div>
            <div className="font-mono text-xs text-[var(--text-faint)]">{line.product_sku}{line.barcode ? ` · ${line.barcode}` : ""}</div>
          </div>
        </div>
      </td>
      <td className="text-right font-mono">{parseFloat(line.expected_qty)}</td>
      <td className="text-right">
        {editable ? (
          <input
            className="input w-24 text-right font-mono"
            type="number" step="any" min="0"
            value={value}
            placeholder="—"
            onChange={e => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void commit(); } }}
          />
        ) : (
          <span className="font-mono">{line.counted_qty !== null ? parseFloat(line.counted_qty) : "—"}</span>
        )}
      </td>
      <td className={`text-right font-mono ${diffCls}`}>
        {diff === null ? "—" : diff > 0 ? `+${diff}` : diff}
      </td>
      <td className={`text-right font-mono text-xs ${diffCls}`}>
        {line.diff_value !== null ? fmtMoney(line.diff_value) : "—"}
      </td>
    </tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StocktakePage() {
  const [sessions, setSessions]     = useState<Stocktake[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading]       = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected]     = useState<Stocktake | null>(null);

  const load = useCallback(async () => {
    const [sts, whs, cats] = await Promise.all([
      apiAll<Stocktake>("/api/warehouse/stocktakes"),
      api<Warehouse[]>("/api/warehouse/warehouses"),
      api<Category[]>("/api/warehouse/categories"),
    ]);
    setSessions(sts);
    setWarehouses(whs);
    setCategories(cats);
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  async function openSession(id: number) {
    const st = await api<Stocktake>(`/api/warehouse/stocktakes/${id}`);
    setSelected(st);
  }

  if (loading) return <div className="skeleton h-64 w-full" />;

  if (selected) {
    return (
      <CountView
        stocktake={selected}
        onBack={() => { setSelected(null); void load(); }}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Інвентаризація</h1>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">
            Повний або частковий підрахунок складу з відомістю розбіжностей
          </p>
        </div>
        <button onClick={() => setCreateOpen(true)} className="btn btn-primary">+ Нова інвентаризація</button>
      </div>

      {sessions.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📋</div>
          <div className="empty-title">Ще не було інвентаризацій</div>
          <div className="empty-sub">Створіть першу, щоб звірити фактичні залишки з обліком</div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ds-table w-full">
            <thead>
              <tr>
                <th className="text-left">№ / Склад</th>
                <th className="text-left">Статус</th>
                <th className="text-right">Позицій</th>
                <th className="text-right">Розбіжн.</th>
                <th className="text-right">Надлишок</th>
                <th className="text-right">Нестача</th>
                <th className="text-right">Дата</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(st => {
                const meta = STATUS_META[st.status] ?? STATUS_META.open;
                return (
                  <tr key={st.id} className="cursor-pointer hover:bg-[var(--surface-hi)]" onClick={() => void openSession(st.id)}>
                    <td>
                      <span className="font-mono text-xs text-[var(--text-faint)]">#{st.id}</span>{" "}
                      <span className="text-sm">{st.warehouse_name}</span>
                      {st.note && <span className="ml-2 text-xs text-[var(--text-faint)]">{st.note}</span>}
                    </td>
                    <td><span className={meta.cls}>{meta.label}</span></td>
                    <td className="text-right font-mono">{st.lines_counted}/{st.lines_total}</td>
                    <td className="text-right font-mono">{st.diff_lines}</td>
                    <td className="text-right font-mono text-[var(--state-ok)]">{fmtMoney(st.surplus_value)}</td>
                    <td className="text-right font-mono text-[var(--state-error)]">{fmtMoney(st.shortage_value)}</td>
                    <td className="text-right text-xs text-[var(--text-muted)]">{fmtDate(st.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CreateModal
          warehouses={warehouses}
          categories={categories}
          onClose={() => setCreateOpen(false)}
          onCreated={st => { setCreateOpen(false); setSelected(st); void load(); }}
        />
      )}
    </div>
  );
}
