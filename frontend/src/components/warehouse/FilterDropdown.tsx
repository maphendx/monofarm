"use client";

import { useEffect, useRef, useState } from "react";

export function FilterDropdown({
  active,
  align = "left",
  children,
}: {
  active: number;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={[
          "btn btn-ghost btn-sm flex items-center gap-1.5",
          active > 0 ? "!border-[var(--accent)] !text-[var(--accent)]" : "",
        ].join(" ")}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        Фільтри
        {active > 0 && (
          <span className="flex size-4 items-center justify-center rounded-full bg-[var(--accent)] text-[9px] font-bold text-white leading-none">
            {active}
          </span>
        )}
      </button>

      {open && (
        <div
          className={[
            "absolute top-full z-30 mt-1 w-64 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl",
            align === "right" ? "right-0" : "left-0",
          ].join(" ")}
        >
          {children}
        </div>
      )}
    </div>
  );
}
