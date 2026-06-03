"use client";

import { useCallback, useEffect, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { TelegramLinkModal } from "@/components/users/TelegramLinkModal";
import { useConfirm } from "@/hooks/useConfirm";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import type { AdminUser, CustomRole, UserRole } from "@/lib/types";

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

interface FormState {
  email: string; name: string; role: UserRole;
  customRoleId: string;   // "" = no custom role, use allowedModules
  allowedModules: string[] | null;
}

const EMPTY_FORM: FormState = { email: "", name: "", role: "operator", customRoleId: "", allowedModules: null };

function UserFormModal({ open, initial, customRoles, onClose, onSaved }: {
  open: boolean; initial: AdminUserWithInvite | null;
  customRoles: CustomRole[];
  onClose: () => void; onSaved: (u: AdminUserWithInvite) => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initial ? {
        email: initial.email, name: initial.name, role: initial.role,
        customRoleId: initial.custom_role_id ? String(initial.custom_role_id) : "",
        allowedModules: initial.allowed_modules ?? null,
      } : EMPTY_FORM);
      setError(null);
    }
  }, [open, initial]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const customRoleId = form.customRoleId ? parseInt(form.customRoleId) : null;
      const body = {
        email: form.email, name: form.name, role: form.role,
        custom_role_id: customRoleId,
        allowed_modules: customRoleId ? null : form.allowedModules,
      };
      let saved: AdminUserWithInvite;
      if (initial) {
        saved = await api<AdminUserWithInvite>(`/api/users/${initial.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        saved = await api<AdminUserWithInvite>("/api/users", { method: "POST", body: JSON.stringify(body) });
      }
      onSaved(saved); onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Помилка"); }
    finally { setBusy(false); }
  }

  const isAdmin = form.role === "admin";
  const hasCustomRole = !!form.customRoleId;

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
        <label className="block"><span className="mb-1 block">Базова роль</span>
          <select value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value as UserRole, customRoleId: "", allowedModules: null }))}
            className="input">
            {(Object.keys(ROLE_LABEL) as UserRole[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <p className="text-[10.5px] text-[var(--text-faint)] mt-1">Оператор/Керівник — рівень прав; модулі контролюються нижче.</p>
        </label>

        {/* Custom role OR individual modules */}
        {!isAdmin && (
          <div className="rounded-lg border border-[var(--border)] p-3 space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-[var(--text-muted)]">Шаблон ролі</span>
              <select value={form.customRoleId}
                onChange={e => setForm(f => ({ ...f, customRoleId: e.target.value, allowedModules: null }))}
                className="input text-sm">
                <option value="">— Індивідуальні права —</option>
                {customRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              {form.customRoleId && (() => {
                const cr = customRoles.find(r => String(r.id) === form.customRoleId);
                return cr ? (
                  <p className="text-[10.5px] text-[var(--accent)] mt-1">
                    Модулі: {cr.allowed_modules.length === 0 ? "повний доступ" : cr.allowed_modules.join(", ")}
                  </p>
                ) : null;
              })()}
            </label>
            {!hasCustomRole && (
              <>
                <div className="h-px bg-[var(--border)]" />
                <div>
                  <p className="text-xs font-semibold text-[var(--text-muted)] mb-2">Або вибери модулі вручну</p>
                  <ModuleCheckboxes value={form.allowedModules} onChange={v => setForm(f => ({ ...f, allowedModules: v }))} />
                </div>
              </>
            )}
          </div>
        )}
        {isAdmin && <p className="text-xs text-[var(--text-faint)]">Адміни мають повний доступ до всіх модулів.</p>}

        {!initial && <p className="text-xs text-[var(--text-muted)]">Запрошення надійде на email. Користувач сам встановить пароль.</p>}
        {error && <p className="text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

export function UsersSection() {
  const { confirm, dialog } = useConfirm();
  const me = useUser();
  const [tab, setTab] = useState<"users" | "roles">("users");
  const [users, setUsers] = useState<AdminUserWithInvite[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminUserWithInvite | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [tgLinkUser, setTgLinkUser] = useState<AdminUserWithInvite | null>(null);
  // role management
  const [editingRole, setEditingRole] = useState<CustomRole | null>(null);
  const [roleForm, setRoleForm] = useState({ name: "", allowedModules: null as string[] | null });
  const [roleBusy, setRoleBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([
        api<AdminUserWithInvite[]>("/api/users"),
        api<CustomRole[]>("/api/roles"),
      ]);
      setUsers(u); setCustomRoles(r);
    }
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

  async function saveRole(e: React.FormEvent) {
    e.preventDefault(); setRoleBusy(true);
    try {
      const body = { name: roleForm.name, allowed_modules: roleForm.allowedModules ?? [] };
      let saved: CustomRole;
      if (editingRole) {
        saved = await api<CustomRole>(`/api/roles/${editingRole.id}`, { method: "PATCH", body: JSON.stringify(body) });
        setCustomRoles(prev => prev.map(r => r.id === saved.id ? saved : r));
      } else {
        saved = await api<CustomRole>("/api/roles", { method: "POST", body: JSON.stringify(body) });
        setCustomRoles(prev => [...prev, saved]);
      }
      setEditingRole(null); setRoleForm({ name: "", allowedModules: null });
    } finally { setRoleBusy(false); }
  }

  async function deleteRole(r: CustomRole) {
    if (!await confirm({ message: `Видалити роль «${r.name}»? Всі юзери з цією роллю отримають повний доступ.`, variant: "danger" })) return;
    await api(`/api/roles/${r.id}`, { method: "DELETE" });
    setCustomRoles(prev => prev.filter(x => x.id !== r.id));
    setUsers(prev => prev.map(u => u.custom_role_id === r.id ? { ...u, custom_role_id: null, custom_role_name: null } : u));
  }

  if (loading) return <PageSkeleton cols={5} rows={4} />;

  return (
    <div className="space-y-4">
      {/* tabs */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-1 border-b border-[var(--border)] flex-1">
          {([["users","Користувачі"],["roles","Ролі"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === id ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}>{label}</button>
          ))}
        </div>
        {tab === "users" && (
          <button onClick={() => { setEditing(null); setModalOpen(true); }} className="btn btn-primary shrink-0">
            + Додати
          </button>
        )}
        {tab === "roles" && (
          <button onClick={() => { setEditingRole(null); setRoleForm({ name: "", allowedModules: null }); }}
            className="btn btn-primary shrink-0">
            + Нова роль
          </button>
        )}
      </div>

      {/* ── Users tab ── */}
      {tab === "users" && (
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
                    <div className="flex flex-wrap gap-1">
                      <span className={`rounded px-1.5 py-0.5 text-xs ${ROLE_COLOR[u.role]}`}>{ROLE_LABEL[u.role]}</span>
                      {u.custom_role_name && (
                        <span className="rounded px-1.5 py-0.5 text-xs bg-[var(--surface-hi)] text-[var(--text-muted)]">{u.custom_role_name}</span>
                      )}
                    </div>
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
                      <button onClick={() => unlinkTelegram(u)} className="text-[var(--accent)] hover:underline">✓ Привʼязано</button>
                    ) : (
                      <button onClick={() => setTgLinkUser(u)} className="text-[var(--text-muted)] hover:text-[var(--text)] hover:underline">Привʼязати</button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {u.invite_pending
                        ? <button onClick={() => resendInvite(u)} className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">↻ Повторити</button>
                        : <button onClick={() => { setEditing(u); setModalOpen(true); }} className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">✎</button>}
                      {u.id !== me.id && (
                        <>
                          {!u.invite_pending && <button onClick={() => toggleActive(u)} className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">{u.is_active ? "⏸" : "▶"}</button>}
                          <button onClick={() => remove(u)} className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-error)]">✕</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Roles tab ── */}
      {tab === "roles" && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-faint)]">
            Створюй ролі з набором модулів, потім призначай юзерам одним кліком. Зміна ролі одразу впливає на всіх.
          </p>

          {/* role editor */}
          {(editingRole !== undefined) && (
            <form onSubmit={saveRole}
              className="rounded-xl border border-[var(--accent)] bg-[var(--bg-elevated)] p-4 space-y-3">
              <p className="text-sm font-semibold">{editingRole ? `Редагувати: ${editingRole.name}` : "Нова роль"}</p>
              <input required placeholder="Назва ролі (напр. Складник)" value={roleForm.name}
                onChange={e => setRoleForm(f => ({ ...f, name: e.target.value }))}
                className="input w-full" />
              <div>
                <p className="text-xs font-semibold text-[var(--text-muted)] mb-2">Модулі</p>
                <ModuleCheckboxes value={roleForm.allowedModules}
                  onChange={v => setRoleForm(f => ({ ...f, allowedModules: v }))} />
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={roleBusy} className="btn btn-primary disabled:opacity-50">{roleBusy ? "…" : "Зберегти"}</button>
                <button type="button" onClick={() => setEditingRole(undefined as unknown as CustomRole | null)}
                  className="btn btn-ghost">Скасувати</button>
              </div>
            </form>
          )}

          {customRoles.length === 0 && !editingRole ? (
            <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-10 text-center text-sm text-[var(--text-muted)]">
              Ще немає ролей — натисни «+ Нова роль» щоб створити першу
            </div>
          ) : (
            <div className="space-y-2">
              {customRoles.map(r => (
                <div key={r.id} className="flex items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">{r.name}</p>
                    <p className="text-xs text-[var(--text-faint)] mt-0.5">
                      {r.allowed_modules.length === 0
                        ? "Повний доступ"
                        : r.allowed_modules.map(m => ALL_MODULES.find(x => x.key === m)?.label ?? m).join(", ")}
                    </p>
                    <p className="text-xs text-[var(--text-faint)]">
                      {users.filter(u => u.custom_role_id === r.id).length} юзерів з цією роллю
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => { setEditingRole(r); setRoleForm({ name: r.name, allowedModules: r.allowed_modules }); }}
                      className="rounded p-1.5 text-[var(--text-faint)] hover:bg-[var(--surface-hi)]" title="Редагувати">✎</button>
                    <button onClick={() => deleteRole(r)}
                      className="rounded p-1.5 text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]" title="Видалити">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <UserFormModal open={modalOpen} initial={editing} customRoles={customRoles}
        onClose={() => setModalOpen(false)} onSaved={upsert} />
      {tgLinkUser && <TelegramLinkModal key={tgLinkUser.id} user={tgLinkUser as AdminUser} onClose={() => setTgLinkUser(null)} />}
      {dialog}
    </div>
  );
}
