"use client";

import { LogOut, ShieldAlert } from "lucide-react";

import { useImpersonation } from "@/lib/impersonation";

export function ImpersonationBanner() {
  const { state, clearImpersonation } = useImpersonation();

  if (!state) return null;

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-[80] border-b border-[var(--state-warn)]/30 bg-[var(--state-warn)]/15 text-[var(--text-hi)] shadow-sm">
        <div className="mx-auto flex min-h-10 max-w-7xl items-center justify-between gap-3 px-4 py-2 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldAlert size={16} aria-hidden="true" />
            <span className="truncate font-medium">
              Viewing as {state.organizationName}
            </span>
            <span className="hidden font-mono text-xs opacity-70 sm:inline">/{state.organizationSlug}</span>
          </div>
          <button
            type="button"
            onClick={clearImpersonation}
            className="inline-flex h-7 shrink-0 items-center gapo-1.5 rounded-[var(--r-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-xs font-semibold text-[var(--text-hi)] hover:bg-[var(--surface-hi)]"
          >
            <LogOut size={14} aria-hidden="true" />
            Exit
          </button>
        </div>
      </div>
      <div className="h-10 shrink-0" aria-hidden="true" />
    </>
  );
}
