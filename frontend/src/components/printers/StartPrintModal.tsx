"use client";

import { useEffect, useState } from "react";

import { SendModal } from "@/components/files/SendModal";
import { api } from "@/lib/api";
import type { GcodeFile, Printer } from "@/lib/types";

function fmtSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${bytes} Б`;
}

export function StartPrintModal({
  printer,
  printers,
  onClose,
}: {
  printer: Printer;
  printers: Printer[];
  onClose: () => void;
}) {
  const [files, setFiles] = useState<GcodeFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<GcodeFile | null>(null);

  useEffect(() => {
    api<GcodeFile[]>("/api/files")
      .then(setFiles)
      .finally(() => setLoading(false));
  }, []);

  if (selected) {
    return (
      <SendModal
        file={selected}
        printers={printers}
        defaultPrinterId={printer.id}
        onClose={() => setSelected(null)}
      />
    );
  }

  const filtered = files.filter((f) =>
    f.original_name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-md flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl  "
        style={{ maxHeight: "80vh" }}>

        {/* header */}
        <div className="border-b border-[var(--border)] px-5 py-4 ">
          <h2 className="font-semibold">▶ Почати друк</h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Вибери файл для <strong>{printer.name}</strong>
          </p>
        </div>

        {/* search */}
        <div className="border-b border-[var(--border)] px-4 py-3 ">
          <input
            type="text"
            placeholder="Пошук файлів…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]  "
          />
        </div>

        {/* file list */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="py-8 text-center text-sm text-[var(--text-faint)]">Завантаження…</p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--text-faint)]">
              {files.length === 0 ? "Файлів ще немає" : "Нічого не знайдено"}
            </p>
          ) : (
            <div className="space-y-1">
              {filtered.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSelected(f)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-[var(--surface-hi)] "
                >
                  {/* extension badge */}
                  <span className="shrink-0 rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] font-mono font-medium text-[var(--text-muted)] ">
                    {f.original_name.split(".").pop()?.toUpperCase() ?? "?"}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.original_name}</p>
                    <div className="flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
                      <span>{fmtSize(f.size_bytes)}</span>
                      {f.filament_meta?.estimated_minutes && (
                        <span>
                          ~{f.filament_meta.estimated_minutes < 60
                            ? `${f.filament_meta.estimated_minutes}хв`
                            : `${Math.floor(f.filament_meta.estimated_minutes / 60)}г`}
                        </span>
                      )}
                      {f.filament_meta?.colors && f.filament_meta.colors.length > 0 && (
                        <span className="flex items-center gap-0.5">
                          {f.filament_meta.colors.slice(0, 4).map((c, i) => (
                            <span key={i} className="h-2 w-2 rounded-full border border-black/10"
                              style={{ background: c ?? "#ccc" }} />
                          ))}
                        </span>
                      )}
                    </div>
                  </div>

                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                    strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]">
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="border-t border-[var(--border)] px-5 py-3 ">
          <button onClick={onClose} className="btn btn-ghost w-full">
            Скасувати
          </button>
        </div>
      </div>
    </div>
  );
}
