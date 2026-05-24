"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useUser } from "@/lib/auth-context";
import type { Filament, FilamentColor } from "@/lib/types";

// ── constants ─────────────────────────────────────────────────────────────────

const FULL_SPOOL_G = 1000;

const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "HIPS", "PVA", "PP"];
const BRANDS = ["Bambu Lab", "eSun", "Polymaker", "Polydream", "Prusament", "Creality", "FormFutura", "Sunlu"];

// ── SVG spool ─────────────────────────────────────────────────────────────────

function SpoolSVG({ pct, hexColor }: { pct: number; hexColor: string | null }) {
  const R = 19;
  const C = 2 * Math.PI * R;
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * C;
  const color = hexColor || "#9ca3af";

  return (
    <svg viewBox="0 0 60 60" className="w-full h-full" aria-hidden="true">
      {/* spool face */}
      <circle cx="30" cy="30" r="28" fill="#e5e7eb" className="dark:fill-neutral-700" />
      {/* empty filament zone */}
      <circle cx="30" cy="30" r={R} fill="none" stroke="#d1d5db" strokeWidth="18"
        className="dark:stroke-neutral-600" />
      {/* remaining filament */}
      {pct > 0 && (
        <circle cx="30" cy="30" r={R} fill="none" stroke={color} strokeWidth="18"
          strokeDasharray={`${filled} ${C}`}
          strokeLinecap="butt"
          transform="rotate(-90 30 30)" />
      )}
      {/* hub */}
      <circle cx="30" cy="30" r="9" fill="#525252" className="dark:fill-neutral-400" />
      {/* center hole */}
      <circle cx="30" cy="30" r="4.5" fill="#171717" className="dark:fill-neutral-950" />
    </svg>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button onClick={copy}
      className="rounded px-1.5 py-0.5 text-[10px] font-mono text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      title="Копіювати SKU">
      {copied ? "✓" : text}
    </button>
  );
}

// ── FilamentCard ──────────────────────────────────────────────────────────────

