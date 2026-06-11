"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { Modal } from "@/components/ui/Modal";
import { FilterDropdown } from "@/components/warehouse/FilterDropdown";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";

// ── Types ─────────────────────────────────────────────────────────────────────

type CounterpartyType = "supplier" | "customer" | "both";

const TYPE_META: Record<CounterpartyType, { label: string; cls: string }> = {
  supplier: { label: "Постачальник", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-400" },
  customer: { label: "Клієнт",       cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)] " },
  both:     { label: "Обидва",       cls: "bg-[var(--surface-hi)] text-[var(--text)] " },
};

type Counterparty = {
  id:          number;
  type:        CounterpartyType;
  name:        string;
  email:       string | null;
  phone:       string | null;
  tax_number:  string | null;
  address:     string | null;
  notes:       string | null;
  balance:     string;
  external_id: string | null;
  created_at:  string;
};

// ── Form modal ────────────────────────────────────────────────────────────────

type FormData = {
  type: CounterpartyType;
  name: string;
  email: string;
  phone: string;
  tax_number: string;
  address: string;
  notes: string;
};

const EMPTY_FORM: FormData = {
  type: "customer", name: "", email: "", phone: "",
  tax_number: "", address: "", notes: "",
};

function CounterpartyModal({
  open, onClose, onSaved, editing,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (cp: Counterparty) => void;
  editing: Counterparty | null;
}) {
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing) {
      setForm({
        type:       editing.type,
        name:       editing.name,
        email:      editing.email ?? "",
        phone:      editing.phone ?? "",
        tax_number: editing.tax_number ?? "",
        address:    editing.address ?? "",
        notes:      editing.notes ?? "",
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, editing]);

  function set(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !form.name.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = {
        type:       form.type,
        name:       form.name.trim(),
        email:      form.email.trim() || null,
        phone:      form.phone.trim() || null,
        tax_number: form.tax_number.trim() || null,
        address:    form.address.trim() || null,
        notes:      form.notes.trim() || null,
      };
      const cp = editing
        ? await api<Counterparty>(`/api/warehouse/counterparties/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<Counterparty>("/api/warehouse/counterparties", { method: "POST", body: JSON.stringify(body) });
      onSaved(cp);
      onClose();
    } catch {
      setError("Помилка збереження");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Редагувати контрагента" : "Новий контрагент"}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
            Скасувати
          </button>
          <button type="submit" form="cp-form" disabled={busy || !form.name.trim()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
            {busy ? "Зберігаю…" : editing ? "Зберегти" : "Створити"}
          </button>
        </>
      }
    >
      <form id="cp-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Тип *</span>
            <select value={form.type} onChange={(e) => set("type", e.target.value)} className={inputCls}>
              <option value="customer">Клієнт</option>
              <option value="supplier">Постачальник</option>
              <option value="both">Обидва</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Назва *</span>
            <input value={form.name} onChange={(e) => set("name", e.target.value)}
              placeholder="ТОВ «Компанія»" className={inputCls} />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Email</span>
            <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)}
              placeholder="info@company.ua" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Телефон</span>
            <input value={form.phone} onChange={(e) => set("phone", e.target.value)}
              placeholder="+380 67 …" className={inputCls} />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">ЄДРПОУ / ІПН</span>
            <input value={form.tax_number} onChange={(e) => set("tax_number", e.target.value)}
              placeholder="12345678" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Адреса</span>
            <input value={form.address} onChange={(e) => set("address", e.target.value)}
              placeholder="м. Київ, вул. …" className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Нотатка</span>
          <input value={form.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} />
        </label>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Balance adjust modal ──────────────────────────────────────────────────────

function BalanceModal({
  open, onClose, cp, onSaved,
}: { open: boolean; onClose: () => void; cp: Counterparty | null; onSaved: (cp: Counterparty) => void }) {
  const [delta, setDelta] = useState("");
  const [note,  setNote]  = useState("");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => { if (open) { setDelta(""); setNote(""); setError(null); } }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !cp || !delta) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Counterparty>(`/api/warehouse/counterparties/${cp.id}/adjust-balance`, {
        method: "POST",
        body: JSON.stringify({ delta: parseFloat(delta), note: note.trim() || null }),
      });
      onSaved(updated);
      onClose();
    } catch {
      setError("Помилка");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";

  return (
    <Modal open={open} onClose={onClose} title={`Оплата — ${cp?.name ?? ""}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
            Скасувати
          </button>
          <button type="submit" form="balance-form" disabled={busy || !delta}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
            {busy ? "Зберігаю…" : "Записати"}
          </button>
        </>
      }
    >
      <form id="balance-form" onSubmit={submit} className="space-y-3 text-sm">
        <p className="text-[var(--text-muted)] ">
          Поточний баланс: <span className={`font-medium ${parseFloat(cp?.balance ?? "0") > 0 ? "text-[var(--state-error)]" : "text-[var(--state-ok)]"}`}>
            {parseFloat(cp?.balance ?? "0").toLocaleString("uk-UA")} ₴
          </span>
        </p>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Сума оплати ₴ (позитивна = клієнт оплатив нам)</span>
          <input type="number" step="0.01" value={delta} onChange={(e) => setDelta(e.target.value)}
            placeholder="1000.00" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Коментар</span>
          <input value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Оплата рахунку №123" className={inputCls} />
        </label>
        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type TypeFilter = "Всі" | CounterpartyType;
const TYPE_FILTERS: TypeFilter[] = ["Всі", "supplier", "customer", "both"];
const TYPE_FILTER_LABELS: Record<string, string> = {
  "Всі": "Всі", supplier: "Постачальники", customer: "Клієнти", both: "Обидва",
};

function fmtBalance(v: string) {
  const n = parseFloat(v);
  if (n === 0) return <span className="text-[var(--text-faint)]">0 ₴</span>;
  return (
    <span className={n > 0 ? "text-[var(--state-error)]" : "text-[var(--state-ok)]"}>
      {n > 0 ? "+" : ""}{n.toLocaleString("uk-UA")} ₴
    </span>
  );
}

const COLS: ColDef[] = [
  { key: "name",       label: "Назва",   required: true },
  { key: "type",       label: "Тип" },
  { key: "email",      label: "Email" },
  { key: "phone",      label: "Телефон" },
  { key: "tax_number", label: "ЄДРПОУ" },
  { key: "balance",    label: "Баланс" },
  { key: "notes",      label: "Нотатка" },
];

export default function CounterpartiesPage() {
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [typeFilter,     setTypeFilter]     = useState<TypeFilter>("Всі");
  const [search,         setSearch]         = useState("");
  const [createOpen,     setCreateOpen]     = useState(false);
  const [editing,        setEditing]        = useState<Counterparty | null>(null);
  const [balanceCp,      setBalanceCp]      = useState<Counterparty | null>(null);

  const colVis = useColumnVisibility("counterparties", COLS);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try { setCounterparties(await api<Counterparty[]>("/api/warehouse/counterparties")); }
    finally { setLoading(false); }
  }, []);

  const { version } = useWarehouseStream();
  useEffect(() => { load(); }, [load, version]);

  function handleSaved(cp: Counterparty) {
    setCounterparties((prev) => {
      const idx = prev.findIndex((c) => c.id === cp.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = cp; return next; }
      return [cp, ...prev];
    });
  }

  const filtered = counterparties.filter((c) => {
    if (typeFilter !== "Всі" && c.type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!c.name.toLowerCase().includes(q) && !(c.email ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  if (loading) return <PageSkeleton cols={5} />;

  return (
    <div className="space-y-4">

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Пошук…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]   "
          />
          <FilterDropdown active={typeFilter !== "Всі" ? 1 : 0}>
            <div className="p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Тип</p>
              <div className="space-y-0.5">
                {TYPE_FILTERS.map((f) => (
                  <label key={f} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                    <input
                      type="radio"
                      name="cp-type-filter"
                      checked={typeFilter === f}
                      onChange={() => setTypeFilter(f)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="text-sm">{TYPE_FILTER_LABELS[f]}</span>
                  </label>
                ))}
              </div>
            </div>
            {typeFilter !== "Всі" && (
              <div className="border-t border-[var(--border)] p-3">
                <button
                  onClick={() => setTypeFilter("Всі")}
                  className="w-full rounded-md px-3 py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
                >
                  Скинути фільтри
                </button>
              </div>
            )}
          </FilterDropdown>
        </div>
        <div className="flex gap-2">
          <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
          <button onClick={() => { setEditing(null); setCreateOpen(true); }}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)]">
            + Контрагент
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
            <tr>
              {colVis.isVisible("name")       && <th className="px-4 py-3 font-medium">Назва</th>}
              {colVis.isVisible("type")       && <th className="px-4 py-3 font-medium">Тип</th>}
              {colVis.isVisible("email")      && <th className="px-4 py-3 font-medium">Email</th>}
              {colVis.isVisible("phone")      && <th className="px-4 py-3 font-medium">Телефон</th>}
              {colVis.isVisible("tax_number") && <th className="px-4 py-3 font-medium">ЄДРПОУ</th>}
              {colVis.isVisible("balance")    && <th className="px-4 py-3 font-medium text-right">Баланс</th>}
              {colVis.isVisible("notes")      && <th className="px-4 py-3 font-medium">Нотатка</th>}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={1 + COLS.filter((c) => colVis.isVisible(c.key)).length} className="px-4 py-10 text-center text-[var(--text-faint)]">
                  {search || typeFilter !== "Всі" ? "Нічого не знайдено" : "Контрагентів ще немає"}
                </td>
              </tr>
            ) : filtered.map((c) => {
              const meta = TYPE_META[c.type];
              return (
                <tr key={c.id} className="hover:bg-[var(--surface-hi)]">
                  {colVis.isVisible("name") && (
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                  )}
                  {colVis.isVisible("type") && (
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </td>
                  )}
                  {colVis.isVisible("email") && (
                    <td className="px-4 py-3 text-[var(--text-muted)]">{c.email ?? "—"}</td>
                  )}
                  {colVis.isVisible("phone") && (
                    <td className="px-4 py-3 text-[var(--text-faint)]">{c.phone ?? "—"}</td>
                  )}
                  {colVis.isVisible("tax_number") && (
                    <td className="px-4 py-3 text-[var(--text-faint)] font-mono text-xs">{c.tax_number ?? "—"}</td>
                  )}
                  {colVis.isVisible("balance") && (
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      {fmtBalance(c.balance)}
                    </td>
                  )}
                  {colVis.isVisible("notes") && (
                    <td className="max-w-[180px] px-4 py-3 truncate text-xs text-[var(--text-faint)]">
                      {c.notes ?? "—"}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => { setBalanceCp(c); }}
                        title="Записати оплату"
                        className="rounded p-1 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-ok)]  dark:hover:text-[var(--state-ok)]">
                        ₴
                      </button>
                      <button
                        onClick={() => { setEditing(c); setCreateOpen(true); }}
                        title="Редагувати"
                        className="rounded p-1 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ">
                        ✎
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <CounterpartyModal
        open={createOpen}
        onClose={() => { setCreateOpen(false); setEditing(null); }}
        onSaved={handleSaved}
        editing={editing}
      />

      <BalanceModal
        open={balanceCp !== null}
        onClose={() => setBalanceCp(null)}
        cp={balanceCp}
        onSaved={handleSaved}
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
    </div>
  );
}
