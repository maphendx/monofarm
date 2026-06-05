"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";

type Zone = {
  id: number; name: string; rows: number; cols: number;
  cell_count: number; filled_cells: number;
  warehouse_id: number; warehouse_name: string;
};

export default function ZonesOverviewPage() {
  const router = useRouter();
  const [zones,   setZones]   = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Zone[]>("/api/warehouse/zones")
      .then(setZones)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <PageSkeleton cols={4} rows={5} />;

  if (zones.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-16 text-center">
        <p className="text-sm text-[var(--text-muted)]">Стелажів ще немає</p>
        <button onClick={() => router.push("/warehouse/warehouses")}
          className="mt-3 rounded-md bg-[var(--accent)] px-4 py-2 text-sm text-white hover:bg-[var(--accent-hi)]">
          До складів
        </button>
      </div>
    );
  }

  // Group zones by warehouse, preserving the backend's ordering.
  const groups: { warehouse_id: number; warehouse_name: string; zones: Zone[] }[] = [];
  for (const z of zones) {
    let g = groups.find((x) => x.warehouse_id === z.warehouse_id);
    if (!g) { g = { warehouse_id: z.warehouse_id, warehouse_name: z.warehouse_name, zones: [] }; groups.push(g); }
    g.zones.push(z);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Стелажі</h1>
        <p className="mt-0.5 text-sm text-[var(--text-muted)]">
          {zones.length} {zones.length === 1 ? "стелаж" : "стелажів"} у {groups.length} складах
        </p>
      </div>

      {groups.map((g) => (
        <div key={g.warehouse_id}>
          <button
            onClick={() => router.push(`/warehouse/warehouses/${g.warehouse_id}`)}
            className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)] hover:text-[var(--text)]">
            {g.warehouse_name}
          </button>
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
            {g.zones.map((z) => {
              const pct = z.cell_count > 0 ? Math.round((z.filled_cells / z.cell_count) * 100) : 0;
              return (
                <button
                  key={z.id}
                  onClick={() => router.push(`/warehouse/warehouses/${z.warehouse_id}`)}
                  className="group flex w-full items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 text-left last:border-0 hover:bg-[var(--surface-hi)]">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium group-hover:text-[var(--accent)]">{z.name}</span>
                  <span className="shrink-0 font-mono text-xs text-[var(--text-faint)]">{z.rows}×{z.cols}</span>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
                    <b className="text-[var(--text)]">{z.filled_cells}</b>/{z.cell_count} зайнято
                  </span>
                  <span className="hidden w-10 shrink-0 text-right text-xs tabular-nums text-[var(--text-faint)] sm:inline">{pct}%</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
