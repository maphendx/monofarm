/** Format ISO date string as "Yesterday at HH:MM", "Today at HH:MM", or "M/D/YYYY, HH:MM" */
export function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const timeStr = d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });

  if (dStart.getTime() === todayStart.getTime()) return `Сьогодні о ${timeStr}`;
  if (dStart.getTime() === yesterdayStart.getTime()) return `Вчора о ${timeStr}`;
  return d.toLocaleString("uk-UA", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format minutes as "2h 30m" or "45m" */
export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Sum array of numbers, ignoring nulls */
export function sumArray(arr: (number | null | undefined)[] | null | undefined): number {
  if (!arr) return 0;
  return arr.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}
