"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import type { Filament, FilamentColor } from "@/lib/types";

// ─── Filament form (create/edit) ──────────────────────────────────────────────

function FilamentFormModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: Filament | null;
  onClose: () => void;
  onSaved: (f: Filament) => void;
}) {
  const [material, setMaterial] = useState("");
  const [color, setColor] = useState("");
  const [brand, setBrand] = useState("");
  const [grams, setGrams] = useState("0");
  const [minGrams, setMinGrams] = useState("0");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMaterial(initial?.material ?? "");
      setColor(initial?.color ?? "");
      setBrand(initial?.brand ?? "");
      setGrams(String(initial?.grams_remaining ?? 0));
      setMinGrams(String(initial?.min_grams ?? 0));
      setNote(initial?.note ?? "");
      setError(null);
    }
  }, [open, initial]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        material: material.trim(),
        color: color.trim(),
        brand: brand.trim() || null,
        grams_remaining: parseInt(grams) || 0,
        min_grams: parseInt(minGrams) || 0,
        note: note.trim() || null,
      };
      const saved = initial
        ? await api<Filament>(`/api/filaments/${initial.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : await api<Filament>("/api/filaments", {
            method: "POST",
            body: JSON.stringify(body),
          });
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
      title={initial ? "Редагувати пластик" : "Новий пластик"}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Скасувати
          </button>
          <button type="submit" form="filament-form" disabled={busy || !material.trim() || !color.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
            {busy ? "Зберігаю…" : initial ? "Зберегти" : "Додати"}
          </button>
        </>
      }
    >
      <form id="filament-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Матеріал</span>
            <input type="text" required autoFocus value={material} onChange={e => setMaterial(e.target.value)}
              placeholder="PLA"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
          <label className="block">
            <span className="mb-1 block">Колір</span>
            <input type="text" required value={color} onChange={e => setColor(e.target.value)}
              placeholder="Чорний"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block">Виробник</span>
          <input type="text" value={brand} onChange={e => setBrand(e.target.value)}
            placeholder="Bambu, eSun, …"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Залишок (г)</span>
            <input type="number" min={0} value={grams} onChange={e => setGrams(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
          <label className="block">
            <span className="mb-1 block">Поріг алерту (г)</span>
            <input type="number" min={0} value={minGrams} onChange={e => setMinGrams(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block">Нотатка</span>
          <input type="text" value={note} onChange={e => setNote(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ─── Adjust stock (quick + / - grams) ─────────────────────────────────────────

function AdjustModal({
  filament,
  onClose,
  onSaved,
}: {
  filament: Filament | null;
  onClose: () => void;
  onSaved: (f: Filament) => void;
}) {
  const [delta, setDelta] = useState("");
  const [direction, setDirection] = useState<"add" | "consume">("consume");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (filament) {
      setDelta("");
      setDirection("consume");
      setError(null);
    }
  }, [filament]);

  if (!filament) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const grams = parseInt(delta);
      if (!grams || grams <= 0) throw new ApiError(400, "Введи позитивне число");
      const signed = direction === "add" ? grams : -grams;
      const saved = await api<Filament>(`/api/filaments/${filament!.id}/adjust`, {
        method: "POST",
        body: JSON.stringify({ delta_grams: signed }),
      });
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
      open={!!filament}
      onClose={() => { if (!busy) onClose(); }}
      title={`${filament.material} · ${filament.color}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Скасувати
          </button>
          <button type="submit" form="adjust-form" disabled={busy || !delta}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
            {busy ? "Зберігаю…" : "Застосувати"}
          </button>
        </>
      }
    >
      <form id="adjust-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          <div className="text-xs text-neutral-500">Поточний залишок</div>
          <div className="text-base font-semibold">{filament.grams_remaining} г</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button"
            onClick={() => setDirection("consume")}
            className={`rounded-md border px-3 py-2 text-sm ${
              direction === "consume"
                ? "border-red-400 bg-red-50 text-red-700 dark:border-red-600 dark:bg-red-950/30 dark:text-red-300"
                : "border-neutral-200 dark:border-neutral-800"
            }`}>
            − Списати
          </button>
          <button type="button"
            onClick={() => setDirection("add")}
            className={`rounded-md border px-3 py-2 text-sm ${
              direction === "add"
                ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-neutral-200 dark:border-neutral-800"
            }`}>
            + Надійшло
          </button>
        </div>
        <label className="block">
          <span className="mb-1 block">Грами</span>
          <input type="number" required min={1} autoFocus value={delta} onChange={e => setDelta(e.target.value)}
            placeholder="напр. 250"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        {delta && (
          <div className="text-xs text-neutral-500">
            Стане:{" "}
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              {filament.grams_remaining +
                (direction === "add" ? 1 : -1) * (parseInt(delta) || 0)}{" "}
              г
            </span>
          </div>
        )}
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ─── Filament Colors ──────────────────────────────────────────────────────────

