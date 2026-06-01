"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ── Scanner mock data ─────────────────────────────────────────────────────────

const MOCK_CELLS: Record<string, string> = {
  "CELL-A1": "Комірка A1",
  "CELL-A2": "Комірка A2",
  "CELL-B1": "Комірка B1",
  "CELL-B2": "Комірка B2",
};

const MOCK_PRODUCTS: Record<string, string> = {
  "SKU-001": "Корпус (Птеродактиль)",
  "SKU-002": "Підставка",
  "SKU-003": "Пакувальна коробка",
  "SKU-004": "Наклейка",
  "SKU-005": "Phone Holder Flex",
};

type ScanStep = "idle" | "has_cell" | "has_product" | "qty";

type ScanState = {
  step: ScanStep;
  cell: { code: string; name: string } | null;
  product: { code: string; name: string } | null;
  qty: string;
  error: string | null;
};

function ScannerPanel() {
  const [state, setState] = useState<ScanState>({
    step: "idle",
    cell: null,
    product: null,
    qty: "",
    error: null,
  });
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  // focus hidden scan input when scanner is active and not in qty step
  useEffect(() => {
    if (active && state.step !== "qty") {
      inputRef.current?.focus();
    }
    if (active && state.step === "qty") {
      qtyRef.current?.focus();
    }
  }, [active, state.step]);

  const reset = useCallback(() => {
    setState({ step: "idle", cell: null, product: null, qty: "", error: null });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const handleScan = useCallback((raw: string) => {
    const code = raw.trim();
    if (!code) return;

    setState((prev) => {
      const isCell = code in MOCK_CELLS;
      const isProduct = code in MOCK_PRODUCTS;

      if (!isCell && !isProduct) {
        return { ...prev, error: `Невідомий код: ${code}` };
      }

      // scanning a cell
      if (isCell) {
        const cell = { code, name: MOCK_CELLS[code] };
        if (prev.step === "has_product") {
          // both ready → qty
          return { ...prev, cell, step: "qty", error: null };
        }
        return { ...prev, cell, step: "has_cell", error: null };
      }

      // scanning a product
      const product = { code, name: MOCK_PRODUCTS[code] };
      if (prev.step === "has_cell") {
        // both ready → qty
        return { ...prev, product, step: "qty", error: null };
      }
      return { ...prev, product, step: "has_product", error: null };
    });
  }, []);

  const handleConfirm = () => {
    const qty = parseInt(state.qty, 10);
    if (!qty || qty <= 0) return;
    // TODO: call API — for now just reset
    reset();
  };

  if (!active) {
    return (
      <button
        onClick={() => setActive(true)}
        className="flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)]"
      >
        <span>⬛</span> Режим сканера
      </button>
    );
  }

  const stepLabel =
    state.step === "idle" ? "Скануйте комірку або товар" :
    state.step === "has_cell" ? "Скануйте товар" :
    state.step === "has_product" ? "Скануйте комірку" :
    "Введіть кількість";

  return (
    <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Сканер</span>
        <button
          onClick={() => { setActive(false); reset(); }}
          className="text-xs text-[var(--text-faint)] hover:text-[var(--text-muted)]"
        >
          ✕ Закрити
        </button>
      </div>

      {/* hidden input captures barcode scanner keystrokes */}
      {state.step !== "qty" && (
        <input
          ref={inputRef}
          className="sr-only"
          onBlur={() => setTimeout(() => inputRef.current?.focus(), 100)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleScan((e.currentTarget as HTMLInputElement).value);
              (e.currentTarget as HTMLInputElement).value = "";
            }
          }}
        />
      )}

      {/* step indicator */}
      <div className="flex items-center gap-2 text-xs">
        <StepDot done={!!state.cell} active={state.step === "idle" || state.step === "has_product"} label="Комірка" />
        <div className="flex-1 h-px bg-[var(--border)]" />
        <StepDot done={!!state.product} active={state.step === "idle" || state.step === "has_cell"} label="Товар" />
        <div className="flex-1 h-px bg-[var(--border)]" />
        <StepDot done={false} active={state.step === "qty"} label="Кількість" />
      </div>

      {/* current context */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className={`rounded-lg border p-2 ${state.cell ? "border-[var(--state-ok)] bg-[rgba(34,197,94,.06)]" : "border-[var(--border)] bg-[var(--surface-hi)]"}`}>
          <p className="text-[var(--text-faint)] mb-0.5">Комірка</p>
          <p className={state.cell ? "font-medium text-[var(--state-ok)]" : "text-[var(--text-faint)]"}>
            {state.cell ? state.cell.name : "—"}
          </p>
        </div>
        <div className={`rounded-lg border p-2 ${state.product ? "border-[var(--state-ok)] bg-[rgba(34,197,94,.06)]" : "border-[var(--border)] bg-[var(--surface-hi)]"}`}>
          <p className="text-[var(--text-faint)] mb-0.5">Товар</p>
          <p className={state.product ? "font-medium text-[var(--state-ok)]" : "text-[var(--text-faint)]"}>
            {state.product ? state.product.name : "—"}
          </p>
        </div>
      </div>

      {state.error && (
        <p className="rounded-md bg-[rgba(239,68,68,.08)] px-3 py-1.5 text-xs text-[var(--state-error)]">
          {state.error}
        </p>
      )}

      {state.step === "qty" ? (
        <div className="flex gap-2">
          <input
            ref={qtyRef}
            type="number"
            min={1}
            value={state.qty}
            onChange={(e) => setState((s) => ({ ...s, qty: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
            placeholder="Кількість"
            className="input flex-1 text-sm"
          />
          <button
            onClick={handleConfirm}
            disabled={!state.qty || parseInt(state.qty) <= 0}
            className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)] disabled:opacity-40"
          >
            ✓
          </button>
          <button
            onClick={reset}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"
          >
            ✕
          </button>
        </div>
      ) : (
        <p className="text-center text-xs text-[var(--text-faint)] py-1">
          {stepLabel}
        </p>
      )}

      {/* demo helper */}
      <details className="text-xs text-[var(--text-faint)]">
        <summary className="cursor-pointer hover:text-[var(--text-muted)]">Тестові коди</summary>
        <div className="mt-2 grid grid-cols-2 gap-1">
          {Object.entries(MOCK_CELLS).map(([code, name]) => (
            <button key={code} onClick={() => handleScan(code)}
              className="rounded border border-[var(--border)] px-2 py-1 text-left hover:bg-[var(--surface-hi)]">
              <span className="font-mono">{code}</span> — {name}
            </button>
          ))}
          {Object.entries(MOCK_PRODUCTS).map(([code, name]) => (
            <button key={code} onClick={() => handleScan(code)}
              className="rounded border border-[var(--border)] px-2 py-1 text-left hover:bg-[var(--surface-hi)]">
              <span className="font-mono">{code}</span> — {name}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

function StepDot({ done, active, label }: { done: boolean; active: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className={`h-5 w-5 rounded-full border-2 flex items-center justify-center text-[10px] ${
        done ? "border-[var(--state-ok)] bg-[var(--state-ok)] text-white" :
        active ? "border-[var(--accent)] bg-[rgba(56,189,248,.12)]" :
        "border-[var(--border)] bg-[var(--surface-hi)]"
      }`}>
        {done ? "✓" : ""}
      </div>
      <span className="text-[10px] text-[var(--text-faint)]">{label}</span>
    </div>
  );
}

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
        <div className="flex items-center gap-2">
          <ScannerPanel />
          <button className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)]">
            + Збірка
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {ORDERS.map((o) => <OrderCard key={o.id} order={o} />)}
      </div>
    </div>
  );
}
