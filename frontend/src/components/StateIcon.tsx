export function StateIcon({ state, size = 16 }: { state: string | null | undefined; size?: number }) {
  const s = state ?? "unknown";

  if (["pausing", "resuming", "cancelling"].includes(s)) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="animate-spin">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.2" />
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (s === "printing") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="4" fill="#3b82f6" />
      </svg>
    );
  }

  const colors: Record<string, string> = {
    operational: "#10b981",
    online: "#10b981",
    print_pending: "#3b82f6",
    idle: "#a3a3a3",
    paused: "#f59e0b",
    awaiting_bed_clear: "#f59e0b",
    in_maintenance: "#f59e0b",
    error: "#ef4444",
    offline: "#404040",
    not_connected: "#404040",
    unknown: "#404040",
  };

  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="4" fill={colors[s] ?? "#a3a3a3"} />
    </svg>
  );
}