function FilamentColorsSection({ canEdit }: { canEdit: boolean }) {
  const [colors, setColors] = useState<FilamentColor[]>([]);
  const [loading, setLoading] = useState(true);
  const [editColor, setEditColor] = useState<FilamentColor | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [hex, setHex] = useState("#ffffff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setColors(await api<FilamentColor[]>("/api/filament-colors")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openAdd() { setName(""); setHex("#3b82f6"); setEditColor(null); setError(null); setAddOpen(true); }
  function openEdit(c: FilamentColor) { setName(c.name); setHex(c.hex_color); setEditColor(c); setError(null); setAddOpen(true); }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      if (editColor) {
        const updated = await api<FilamentColor>(`/api/filament-colors/${editColor.id}`, {
          method: "PATCH", body: JSON.stringify({ name: name.trim(), hex_color: hex }),
        });
        setColors(prev => prev.map(c => c.id === updated.id ? updated : c));
      } else {
        const created = await api<FilamentColor>("/api/filament-colors", {
          method: "POST", body: JSON.stringify({ name: name.trim(), hex_color: hex }),
        });
        setColors(prev => [...prev, created]);
      }
      setAddOpen(false);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Помилка"); }
    finally { setBusy(false); }
  }

  async function remove(c: FilamentColor) {
    if (!confirm(`Видалити колір "${c.name}"?`)) return;
    await api(`/api/filament-colors/${c.id}`, { method: "DELETE" });
    setColors(prev => prev.filter(x => x.id !== c.id));
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-medium">Каталог кольорів</h2>
        {canEdit && (
          <button onClick={openAdd}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300">
            + Додати колір
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-neutral-400">Завантаження…</p>
      ) : colors.length === 0 ? (
        <p className="text-sm text-neutral-400">Каталог порожній</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {colors.map(c => (
            <div key={c.id}
              className="group flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
              <span className="h-4 w-4 shrink-0 rounded-full border border-neutral-200 dark:border-neutral-700"
                style={{ background: c.hex_color }} />
              <span className="text-sm">{c.name}</span>
              <span className="text-xs text-neutral-400">{c.hex_color}</span>
              {canEdit && (
                <div className="ml-1 hidden gap-0.5 group-hover:flex">
                  <button onClick={() => openEdit(c)} className="rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">✎</button>
                  <button onClick={() => remove(c)} className="rounded p-0.5 text-neutral-400 hover:text-red-600">✕</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={addOpen} onClose={() => { if (!busy) setAddOpen(false); }}
        title={editColor ? "Редагувати колір" : "Новий колір"}
        footer={<>
          <button type="button" onClick={() => setAddOpen(false)} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">Скасувати</button>
          <button type="submit" form="color-form" disabled={busy || !name.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">{busy ? "Зберігаю…" : "Зберегти"}</button>
        </>}
      >
        <form id="color-form" onSubmit={save} className="space-y-3 text-sm">
          <label className="block"><span className="mb-1 block">Назва</span>
            <input type="text" required autoFocus value={name} onChange={e => setName(e.target.value)}
              placeholder="Чорний, Білий, Galaxy Black…"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" /></label>
          <label className="block"><span className="mb-1 block">Колір</span>
            <div className="flex items-center gap-3">
              <input type="color" value={hex} onChange={e => setHex(e.target.value)}
                className="h-10 w-16 cursor-pointer rounded-md border border-neutral-300 bg-white p-1 dark:border-neutral-700 dark:bg-neutral-950" />
              <input type="text" value={hex} onChange={e => setHex(e.target.value)}
                pattern="^#[0-9a-fA-F]{6}$"
                className="w-32 rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
            </div>
          </label>
          {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        </form>
      </Modal>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FilamentPage() {
  const me = useUser();
  const isAdmin = me.role === "admin";
  const canEdit = isAdmin || me.role === "operator";

  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [loading, setLoading] = useState(true);
  const [editFilament, setEditFilament] = useState<Filament | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [adjustFilament, setAdjustFilament] = useState<Filament | null>(null);

  const load = useCallback(async () => {
    try {
      setFilaments(await api<Filament[]>("/api/filaments"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function upsert(f: Filament) {
    setFilaments(prev => {
      const idx = prev.findIndex(x => x.id === f.id);
      if (idx === -1) return [...prev, f];
      const copy = [...prev]; copy[idx] = f; return copy;
    });
  }

  async function remove(f: Filament) {
    if (!confirm(`Видалити ${f.material} · ${f.color}?`)) return;
    await api(`/api/filaments/${f.id}`, { method: "DELETE" });
    setFilaments(prev => prev.filter(x => x.id !== f.id));
  }

  const lowCount = useMemo(() => filaments.filter(f => f.is_low).length, [filaments]);

  if (loading) return <div className="text-sm text-neutral-500">Завантаження…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Пластик</h1>
          {lowCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              ⚠️ {lowCount} закінчується
            </span>
          )}
        </div>
        {canEdit && (
          <button
            onClick={() => { setEditFilament(null); setEditOpen(true); }}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900">
            + Пластик
          </button>
        )}
      </div>

      {filaments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-400 dark:border-neutral-700">
          Немає пластиків — натисни + Пластик
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-950">
              <tr>
                <th className="px-4 py-3 font-medium">Матеріал</th>
                <th className="px-4 py-3 font-medium">Колір</th>
                <th className="px-4 py-3 font-medium">Виробник</th>
                <th className="px-4 py-3 font-medium">Залишок</th>
                <th className="px-4 py-3 font-medium">Поріг</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {filaments.map(f => (
                <tr key={f.id} className={f.is_low ? "bg-amber-50/50 dark:bg-amber-950/20" : ""}>
                  <td className="px-4 py-3 font-medium">{f.material}</td>
                  <td className="px-4 py-3">{f.color}</td>
                  <td className="px-4 py-3 text-neutral-500">{f.brand ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={f.is_low ? "font-semibold text-amber-700 dark:text-amber-400" : ""}>
                      {f.grams_remaining} г
                    </span>
                    {f.is_low && <span className="ml-1 text-xs">⚠️</span>}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">{f.min_grams} г</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {canEdit && (
                        <button onClick={() => setAdjustFilament(f)}
                          className="rounded bg-neutral-100 px-2 py-1 text-xs hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                          title="Списати / Надходження">
                          ± грами
                        </button>
                      )}
                      {canEdit && (
                        <button onClick={() => { setEditFilament(f); setEditOpen(true); }}
                          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
                          title="Редагувати">✎</button>
                      )}
                      {isAdmin && (
                        <button onClick={() => remove(f)}
                          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                          title="Видалити">✕</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FilamentFormModal
        open={editOpen}
        initial={editFilament}
        onClose={() => setEditOpen(false)}
        onSaved={upsert}
      />
      <AdjustModal
        filament={adjustFilament}
        onClose={() => setAdjustFilament(null)}
        onSaved={upsert}
      />

      <div className="mt-10 border-t border-neutral-200 pt-8 dark:border-neutral-800">
        <FilamentColorsSection canEdit={canEdit} />
      </div>
    </div>
  );
}
