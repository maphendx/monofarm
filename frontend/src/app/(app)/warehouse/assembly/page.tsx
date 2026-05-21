"use client";

import { useState } from "react";

// ── Types & mock data ─────────────────────────────────────────────────────────

type ComponentType = "printable" | "purchased" | "assembly";

const COMPONENT_TYPE_META: Record<ComponentType, { label: string; cls: string }> = {
  printable:  { label: "Друк",    cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
  purchased:  { label: "Закупка", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-400" },
  assembly:   { label: "Збірка",  cls: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400" },
};

type AssemblyStatus = "draft" | "in_progress" | "done";

const STATUS_META: Record<AssemblyStatus, { label: string; cls: string }> = {
  draft:       { label: "Чернетка",  cls: "bg-neutral-500/15 text-neutral-600 dark:text-neutral-400" },
  in_progress: { label: "Збирається", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  done:        { label: "Готово",     cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
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
    <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
      <div className="h-full rounded-full bg-cyan-500" style={{ width: `${pct}%` }} />
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
    <div className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="p-4">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{order.name}</p>
            <p className="text-xs text-neutral-400">{order.outputProduct}</p>
          </div>
          <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
            {meta.label}
          </span>
        </div>

        {order.status !== "draft" && (
          <div className="mb-3">
            <ProgressBar value={pct} />
            <p className="mt-1 text-xs text-neutral-400">
              {order.assembledQty} / {order.outputQty} зібрано · {pct.toFixed(0)}%
            </p>
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-neutral-400">
          <span>
            Компоненти: <span className={allReady ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
              {readyComponents}/{order.components.length} готово
            </span>
          </span>
          <span>до {order.dueDate}</span>
        </div>
      </div>

      {/* Toggle BOM */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between border-t border-neutral-100 px-4 py-2 text-xs text-neutral-400 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
      >
        <span>Компоненти (BOM)</span>
        <span>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-neutral-100 dark:border-neutral-800">
          <table className="w-full text-xs">
            <thead className="bg-neutral-50 dark:bg-neutral-950">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-neutral-400">Назва</th>
                <th className="px-4 py-2 text-left font-medium text-neutral-400">Тип</th>
                <th className="px-4 py-2 text-right font-medium text-neutral-400">Потрібно</th>
                <th className="px-4 py-2 text-right font-medium text-neutral-400">Є</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {order.components.map((c, i) => {
                const ctMeta = COMPONENT_TYPE_META[c.type];
                const shortage = c.totalQty - c.ready;
                return (
                  <tr key={i} className={shortage > 0 ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}>
                    <td className="px-4 py-2">{c.name}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ctMeta.cls}`}>
                        {ctMeta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.totalQty} шт</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      <span className={shortage > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
                        {c.ready}
                      </span>
                      {shortage > 0 && <span className="ml-1 text-amber-500">−{shortage}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {order.status === "draft" && (
        <div className="border-t border-neutral-100 p-3 dark:border-neutral-800">
          <button
            disabled={!allReady}
            className="w-full rounded-md border border-neutral-200 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
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
        <p className="text-sm text-neutral-500">Assembly Orders — збірка з компонентів</p>
        <button className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300">
          + Збірка
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {ORDERS.map((o) => <OrderCard key={o.id} order={o} />)}
      </div>
    </div>
  );
}
