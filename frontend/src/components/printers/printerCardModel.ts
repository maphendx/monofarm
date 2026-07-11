import type { Printer } from "@/lib/types";

export type PrinterCardTone =
  | "printing"
  | "paused"
  | "collect"
  | "warn"
  | "error"
  | "ok"
  | "idle"
  | "offline";

const BAMBU_COVER: [RegExp, string][] = [
  [/a1[\s_-]*mini/i, "/printers/a1_mini.png"],
  [/a1[\s_-]*combo/i, "/printers/a1_mini.png"],
  [/\ba1\b/i, "/printers/a1.png"],
  [/p1s/i, "/printers/p1s.png"],
  [/p1p/i, "/printers/p1p.png"],
  [/x1[\s_-]*carbon/i, "/printers/x1c.png"],
  [/x1c/i, "/printers/x1c.png"],
  [/x1e/i, "/printers/x1e.png"],
  [/\bx1\b/i, "/printers/x1.png"],
  [/h2d[\s_-]*pro/i, "/printers/h2d_pro.png"],
  [/h2d/i, "/printers/h2d.png"],
];

function bambuCover(model: string | null | undefined): string | null {
  if (!model) return null;
  for (const [re, path] of BAMBU_COVER) {
    if (re.test(model)) return path;
  }
  return null;
}

export function printerCover(printer: Printer): string | null {
  if (printer.kind === "bambu") return bambuCover(printer.bambu_model);
  if (printer.kind === "snapmaker_u1") return "/printers/snapmaker_u1.png";
  return null;
}

export function getPrinterCardTone(printer: Printer): PrinterCardTone {
  if (!printer.is_active || printer.state === "offline" || printer.state === "not_connected") {
    return "offline";
  }

  const needsClearBed = printer.state === "awaiting_bed_clear" ||
    (printer.state === "operational" && (!!printer.job || (printer.progress_pct ?? 0) >= 100));
  if (needsClearBed) return "collect";

  const flags = printer.flags ?? [];
  if (flags.includes("requires_attention") || flags.includes("ai_detected_high") || printer.state === "error") {
    return "error";
  }
  if (flags.includes("ai_detected_low") || printer.state === "in_maintenance") return "warn";

  switch (printer.state) {
    case "printing":
    case "pausing":
    case "resuming":
    case "cancelling":
      return "printing";
    case "paused":
      return "paused";
    case "operational":
    case "online":
    case "print_pending":
      return "ok";
    case "idle":
      return "idle";
    default:
      return "idle";
  }
}

export function formatEtaShort(min: number): string {
  if (min < 60) return `${min}хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}г ${m}хв` : `${h}год`;
}

export function formatFinishTime(etaMinutes: number, now = new Date()): string {
  const finish = new Date(now.getTime() + etaMinutes * 60_000);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
  const dayAfter = new Date(todayStart.getTime() + 2 * 86_400_000);
  const time = finish.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  if (finish < tomorrowStart) return `Сьогодні, ${time}`;
  if (finish < dayAfter) return `Завтра, ${time}`;
  return `${finish.toLocaleDateString("uk-UA", { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

export function getSlotNumber(slot: { slot_index: number }): string {
  return String(slot.slot_index + 1);
}

export function canSkipObject(printer: Pick<Printer, "state" | "moonraker_url">): boolean {
  return printer.state === "printing" && !!printer.moonraker_url;
}
