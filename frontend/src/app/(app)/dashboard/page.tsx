"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { CreatePrinterModal } from "@/components/CreatePrinterModal";
import { DashboardPet } from "@/components/DashboardPet";
import { DaySummary } from "@/components/DaySummary";
import { PrinterCard } from "@/components/PrinterCard";
import { PrinterDetailModal } from "@/components/PrinterDetailModal";
import { PrinterGroupsModal } from "@/components/PrinterGroupsModal";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import type { Printer, PrinterKind } from "@/lib/types";

// ── group stats ───────────────────────────────────────────────────────────────

interface GroupStats {
  printing: number;
  paused: number;
  action: number;  // awaiting_bed_clear / in_maintenance / error
  ready: number;   // operational / idle / online / print_pending
  offline: number; // offline / not_connected / unknown
}

function calcGroupStats(items: Printer[]): GroupStats {
  const s: GroupStats = { printing: 0, paused: 0, action: 0, ready: 0, offline: 0 };
  for (const p of items) {
    const st = p.state ?? "unknown";
    if (st === "printing") s.printing++;
    else if (st === "paused") s.paused++;
    else if (["awaiting_bed_clear", "in_maintenance", "error"].includes(st)) s.action++;
    else if (["operational", "idle", "online", "print_pending"].includes(st)) s.ready++;
    else s.offline++;
  }
  return s;
}

function StatBadge({
  count,
  label,
  className,
}: {
  count: number;
  label: string;
  className: string;
}) {
  if (count === 0) return null;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {count} {label}
    </span>
  );
}

function GroupStatsBadges({ stats }: { stats: GroupStats }) {
  return (
    <div className="flex items-center gap-1.5">
      <StatBadge
        count={stats.printing}
        label="друкує"
        className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
      />
      <StatBadge
        count={stats.paused}
        label="пауза"
        className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
      />
      <StatBadge
        count={stats.action}
        label="дія"
        className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
      />
      <StatBadge
        count={stats.ready}
        label="готові"
        className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
      />
      <StatBadge
        count={stats.offline}
        label="офлайн"
        className="bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
      />
    </div>
  );
}

// ── filter ───────────────────────────────────────────────────────────────────

type Filter = "all" | "snapmaker_u1" | "problems";

const FILTER_OPTS: { id: Filter; label: string }[] = [
  { id: "all", label: "Всі принтери" },
  { id: "snapmaker_u1", label: "Snapmaker U1" },
  { id: "problems", label: "Лише проблеми" },
];

// ── grouping ──────────────────────────────────────────────────────────────────

type GroupBy = "mygroup" | "none" | "kind" | "state";

const GROUP_OPTS: { id: GroupBy; label: string }[] = [
  { id: "mygroup", label: "За моїми групами" },
  { id: "none", label: "Без групування" },
  { id: "kind", label: "За типом" },
  { id: "state", label: "За станом" },
];

const KIND_ORDER: PrinterKind[] = ["bambu", "snapmaker_u1", "other"];

const STATE_ORDER = [
  "printing", "paused", "error", "awaiting_bed_clear",
  "in_maintenance", "operational", "online", "print_pending",
  "idle", "not_connected", "offline", "unknown",
];

function groupPrinters(
  printers: Printer[],
  by: GroupBy,
): { key: string; label: string; items: Printer[] }[] {
  if (by === "none") return [{ key: "all", label: "", items: printers }];

  if (by === "mygroup") {
    // Printers arrive from the API already sorted: by group sort_order then name,
    // ungrouped printers last. We just need to segment them into sections.
    const sections: { key: string; label: string; items: Printer[] }[] = [];
    const seen = new Map<string, number>(); // key → index in sections

    for (const p of printers) {
      const key = p.group_id !== null ? `g${p.group_id}` : "__ungrouped__";
      const label = p.group_name ?? "Без групи";
      if (!seen.has(key)) {
        seen.set(key, sections.length);
        sections.push({ key, label, items: [] });
      }
      sections[seen.get(key)!].items.push(p);
    }
    return sections;
  }

  const map = new Map<string, Printer[]>();
  if (by === "kind") {
    for (const p of printers) {
      if (!map.has(p.kind)) map.set(p.kind, []);
      map.get(p.kind)!.push(p);
    }
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => ({
      key: k, label: kindLabel(k), items: map.get(k)!,
    }));
  }

  // by === "state"
  for (const p of printers) {
    const s = p.state ?? "unknown";
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(p);
  }
  const ordered = STATE_ORDER.filter((s) => map.has(s));
  for (const s of map.keys()) if (!ordered.includes(s)) ordered.push(s);
  return ordered.map((s) => ({
    key: s, label: stateLabel(s), items: map.get(s)!,
  }));
}

