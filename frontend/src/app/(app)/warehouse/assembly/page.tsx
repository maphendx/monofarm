"use client";

import { useState } from "react";

// ── Types & mock data ─────────────────────────────────────────────────────────

type ComponentType = "printable" | "purchased" | "assembly";

const COMPONENT_TYPE_META: Record<ComponentType, { label: string; cls: string }> = {
  printable:  { label: "Друк",    cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)]" },
  purchased:  { label: "Закупка", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-400" },
  assembly:   { label: "Збірка",  cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)] " },
};

type AssemblyStatus = "draft" | "in_progress" | "done";

const STATUS_META: Record<AssemblyStatus, { label: string; cls: string }> = {
  draft:       { label: "Чернетка",  cls: "bg-[var(--surface-hi)] text-[var(--text-muted)] " },
  in_progress: { label: "Збирається", cls: "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]" },
  done:        { label: "Готово",     cls: "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]" },
};

type AssemblyComponent = {
  name: string;
  type: ComponentType;
  qtyPerUnit: number;
  totalQty: number;
  ready: number;
};

type AssemblyOrder = {
  id: string;
  name: string;
  outputProduct: string;
  outputQty: number;
  assembledQty: number;
  status: AssemblyStatus;
  dueDate: string;
  components: AssemblyComponent[];
};

const ORDERS: AssemblyOrder[] = [
  {
    id: "1",
    name: "Збірка Box Set #12",
    outputProduct: "Gift Box Set",
    outputQty: 20,
    assembledQty: 8,
    status: "in_progress",
    dueDate: "22.05",
    components: [
      { name: "Корпус (Птеродактиль)", type: "printable",  qtyPerUnit: 1, totalQty: 20, ready: 20 },
      { name: "Підставка",             type: "printable",  qtyPerUnit: 1, totalQty: 20, ready: 12 },
      { name: "Пакувальна коробка",    type: "purchased",  qtyPerUnit: 1, totalQty: 20, ready: 20 },
      { name: "Наклейка",              type: "purchased",  qtyPerUnit: 2, totalQty: 40, ready: 40 },
    ],
  },
  {
    id: "2",
    name: "Збірка Desk Kit #4",
    outputProduct: "Desk Organizer Kit",
    outputQty: 10,
    assembledQty: 0,
    status: "draft",
    dueDate: "28.05",
    components: [
      { name: "Phone Holder Flex", type: "printable",  qtyPerUnit: 1, totalQty: 10, ready: 5  },
      { name: "Cube Stand v2",     type: "printable",  qtyPerUnit: 2, totalQty: 20, ready: 0  },
      { name: "Інструкція",        type: "purchased",  qtyPerUnit: 1, totalQty: 10, ready: 10 },
    ],
  },
  {
    id: "3",
    name: "Збірка Mini Set #8",
    outputProduct: "Dragon Mini Gift",
    outputQty: 15,
    assembledQty: 15,
    status: "done",
    dueDate: "16.05",
    components: [
      { name: "Dragon Mini",    type: "printable",  qtyPerUnit: 1, totalQty: 15, ready: 15 },
      { name: "Підставка мала", type: "printable",  qtyPerUnit: 1, totalQty: 15, ready: 15 },
      { name: "Коробка мала",   type: "purchased",  qtyPerUnit: 1, totalQty: 15, ready: 15 },
    ],
  },
];

// ── Components ────────────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.round(value));
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
    </div>
  );
}

function OrderCard({ order }: { order: AssemblyOrder }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[order.status];
  const pct = order.outputQty > 0 ? (order.assembledQty / order.outputQty) * 100 : 0;

  const readyComponents = order.components.filter((c) => c.ready >= c.totalQty).length;
  const allReady = readyComponents === order.components.length;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
      <div className="p-4">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{order.name}</p>
            <p className="text-xs text-[var(--text-faint)]">{order.outputProduct}</p>
          </div>
          <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
            {meta.label}
          </span>
        </div>

        {order.status !== "draft" && (
          <div className="mb-3">
            <ProgressBar value={pct} />
            <p className="mt-1 text-xs text-[var(--text-faint)]">
              {order.assembledQty} / {order.outputQty} зібрано · {pct.toFixed(0)}%
            </p>
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-[var(--text-faint)]">
          <span>
            Компоненти: <span className={allReady ? "text-[var(--state-ok)]" : "text-[var(--state-warn)]"}>
              {readyComponents}/{order.components.length} готово
            </span>
          </span>
          <span>до {order.dueDate}</span>
        </div>
      </div>

      {/* Toggle BOM */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)]  "
      >
        <span>Компоненти (BOM)</span>
        <span>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] ">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg)] ">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-[var(--text-faint)]">Назва</th>
                <th className="px-4 py-2 text-left font-medium text-[var(--text-faint)]">Тип</th>
                <th className="px-4 py-2 text-right font-medium text-[var(--text-faint)]">Потрібно</th>
                <th className="px-4 py-2 text-right font-medium text-[var(--text-faint)]">Є</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] dark:divide-neutral-800">
              {order.components.map((c, i) => {
                const ctMeta = COMPONENT_TYPE_META[c.type];
                const shortage = c.totalQty - c.ready;
                return (
                  <tr key={i} className={shortage > 0 ? "bg-[rgba(245,158,11,.08)]/40 " : ""}>
                    <td className="px-4 py-2">{c.name}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ctMeta.cls}`}>
                        {ctMeta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.totalQty} шт</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      <span className={shortage > 0 ? "text-[var(--state-warn)]" : "text-[var(--state-ok)]"}>
                        {c.ready}
                      </span>
                      {shortage > 0 && <span className="ml-1 text-[var(--state-warn)]">−{shortage}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {order.status === "draft" && (
        <div className="border-t border-[var(--border)] p-3 ">
          <button
            disabled={!allReady}
            className="w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-40   "
          >
            {allReady ? "→ Розпочати збірку" : "⚠ Не вистачає компонентів"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AssemblyPage() {
  return (
    <div className="space-y-4">

      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--text-muted)]">Assembly Orders — збірка з компонентів</p>
        <button className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)]   ">
          + Збірка
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {ORDERS.map((o) => <OrderCard key={o.id} order={o} />)}
      </div>
    </div>
  );
}
