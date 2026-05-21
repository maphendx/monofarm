"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/Modal";

// ── Types ─────────────────────────────────────────────────────────────────────

type CounterpartyType = "supplier" | "customer" | "both";

const TYPE_META: Record<CounterpartyType, { label: string; cls: string }> = {
  supplier: { label: "Постачальник", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-400" },
  customer: { label: "Клієнт",       cls: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400" },
  both:     { label: "Обидва",       cls: "bg-neutral-500/15 text-neutral-700 dark:text-neutral-400" },
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

  const inputCls = "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Редагувати контрагента" : "Новий контрагент"}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Скасувати
          </button>
          <button type="submit" form="cp-form" disabled={busy || !form.name.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
            {busy ? "Зберігаю…" : editing ? "Зберегти" : "Створити"}
          </button>
        </>
      }
    >
      <form id="cp-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Тип *</span>
            <select value={form.type} onChange={(e) => set("type", e.target.value)} className={inputCls}>
              <option value="customer">Клієнт</option>
              <option value="supplier">Постачальник</option>
              <option value="both">Обидва</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Назва *</span>
            <input value={form.name} onChange={(e) => set("name", e.target.value)}
              placeholder="ТОВ «Компанія»" className={inputCls} />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Email</span>
            <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)}
              placeholder="info@company.ua" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Телефон</span>
            <input value={form.phone} onChange={(e) => set("phone", e.target.value)}
              placeholder="+380 67 …" className={inputCls} />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">ЄДРПОУ / ІПН</span>
            <input value={form.tax_number} onChange={(e) => set("tax_number", e.target.value)}
              placeholder="12345678" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Адреса</span>
            <input value={form.address} onChange={(e) => set("address", e.target.value)}
              placeholder="м. Київ, вул. …" className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Нотатка</span>
          <input value={form.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} />
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
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

  const inputCls = "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";

  return (
    <Modal open={open} onClose={onClose} title={`Оплата — ${cp?.name ?? ""}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Скасувати
          </button>
          <button type="submit" form="balance-form" disabled={busy || !delta}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
            {busy ? "Зберігаю…" : "Записати"}
          </button>
        </>
      }
    >
      <form id="balance-form" onSubmit={submit} className="space-y-3 text-sm">
        <p className="text-neutral-500 dark:text-neutral-400">
          Поточний баланс: <span className={`font-medium ${parseFloat(cp?.balance ?? "0") > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
            {parseFloat(cp?.balance ?? "0").toLocaleString("uk-UA")} ₴
          </span>
        </p>
        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Сума оплати ₴ (позитивна = клієнт оплатив нам)</span>
          <input type="number" step="0.01" value={delta} onChange={(e) => setDelta(e.target.value)}
            placeholder="1000.00" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Коментар</span>
          <input value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Оплата рахунку №123" className={inputCls} />
        </label>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
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
  if (n === 0) return <span className="text-neutral-400">0 ₴</span>;
  return (
    <span className={n > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}>
      {n > 0 ? "+" : ""}{n.toLocaleString("uk-UA")} ₴
    </span>
  );
}

export default function CounterpartiesPage() {
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [typeFilter,     setTypeFilter]     = useState<TypeFilter>("Всі");
  const [search,         setSearch]         = useState("");
  const [createOpen,     setCreateOpen]     = useState(false);
  const [editing,        setEditing]        = useState<Counterparty | null>(null);
  const [balanceCp,      setBalanceCp]      = useState<Counterparty | null>(null);

  const load = useCallback(async () => {
    try { setCounterparties(await api<Counterparty[]>("/api/warehouse/counterparties")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

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

  if (loading) return <div className="text-sm text-neutral-500">Завантаження…</div>;

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
            className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
          />
          <div className="flex gap-1">
            {TYPE_FILTERS.map((f) => (
              <button key={f} onClick={() => setTypeFilter(f)}
                className={[
                  "rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  typeFilter === f
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "border border-neutral-200 text-neutral-600 hover:border-neutral-400 dark:border-neutral-800 dark:text-neutral-400",
                ].join(" ")}>
                {TYPE_FILTER_LABELS[f]}
              </button>
            ))}
          </div>
        </div>
        <button onClick={() => { setEditing(null); setCreateOpen(true); }}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900">
          + Контрагент
        </button>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-3 font-medium">Назва</th>
              <th className="px-4 py-3 font-medium">Тип</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Телефон</th>
              <th className="px-4 py-3 font-medium">ЄДРПОУ</th>
              <th className="px-4 py-3 font-medium text-right">Баланс</th>
              <th className="px-4 py-3 font-medium">Нотатка</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-neutral-400">
                  {search || typeFilter !== "Всі" ? "Нічого не знайдено" : "Контрагентів ще немає"}
                </td>
              </tr>
            ) : filtered.map((c) => {
              const meta = TYPE_META[c.type];
              return (
                <tr key={c.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-500">{c.email ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-400">{c.phone ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-400 font-mono text-xs">{c.tax_number ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {fmtBalance(c.balance)}
                  </td>
                  <td className="max-w-[180px] px-4 py-3 truncate text-xs text-neutral-400">
                    {c.notes ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => { setBalanceCp(c); }}
                        title="Записати оплату"
                        className="rounded p-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-emerald-600 dark:hover:bg-neutral-800 dark:hover:text-emerald-400">
                        ₴
                      </button>
                      <button
                        onClick={() => { setEditing(c); setCreateOpen(true); }}
                        title="Редагувати"
                        className="rounded p-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800">
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
    </div>
  );
}
