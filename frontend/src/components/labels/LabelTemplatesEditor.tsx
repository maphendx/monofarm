"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { LabelTemplate } from "@/lib/types";

export default function LabelTemplatesPage() {
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [selected, setSelected] = useState<LabelTemplate | null>(null);
  const [loading, setLoading] = useState(true);

  // Editor state
  const [name, setName] = useState("");
  const [targetType, setTargetType] = useState("product");
  const [format, setFormat] = useState<"html" | "zpl">("html");
  const [content, setContent] = useState("");
  const [width, setWidth] = useState(85);
  const [height, setHeight] = useState(54);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api<LabelTemplate[]>("/api/label-templates");
      setTemplates(data);
      if (data.length > 0 && !selected) {
        selectTmpl(data[0]);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  function selectTmpl(t: LabelTemplate) {
    setSelected(t);
    setName(t.name);
    setTargetType(t.target_type);
    setFormat(t.format);
    setContent(t.content);
    setWidth(t.width_mm);
    setHeight(t.height_mm);
  }

  function newTmpl() {
    setSelected(null);
    setName("Новий шаблон");
    setTargetType("product");
    setFormat("html");
    setContent(`<div style="padding:10px; font-family:sans-serif;">\n  <h2>{{ name }}</h2>\n  <p>SKU: {{ sku }}</p>\n  <div style="margin-top:10px;">{{ barcode }}</div>\n</div>`);
    setWidth(85);
    setHeight(54);
  }

  async function saveTmpl() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name,
        target_type: targetType,
        format,
        content,
        width_mm: width,
        height_mm: height,
      };
      if (selected) {
        await api(`/api/label-templates/${selected.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await api("/api/label-templates", { method: "POST", body: JSON.stringify(payload) });
      }
      await load();
    } catch (e) {
      console.error(e);
      alert("Помилка збереження");
    } finally {
      setSaving(false);
    }
  }

  async function deleteTmpl() {
    if (!selected) return;
    if (!confirm("Видалити шаблон?")) return;
    try {
      await api(`/api/label-templates/${selected.id}`, { method: "DELETE" });
      setSelected(null);
      await load();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="flex h-[calc(100vh-80px)] overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 border-r border-[var(--border)] bg-[var(--surface-lo)] flex flex-col">
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="font-semibold">Шаблони лейблів</h2>
          <button onClick={newTmpl} className="btn btn-ghost btn-sm px-2 text-blue-500" title="Додати">
            <Plus className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {loading ? (
            <div className="p-4 text-center text-sm text-[var(--text-faint)]">Завантаження...</div>
          ) : templates.length === 0 ? (
            <div className="p-4 text-center text-sm text-[var(--text-faint)]">Немає шаблонів</div>
          ) : (
            templates.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTmpl(t)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition ${
                  selected?.id === t.id
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text)] hover:bg-[var(--surface-hi)]"
                }`}
              >
                <div className="font-medium truncate">{t.name}</div>
                <div className="text-xs opacity-80 mt-0.5">{t.target_type} · {t.format.toUpperCase()}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-auto flex flex-col bg-[var(--bg)]">
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between shrink-0">
          <h3 className="text-lg font-medium">{selected ? "Редагування шаблону" : "Створення шаблону"}</h3>
          <div className="flex gap-2">
            {selected && (
              <button onClick={deleteTmpl} className="btn btn-ghost text-red-500">
                <Trash2 className="w-4 h-4 mr-1" /> Видалити
              </button>
            )}
            <button onClick={saveTmpl} disabled={saving} className="btn btn-primary">
              {saving ? "Збереження..." : "Зберегти"}
            </button>
          </div>
        </div>

        <div className="p-6 flex-1 flex flex-col gap-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 shrink-0">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Назва</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input w-full" />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Цільовий тип</label>
              <select value={targetType} onChange={(e) => setTargetType(e.target.value)} className="input w-full">
                <option value="product">Товар (product)</option>
                <option value="cell">Комірка (cell)</option>
                <option value="order">Замовлення (order)</option>
                <option value="filament">Котушка (filament)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Формат</label>
              <select value={format} onChange={(e) => setFormat(e.target.value as "html" | "zpl")} className="input w-full">
                <option value="html">HTML (Браузер/PDF)</option>
                <option value="zpl">ZPL (Zebra Print)</option>
              </select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-[var(--text-muted)] mb-1">Ширина (мм)</label>
                <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} className="input w-full" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-[var(--text-muted)] mb-1">Висота (мм)</label>
                <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} className="input w-full" />
              </div>
            </div>
          </div>

          <div className="flex-1 flex flex-col min-h-[400px]">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <label className="text-sm font-medium">Код шаблону ({format.toUpperCase()})</label>
              <div className="text-xs text-[var(--text-muted)]">
                Доступні змінні: 
                <code className="mx-1 px-1 py-0.5 bg-[var(--surface-hi)] rounded">{'{{ name }}'}</code>
                <code className="mx-1 px-1 py-0.5 bg-[var(--surface-hi)] rounded">{'{{ sku }}'}</code>
                <code className="mx-1 px-1 py-0.5 bg-[var(--surface-hi)] rounded">{'{{ qr_code }}'}</code>
                <code className="mx-1 px-1 py-0.5 bg-[var(--surface-hi)] rounded">{'{{ barcode }}'}</code>
              </div>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="flex-1 w-full p-4 font-mono text-sm border border-[var(--border)] rounded-md focus:outline-none focus:border-[var(--border-focus)] bg-[var(--surface-lo)] text-[var(--text)]"
              placeholder={format === "html" ? "<div>HTML code here...</div>" : "^XA...^XZ"}
              spellCheck={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
