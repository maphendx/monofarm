"use client";

// Dynamic config panel — renders a form for the selected node from its
// catalog spec. Text values resolve {{...}} expressions at runtime, so most
// fields accept both literals and expressions.

import { WorkflowIcon } from "@/components/workflows/WorkflowIcon";
import { useLocale, useT } from "@/lib/i18n";
import { pick, type CatalogField, type CatalogNode, type GraphNode } from "@/lib/workflows";

export function NodeConfigPanel({
  node,
  spec,
  workflowId,
  onPatchConfig,
  onRename,
  onDelete,
}: {
  node: GraphNode;
  spec: CatalogNode;
  workflowId: number;
  onPatchConfig: (config: Record<string, unknown>) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const { locale } = useLocale();
  const tr = useT();
  const t = (uk: string, en: string) => (locale === "en" ? en : uk);

  function set(key: string, value: unknown) {
    onPatchConfig({ ...node.config, [key]: value });
  }

  const inputCls =
    "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]";

  function labelFor(field: CatalogField) {
    return (
      <label htmlFor={`workflow-${node.key}-${field.key}`} className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
        {pick(field.label, locale)}
        {field.required && <span className="text-[var(--state-error)]">*</span>}
      </label>
    );
  }

  function hintFor(field: CatalogField) {
    if (!field.hint) return null;
    return <p className="mt-1 text-[10px] leading-snug text-[var(--text-faint)]">{pick(field.hint, locale)}</p>;
  }

  function renderField(field: CatalogField) {
    const value = node.config[field.key];

    if (field.type === "text" || field.type === "textarea" || field.type === "number") {
      return (
        <div key={field.key} className="mb-3">
          {labelFor(field)}
          {field.type === "textarea" ? (
            <textarea
              id={`workflow-${node.key}-${field.key}`}
              className={`${inputCls} min-h-[72px] resize-y font-mono`}
              value={String(value ?? "")}
              placeholder={field.placeholder}
              onChange={(e) => set(field.key, e.target.value)}
            />
          ) : (
            <input
              id={`workflow-${node.key}-${field.key}`}
              type={field.type === "number" ? "number" : "text"}
              className={`${inputCls} ${field.type === "text" ? "font-mono" : ""}`}
              value={String(value ?? "")}
              placeholder={field.placeholder}
              onChange={(e) => set(field.key, e.target.value)}
            />
          )}
          {hintFor(field)}
        </div>
      );
    }

    if (field.type === "select") {
      const known = (field.options ?? []).some((o) => o.value === value);
      return (
        <div key={field.key} className="mb-3">
          {labelFor(field)}
          <select id={`workflow-${node.key}-${field.key}`} className={inputCls} value={String(value ?? "")} onChange={(e) => set(field.key, e.target.value)}>
            <option value="">—</option>
            {(field.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {pick(o.label, locale)}
              </option>
            ))}
            {!known && value ? <option value={String(value)}>{String(value)}</option> : null}
          </select>
          {hintFor(field)}
        </div>
      );
    }

    if (field.type === "switch") {
      return <label key={field.key} className="mb-3 flex items-center gap-2 text-xs text-[var(--text-muted)]"><input type="checkbox" checked={!!value} onChange={event => set(field.key, event.target.checked)} />{pick(field.label, locale)}</label>;
    }

    if (field.type === "keyvalue") {
      const entries = Object.entries((value as Record<string, string>) ?? {});
      return (
        <div key={field.key} className="mb-3">
          {labelFor(field)}
          <div className="flex flex-col gap-1.5">
            {entries.map(([k, v], i) => (
              <div key={`${k}-${i}`} className="flex items-center gap-1">
                <input
                  className={`${inputCls} w-[38%] font-mono`}
                  value={k}
                  placeholder="key"
                  onChange={(e) => {
                    const rebuilt: Record<string, string> = {};
                    entries.forEach(([kk, vv], idx) => {
                      rebuilt[idx === i ? e.target.value : kk] = vv;
                    });
                    set(field.key, rebuilt);
                  }}
                />
                <input
                  className={`${inputCls} flex-1 font-mono`}
                  value={v}
                  placeholder="value"
                  onChange={(e) => {
                    const rebuilt: Record<string, string> = {};
                    entries.forEach(([kk, vv], idx) => {
                      rebuilt[kk] = idx === i ? e.target.value : vv;
                    });
                    set(field.key, rebuilt);
                  }}
                />
                <button
                  className="btn btn-ghost btn-sm shrink-0 px-1.5"
                  onClick={() => {
                    const next = { ...(value as Record<string, string>) };
                    delete next[k];
                    set(field.key, next);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="btn btn-secondary btn-sm w-fit"
              onClick={() => set(field.key, { ...(value as Record<string, string>), "": "" })}
            >
              + {t("Додати пару", "Add pair")}
            </button>
          </div>
          {hintFor(field)}
        </div>
      );
    }

    if (field.type === "assignments") {
      const rows = (Array.isArray(value) ? value : []) as { name: string; value: unknown }[];
      return (
        <div key={field.key} className="mb-3">
          {labelFor(field)}
          <div className="flex flex-col gap-1.5">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  className={`${inputCls} w-[38%] font-mono`}
                  value={row.name}
                  placeholder="name"
                  onChange={(e) =>
                    set(field.key, rows.map((r, idx) => (idx === i ? { ...r, name: e.target.value } : r)))
                  }
                />
                <input
                  className={`${inputCls} flex-1 font-mono`}
                  value={String(row.value ?? "")}
                  placeholder="{{trigger.payload.x}}"
                  onChange={(e) =>
                    set(field.key, rows.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))
                  }
                />
                <button
                  className="btn btn-ghost btn-sm shrink-0 px-1.5"
                  onClick={() => set(field.key, rows.filter((_, idx) => idx !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="btn btn-secondary btn-sm w-fit"
              onClick={() => set(field.key, [...rows, { name: "", value: "" }])}
            >
              + {t("Додати змінну", "Add variable")}
            </button>
          </div>
          {hintFor(field)}
        </div>
      );
    }

    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
        <WorkflowIcon type={spec.type} className="shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <input
            aria-label={tr("flowStudio.nodeName")}
            className="w-full bg-transparent text-[13px] font-semibold text-[var(--text-hi)] outline-none"
            value={node.name ?? ""}
            placeholder={pick(spec.title, locale)}
            onChange={(e) => onRename(e.target.value)}
          />
          <p className="text-[10px] text-[var(--text-faint)]">
            {pick(spec.description, locale)}
          </p>
        </div>
        <button onClick={onDelete} className="btn btn-danger btn-sm px-2" title={t("Видалити", "Delete")}>
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {spec.type === "trigger.webhook" && (
          <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface-hi)] p-2.5">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">URL</p>
            <code className="block break-all text-[10px] text-[var(--text-muted)]">
              {typeof window !== "undefined"
                ? `${window.location.origin}/api/workflows/hooks/whk-${workflowId}-${String(node.config.token ?? "<save>")}`
                : ""}
            </code>
          </div>
        )}
        {spec.config.length === 0 && (
          <p className="text-[11px] text-[var(--text-faint)]">{t("Ця нода не потребує налаштувань.", "No configuration needed.")}</p>
        )}
        {spec.config.map(renderField)}

        {spec.outputs.length > 1 && (
          <div className="mt-2 rounded-lg border border-[var(--border)] p-2.5">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
              {t("Виходи", "Outputs")}
            </p>
            {spec.outputs.map((o) => (
              <div key={o.name} className="flex items-center gap-1.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                <span className="text-[11px] text-[var(--text-muted)]">{pick(o.title, locale)}</span>
                <code className="ml-auto text-[10px] text-[var(--text-faint)]">{o.name}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
