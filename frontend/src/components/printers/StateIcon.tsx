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

// Maps each state to its CSS custom property from the design-system token set.
const STATE_COLORS: Record<string, string> = {
  operational:        "var(--state-ok)",
  online:             "var(--state-ok)",
  printing:           "var(--state-print)",
  print_pending:      "var(--state-print)",
  idle:               "var(--state-idle)",
  paused:             "var(--state-warn)",
  awaiting_bed_clear: "var(--state-warn)",
  in_maintenance:     "var(--state-warn)",
  error:              "var(--state-error)",
  offline:            "var(--state-offline)",
  not_connected:      "var(--state-offline)",
  unknown:            "var(--state-offline)",
};

export function StateIcon({ state, size = 16 }: { state: string | null | undefined; size?: number }) {
  const s = state ?? "unknown";
  const label = STATE_LABELS[s] ?? s;
  const color = STATE_COLORS[s] ?? "var(--state-idle)";

  if (["pausing", "resuming", "cancelling"].includes(s)) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="animate-spin" aria-label={label} role="img">
        <title>{label}</title>
        <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="1.5" strokeOpacity="0.25" />
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
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
          className="absolute inline-flex rounded-full animate-ping"
          style={{ width: dot, height: dot, background: "var(--state-print)", opacity: 0.5 }}
        />
        <span
          className="relative inline-flex rounded-full"
          style={{ width: dot, height: dot, background: "var(--state-print)" }}
        />
      </span>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={label} role="img">
      <title>{label}</title>
      <circle cx="8" cy="8" r="4" fill={color} />
    </svg>
  );
}
