"use client";

import { ReactNode } from "react";

type Action = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger" | "ghost";
};

type Props = {
  count: number;
  actions: Action[];
  onClear: () => void;
};

export function BulkActionBar({ count, actions, onClear }: Props) {
  if (count === 0) return null;

  return (
    <div className="fixed bottom-6 left-0 right-0 z-40 flex justify-center pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-5 py-3 shadow-2xl">
        <span className="text-sm font-medium text-[var(--text)]">
          Вибрано {count}
        </span>
        <button
          onClick={onClear}
          className="text-sm text-[var(--text-faint)] hover:text-[var(--text)] transition-colors"
        >
          Скасувати
        </button>
        <div className="h-4 w-px bg-[var(--border)]" />
        <div className="flex items-center gap-2">
          {actions.map((a) => (
            <ActionBtn key={a.label} action={a} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ActionBtn({ action }: { action: Action }) {
  const base = "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50";
  const variants: Record<NonNullable<Action["variant"]>, string> = {
    default: `${base} bg-[var(--accent)] text-white hover:opacity-90`,
    danger:  `${base} bg-[var(--state-error)] text-white hover:opacity-90`,
    ghost:   `${base} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-hi)]`,
  };
  return (
    <button
      onClick={action.onClick}
      disabled={action.disabled}
      className={variants[action.variant ?? "ghost"]}
    >
      {action.label}
    </button>
  );
}
