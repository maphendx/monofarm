"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { WorkflowIcon } from "@/components/workflows/WorkflowIcon";
import { useT } from "@/lib/i18n";
import { pick, type CatalogNode, type Locale } from "@/lib/workflows";

export function NodePalette({ catalog, locale, onAdd }: { catalog: CatalogNode[]; locale: Locale; onAdd: (type: string) => void }) {
  const t = useT();
  const [search, setSearch] = useState("");
  const filtered = catalog.filter(node => `${pick(node.title, locale)} ${pick(node.description, locale)}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
    <label className="relative block">
      <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-[var(--text-faint)]" />
      <input aria-label={t("flowStudio.findStep")} className="input w-full pl-8 text-xs" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("flowStudio.findStep")} />
    </label>
    {(["trigger", "flow", "action"] as const).map(category => {
      const items = filtered.filter(node => node.category === category);
      if (!items.length) return null;
      return <div key={category}>
        <p className="mb-2 text-[10px] font-medium text-[var(--text-faint)]">{t(`flowStudio.${category}`)}</p>
        <div className="space-y-1.5">{items.map(node => <button key={node.type} type="button" draggable
          onDragStart={event => { event.dataTransfer.setData("application/monofarm-node", node.type); event.dataTransfer.effectAllowed = "move"; }}
          onClick={() => onAdd(node.type)} className="flex w-full items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left transition-colors hover:border-[var(--accent)] active:bg-[var(--surface-hi)]">
          <WorkflowIcon type={node.type} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <span><span className="block text-xs font-medium text-[var(--text)]">{pick(node.title, locale)}</span><span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-muted)]">{pick(node.description, locale)}</span></span>
        </button>)}</div>
      </div>;
    })}
    {!filtered.length && <p className="text-xs text-[var(--text-muted)]">{t("flowStudio.noMatches")}</p>}
  </div>;
}
