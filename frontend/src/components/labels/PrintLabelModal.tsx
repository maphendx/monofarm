"use client";

import { useEffect, useState, useRef } from "react";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import type { LabelTemplate } from "@/lib/types";

interface PrintLabelModalProps {
  targetType: string; // 'product', 'cell', etc.
  variables?: Record<string, string>; // For single label
  variablesList?: Record<string, string>[]; // For multiple labels
  onClose: () => void;
  title?: string;
}

export function PrintLabelModal({ targetType, variables, variablesList, onClose, title = "Друк лейбла" }: PrintLabelModalProps) {
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [printStatus, setPrintStatus] = useState<string | null>(null);
  const printFrameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    api<LabelTemplate[]>(`/api/label-templates?target_type=${targetType}`)
      .then(data => {
        setTemplates(data);
        if (data.length > 0) setSelectedId(data[0].id);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [targetType]);

  const selected = templates.find(t => t.id === selectedId);

  const itemsToRender = variablesList || (variables ? [variables] : []);

  // Replace placeholders in content
  const renderedContents = itemsToRender.map(vars => {
    let content = selected?.content || "";
    for (const [key, value] of Object.entries(vars)) {
      content = content.replaceAll(`{{ ${key} }}`, value);
      content = content.replaceAll(`{{${key}}}`, value);
    }
    return content;
  });

  const fullZpl = renderedContents.join("\n");

  // Generate Zebra ZPL print
  async function sendViaBrowserPrint(zpl: string) {
    try {
      const devResp = await fetch("http://localhost:9090/default", { signal: AbortSignal.timeout(1200) });
      if (!devResp.ok) return "not_available";
      const device = await devResp.json();

      const writeResp = await fetch("http://localhost:9090/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device, data: zpl }),
        signal: AbortSignal.timeout(3000),
      });
      return writeResp.ok ? "ok" : "error";
    } catch {
      return "not_available";
    }
  }

  async function handlePrint() {
    if (!selected) return;

    if (selected.format === "zpl") {
      setPrintStatus("Відправка на принтер...");
      const result = await sendViaBrowserPrint(fullZpl);
      if (result === "ok") setPrintStatus("✓ Відправлено на принтер Zebra");
      else if (result === "not_available") setPrintStatus("✗ Zebra Browser Print не знайдено");
      else setPrintStatus("✗ Помилка відправки");
    } else {
      // HTML Print via hidden iframe
      if (printFrameRef.current) {
        const doc = printFrameRef.current.contentWindow?.document;
        if (doc) {
          doc.open();
          doc.write(`
            <html>
              <head>
                <title>Друк</title>
                <style>
                  @page { size: ${selected.width_mm}mm ${selected.height_mm}mm; margin: 0; }
                  body { margin: 0; padding: 0; }
                  .label-page { 
                    width: ${selected.width_mm}mm; 
                    height: ${selected.height_mm}mm; 
                    overflow: hidden; 
                    page-break-after: always;
                    position: relative;
                  }
                </style>
              </head>
              <body>
                ${renderedContents.map(c => `<div class="label-page">${c}</div>`).join("")}
              </body>
            </html>
          `);
          doc.close();
          setTimeout(() => {
            printFrameRef.current?.contentWindow?.focus();
            printFrameRef.current?.contentWindow?.print();
            setPrintStatus("✓ Відкрито діалог друку браузера");
          }, 200);
        }
      }
    }
  }

  return (
    <Modal open={true} onClose={onClose} title={title} size="lg">
      <div className="space-y-4">
        {loading ? (
          <div className="text-sm text-[var(--text-muted)]">Завантаження шаблонів...</div>
        ) : templates.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">
            Не знайдено жодного шаблону для типу <b>{targetType}</b>. 
            <br />
            Будь ласка, створіть шаблон в Налаштуваннях → Шаблони лейблів.
          </div>
        ) : (
          <>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Оберіть шаблон</label>
              <select 
                value={selectedId || ""} 
                onChange={(e) => setSelectedId(Number(e.target.value))}
                className="input w-full"
              >
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.format.toUpperCase()})</option>
                ))}
              </select>
            </div>

            <div className="border border-[var(--border)] rounded-md bg-white overflow-hidden relative" style={{ minHeight: '200px' }}>
              <div className="bg-[var(--surface-lo)] border-b border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] flex justify-between">
                <span>Попередній перегляд (показано 1 з {itemsToRender.length})</span>
              </div>
              <div className="p-4 flex items-center justify-center bg-gray-100 overflow-auto" style={{ maxHeight: '400px' }}>
                {selected?.format === "html" ? (
                  <div 
                    className="bg-white shadow-sm overflow-hidden" 
                    style={{ 
                      width: `${selected.width_mm}mm`, 
                      height: `${selected.height_mm}mm`,
                      position: 'relative'
                    }}
                    dangerouslySetInnerHTML={{ __html: renderedContents[0] || "" }}
                  />
                ) : (
                  <div className="w-full text-xs font-mono whitespace-pre-wrap text-black bg-white p-2">
                    {renderedContents[0] || ""}
                  </div>
                )}
              </div>
            </div>

            {/* Hidden iframe for HTML printing */}
            <iframe ref={printFrameRef} style={{ display: 'none' }} title="Print Frame" />
          </>
        )}

        <div className="flex items-center justify-between pt-4 mt-2 border-t border-[var(--border)]">
          <div className="text-xs text-[var(--text-muted)] truncate max-w-[200px]">
            {printStatus}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-ghost">Закрити</button>
            <button 
              onClick={handlePrint} 
              disabled={templates.length === 0}
              className="btn btn-primary"
            >
              Друкувати ({itemsToRender.length})
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
