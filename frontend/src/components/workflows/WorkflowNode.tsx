"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { WorkflowIcon } from "@/components/workflows/WorkflowIcon";
import { useT } from "@/lib/i18n";
import { RUN_STATUS_COLORS, pick, type CatalogNode, type GraphNode, type Locale, type RunNodeState } from "@/lib/workflows";

export interface WFNodeData extends Record<string, unknown> {
  spec: CatalogNode;
  node: GraphNode;
  locale: Locale;
  runState?: RunNodeState;
  category: "trigger" | "flow" | "action";
}
export type WFNode = Node<WFNodeData, "wf">;
export const NODE_TYPE_NAME = "wf" as const;

export function WorkflowNodeView({ data, selected }: NodeProps<WFNode>) {
  const t = useT();
  const { spec, node, locale, runState, category } = data;
  const title = node.name || pick(spec.title, locale);
  const statusColor = runState ? RUN_STATUS_COLORS[runState.status] : undefined;
  const fields = spec.config.filter(field => field.key !== "token" && field.key !== "headers").slice(0, 2);
  return (
    <div className="group relative w-[236px] border bg-[var(--bg-elevated)] text-left"
      style={{ borderRadius: "var(--r-xl)", borderColor: selected ? "var(--accent)" : statusColor ?? "var(--border-strong)", boxShadow: selected ? "0 0 0 2px var(--accent-soft), var(--shadow-md)" : "var(--shadow-md)" }}>
      {category !== "trigger" && <Handle type="target" position={Position.Left} aria-label={t("flowStudio.input")} style={{ width: 10, height: 10, background: "var(--state-print)", border: "2px solid var(--bg-elevated)" }} />}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <WorkflowIcon type={spec.type} className="shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text-hi)]">{title}</span>
        <span className="text-[10px] text-[var(--text-faint)]">{t(`flowStudio.${category}`)}</span>
      </div>
      <div className="space-y-2 border-t border-[var(--border)] px-3 py-2.5">
        {fields.length ? fields.map(field => {
          const value = node.config[field.key];
          const option = field.options?.find(option => option.value === value);
          const text = option ? pick(option.label, locale) : value == null || value === "" ? t("flowStudio.notConfigured") : typeof value === "object" ? t("flowStudio.configured") : String(value);
          return <div key={field.key} className="flex items-start justify-between gap-3 text-[11px]">
            <span className="shrink-0 text-[var(--text-faint)]">{pick(field.label, locale)}</span>
            <span className="min-w-0 truncate text-right font-medium text-[var(--text)]" title={text}>{text}</span>
          </div>;
        }) : <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{pick(spec.description, locale)}</p>}
      </div>
      {runState && <div className="flex items-center gap-1.5 border-t border-[var(--border)] px-3 py-2 text-[10px]" style={{ color: statusColor }}>
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        <span>{t(`flowStudio.${runState.status}`)}</span>
        {runState.error && <span className="min-w-0 flex-1 truncate" title={runState.error}>{runState.error}</span>}
      </div>}
      {spec.outputs.map((port, index) => <Handle key={port.name} id={port.name} type="source" position={Position.Right}
        aria-label={pick(port.title, locale)} title={pick(port.title, locale)}
        style={{ top: `${100 * (index + 1) / (spec.outputs.length + 1)}%`, width: 10, height: 10, background: port.name === "false" ? "var(--state-warn)" : "var(--state-print)", border: "2px solid var(--bg-elevated)" }} />)}
    </div>
  );
}
