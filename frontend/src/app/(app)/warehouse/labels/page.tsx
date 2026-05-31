"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  LabelCanvas,
  type LabelDataVars,
  type LabelElement,
  type LabelTemplate,
} from "@/components/warehouse/LabelCanvas";
import { generateCode128Url } from "@/components/warehouse/labelUtils";

// ─── Sample data for preview ──────────────────────────────────────────────────

const SAMPLE_VARS: Record<string, LabelDataVars> = {
  cell: {
    code: "A1", zone_name: "Стелаж 1", notes: "Верхня полиця",
    CELL_QR: "CELL:42",
  },
  product: {
    name: "Брелок Dragon", sku: "P-0312", barcode: "03026100",
    categories: "Брелоки · Дракони",
    PROD_QR: "03026100",
  },
  action: {
    label: "Списання", code: "ACTION:WRITE_OFF",
    ACTION_QR: "ACTION:WRITE_OFF",
  },
  universal: {
    code: "A1", name: "Товар", sku: "SKU-001",
    CELL_QR: "CELL:1", PROD_QR: "SKU-001", ACTION_QR: "ACTION:RECEIVE",
  },
};

const ITEM_TYPE_LABELS: Record<string, string> = {
  cell: "Клітинка", product: "Товар", action: "Дія сканера", universal: "Універсальний",
};

const ELEMENT_TYPE_LABELS: Record<string, string> = {
  text: "Текст", qr: "QR-код", barcode: "Штрих-код", image: "Фото", rect: "Прямокутник", line: "Лінія",
};

const PX_PER_MM = 96 / 25.4;

// ─── Unique id ────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 8); }

// ─── Default element by type ──────────────────────────────────────────────────

function defaultElement(type: LabelElement["type"], tpl: LabelTemplate): LabelElement {
  const cx = Math.round(tpl.width_mm / 2 - 10);
  const cy = Math.round(tpl.height_mm / 2 - 5);
  const base = { id: uid(), type, x: cx, y: cy, w: 20, h: 10 };
  switch (type) {
    case "text":    return { ...base, text: "{{name}}", fontSize: 4, fontWeight: "normal", color: "#111", align: "left" };
    case "qr":      return { ...base, w: 20, h: 20, value: "{{CELL_QR}}", level: "M" as const };
    case "barcode": return { ...base, w: 30, h: 15, value: "{{PROD_QR}}", barcodeFormat: "CODE128", showText: true };
    case "image":   return { ...base, w: 20, h: 20, source: "product_image" as const, objectFit: "cover" as const };
    case "rect":    return { ...base, borderColor: "#ccc", borderWidth: 0.3, borderRadius: 0 };
    case "line":    return { ...base, w: 30, h: 0.3, strokeColor: "#ccc", strokeWidth: 0.3, orientation: "horizontal" as const };
  }
}

// ─── Variable picker helper ───────────────────────────────────────────────────

const ALL_VARS = [
  "{{name}}", "{{sku}}", "{{barcode}}", "{{categories}}", "{{PROD_QR}}",
  "{{code}}", "{{zone_name}}", "{{notes}}", "{{CELL_QR}}",
  "{{label}}", "{{ACTION_QR}}",
];

function VarPicker({ onPick }: { onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {ALL_VARS.map(v => (
        <button key={v} type="button" onClick={() => onPick(v)}
          className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--accent)] transition-colors">
          {v}
        </button>
      ))}
    </div>
  );
}

// ─── Element property editor ──────────────────────────────────────────────────

