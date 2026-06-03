"use client";

import { useCallback, useEffect, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { TelegramLinkModal } from "@/components/users/TelegramLinkModal";
import { useConfirm } from "@/hooks/useConfirm";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import type { AdminUser, UserRole } from "@/lib/types";

// Extend AdminUser locally for invite_pending field returned by the API
type AdminUserWithInvite = AdminUser & { invite_pending?: boolean };
import { PageSkeleton } from "@/components/ui/ContentSkeleton";

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Адмін",
  operator: "Оператор",
  manager: "Керівник",
};

const ROLE_COLOR: Record<UserRole, string> = {
  admin: "badge badge-accent",
  operator: "badge badge-print",
  manager: "badge badge-warn",
};

// ── Module access ─────────────────────────────────────────────────────────────

const ALL_MODULES = [
  { key: "dashboard",  label: "Дашборд (принтери)" },
  { key: "plan",       label: "Черга / план" },
  { key: "tasks",      label: "Завдання" },
  { key: "history",    label: "Історія друку" },
  { key: "filament",   label: "Філамент" },
  { key: "files",      label: "Файли (gcode)" },
  { key: "printers",   label: "Принтери" },
  { key: "warehouse",  label: "Склад" },
  { key: "analytics",  label: "Аналітика" },
];

