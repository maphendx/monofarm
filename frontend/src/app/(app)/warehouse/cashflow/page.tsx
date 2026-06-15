"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useConfirm } from "@/hooks/useConfirm";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterDropdown } from "@/components/warehouse/FilterDropdown";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";

// ── Types ─────────────────────────────────────────────────────────────────────

type TxType = "income" | "expense";
type TxCategory =
  | "order_payment" | "supplier_payment" | "salary"
  | "utility" | "refund" | "other";

const TYPE_META: Record<TxType, { label: string; sign: string; cls: string }> = {
  income:  { label: "Дохід",   sign: "+", cls: "text-[var(--state-ok)]" },
  expense: { label: "Витрата", sign: "−", cls: "text-[var(--state-error)]" },
};

const CATEGORY_LABELS: Record<TxCategory, string> = {
  order_payment:    "Оплата замовлення",
  supplier_payment: "Оплата постачальнику",
  salary:           "Зарплата",
  utility:          "Комунальні",
  refund:           "Повернення",
  other:            "Інше",
};

type CashTx = {
  id:               number;
  type:             TxType;
  category:         TxCategory;
  amount:           string;
  counterparty_id:  number | null;
  counterparty_name: string | null;
  order_id:         number | null;
  order_number:     string | null;
  description:      string | null;
  transaction_date: string;
  created_at:       string;
};

type Summary = {
  total_income:  string;
  total_expense: string;
  net:           string;
  by_category:   { category: string; type: string; total: number }[];
};

type Counterparty = { id: number; name: string };

// ── Create modal ──────────────────────────────────────────────────────────────

