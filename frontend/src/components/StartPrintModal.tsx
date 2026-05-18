"use client";

import { useEffect, useState } from "react";

import { SendModal } from "@/components/SendModal";
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
      <div className="flex w-full max-w-md flex-col rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        style={{ maxHeight: "80vh" }}>

        {/* header */}
        <div className="border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 className="font-semibold">▶ Почати друк</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Вибери файл для <strong>{printer.name}</strong>
          </p>
        </div>

        {/* search */}
        <div className="border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
          <input
            type="text"
            placeholder="Пошук файлів…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:focus:border-neutral-500"
          />
        </div>

        {/* file list */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="py-8 text-center text-sm text-neutral-400">Завантаження…</p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-400">
              {files.length === 0 ? "Файлів ще немає" : "Нічого не знайдено"}
            </p>
          ) : (
            <div className="space-y-1">
              {filtered.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSelected(f)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {/* extension badge */}
                  <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-mono font-medium text-neutral-500 dark:bg-neutral-800">
                    {f.original_name.split(".").pop()?.toUpperCase() ?? "?"}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.original_name}</p>
                    <div className="flex items-center gap-2 text-[11px] text-neutral-400">
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

                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-neutral-300">
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="border-t border-neutral-100 px-5 py-3 dark:border-neutral-800">
          <button onClick={onClose}
            className="w-full rounded-md py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            Скасувати
          </button>
        </div>
      </div>
    </div>
  );
}