function ElementEditor({
  el, onChange, onDelete,
}: {
  el: LabelElement;
  onChange: (patch: Partial<LabelElement>) => void;
  onDelete: () => void;
}) {
  const num = (label: string, key: keyof LabelElement, step = 0.5) => (
    <label className="flex items-center gap-2">
      <span className="w-6 shrink-0 text-[10px] text-[var(--text-faint)]">{label}</span>
      <input type="number" step={step} value={(el[key] as number) ?? 0}
        onChange={e => onChange({ [key]: parseFloat(e.target.value) || 0 })}
        className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-xs font-mono outline-none focus:border-[var(--accent)]" />
    </label>
  );

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-strong)] bg-[var(--bg)] p-3">
      {/* Position + size */}
      <div>
        <p className="mb-1.5 text-[10px] font-medium text-[var(--text-muted)]">Позиція (мм)</p>
        <div className="grid grid-cols-2 gap-1.5">
          {num("X", "x")} {num("Y", "y")}
          {num("W", "w")} {num("H", "h")}
        </div>
      </div>

      {/* Text props */}
      {el.type === "text" && (
        <div className="space-y-2">
          <div>
            <p className="mb-0.5 text-[10px] text-[var(--text-muted)]">Текст</p>
            <input value={el.text ?? ""} onChange={e => onChange({ text: e.target.value })}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs font-mono outline-none focus:border-[var(--accent)]" />
            <VarPicker onPick={v => onChange({ text: (el.text ?? "") + v })} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {num("fs", "fontSize", 0.5)}
            <label className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--text-faint)]">bold</span>
              <input type="checkbox" checked={el.fontWeight === "bold"}
                onChange={e => onChange({ fontWeight: e.target.checked ? "bold" : "normal" })}
                className="h-3 w-3" />
            </label>
          </div>
          <div className="flex gap-2 items-center">
            <span className="text-[10px] text-[var(--text-faint)]">Колір</span>
            <input type="color" value={el.color ?? "#000000"} onChange={e => onChange({ color: e.target.value })}
              className="h-6 w-8 cursor-pointer rounded border border-[var(--border)]" />
            <select value={el.align ?? "left"} onChange={e => onChange({ align: e.target.value as "left" | "center" | "right" })}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-1 text-xs outline-none">
              <option value="left">Ліво</option>
              <option value="center">Центр</option>
              <option value="right">Право</option>
            </select>
          </div>
        </div>
      )}

      {/* QR props */}
      {el.type === "qr" && (
        <div className="space-y-2">
          <div>
            <p className="mb-0.5 text-[10px] text-[var(--text-muted)]">Вміст</p>
            <input value={el.value ?? ""} onChange={e => onChange({ value: e.target.value })}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs font-mono outline-none focus:border-[var(--accent)]" />
            <VarPicker onPick={v => onChange({ value: v })} />
          </div>
          <label className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-faint)]">Рівень</span>
            <select value={el.level ?? "M"} onChange={e => onChange({ level: e.target.value as "L" | "M" | "Q" | "H" })}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-1 text-xs outline-none">
              {["L","M","Q","H"].map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        </div>
      )}

      {/* Barcode props */}
      {el.type === "barcode" && (
        <div className="space-y-2">
          <div>
            <p className="mb-0.5 text-[10px] text-[var(--text-muted)]">Вміст</p>
            <input value={el.value ?? ""} onChange={e => onChange({ value: e.target.value })}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs font-mono outline-none focus:border-[var(--accent)]" />
            <VarPicker onPick={v => onChange({ value: v })} />
          </div>
          <div className="flex gap-2 items-center">
            <select value={el.barcodeFormat ?? "CODE128"} onChange={e => onChange({ barcodeFormat: e.target.value as "CODE128" | "EAN13" })}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-1 text-xs outline-none">
              <option value="CODE128">Code128</option>
              <option value="EAN13">EAN-13</option>
            </select>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={el.showText ?? true} onChange={e => onChange({ showText: e.target.checked })} className="h-3 w-3" />
              <span className="text-[10px] text-[var(--text-faint)]">текст</span>
            </label>
          </div>
        </div>
      )}

      {/* Rect props */}
      {el.type === "rect" && (
        <div className="flex flex-wrap gap-2 items-center">
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-faint)]">Рамка</span>
            <input type="color" value={el.borderColor ?? "#cccccc"} onChange={e => onChange({ borderColor: e.target.value })}
              className="h-6 w-8 cursor-pointer rounded border border-[var(--border)]" />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-faint)]">Фон</span>
            <input type="color" value={el.fillColor ?? "#ffffff"} onChange={e => onChange({ fillColor: e.target.value })}
              className="h-6 w-8 cursor-pointer rounded border border-[var(--border)]" />
          </label>
          {num("r", "borderRadius", 0.5)}
        </div>
      )}

      {/* Line props */}
      {el.type === "line" && (
        <div className="flex gap-2 items-center">
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-faint)]">Колір</span>
            <input type="color" value={el.strokeColor ?? "#cccccc"} onChange={e => onChange({ strokeColor: e.target.value })}
              className="h-6 w-8 cursor-pointer rounded border border-[var(--border)]" />
          </label>
          <select value={el.orientation ?? "horizontal"} onChange={e => onChange({ orientation: e.target.value as "horizontal" | "vertical" })}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-1 text-xs outline-none">
            <option value="horizontal">Горизонтальна</option>
            <option value="vertical">Вертикальна</option>
          </select>
        </div>
      )}

      <button type="button" onClick={onDelete}
        className="text-[10px] text-[var(--state-error)] hover:underline">
        Видалити елемент
      </button>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LabelsPage() {
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [editing,   setEditing]   = useState<LabelTemplate | null>(null);
  const [selectedEl, setSelectedEl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [bcUrls, setBcUrls] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const data = await api<LabelTemplate[]>("/api/warehouse/label-templates");
    setTemplates(data);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Pre-render barcodes for preview
  useEffect(() => {
    if (!editing) return;
    const vars = SAMPLE_VARS[editing.item_type] ?? SAMPLE_VARS.universal;
    const hPx = Math.round(editing.height_mm * PX_PER_MM);
    editing.elements.filter(el => el.type === "barcode" && el.value).forEach(el => {
      const raw = el.value!.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars as Record<string, string | undefined>)[k] ?? "");
      if (!raw || bcUrls[raw]) return;
      generateCode128Url(raw, hPx).then(url => {
        if (url) setBcUrls(prev => ({ ...prev, [raw]: url }));
      });
    });
  }, [editing?.elements, editing?.item_type]); // eslint-disable-line react-hooks/exhaustive-deps

  function startNew() {
    setEditing({
      id: 0, name: "Новий шаблон", item_type: "product",
      width_mm: 100, height_mm: 30, elements: [], is_builtin: false, is_default: false,
    });
    setSelectedEl(null);
  }

  function startEdit(tpl: LabelTemplate) {
    setEditing(JSON.parse(JSON.stringify(tpl))); // deep clone
    setSelectedEl(null);
  }

  async function save() {
    if (!editing || inFlight.current) return;
    inFlight.current = true; setSaving(true);
    try {
      if (editing.id === 0) {
        const created = await api<LabelTemplate>("/api/warehouse/label-templates", {
          method: "POST", body: JSON.stringify({
            name: editing.name, item_type: editing.item_type,
            width_mm: editing.width_mm, height_mm: editing.height_mm,
            elements: editing.elements, is_default: editing.is_default,
          }),
        });
        setTemplates(prev => [...prev, created]);
      } else {
        const updated = await api<LabelTemplate>(`/api/warehouse/label-templates/${editing.id}`, {
          method: "PUT", body: JSON.stringify({
            name: editing.name, item_type: editing.item_type,
            width_mm: editing.width_mm, height_mm: editing.height_mm,
            elements: editing.elements, is_default: editing.is_default,
          }),
        });
        setTemplates(prev => prev.map(t => t.id === updated.id ? updated : t));
      }
      setEditing(null);
    } finally { inFlight.current = false; setSaving(false); }
  }

  async function del(id: number) {
    await api(`/api/warehouse/label-templates/${id}`, { method: "DELETE" });
    setTemplates(prev => prev.filter(t => t.id !== id));
  }

  function patchEl(id: string, patch: Partial<LabelElement>) {
    if (!editing) return;
    setEditing(prev => prev ? ({
      ...prev,
      elements: prev.elements.map(e => e.id === id ? { ...e, ...patch } : e),
    }) : null);
  }

  function addElement(type: LabelElement["type"]) {
    if (!editing) return;
    const el = defaultElement(type, editing);
    setEditing(prev => prev ? ({ ...prev, elements: [...prev.elements, el] }) : null);
    setSelectedEl(el.id);
  }

  function deleteElement(id: string) {
    if (!editing) return;
    setEditing(prev => prev ? ({ ...prev, elements: prev.elements.filter(e => e.id !== id) }) : null);
    setSelectedEl(null);
  }

  function moveEl(id: string, dir: -1 | 1) {
    if (!editing) return;
    setEditing(prev => {
      if (!prev) return null;
      const els = [...prev.elements];
      const i = els.findIndex(e => e.id === id);
      const j = i + dir;
      if (j < 0 || j >= els.length) return prev;
      [els[i], els[j]] = [els[j], els[i]];
      return { ...prev, elements: els };
    });
  }

  // ── Preview vars ──
  const previewVars = editing ? (SAMPLE_VARS[editing.item_type] ?? SAMPLE_VARS.universal) : {};

  // ── Preview scale ──
  const CANVAS_W = 340;
  const previewScale = editing ? Math.min(2, CANVAS_W / (editing.width_mm * PX_PER_MM)) : 1;
  const previewH = editing ? Math.round(editing.height_mm * PX_PER_MM * previewScale) : 0;

  // ── Selected element ──
  const selEl = editing?.elements.find(e => e.id === selectedEl) ?? null;

  const inputCls = "w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]";

  // ─── Editor view ────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="flex h-[calc(100vh-64px)] gap-0 overflow-hidden">

        {/* Left: canvas + element list */}
        <div className="flex w-[400px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-elevated)]">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
            <button onClick={() => setEditing(null)} className="text-[var(--text-faint)] hover:text-[var(--text)] text-sm">← Назад</button>
            <input value={editing.name} onChange={e => setEditing(p => p ? { ...p, name: e.target.value } : null)}
              className="flex-1 bg-transparent text-sm font-medium outline-none focus:text-[var(--accent)]" />
            <button onClick={save} disabled={saving} className="btn btn-primary btn-sm disabled:opacity-50">
              {saving ? "…" : "Зберегти"}
            </button>
          </div>

          {/* Canvas preview */}
          <div className="flex flex-col items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-hi)] p-4">
            <div style={{ width: CANVAS_W, height: previewH, overflow: "hidden" }}>
              <div style={{ transform: `scale(${previewScale})`, transformOrigin: "top left", width: editing.width_mm * PX_PER_MM, height: editing.height_mm * PX_PER_MM }}>
                <LabelCanvas template={editing} vars={previewVars} barcodeUrls={bcUrls}
                  selected={selectedEl ?? undefined} onSelect={setSelectedEl} />
              </div>
            </div>
            <p className="text-[10px] text-[var(--text-faint)]">{editing.width_mm}×{editing.height_mm} мм · клікни елемент щоб вибрати</p>
          </div>

          {/* Elements list */}
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-[var(--text-muted)]">Елементи ({editing.elements.length})</p>
            </div>

            {editing.elements.length === 0 && (
              <p className="text-xs text-[var(--text-faint)] py-4 text-center">Додай елементи нижче</p>
            )}

            {editing.elements.map((el, i) => (
              <div key={el.id}
                className={["flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer text-sm transition",
                  selectedEl === el.id
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]/20 text-[var(--accent)]"
                    : "border-[var(--border)] hover:bg-[var(--surface-hi)]",
                ].join(" ")}
                onClick={() => setSelectedEl(el.id === selectedEl ? null : el.id)}
              >
                <span className="w-16 shrink-0 text-[10px] text-[var(--text-faint)]">{ELEMENT_TYPE_LABELS[el.type]}</span>
                <span className="flex-1 truncate font-mono text-[11px]">
                  {el.type === "text" ? el.text : el.type === "image" ? "product_image" : el.value ?? ""}
                </span>
                <button onClick={e => { e.stopPropagation(); moveEl(el.id, -1); }} disabled={i === 0}
                  className="text-[var(--text-faint)] hover:text-[var(--text)] disabled:opacity-30 text-xs">↑</button>
                <button onClick={e => { e.stopPropagation(); moveEl(el.id, 1); }} disabled={i === editing.elements.length - 1}
                  className="text-[var(--text-faint)] hover:text-[var(--text)] disabled:opacity-30 text-xs">↓</button>
              </div>
            ))}

            {/* Add element buttons */}
            <div className="pt-2">
              <p className="mb-1.5 text-[10px] text-[var(--text-muted)]">Додати елемент</p>
              <div className="flex flex-wrap gap-1.5">
                {(["text","qr","barcode","image","rect","line"] as LabelElement["type"][]).map(t => (
                  <button key={t} type="button" onClick={() => addElement(t)}
                    className="rounded border border-dashed border-[var(--border-strong)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">
                    + {ELEMENT_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right: template settings + element properties */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* Template settings */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 space-y-3">
            <p className="text-sm font-semibold">Налаштування шаблону</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--text-muted)]">Тип</span>
                <select value={editing.item_type}
                  onChange={e => setEditing(p => p ? { ...p, item_type: e.target.value } : null)}
                  className={inputCls}>
                  {Object.entries(ITEM_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--text-muted)]">Назва</span>
                <input value={editing.name}
                  onChange={e => setEditing(p => p ? { ...p, name: e.target.value } : null)}
                  className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--text-muted)]">Ширина (мм)</span>
                <input type="number" step="0.5" min="20" max="300" value={editing.width_mm}
                  onChange={e => setEditing(p => p ? { ...p, width_mm: parseFloat(e.target.value) || p.width_mm } : null)}
                  className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--text-muted)]">Висота (мм)</span>
                <input type="number" step="0.5" min="10" max="300" value={editing.height_mm}
                  onChange={e => setEditing(p => p ? { ...p, height_mm: parseFloat(e.target.value) || p.height_mm } : null)}
                  className={inputCls} />
              </label>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={editing.is_default ?? false}
                onChange={e => setEditing(p => p ? { ...p, is_default: e.target.checked } : null)}
                className="h-3.5 w-3.5" />
              <span className="text-xs text-[var(--text)]">За замовчуванням для цього типу</span>
            </label>
          </div>

          {/* Element property editor */}
          {selEl ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 space-y-3">
              <p className="text-sm font-semibold">
                {ELEMENT_TYPE_LABELS[selEl.type]}
                <span className="ml-2 font-mono text-[10px] text-[var(--text-faint)]">{selEl.id}</span>
              </p>
              <ElementEditor
                el={selEl}
                onChange={patch => patchEl(selEl.id, patch)}
                onDelete={() => deleteElement(selEl.id)}
              />
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-12 text-center text-sm text-[var(--text-faint)]">
              Вибери елемент зліва щоб редагувати
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Templates library ────────────────────────────────────────────────────────
  const builtins  = templates.filter(t => t.is_builtin);
  const custom    = templates.filter(t => !t.is_builtin);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Шаблони міток</h1>
          <p className="text-xs text-[var(--text-faint)]">Редагуй елементи, розміри і змінні. Шаблони використовуються при друці міток.</p>
        </div>
        <button onClick={startNew} className="btn btn-primary">+ Новий шаблон</button>
      </div>

      {/* Built-in templates */}
      <section>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Вбудовані</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {builtins.map(tpl => (
            <TemplateCard key={tpl.id} tpl={tpl} onEdit={startEdit} onDelete={undefined} />
          ))}
        </div>
      </section>

      {/* Custom templates */}
      {custom.length > 0 && (
        <section>
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Власні</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {custom.map(tpl => (
              <TemplateCard key={tpl.id} tpl={tpl} onEdit={startEdit} onDelete={() => del(tpl.id)} />
            ))}
          </div>
        </section>
      )}

      {custom.length === 0 && builtins.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-20 text-center">
          <p className="text-sm text-[var(--text-muted)]">Шаблонів ще немає</p>
          <button onClick={startNew} className="mt-3 btn btn-primary">Створити перший</button>
        </div>
      )}
    </div>
  );
}

