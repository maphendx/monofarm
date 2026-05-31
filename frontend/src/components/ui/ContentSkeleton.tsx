/**
 * Reusable skeleton loaders for page content.
 * Uses the .skeleton shimmer class from globals.css.
 *
 * Variants:
 *   <TableSkeleton />     — table with header + rows
 *   <CardsSkeleton />     — grid of card placeholders
 *   <StatsSkeleton />     — row of stat boxes + optional chart area
 *   <PageSkeleton />      — header bar + table (most common layout)
 *   <KanbanSkeleton />    — column-based board skeleton
 */

// ── Shared fade-in animation ─────────────────────────────────────────────────

const fadeStyle = (i: number): React.CSSProperties => ({
  animation: `skeletonFadeIn 0.4s ease-out ${i * 0.06}s both`,
});

// ── Table ─────────────────────────────────────────────────────────────────────

export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      <style>{`@keyframes skeletonFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
              {Array.from({ length: cols }).map((_, c) => (
                <th key={c} className="px-4 py-3">
                  <div
                    className="skeleton h-3 rounded"
                    style={{ width: c === 0 ? "40%" : `${55 + (c * 13) % 30}%` }}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, r) => (
              <tr
                key={r}
                className="border-b border-[var(--border)] last:border-b-0"
                style={fadeStyle(r)}
              >
                {Array.from({ length: cols }).map((_, c) => (
                  <td key={c} className="px-4 py-3">
                    <div
                      className="skeleton h-3.5 rounded"
                      style={{ width: `${40 + ((r + c) * 7) % 45}%` }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Stats row ─────────────────────────────────────────────────────────────────

export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      <style>{`@keyframes skeletonFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(count, 5)}, 1fr)` }}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
            style={fadeStyle(i)}
          >
            <div className="skeleton mb-3 h-2.5 w-16 rounded" />
            <div className="skeleton mb-2 h-7 w-20 rounded" />
            <div className="skeleton h-1.5 w-full rounded-full" />
          </div>
        ))}
      </div>
    </>
  );
}

// ── Cards grid ────────────────────────────────────────────────────────────────

export function CardsSkeleton({ count = 6, cols = 3 }: { count?: number; cols?: number }) {
  return (
    <>
      <style>{`@keyframes skeletonFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
            style={fadeStyle(i)}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="skeleton size-9 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-3.5 w-3/4 rounded" />
                <div className="skeleton h-2.5 w-1/2 rounded" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="skeleton h-2.5 w-full rounded" />
              <div className="skeleton h-2.5 w-5/6 rounded" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Kanban columns ────────────────────────────────────────────────────────────

export function KanbanSkeleton({ columns = 4, cardsPerCol = 3 }: { columns?: number; cardsPerCol?: number }) {
  return (
    <>
      <style>{`@keyframes skeletonFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: columns }).map((_, col) => (
          <div
            key={col}
            className="flex w-72 shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
            style={fadeStyle(col)}
          >
            <div className="flex items-center justify-between px-1 py-1">
              <div className="skeleton h-3.5 w-20 rounded" />
              <div className="skeleton size-5 rounded" />
            </div>
            {Array.from({ length: cardsPerCol }).map((_, card) => (
              <div
                key={card}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 space-y-2"
                style={fadeStyle(col + card + 1)}
              >
                <div className="skeleton h-3 w-4/5 rounded" />
                <div className="skeleton h-2.5 w-3/5 rounded" />
                <div className="flex gap-2 pt-1">
                  <div className="skeleton h-5 w-14 rounded-full" />
                  <div className="skeleton h-5 w-10 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

// ── Toolbar (header bar) ──────────────────────────────────────────────────────

function ToolbarSkeleton() {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="skeleton h-8 w-32 rounded-lg" />
        <div className="skeleton h-8 w-24 rounded-lg" />
      </div>
      <div className="flex items-center gap-2">
        <div className="skeleton h-8 w-8 rounded-lg" />
        <div className="skeleton h-8 w-28 rounded-lg" />
      </div>
    </div>
  );
}

// ── Full page: title + toolbar + table (most common) ──────────────────────────

export function PageSkeleton({
  rows = 8,
  cols = 5,
  withStats = false,
  statsCount = 4,
}: {
  rows?: number;
  cols?: number;
  withStats?: boolean;
  statsCount?: number;
}) {
  return (
    <div className="space-y-4">
      {/* Title */}
      <div className="skeleton h-6 w-44 rounded" />

      {/* Toolbar */}
      <ToolbarSkeleton />

      {/* Stats row */}
      {withStats && <StatsSkeleton count={statsCount} />}

      {/* Table */}
      <TableSkeleton rows={rows} cols={cols} />
    </div>
  );
}
