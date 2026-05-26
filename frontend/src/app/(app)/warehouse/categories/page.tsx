"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Category = {
  id:         number;
  name:       string;
  color:      string | null;
  sort_order: number;
  created_at: string;
};

// Preset palette (Notion-style)
const COLORS = [
  "#e5e7eb", // neutral
  "#fecdd3", // rose
  "#fed7aa", // orange
  "#fef08a", // yellow
  "#bbf7d0", // green
  "#bae6fd", // sky
  "#c7d2fe", // indigo
  "#f5d0fe", // purple
  "#fce7f3", // pink
];

// ── ColorDot ──────────────────────────────────────────────────────────────────

function ColorDot({ color }: { color: string | null }) {
  return (
    <span
      className="inline-block size-3 rounded-full border border-black/10 shrink-0"
      style={{ background: color ?? "#e5e7eb" }}
    />
  );
}

// ── CategoryModal ─────────────────────────────────────────────────────────────

function CategoryModal({
  category,
  onClose,
  onSaved,
}: {
  category: Category | null;
  onClose: () => void;
  onSaved: (c: Category) => void;
}) {
  const isEdit = category !== null;
  const [name,  setName]  = useState(category?.name  ?? "");
  const [color, setColor] = useState(category?.color ?? COLORS[0]);
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = { name: name.trim(), color };
      const cat = isEdit
        ? await api<Category>(`/api/warehouse/categories/${category!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<Category>("/api/warehouse/categories", { method: "POST", body: JSON.stringify(body) });
      onSaved(cat);
      onClose();
    } catch {
      setErr("Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl  ">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4 ">
          <h2 className="font-semibold">{isEdit ? "Редагувати категорію" : "Нова категорія"}</h2>
          <button onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] ">
            ×
          </button>
        </div>

        <form onSubmit={save} className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1.5 block text-sm text-[var(--text-muted)] ">Назва</label>
            <input
              required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]   "
            />
          </div>

          {/* Color */}
          <div>
            <label className="mb-1.5 block text-sm text-[var(--text-muted)] ">Колір</label>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button
                  key={c} type="button"
                  onClick={() => setColor(c)}
                  className={[
                    "size-7 rounded-full border-2 transition-transform hover:scale-110",
                    color === c ? "border-[var(--border-strong)]  scale-110" : "border-transparent",
                  ].join(" ")}
                  style={{ background: c }}
                />
              ))}
              {/* Custom hex */}
              <label className="flex size-7 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-[var(--border-strong)] text-[10px] text-[var(--text-faint)] hover:border-neutral-500 " title="Свій колір">
                <input type="color" value={color ?? "#e5e7eb"} onChange={(e) => setColor(e.target.value)} className="sr-only" />
                +
              </label>
            </div>
            {/* Preview */}
            <div className="mt-2 flex items-center gap-2">
              <span
                className="rounded-full px-2.5 py-0.5 text-xs font-medium"
                style={{ background: color ?? "#e5e7eb", color: "#111" }}
              >
                {name || "Приклад"}
              </span>
            </div>
          </div>

          {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={busy}
              className="rounded-md px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
              Скасувати
            </button>
            <button type="submit" disabled={busy || !name.trim()}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
              {busy ? "Зберігаю…" : isEdit ? "Зберегти" : "Додати"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [modal,      setModal]      = useState<Category | null | "create">(null);
  const [deleting,   setDeleting]   = useState<number | null>(null);

  const load = useCallback(async () => {
    try { setCategories(await api<Category[]>("/api/warehouse/categories")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleSaved(c: Category) {
    setCategories((prev) => {
      const idx = prev.findIndex((x) => x.id === c.id);
      return idx >= 0 ? prev.map((x) => x.id === c.id ? c : x) : [...prev, c];
    });
  }

  async function deleteCategory(id: number) {
    if (!window.confirm("Видалити категорію? Продукти з цією категорією залишаться незмінними.")) return;
    setDeleting(id);
    try {
      await api(`/api/warehouse/categories/${id}`, { method: "DELETE" });
      setCategories((prev) => prev.filter((c) => c.id !== id));
    } finally {
      setDeleting(null);
    }
  }

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Категорії товарів</h1>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">
            {categories.length} {categories.length === 1 ? "категорія" : "категорій"} · використовуються для фільтрації номенклатури
          </p>
        </div>
        <button
          onClick={() => setModal("create")}
          className="h-9 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white hover:bg-[var(--accent-hi)]  "
        >
          + Категорія
        </button>
      </div>

      {/* List */}
      {categories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-16 text-center ">
          <p className="text-sm text-[var(--text-muted)]">Категорій ще немає</p>
          <p className="mt-1 text-xs text-[var(--text-faint)]">Додай першу, щоб групувати номенклатуру</p>
          <button
            onClick={() => setModal("create")}
            className="mt-4 rounded-md bg-[var(--accent)] px-4 py-2 text-sm text-white hover:bg-[var(--accent-hi)]  "
          >
            Додати категорію
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]  ">
              <tr>
                <th className="px-5 py-3 font-medium">Назва</th>
                <th className="px-4 py-3 font-medium">Колір</th>
                <th className="px-4 py-3 font-medium text-right">Дата створення</th>
                <th className="w-20 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] dark:divide-neutral-800">
              {categories.map((cat) => (
                <tr key={cat.id} className="group hover:bg-[var(--surface-hi)]/80 ">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <ColorDot color={cat.color} />
                      <span
                        className="rounded-full px-2.5 py-0.5 text-xs font-medium"
                        style={{ background: cat.color ?? "#e5e7eb", color: "#111" }}
                      >
                        {cat.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs text-[var(--text-faint)]">{cat.color ?? "—"}</code>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[var(--text-faint)]">
                    {new Date(cat.created_at).toLocaleDateString("uk-UA")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => setModal(cat)}
                        className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] "
                        title="Редагувати"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => deleteCategory(cat.id)}
                        disabled={deleting === cat.id}
                        className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-red-50 hover:text-red-500 disabled:opacity-50 dark:hover:bg-red-950/30"
                        title="Видалити"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                          <path d="M10 11v6M14 11v6"/>
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal !== null && (
        <CategoryModal
          category={modal === "create" ? null : modal}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