// ─── Template card ────────────────────────────────────────────────────────────

const SAMPLE_VARS_STATIC = SAMPLE_VARS;
const PX_PER_MM_STATIC = PX_PER_MM;

function TemplateCard({
  tpl, onEdit, onDelete,
}: {
  tpl: LabelTemplate;
  onEdit: (t: LabelTemplate) => void;
  onDelete?: () => void;
}) {
  const vars = SAMPLE_VARS_STATIC[tpl.item_type] ?? SAMPLE_VARS_STATIC.universal;
  const CARD_W = 200;
  const scale = Math.min(1.5, CARD_W / (tpl.width_mm * PX_PER_MM_STATIC));
  const cardH = Math.round(tpl.height_mm * PX_PER_MM_STATIC * scale);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 space-y-3">
      {/* Mini preview */}
      <div className="flex items-center justify-center rounded-lg bg-[var(--surface-hi)] p-3">
        <div style={{ width: CARD_W, height: cardH, overflow: "hidden" }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: tpl.width_mm * PX_PER_MM_STATIC, height: tpl.height_mm * PX_PER_MM_STATIC }}>
            <LabelCanvas template={tpl} vars={vars} />
          </div>
        </div>
      </div>

      <div>
        <p className="font-medium text-sm">{tpl.name}</p>
        <p className="text-xs text-[var(--text-faint)]">
          {ITEM_TYPE_LABELS[tpl.item_type] ?? tpl.item_type} · {tpl.width_mm}×{tpl.height_mm} мм · {tpl.elements.length} ел.
          {tpl.is_builtin && <span className="ml-1.5 rounded bg-[var(--surface-hi)] px-1 py-0.5 text-[10px]">вбудований</span>}
          {tpl.is_default && <span className="ml-1.5 rounded bg-[var(--accent)]/10 px-1 py-0.5 text-[10px] text-[var(--accent)]">за замовч.</span>}
        </p>
      </div>

      <div className="flex gap-2">
        <button onClick={() => onEdit(tpl)} className="flex-1 btn btn-ghost btn-sm">
          {tpl.is_builtin ? "Переглянути" : "Редагувати"}
        </button>
        {!tpl.is_builtin && onDelete && (
          <button onClick={onDelete} className="btn btn-ghost btn-sm text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]">
            ×
          </button>
        )}
      </div>
    </div>
  );
}