function ModuleCheckboxes({ value, onChange }: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const unrestricted = value === null;
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={unrestricted}
          onChange={e => onChange(e.target.checked ? null : ALL_MODULES.map(m => m.key))}
          className="rounded" />
        <span className="text-xs font-medium">Повний доступ (без обмежень)</span>
      </label>
      {!unrestricted && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pl-1 pt-1 border-l-2 border-[var(--border)] ml-1">
          {ALL_MODULES.map(m => (
            <label key={m.key} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox"
                checked={value!.includes(m.key)}
                onChange={e => {
                  const next = e.target.checked
                    ? [...value!, m.key]
                    : value!.filter(k => k !== m.key);
                  onChange(next);
                }}
                className="rounded" />
              <span className="text-xs">{m.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Form ──────────────────────────────────────────────────────────────────────

interface FormState { email: string; name: string; role: UserRole; allowedModules: string[] | null }
const EMPTY_FORM: FormState = { email: "", name: "", role: "operator", allowedModules: null };

function UserFormModal({ open, initial, onClose, onSaved }: {
  open: boolean; initial: AdminUserWithInvite | null;
  onClose: () => void; onSaved: (u: AdminUserWithInvite) => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initial
        ? { email: initial.email, name: initial.name, role: initial.role, allowedModules: initial.allowed_modules ?? null }
        : EMPTY_FORM);
      setError(null);
    }
  }, [open, initial]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      let saved: AdminUserWithInvite;
      if (initial) {
        saved = await api<AdminUserWithInvite>(`/api/users/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: form.name, role: form.role, allowed_modules: form.allowedModules }),
        });
      } else {
        saved = await api<AdminUserWithInvite>("/api/users", {
          method: "POST",
          body: JSON.stringify({ email: form.email, name: form.name, role: form.role, allowed_modules: form.allowedModules }),
        });
      }
      onSaved(saved); onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Помилка"); }
    finally { setBusy(false); }
  }

  const isAdmin = form.role === "admin";

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }}
      title={initial ? "Редагувати користувача" : "Запросити користувача"}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost disabled:opacity-50">Скасувати</button>
        <button type="submit" form="user-form" disabled={busy} className="btn btn-primary disabled:opacity-50">
          {busy ? "Зберігаю…" : initial ? "Зберегти" : "Запросити"}
        </button>
      </>}>
      <form id="user-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block"><span className="mb-1 block">Email</span>
          <input type="email" required disabled={!!initial} value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            placeholder="user@example.com" className="input disabled:opacity-60" /></label>
        <label className="block"><span className="mb-1 block">Імʼя</span>
          <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Іван" className="input" /></label>
        <label className="block"><span className="mb-1 block">Роль</span>
          <select value={form.role}
            onChange={e => {
              const role = e.target.value as UserRole;
              setForm(f => ({ ...f, role, allowedModules: role === "admin" ? null : f.allowedModules }));
            }}
            className="input">
            {(Object.keys(ROLE_LABEL) as UserRole[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select></label>

        {/* Module access — only for non-admin */}
        {!isAdmin && (
          <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
            <p className="text-xs font-semibold text-[var(--text-muted)]">Доступ до модулів</p>
            <ModuleCheckboxes
              value={form.allowedModules}
              onChange={v => setForm(f => ({ ...f, allowedModules: v }))}
            />
          </div>
        )}
        {isAdmin && (
          <p className="text-xs text-[var(--text-faint)]">Адміни мають повний доступ до всіх модулів.</p>
        )}

        {!initial && <p className="text-xs text-[var(--text-muted)]">Запрошення надійде на email. Користувач сам встановить пароль.</p>}
        {error && <p className="text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

export function UsersSection() {
  const { confirm, dialog } = useConfirm();
  const me = useUser();
  const [users, setUsers] = useState<AdminUserWithInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminUserWithInvite | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [tgLinkUser, setTgLinkUser] = useState<AdminUserWithInvite | null>(null);

  const load = useCallback(async () => {
    try { setUsers(await api<AdminUserWithInvite[]>("/api/users")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function upsert(u: AdminUserWithInvite) {
    setUsers(prev => {
      const idx = prev.findIndex(x => x.id === u.id);
      if (idx === -1) return [...prev, u];
      const copy = [...prev]; copy[idx] = u; return copy;
    });
  }

  async function toggleActive(u: AdminUserWithInvite) {
    if (u.id === me.id) return;
    const updated = await api<AdminUserWithInvite>(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ is_active: !u.is_active }) });
    upsert(updated);
  }

  async function remove(u: AdminUserWithInvite) {
    if (u.id === me.id) return;
    if (!await confirm({ message: `Видалити користувача ${u.email}?`, variant: "danger" })) return;
    await api(`/api/users/${u.id}`, { method: "DELETE" });
    setUsers(prev => prev.filter(x => x.id !== u.id));
  }

  async function unlinkTelegram(u: AdminUserWithInvite) {
    if (!await confirm({ message: `Відвʼязати Telegram від ${u.email}?`, variant: "warn" })) return;
    const updated = await api<AdminUserWithInvite>(`/api/users/${u.id}/telegram`, { method: "DELETE" });
    upsert(updated);
  }

  async function resendInvite(u: AdminUserWithInvite) {
    await api(`/api/users/${u.id}/resend-invite`, { method: "POST" });
  }

  if (loading) return <PageSkeleton cols={5} rows={4} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Користувачі</h2>
        <button onClick={() => { setEditing(null); setModalOpen(true); }} className="btn btn-primary">
          + Додати
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
            <tr>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Імʼя</th>
              <th className="px-4 py-3 font-medium">Роль</th>
              <th className="px-4 py-3 font-medium">Статус</th>
              <th className="px-4 py-3 font-medium">Telegram</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {users.map(u => (
              <tr key={u.id} className={u.is_active ? "" : "opacity-50"}>
                <td className="px-4 py-3 font-medium">
                  {u.email}
                  {u.id === me.id && <span className="ml-1.5 text-xs text-[var(--text-faint)]">(ти)</span>}
                </td>
                <td className="px-4 py-3 text-[var(--text-muted)]">{u.name || "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${ROLE_COLOR[u.role]}`}>{ROLE_LABEL[u.role]}</span>
                </td>
                <td className="px-4 py-3 text-xs">
                  {u.invite_pending
                    ? <span className="text-[var(--state-warn)]">◌ Очікує</span>
                    : u.is_active
                      ? <span className="text-[var(--state-ok)]">● Активний</span>
                      : <span className="text-[var(--text-faint)]">○ Деактивований</span>}
                </td>
                <td className="px-4 py-3 text-xs">
                  {u.telegram_chat_id ? (
                    <button onClick={() => unlinkTelegram(u)} className="text-[var(--accent)] hover:underline" title="Відвʼязати">✓ Привʼязано</button>
                  ) : (
                    <button onClick={() => setTgLinkUser(u)} className="text-[var(--text-muted)] hover:text-[var(--text)] hover:underline">Привʼязати</button>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    {u.invite_pending
                      ? <button onClick={() => resendInvite(u)}
                          className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
                          title="Надіслати запрошення знову">↻ Повторити</button>
                      : <button onClick={() => { setEditing(u); setModalOpen(true); }}
                          className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]" title="Редагувати">✎</button>
                    }
                    {u.id !== me.id && (
                      <>
                        {!u.invite_pending && <button onClick={() => toggleActive(u)}
                          className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)]"
                          title={u.is_active ? "Деактивувати" : "Активувати"}>{u.is_active ? "⏸" : "▶"}</button>}
                        <button onClick={() => remove(u)}
                          className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-error)]" title="Видалити">✕</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <UserFormModal open={modalOpen} initial={editing} onClose={() => setModalOpen(false)} onSaved={upsert} />
      {tgLinkUser && <TelegramLinkModal key={tgLinkUser.id} user={tgLinkUser as AdminUser} onClose={() => setTgLinkUser(null)} />}
      {dialog}
    </div>
  );
}