function CreateTxModal({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (tx: CashTx) => void;
}) {
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [type,          setType]          = useState<TxType>("income");
  const [category,      setCategory]      = useState<TxCategory>("order_payment");
  const [amount,        setAmount]        = useState("");
  const [cpId,          setCpId]          = useState("");
  const [description,   setDescription]   = useState("");
  const [txDate,        setTxDate]        = useState(() => new Date().toISOString().slice(0, 10));
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setError(null); setAmount(""); setCpId(""); setDescription("");
    setType("income"); setCategory("order_payment");
    setTxDate(new Date().toISOString().slice(0, 10));
    api<Counterparty[]>("/api/warehouse/counterparties").then(setCounterparties).catch(() => {});
  }, [open]);

  // Auto-switch category to sensible default when type changes
  useEffect(() => {
    setCategory(type === "income" ? "order_payment" : "supplier_payment");
  }, [type]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !amount) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const body = {
        type, category,
        amount: parseFloat(amount),
        counterparty_id: cpId ? parseInt(cpId) : null,
        description:     description.trim() || null,
        transaction_date: txDate,
      };
      const tx = await api<CashTx>("/api/warehouse/cashflow", { method: "POST", body: JSON.stringify(body) });
      onCreated(tx);
      onClose();
    } catch { setError("Помилка збереження"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";
  const incomeCategories: TxCategory[]  = ["order_payment", "refund", "other"];
  const expenseCategories: TxCategory[] = ["supplier_payment", "salary", "utility", "refund", "other"];
  const categories = type === "income" ? incomeCategories : expenseCategories;

  return (
    <Modal open={open} onClose={onClose} title="Нова транзакція"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
            Скасувати
          </button>
          <button type="submit" form="cash-form" disabled={busy || !amount}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
            {busy ? "Зберігаю…" : "Додати"}
          </button>
        </>
      }
    >
      <form id="cash-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Тип</span>
            <select value={type} onChange={(e) => setType(e.target.value as TxType)} className={inputCls}>
              <option value="income">Дохід</option>
              <option value="expense">Витрата</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Категорія</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as TxCategory)} className={inputCls}>
              {categories.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Сума ₴ *</span>
            <input type="number" min={0.01} step="0.01" value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1000.00" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Дата</span>
            <input type="date" value={txDate} onChange={(e) => setTxDate(e.target.value)} className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Контрагент</span>
          <select value={cpId} onChange={(e) => setCpId(e.target.value)} className={inputCls}>
            <option value="">— без контрагента —</option>
            {counterparties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Опис</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Оплата рахунку №…" className={inputCls} />
        </label>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function fmt(v: string | number) {
  return parseFloat(String(v)).toLocaleString("uk-UA", { minimumFractionDigits: 2 });
}

function thisMonthRange() {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to   = now.toISOString().slice(0, 10);
  return { from, to };
}

const COLS: ColDef[] = [
  { key: "date",         label: "Дата",        required: true },
  { key: "type",         label: "Тип" },
  { key: "category",     label: "Категорія" },
  { key: "counterparty", label: "Контрагент" },
  { key: "order",        label: "Замовлення" },
  { key: "description",  label: "Опис" },
  { key: "amount",       label: "Сума" },
];

export default function CashFlowPage() {
  const { confirm, dialog } = useConfirm();
  const { from: defaultFrom, to: defaultTo } = thisMonthRange();
  const [transactions, setTransactions] = useState<CashTx[]>([]);
  const [summary,      setSummary]      = useState<Summary | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [typeFilter,   setTypeFilter]   = useState<"all" | TxType>("all");
  const [dateFrom,     setDateFrom]     = useState(defaultFrom);
  const [dateTo,       setDateTo]       = useState(defaultTo);
  const [createOpen,   setCreateOpen]   = useState(false);
  const [deleting,     setDeleting]     = useState<number | null>(null);

  const colVis = useColumnVisibility("cashflow", COLS);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
      if (typeFilter !== "all") params.set("type", typeFilter);
      const [txs, sum] = await Promise.all([
        api<CashTx[]>(`/api/warehouse/cashflow?${params}`),
        api<Summary>(`/api/warehouse/cashflow/summary?date_from=${dateFrom}&date_to=${dateTo}`),
      ]);
      setTransactions(txs);
      setSummary(sum);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, typeFilter]);

  const { version } = useWarehouseStream();
  useEffect(() => { load(); }, [load, version]);

  async function deleteTx(id: number) {
    if (!await confirm({ message: "Видалити транзакцію?", variant: "danger" })) return;
    setDeleting(id);
    try {
      await api(`/api/warehouse/cashflow/${id}`, { method: "DELETE" });
      setTransactions((prev) => prev.filter((t) => t.id !== id));
      load(); // refresh summary
    } catch { toast.error("Помилка видалення"); }
    finally { setDeleting(null); }
  }

  const net = parseFloat(summary?.net ?? "0");

  return (
    <div className="space-y-5">

      {/* KPI */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <p className="text-xs text-[var(--text-muted)]">Доходи</p>
          <p className="mt-1 text-base sm:text-2xl font-bold tabular-nums text-[var(--state-ok)]">
            {fmt(summary?.total_income ?? 0)} ₴
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <p className="text-xs text-[var(--text-muted)]">Витрати</p>
          <p className="mt-1 text-base sm:text-2xl font-bold tabular-nums text-[var(--state-error)]">
            {fmt(summary?.total_expense ?? 0)} ₴
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <p className="text-xs text-[var(--text-muted)]">Баланс</p>
          <p className={`mt-1 text-base sm:text-2xl font-bold tabular-nums ${net >= 0 ? "text-[var(--state-ok)]" : "text-[var(--state-error)]"}`}>
            {net >= 0 ? "+" : ""}{fmt(net)} ₴
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FilterDropdown active={typeFilter !== "all" ? 1 : 0}>
            <div className="p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Тип</p>
              <div className="space-y-0.5">
                {(["all", "income", "expense"] as const).map((f) => (
                  <label key={f} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                    <input
                      type="radio"
                      name="cashflow-type-filter"
                      checked={typeFilter === f}
                      onChange={() => setTypeFilter(f)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="text-sm">{f === "all" ? "Всі" : f === "income" ? "Доходи" : "Витрати"}</span>
                  </label>
                ))}
              </div>
            </div>
            {typeFilter !== "all" && (
              <div className="border-t border-[var(--border)] p-3">
                <button
                  onClick={() => setTypeFilter("all")}
                  className="w-full rounded-md px-3 py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
                >
                  Скинути фільтри
                </button>
              </div>
            )}
          </FilterDropdown>
          {/* Date range */}
          <div className="hidden sm:flex items-center gap-1">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs" />
            <span className="text-[var(--text-faint)]">—</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs" />
          </div>
        </div>
        <div className="flex gap-2">
          <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
          <button onClick={() => setCreateOpen(true)}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)]">
            + Транзакція
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <table className="min-w-[560px] w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
            <tr>
              {colVis.isVisible("date")         && <th className="px-4 py-3 font-medium">Дата</th>}
              {colVis.isVisible("type")         && <th className="px-4 py-3 font-medium">Тип</th>}
              {colVis.isVisible("category")     && <th className="px-4 py-3 font-medium">Категорія</th>}
              {colVis.isVisible("counterparty") && <th className="px-4 py-3 font-medium">Контрагент</th>}
              {colVis.isVisible("order")        && <th className="px-4 py-3 font-medium">Замовлення</th>}
              {colVis.isVisible("description")  && <th className="px-4 py-3 font-medium">Опис</th>}
              {colVis.isVisible("amount")       && <th className="px-4 py-3 font-medium text-right">Сума</th>}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {loading ? (
              <tr><td colSpan={1 + COLS.filter((c) => colVis.isVisible(c.key)).length} className="px-4 py-10 text-center text-[var(--text-faint)]">Завантаження…</td></tr>
            ) : transactions.length === 0 ? (
              <tr><td colSpan={1 + COLS.filter((c) => colVis.isVisible(c.key)).length} className="p-3">
                <EmptyState
                  className="border-0"
                  icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>}
                  title="Транзакцій немає"
                  description="Доходи й витрати з'являться тут. Додайте першу транзакцію."
                  action={{ label: "Додати транзакцію", onClick: () => setCreateOpen(true) }}
                />
              </td></tr>
            ) : transactions.map((tx) => {
              const meta = TYPE_META[tx.type];
              return (
                <tr key={tx.id} className="hover:bg-[var(--surface-hi)]">
                  {colVis.isVisible("date") && (
                    <td className="px-4 py-3 text-[var(--text-muted)] tabular-nums">
                      {new Date(tx.transaction_date).toLocaleDateString("uk-UA")}
                    </td>
                  )}
                  {colVis.isVisible("type") && (
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                    </td>
                  )}
                  {colVis.isVisible("category") && (
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                      {CATEGORY_LABELS[tx.category]}
                    </td>
                  )}
                  {colVis.isVisible("counterparty") && (
                    <td className="px-4 py-3 text-[var(--text-muted)]">
                      {tx.counterparty_name ?? <span className="text-[var(--text-faint)]">—</span>}
                    </td>
                  )}
                  {colVis.isVisible("order") && (
                    <td className="px-4 py-3 font-mono text-xs">
                      {tx.order_number ?? <span className="text-[var(--text-faint)]">—</span>}
                    </td>
                  )}
                  {colVis.isVisible("description") && (
                    <td className="max-w-[200px] px-4 py-3 truncate text-xs text-[var(--text-faint)]">
                      {tx.description ?? "—"}
                    </td>
                  )}
                  {colVis.isVisible("amount") && (
                    <td className={`px-4 py-3 text-right font-medium tabular-nums ${meta.cls}`}>
                      {meta.sign}{fmt(tx.amount)} ₴
                    </td>
                  )}
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => deleteTx(tx.id)}
                      disabled={deleting === tx.id}
                      className="rounded p-1 text-xs text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)] disabled:opacity-50  dark:hover:text-[var(--state-error)]">
                      {deleting === tx.id ? "…" : "✕"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* By category breakdown */}
      {summary && summary.by_category.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <h3 className="mb-3 text-sm font-medium text-[var(--text)] ">За категоріями</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {summary.by_category.map((row) => {
              const isIncome = row.type === "income";
              return (
                <div key={`${row.type}-${row.category}`}
                  className="flex items-center justify-between rounded-lg bg-[var(--bg)] px-3 py-2 ">
                  <span className="text-xs text-[var(--text-muted)] ">
                    {CATEGORY_LABELS[row.category as TxCategory] ?? row.category}
                  </span>
                  <span className={`text-sm font-medium tabular-nums ${isIncome ? "text-[var(--state-ok)]" : "text-[var(--state-error)]"}`}>
                    {isIncome ? "+" : "−"}{fmt(row.total)} ₴
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <CreateTxModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(tx) => { setTransactions((prev) => [tx, ...prev]); load(); }}
      />

      <ColumnSettingsModal
        open={colSettingsOpen}
        onClose={() => setColSettingsOpen(false)}
        cols={colVis.cols}
        hidden={colVis.hidden}
        setVisibility={colVis.setVisibility}
        orderedCols={colVis.orderedCols}
        setOrder={colVis.setOrder}
      />
      {dialog}
    </div>
  );
}
