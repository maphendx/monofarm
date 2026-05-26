"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export function AmountStepper({
  taskId,
  value,
  onChange,
}: {
  taskId: number;
  value: number;
  onChange: (next: number) => void;
}) {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  function commit(next: number) {
    const v = Math.max(1, next);
    setLocal(v);
    onChange(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      api(`/api/tasks/print/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ quantity: v }),
      }).catch(() => {});
    }, 600);
  }

  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={() => commit(local - 1)}
        className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] bg-[var(--surface-2)] text-sm text-[var(--text-muted)] hover:bg-neutral-700 active:scale-95"
      >
        −
      </button>
      <input
        type="number"
        min={1}
        value={local}
        onChange={(e) => commit(Number(e.target.value))}
        className="h-7 w-12 rounded border border-[var(--border-strong)] bg-[var(--surface-2)] text-center text-sm text-neutral-100 outline-none focus:border-accent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        onClick={() => commit(local + 1)}
        className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] bg-[var(--surface-2)] text-sm text-[var(--text-muted)] hover:bg-neutral-700 active:scale-95"
      >
        +
      </button>
    </div>
  );
}