// ── compact select ────────────────────────────────────────────────────────────

function CompactSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-700 outline-none hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const user = useUser();
  const router = useRouter();

  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("mygroup");
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
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
    if (filter === "problems")
      return printers.filter((p) => {
        const t = printerTone(p);
        return t === "bad" || t === "warn";
      });
    return printers.filter((p) => p.kind === filter);
  }, [printers, filter]);

  const groups = useMemo(
    () => groupPrinters(filtered, groupBy),
    [filtered, groupBy],
  );

  const counts = useMemo(() => {
    const c = { all: printers.length, snapmaker_u1: 0, problems: 0 };
    for (const p of printers) {
      if (p.kind === "snapmaker_u1") c.snapmaker_u1++;
      const t = printerTone(p);
      if (t === "bad" || t === "warn") c.problems++;
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

  const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";
  const isGrouped = groupBy !== "none";

  return (
    <div className="space-y-4">
      <DaySummary />

      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CompactSelect value={filter} onChange={setFilter} options={FILTER_OPTS} />
          <span className="text-xs text-neutral-400">
            {filtered.length !== counts.all
              ? `${filtered.length} з ${counts.all}`
              : counts.all}
          </span>
          <CompactSelect value={groupBy} onChange={setGroupBy} options={GROUP_OPTS} />
        </div>

        <div className="flex items-center gap-2 text-sm text-neutral-500">
          {refreshedAt && (
            <span className="text-xs">{refreshedAt.toLocaleTimeString("uk-UA")}</span>
          )}
          <button
            onClick={load}
            className="rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs transition hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
          >
            ↻ Оновити
          </button>
          {(user.role === "admin" || user.role === "operator") && (
            <button
              onClick={() => setGroupsOpen(true)}
              className="rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800"
              title="Керувати групами принтерів"
            >
              Групи
            </button>
          )}
          {user.role === "admin" && (
            <button
              onClick={() => setCreateOpen(true)}
              className="rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
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

      {/* ── content ── */}
      {loading && printers.length === 0 ? (
        <div className="text-sm text-neutral-500">Завантаження…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Принтерів не знайдено
        </div>
      ) : !isGrouped ? (
        <div className={GRID}>
          {filtered.map((p) => (
            <PrinterCard key={p.id} printer={p} onClick={(p) => router.push(`/printers/${p.id}`)} onSettings={setSelected} onUpdated={upsertPrinter} />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
            const stats = calcGroupStats(g.items);
            return (
              <section key={g.key}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-semibold">{g.label}</span>
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                    {g.items.length}
                  </span>
                  <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
                  <GroupStatsBadges stats={stats} />
                </div>
                <div className={GRID}>
                  {g.items.map((p) => (
                    <PrinterCard key={p.id} printer={p} onClick={(p) => router.push(`/printers/${p.id}`)} onSettings={setSelected} onUpdated={upsertPrinter} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <CreatePrinterModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(p) => { upsertPrinter(p); load(); }}
      />

      <PrinterGroupsModal
        open={groupsOpen}
        onClose={() => setGroupsOpen(false)}
        onChange={load}
      />

      <PrinterDetailModal
        printer={selected}
        onClose={() => setSelected(null)}
        onUpdated={(p) => { upsertPrinter(p); load(); }}
        onDeleted={(id) => setPrinters((prev) => prev.filter((p) => p.id !== id))}
      />

      {!loading && printers.length > 0 && <DashboardPet printers={printers} />}
    </div>
  );
}
