"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

type BankAccount = {
  id: number;
  name: string;
  status: "open" | "closed";
  balance: number;
  initial_balance: number;
  initial_balance_date: string | null;
  sort_order: number;
  created_at: string;
};

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <span className="font-semibold text-[var(--text)]">{title}</span>
          <button onClick={onClose} className="text-[var(--text-faint)] hover:text-[var(--text)]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export default function BankAccountsPage() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading]   = useState(true);
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<BankAccount | null>(null);
  const [name, setName]         = useState("");
  const [initBalance, setInitBalance] = useState("0");
  const [initDate, setInitDate] = useState("");
  const [saving, setSaving]     = useState(false);
  const inFlight                = useRef(false);

  const totalBalance = accounts.filter((a) => a.status === "open").reduce((s, a) => s + a.balance, 0);

  function load() {
    setLoading(true);
    api<BankAccount[]>("/api/warehouse/bank-accounts")
      .then(setAccounts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setName("");
    setInitBalance("0");
    setInitDate("");
    setCreating(true);
  }

  function openEdit(a: BankAccount) {
    setEditTarget(a);
    setName(a.name);
    setInitBalance("");
    setInitDate("");
  }

  async function handleCreate() {
    if (inFlight.current || !name.trim()) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await api("/api/warehouse/bank-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          initial_balance:      parseFloat(initBalance) || 0,
          initial_balance_date: initDate || null,
        }),
      });
      setCreating(false);
      load();
    } catch (e: unknown) {
      alert((e as { detail?: string })?.detail ?? "Помилка");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  async function handleUpdate() {
    if (inFlight.current || !editTarget || !name.trim()) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await api(`/api/warehouse/bank-accounts/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      setEditTarget(null);
      load();
    } catch (e: unknown) {
      alert((e as { detail?: string })?.detail ?? "Помилка");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  async function toggleStatus(a: BankAccount) {
    await api(`/api/warehouse/bank-accounts/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: a.status === "open" ? "closed" : "open" }),
    });
    load();
  }

  async function handleDelete(a: BankAccount) {
    if (!confirm(`Видалити "${a.name}"? Баланс має бути 0.`)) return;
    try {
      await api(`/api/warehouse/bank-accounts/${a.id}`, { method: "DELETE" });
      load();
    } catch (e: unknown) {
      alert((e as { detail?: string })?.detail ?? "Помилка");
    }
  }

  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Рахунки</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Загальний баланс: <span className="font-semibold text-[var(--text)]">{totalBalance.toFixed(2)} ₴</span>
          </p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Додати</button>
      </div>

      {loading && <p className="text-sm text-[var(--text-faint)]">Завантаження...</p>}

      {!loading && accounts.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center">
          <p className="text-sm text-[var(--text-faint)]">
            Немає рахунків. Додайте касу, термінал або рахунок у банку.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {accounts.map((a) => (
          <div
            key={a.id}
            className={[
              "flex items-center gap-3 rounded-xl border p-4 transition-colors",
              a.status === "closed"
                ? "border-[var(--border)] opacity-50"
                : "border-[var(--border)] bg-[var(--bg-elevated)]",
            ].join(" ")}
          >
            {/* Status dot */}
            <span className={[
              "h-2.5 w-2.5 shrink-0 rounded-full",
              a.status === "open" ? "bg-[var(--state-ok)]" : "bg-[var(--text-faint)]",
            ].join(" ")} />

            <div className="flex-1 min-w-0">
              <p className="font-medium text-[var(--text)] truncate">{a.name}</p>
              {a.initial_balance_date && (
                <p className="text-xs text-[var(--text-faint)]">
                  Початковий баланс {a.initial_balance.toFixed(2)} ₴ від {a.initial_balance_date}
                </p>
              )}
            </div>

            <span className="shrink-0 text-lg font-bold text-[var(--text)]">
              {a.balance.toFixed(2)} ₴
            </span>

            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => openEdit(a)}
                className="rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] transition-colors"
                title="Редагувати"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              <button
                onClick={() => toggleStatus(a)}
                className="rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] transition-colors"
                title={a.status === "open" ? "Закрити" : "Відкрити"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {a.status === "open"
                    ? <><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></>
                    : <><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>
                  }
                </svg>
              </button>
              <button
                onClick={() => handleDelete(a)}
                className="rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-error)] transition-colors"
                title="Видалити"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Create modal */}
      {creating && (
        <Modal title="Новий рахунок" onClose={() => setCreating(false)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Назва</label>
              <input
                autoFocus
                type="text"
                placeholder="Готівка, Термінал, ПриватБанк..."
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input w-full"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Початковий баланс, ₴</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={initBalance}
                onChange={(e) => setInitBalance(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Дата початкового балансу</label>
              <input
                type="date"
                value={initDate}
                onChange={(e) => setInitDate(e.target.value)}
                className="input w-full"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setCreating(false)} className="btn flex-1">Скасувати</button>
              <button onClick={handleCreate} disabled={saving || !name.trim()} className="btn btn-primary flex-1">
                {saving ? "Зберігаємо..." : "Додати"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit modal */}
      {editTarget && (
        <Modal title="Редагувати рахунок" onClose={() => setEditTarget(null)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Назва</label>
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input w-full"
                onKeyDown={(e) => e.key === "Enter" && handleUpdate()}
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setEditTarget(null)} className="btn flex-1">Скасувати</button>
              <button onClick={handleUpdate} disabled={saving || !name.trim()} className="btn btn-primary flex-1">
                {saving ? "Зберігаємо..." : "Зберегти"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