function FilamentCard({
  f, canEdit, isAdmin, onAdjust, onEdit, onDelete,
}: {
  f: Filament; canEdit: boolean; isAdmin: boolean;
  onAdjust: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const pct = Math.min(100, Math.round((f.grams_remaining / FULL_SPOOL_G) * 100));
  const isLow = f.is_low;

  return (
    <div className={[
      "relative flex flex-col gap-3 rounded-xl border bg-white p-4 transition dark:bg-neutral-900",
      isLow ? "border-amber-300 dark:border-amber-700" : "border-neutral-200 dark:border-neutral-800",
    ].join(" ")}>
      {/* spool visual + info */}
      <div className="flex items-center gap-3">
        <div className="h-14 w-14 shrink-0">
          <SpoolSVG pct={pct} hexColor={f.hex_color ?? null} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-sm">{f.material}</p>
          <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
            {f.color}{f.brand ? ` · ${f.brand}` : ""}
          </p>
          <p className={[
            "mt-1 text-base font-bold tabular-nums",
            isLow ? "text-amber-600 dark:text-amber-400" : "",
          ].join(" ")}>
            {f.grams_remaining} г
            {isLow && <span className="ml-2 text-[10px] font-normal">мало</span>}
          </p>
        </div>
      </div>

      {/* SKU */}
      {f.sku && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-neutral-400">SKU</span>
          <CopyButton text={f.sku} />
        </div>
      )}

      {/* progress bar */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div className={[
          "h-full rounded-full transition-all",
          isLow ? "bg-amber-400" : pct < 20 ? "bg-orange-400" : "bg-emerald-500",
        ].join(" ")} style={{ width: `${pct}%` }} />
      </div>

      {/* cost + note */}
      {(f.cost_per_kg != null || f.note) && (
        <div className="flex items-center gap-3 text-[11px] text-neutral-400">
          {f.cost_per_kg != null && (
            <span>{f.cost_per_kg} грн/кг · ~{((f.cost_per_kg / 1000) * f.grams_remaining).toFixed(0)} грн</span>
          )}
          {f.note && <span className="line-clamp-1">{f.note}</span>}
        </div>
      )}

      {/* actions */}
      <div className="flex items-center gap-1">
        {canEdit && (
          <button onClick={onAdjust}
            className="flex-1 rounded-md border border-neutral-200 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
            ± Грами
          </button>
        )}
        {canEdit && (
          <button onClick={onEdit}
            className="rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            title="Редагувати">
            ✎
          </button>
        )}
        {isAdmin && (
          <button onClick={onDelete}
            className="rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-400 hover:bg-neutral-50 hover:text-red-600 dark:border-neutral-700 dark:hover:bg-neutral-800"
            title="Видалити">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

// ── FilamentFormModal ─────────────────────────────────────────────────────────

function FilamentFormModal({
  open, initial, onClose, onSaved,
}: {
  open: boolean; initial: Filament | null; onClose: () => void; onSaved: (f: Filament) => void;
}) {
  const [material, setMaterial] = useState("");
  const [color, setColor] = useState("");
  const [hexColor, setHexColor] = useState("");
  const [brand, setBrand] = useState("");
  const [grams, setGrams] = useState("0");
  const [minGrams, setMinGrams] = useState("0");
  const [costPerKg, setCostPerKg] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMaterial(initial?.material ?? "");
      setColor(initial?.color ?? "");
      setHexColor(initial?.hex_color ?? "");
      setBrand(initial?.brand ?? "");
      setGrams(String(initial?.grams_remaining ?? 1000));
      setMinGrams(String(initial?.min_grams ?? 100));
      setCostPerKg(initial?.cost_per_kg != null ? String(initial.cost_per_kg) : "");
      setNote(initial?.note ?? "");
      setError(null);
    }
  }, [open, initial]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = {
        material: material.trim(),
        color: color.trim(),
        hex_color: hexColor.trim() || null,
        brand: brand.trim() || null,
        grams_remaining: parseInt(grams) || 0,
        min_grams: parseInt(minGrams) || 0,
        cost_per_kg: costPerKg.trim() ? parseInt(costPerKg) : null,
        note: note.trim() || null,
      };
      const saved = initial
        ? await api<Filament>(`/api/filaments/${initial.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<Filament>("/api/filaments", { method: "POST", body: JSON.stringify(body) });
      onSaved(saved); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally { setBusy(false); }
  }

  const inputCls = "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950";

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }}
      title={initial ? "Редагувати котушку" : "Нова котушка"}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
          Скасувати
        </button>
        <button type="submit" form="filament-form" disabled={busy || !material.trim() || !color.trim()}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
          {busy ? "Зберігаю…" : initial ? "Зберегти" : "Додати"}
        </button>
      </>}>
      <form id="filament-form" onSubmit={submit} className="space-y-3 text-sm">

        {/* preview spool */}
        {hexColor && (
          <div className="flex justify-center py-1">
            <div className="h-16 w-16">
              <SpoolSVG pct={Math.min(100, Math.round((parseInt(grams) || 0) / FULL_SPOOL_G * 100))} hexColor={hexColor} />
            </div>
          </div>
        )}

        {/* material */}
        <label className="block">
          <span className="mb-1 block text-xs text-neutral-500">Матеріал *</span>
          <input type="text" required autoFocus value={material} onChange={e => setMaterial(e.target.value)}
            list="material-presets" placeholder="PLA" className={inputCls} />
          <datalist id="material-presets">
            {MATERIALS.map(m => <option key={m} value={m} />)}
          </datalist>
        </label>

        {/* color + hex */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">Колір *</span>
            <input type="text" required value={color} onChange={e => setColor(e.target.value)}
              placeholder="Чорний" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">HEX</span>
            <div className="flex gap-2">
              <input type="color" value={hexColor || "#000000"}
                onChange={e => setHexColor(e.target.value)}
                className="h-[38px] w-10 shrink-0 cursor-pointer rounded-md border border-neutral-300 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-950" />
              <input type="text" value={hexColor} onChange={e => setHexColor(e.target.value)}
                placeholder="#000000" maxLength={7}
                className={`flex-1 font-mono ${inputCls}`} />
            </div>
          </label>
        </div>

        {/* brand */}
        <label className="block">
          <span className="mb-1 block text-xs text-neutral-500">Виробник</span>
          <input type="text" value={brand} onChange={e => setBrand(e.target.value)}
            list="brand-presets" placeholder="Bambu Lab, eSun, Polydream…" className={inputCls} />
          <datalist id="brand-presets">
            {BRANDS.map(b => <option key={b} value={b} />)}
          </datalist>
        </label>

        {/* grams + threshold */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">Залишок (г)</span>
            <input type="number" min={0} value={grams} onChange={e => setGrams(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">Поріг алерту (г)</span>
            <input type="number" min={0} value={minGrams} onChange={e => setMinGrams(e.target.value)} className={inputCls} />
          </label>
        </div>

        {/* cost */}
        <label className="block">
          <span className="mb-1 block text-xs text-neutral-500">Ціна за кг (грн)</span>
          <input type="number" min={0} value={costPerKg} onChange={e => setCostPerKg(e.target.value)}
            placeholder="напр. 800" className={inputCls} />
        </label>

        {/* note */}
        <label className="block">
          <span className="mb-1 block text-xs text-neutral-500">Нотатка</span>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} className={inputCls} />
        </label>

        {error && <p className="text-red-600 dark:text-red-400 text-xs">{error}</p>}
      </form>
    </Modal>
  );
}

// ── AdjustModal ───────────────────────────────────────────────────────────────

function AdjustModal({
  filament, onClose, onSaved,
}: {
  filament: Filament | null; onClose: () => void; onSaved: (f: Filament) => void;
}) {
  const [delta, setDelta] = useState("");
  const [direction, setDirection] = useState<"add" | "consume">("consume");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (filament) { setDelta(""); setDirection("consume"); setReason(""); setError(null); }
  }, [filament]);

  if (!filament) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const grams = parseInt(delta);
      if (!grams || grams <= 0) throw new ApiError(400, "Введи позитивне число");
      const signed = direction === "add" ? grams : -grams;
      const saved = await api<Filament>(`/api/filaments/${filament!.id}/adjust`, {
        method: "POST",
        body: JSON.stringify({ delta_grams: signed, reason: reason.trim() || null }),
      });
      onSaved(saved); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally { setBusy(false); }
  }

  const previewGrams = filament.grams_remaining + (direction === "add" ? 1 : -1) * (parseInt(delta) || 0);
  const previewPct = Math.min(100, Math.round((Math.max(0, previewGrams) / FULL_SPOOL_G) * 100));
  const inputCls = "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950";

  return (
    <Modal open={!!filament} onClose={() => { if (!busy) onClose(); }}
      title={`${filament.material} · ${filament.color}`}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
          Скасувати
        </button>
        <button type="submit" form="adjust-form" disabled={busy || !delta}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
          {busy ? "Зберігаю…" : "Застосувати"}
        </button>
      </>}>
      <form id="adjust-form" onSubmit={submit} className="space-y-3 text-sm">
        {/* spool + current stock */}
        <div className="flex items-center gap-4 rounded-lg bg-neutral-50 px-4 py-3 dark:bg-neutral-800">
          <div className="h-12 w-12 shrink-0">
            <SpoolSVG
              pct={delta ? previewPct : Math.min(100, Math.round((filament.grams_remaining / FULL_SPOOL_G) * 100))}
              hexColor={filament.hex_color ?? null}
            />
          </div>
          <div>
            <div className="text-xs text-neutral-500">
              {delta ? "Стане" : "Зараз на котушці"}
            </div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums">
              {delta ? Math.max(0, previewGrams) : filament.grams_remaining} г
              {delta && previewGrams < 0 && (
                <span className="ml-2 text-sm font-normal text-red-500">не вистачає!</span>
              )}
            </div>
            {filament.sku && <div className="mt-0.5 font-mono text-[10px] text-neutral-400">{filament.sku}</div>}
          </div>
        </div>

        {/* direction */}
        <div className="grid grid-cols-2 gap-2">
          {(["consume", "add"] as const).map(d => (
            <button key={d} type="button" onClick={() => setDirection(d)}
              className={["rounded-lg border py-2.5 text-sm font-medium transition", direction === d
                ? d === "consume"
                  ? "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300"
                  : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800",
              ].join(" ")}>
              {d === "consume" ? "− Списати" : "+ Надійшло"}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-neutral-500">Грами</span>
          <input type="number" required min={1} autoFocus value={delta} onChange={e => setDelta(e.target.value)}
            placeholder="напр. 250" className={inputCls} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-neutral-500">Причина (необов'язково)</span>
          <input type="text" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Нова котушка, витрата на замовлення #12…" className={inputCls} />
        </label>

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ── FilamentColorsSection ─────────────────────────────────────────────────────

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
        const updated = await api<FilamentColor>(`/api/filament-colors/${editColor.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), hex_color: hex }) });
        setColors(prev => prev.map(c => c.id === updated.id ? updated : c));
      } else {
        const created = await api<FilamentColor>("/api/filament-colors", { method: "POST", body: JSON.stringify({ name: name.trim(), hex_color: hex }) });
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

  const inputCls = "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Каталог кольорів</h2>
        {canEdit && (
          <button onClick={openAdd}
            className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800">
            + Колір
          </button>
        )}
      </div>
      {loading ? <p className="text-xs text-neutral-400">Завантаження…</p>
        : colors.length === 0 ? <p className="text-xs text-neutral-400">Каталог порожній</p>
        : (
          <div className="flex flex-wrap gap-1.5">
            {colors.map(c => (
              <div key={c.id}
                className="group flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 dark:border-neutral-800 dark:bg-neutral-900">
                <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: c.hex_color }} />
                <span className="text-xs">{c.name}</span>
                {canEdit && (
                  <div className="ml-0.5 hidden gap-0.5 group-hover:flex">
                    <button onClick={() => openEdit(c)} className="text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">✎</button>
                    <button onClick={() => remove(c)} className="text-[10px] text-neutral-400 hover:text-red-600">✕</button>
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
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
        </>}>
        <form id="color-form" onSubmit={save} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">Назва</span>
            <input type="text" required autoFocus value={name} onChange={e => setName(e.target.value)}
              placeholder="Чорний, Galaxy Black…" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">Колір</span>
            <div className="flex items-center gap-3">
              <input type="color" value={hex} onChange={e => setHex(e.target.value)}
                className="h-10 w-14 cursor-pointer rounded-md border border-neutral-300 bg-white p-1 dark:border-neutral-700 dark:bg-neutral-950" />
              <input type="text" value={hex} onChange={e => setHex(e.target.value)}
                pattern="^#[0-9a-fA-F]{6}$" className="w-28 rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
            </div>
          </label>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </form>
      </Modal>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FilamentPage() {
  const t = useT();
  const me = useUser();
  const isAdmin = me.role === "admin";
  const canEdit = isAdmin || me.role === "operator";

  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [loading, setLoading] = useState(true);
  const [editFilament, setEditFilament] = useState<Filament | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [adjustFilament, setAdjustFilament] = useState<Filament | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try { setFilaments(await api<Filament[]>("/api/filaments")); }
    finally { setLoading(false); }
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

  const stats = useMemo(() => ({
    total: filaments.length,
    totalGrams: filaments.reduce((s, f) => s + f.grams_remaining, 0),
    low: filaments.filter(f => f.is_low).length,
  }), [filaments]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return filaments;
    return filaments.filter(f =>
      f.material.toLowerCase().includes(q) ||
      f.color.toLowerCase().includes(q) ||
      (f.brand ?? "").toLowerCase().includes(q) ||
      (f.sku ?? "").toLowerCase().includes(q),
    );
  }, [filaments, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Filament[]>();
    for (const f of filtered) {
      const key = f.material.toUpperCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  if (loading) return <div className="text-sm text-neutral-500">{t("common.loading")}</div>;

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{t("filament.title")}</h1>
          {stats.low > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              ⚠ {stats.low} мало
            </span>
          )}
        </div>
        {canEdit && (
          <button onClick={() => { setEditFilament(null); setEditOpen(true); }}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900">
            + Котушка
          </button>
        )}
      </div>

      {/* stats */}
      {filaments.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Котушок", value: stats.total },
            { label: "Всього грам", value: `${stats.totalGrams.toLocaleString()} г` },
            { label: "Мало залишку", value: stats.low, warn: stats.low > 0 },
          ].map(({ label, value, warn }) => (
            <div key={label} className="rounded-xl border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="text-xs text-neutral-500">{label}</div>
              <div className={["mt-0.5 text-xl font-semibold tabular-nums", warn ? "text-amber-600 dark:text-amber-400" : ""].join(" ")}>
                {value}
              </div>
            </div>
          ))}
        </div>
      )}

      {filaments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-16 text-center text-sm text-neutral-400 dark:border-neutral-700">
          Немає котушок — натисни + Котушка
        </div>
      ) : (
        <>
          {/* search */}
          <input type="search" placeholder="Пошук за матеріалом, кольором, SKU…"
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900" />

          {grouped.length === 0 ? (
            <p className="text-sm text-neutral-400">Нічого не знайдено</p>
          ) : (
            <div className="space-y-6">
              {grouped.map(([material, spools]) => (
                <div key={material}>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-400">{material}</h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {spools.map(f => (
                      <FilamentCard key={f.id} f={f} canEdit={canEdit} isAdmin={isAdmin}
                        onAdjust={() => setAdjustFilament(f)}
                        onEdit={() => { setEditFilament(f); setEditOpen(true); }}
                        onDelete={() => remove(f)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <FilamentFormModal open={editOpen} initial={editFilament}
        onClose={() => setEditOpen(false)} onSaved={upsert} />
      <AdjustModal filament={adjustFilament}
        onClose={() => setAdjustFilament(null)} onSaved={upsert} />

      {filaments.length > 0 && (
        <div className="border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <FilamentColorsSection canEdit={canEdit} />
        </div>
      )}
    </div>
  );
}
