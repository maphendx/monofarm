export default function PrinterDetailLoading() {
  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] pb-4">
        <div className="skeleton size-8 rounded-lg" />
        <div className="space-y-2">
          <div className="skeleton h-6 w-48 rounded" />
          <div className="skeleton h-3.5 w-64 rounded" />
        </div>
      </div>

      {/* content grid: webcam + stats */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-3">
          <div className="skeleton aspect-video w-full rounded-xl" />
          <div className="skeleton h-20 w-full rounded-xl" />
        </div>
        <div className="space-y-3">
          <div className="skeleton h-44 w-full rounded-xl" />
          <div className="skeleton h-44 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
