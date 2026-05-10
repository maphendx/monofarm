"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { CreatePrinterModal } from "@/components/CreatePrinterModal";
import { DaySummary } from "@/components/DaySummary";
import { PrinterCard } from "@/components/PrinterCard";
import { PrinterDetailModal } from "@/components/PrinterDetailModal";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { printerTone } from "@/lib/printerLabels";
import type { Printer } from "@/lib/types";

type Filter = "all" | "simplyprint" | "snapmaker_u1" | "problems";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Всі" },
  { id: "simplyprint", label: "SimplyPrint" },
  { id: "snapmaker_u1", label: "Snapmaker U1" },
  { id: "problems", label: "Проблеми" },
];

export default function DashboardPage() {
  const user = useUser();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Printer | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<Printer[]>("/api/printers");
      setPrinters(data);
      setRefreshedAt(new Date());
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Помилка завантаження");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const filtered = useMemo(() => {
    if (filter === "all") return printers;
    if (filter === "problems") {
      return printers.filter((p) => {
        const tone = printerTone(p);
        return tone === "bad" || tone === "warn";
      });
    }
    return printers.filter((p) => p.kind === filter);
  }, [printers, filter]);

  const counts = useMemo(() => {
    const c = { all: printers.length, simplyprint: 0, snapmaker_u1: 0, problems: 0 };
    for (const p of printers) {
      if (p.kind === "simplyprint") c.simplyprint += 1;
      if (p.kind === "snapmaker_u1") c.snapmaker_u1 += 1;
      const tone = printerTone(p);
      if (tone === "bad" || tone === "warn") c.problems += 1;
    }
    return c;
  }, [printers]);

  function upsertPrinter(p: Printer) {
    setPrinters((prev) => {
      const idx = prev.findIndex((x) => x.id === p.id);
      if (idx === -1) return [...prev, p];
      const copy = [...prev];
      copy[idx] = p;
      return copy;
    });
  }

  return (
    <div className="space-y-4">
      <DaySummary />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={
                "rounded-md px-3 py-1.5 text-sm transition " +
                (filter === f.id
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "border border-neutral-200 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800")
              }
            >
              {f.label}
              <span className="ml-1.5 text-xs opacity-60">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          {refreshedAt && (
            <span>Оновлено {refreshedAt.toLocaleTimeString("uk-UA")}</span>
          )}
          <button
            onClick={load}
            className="rounded-md border border-neutral-200 px-3 py-1.5 transition hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
          >
            Оновити
          </button>
          {user.role === "admin" && (
            <button
              onClick={() => setCreateOpen(true)}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              + Принтер
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && printers.length === 0 ? (
        <div className="text-sm text-neutral-500">Завантаження…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Принтерів не знайдено
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {filtered.map((p) => (
            <PrinterCard key={p.id} printer={p} onClick={setSelected} />
          ))}
        </div>
      )}

      <CreatePrinterModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(p) => {
          upsertPrinter(p);
          load();
        }}
      />

      <PrinterDetailModal
        printer={selected}
        onClose={() => setSelected(null)}
        onUpdated={(p) => {
          upsertPrinter(p);
        }}
      />
    </div>
  );
}
