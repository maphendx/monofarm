"use client";

import { useCallback, useEffect, useState } from "react";

import { Modal } from "@/components/Modal";
import { TelegramLinkModal } from "@/components/TelegramLinkModal";
import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useUser } from "@/lib/auth-context";
import type { AdminUser, UserRole } from "@/lib/types";

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Адмін",
  operator: "Оператор",
  manager: "Керівник",
};

const ROLE_COLOR: Record<UserRole, string> = {
  admin: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  operator: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  manager: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

interface FormState {
  email: string;
  name: string;
  password: string;
  role: UserRole;
}

const EMPTY_FORM: FormState = {
  email: "",
  name: "",
  password: "",
  role: "operator",
};

function UserFormModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: AdminUser | null;
  onClose: () => void;
  onSaved: (u: AdminUser) => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(
        initial
          ? { email: initial.email, name: initial.name, password: "", role: initial.role }
          : EMPTY_FORM,
      );
      setError(null);
    }
  }, [open, initial]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let saved: AdminUser;
      if (initial) {
        const body: Record<string, unknown> = { name: form.name, role: form.role };
        if (form.password) body.password = form.password;
        saved = await api<AdminUser>(`/api/users/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        saved = await api<AdminUser>("/api/users", {
          method: "POST",
          body: JSON.stringify(form),
        });
      }
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={initial ? "Редагувати користувача" : "Додати користувача"}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
            Скасувати
          </button>
          <button type="submit" form="user-form" disabled={busy}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
            {busy ? "Зберігаю…" : initial ? "Зберегти" : "Створити"}
          </button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block">Email</span>
          <input type="email" required disabled={!!initial} value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            placeholder="user@example.com"
            className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-[var(--border-focus)] disabled:opacity-60  " />
        </label>
        <label className="block">
          <span className="mb-1 block">Імʼя</span>
          <input type="text" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Іван"
            className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-[var(--border-focus)] " />
        </label>
        <label className="block">
          <span className="mb-1 block">
            Пароль {initial && <span className="text-[var(--text-faint)]">(залиш порожнім — не міняти)</span>}
          </span>
          <input type="password" required={!initial} minLength={6} value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            placeholder="мін. 6 символів"
            className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-[var(--border-focus)] " />
        </label>
        <label className="block">
          <span className="mb-1 block">Роль</span>
          <select value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value as UserRole }))}
            className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none  ">
            {(Object.keys(ROLE_LABEL) as UserRole[]).map(r => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </label>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const t = useT();
  const me = useUser();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [tgLinkUser, setTgLinkUser] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api<AdminUser[]>("/api/users"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function upsert(u: AdminUser) {
    setUsers(prev => {
      const idx = prev.findIndex(x => x.id === u.id);
      if (idx === -1) return [...prev, u];
      const copy = [...prev]; copy[idx] = u; return copy;
    });
  }

  async function toggleActive(u: AdminUser) {
    if (u.id === me.id) return;
    const updated = await api<AdminUser>(`/api/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: !u.is_active }),
    });
    upsert(updated);
  }

  async function remove(u: AdminUser) {
    if (u.id === me.id) return;
    if (!confirm(`Видалити користувача ${u.email}?`)) return;
    await api(`/api/users/${u.id}`, { method: "DELETE" });
    setUsers(prev => prev.filter(x => x.id !== u.id));
  }

  async function unlinkTelegram(u: AdminUser) {
    if (!confirm(`Відвʼязати Telegram від ${u.email}?`)) return;
    const updated = await api<AdminUser>(`/api/users/${u.id}/telegram`, { method: "DELETE" });
    upsert(updated);
  }

  if (loading) return <div className="text-sm text-[var(--text-muted)]">{t("common.loading")}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("users.title")}</h1>
        <button onClick={() => { setEditing(null); setModalOpen(true); }}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)]  ">
          + {t("users.addUser")}
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)] ">
            <tr>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Імʼя</th>
              <th className="px-4 py-3 font-medium">Роль</th>
              <th className="px-4 py-3 font-medium">Статус</th>
              <th className="px-4 py-3 font-medium">Telegram</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] dark:divide-neutral-800">
            {users.map(u => (
              <tr key={u.id} className={u.is_active ? "" : "opacity-50"}>
                <td className="px-4 py-3 font-medium">
                  {u.email}
                  {u.id === me.id && <span className="ml-1.5 text-xs text-[var(--text-faint)]">(ти)</span>}
                </td>
                <td className="px-4 py-3 text-[var(--text-muted)] ">{u.name || "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${ROLE_COLOR[u.role]}`}>
                    {ROLE_LABEL[u.role]}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs">
                  {u.is_active ? (
                    <span className="text-emerald-600 dark:text-emerald-400">● Активний</span>
                  ) : (
                    <span className="text-[var(--text-faint)]">○ Деактивований</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {u.telegram_chat_id ? (
                    <button
                      onClick={() => unlinkTelegram(u)}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                      title="Відвʼязати"
                    >
                      ✓ Привʼязано
                    </button>
                  ) : (
                    <button
                      onClick={() => setTgLinkUser(u)}
                      className="text-[var(--text-muted)] hover:text-[var(--text-hi)] hover:underline "
                    >
                      Привʼязати
                    </button>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => { setEditing(u); setModalOpen(true); }}
                      className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] "
                      title="Редагувати">✎</button>
                    {u.id !== me.id && (
                      <>
                        <button onClick={() => toggleActive(u)}
                          className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] "
                          title={u.is_active ? "Деактивувати" : "Активувати"}>
                          {u.is_active ? "⏸" : "▶"}
                        </button>
                        <button onClick={() => remove(u)}
                          className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-red-600 "
                          title="Видалити">✕</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <UserFormModal
        open={modalOpen}
        initial={editing}
        onClose={() => setModalOpen(false)}
        onSaved={upsert}
      />

      <TelegramLinkModal
        user={tgLinkUser}
        onClose={() => setTgLinkUser(null)}
      />
    </div>
  );
}
