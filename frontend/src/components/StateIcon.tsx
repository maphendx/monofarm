const STATE_LABELS: Record<string, string> = {
  printing: "Друкує",
  pausing: "Пауза...",
  resuming: "Відновлення...",
  cancelling: "Скасування...",
  operational: "Готовий",
  online: "Онлайн",
  print_pending: "Очікує",
  idle: "Вільний",
  paused: "На паузі",
  awaiting_bed_clear: "Очікує очищення столу",
  in_maintenance: "Обслуговування",
  error: "Помилка",
  offline: "Офлайн",
  not_connected: "Не підключений",
  unknown: "Невідомо",
};

export function StateIcon({ state, size = 16 }: { state: string | null | undefined; size?: number }) {
  const s = state ?? "unknown";
  const label = STATE_LABELS[s] ?? s;

  if (["pausing", "resuming", "cancelling"].includes(s)) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="animate-spin" aria-label={label} role="img">
        <title>{label}</title>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.2" />
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (s === "printing") {
    const dot = Math.round(size * 0.5);
    return (
      <span
        className="relative flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
        role="img"
        aria-label={label}
      >
        <span
          className="absolute inline-flex rounded-full bg-blue-400 opacity-75 animate-ping"
          style={{ width: dot, height: dot }}
        />
        <span
          className="relative inline-flex rounded-full bg-blue-500"
          style={{ width: dot, height: dot }}
        />
      </span>
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
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={label} role="img">
      <title>{label}</title>
      <circle cx="8" cy="8" r="4" fill={colors[s] ?? "#a3a3a3"} />
    </svg>
  );
}
