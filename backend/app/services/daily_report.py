"""Build and send the daily plan/status messages for Telegram."""
import logging
from collections import defaultdict
from datetime import date

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import SessionLocal
from app.models.plan import PlanEntry
from app.models.printer import Printer
from app.models.task import PrintTask
from app.models.user import User
from app.services import simplyprint, telegram_bot


log = logging.getLogger(__name__)


# ── plan ─────────────────────────────────────────────────────────────────────

def _esc(text: str) -> str:
    """Escape special markdown chars in printer/task names."""
    if not text:
        return ""
    return text.replace("*", "").replace("_", "").replace("`", "").replace("[", "(").replace("]", ")")


def build_daily_plan_text(db: Session, plan_date: date | None = None) -> str:
    plan_date = plan_date or date.today()
    entries = (
        db.query(PlanEntry)
        .filter(PlanEntry.plan_date == plan_date)
        .order_by(PlanEntry.printer_id, PlanEntry.sequence, PlanEntry.created_at)
        .all()
    )
    title = f"*План на {plan_date.strftime('%d.%m.%Y')}*"
    if not entries:
        return f"{title}\n\nПорожньо. Відкрий {settings.FARM_PUBLIC_URL}/plan щоб додати."

    by_printer: dict[int, list[PlanEntry]] = defaultdict(list)
    for e in entries:
        by_printer[e.printer_id].append(e)

    lines = [title, ""]
    for printer_id, plan_entries in by_printer.items():
        printer = db.get(Printer, printer_id)
        if not printer:
            continue
        lines.append(f"🖨️ *{_esc(printer.name)}*")
        for entry in plan_entries:
            task = db.get(PrintTask, entry.task_id)
            check = "✅" if entry.done else "▫️"
            qty = f" ×{task.quantity}" if task and task.quantity > 1 else ""
            title_str = _esc(task.title) if task else "—"
            lines.append(f"  {check} {title_str}{qty}")
        lines.append("")

    done = sum(1 for e in entries if e.done)
    lines.append(f"_Виконано {done} з {len(entries)} · {settings.FARM_PUBLIC_URL}/plan_")
    return "\n".join(lines)


# ── status (printers) ────────────────────────────────────────────────────────

_STATE_EMOJI = {
    "printing": "🖨️", "operational": "✅", "online": "🟢",
    "print_pending": "⏳", "awaiting_bed_clear": "🧹",
    "paused": "⏸️", "in_maintenance": "🔧",
    "not_connected": "🔌", "offline": "🔌",
    "idle": "💤", "error": "🛑",
}
_STATE_LABEL = {
    "printing": "друкує", "operational": "готовий", "online": "онлайн",
    "print_pending": "очікує", "awaiting_bed_clear": "потрібно очистити стіл",
    "paused": "на паузі", "in_maintenance": "обслуговування",
    "not_connected": "не підʼєднаний", "offline": "офлайн",
    "idle": "вільний", "error": "помилка",
}


def build_status_text(db: Session) -> str:
    overview = simplyprint.get_farm_overview()
    sp_states = {str(p["id"]): p for p in simplyprint.extract_printers(overview)}

    rows = (
        db.query(Printer)
        .filter(Printer.is_active.is_(True))
        .order_by(Printer.kind, Printer.name)
        .all()
    )
    if not rows:
        return "Принтерів немає."

    # Bucket
    counts: dict[str, list[str]] = defaultdict(list)
    problems: list[tuple[Printer, str, list[str]]] = []

    for row in rows:
        if row.sp_printer_id and row.sp_printer_id in sp_states:
            sp = sp_states[row.sp_printer_id]
            state = sp["state"]
            flags = sp.get("flags", [])
        else:
            state = row.manual_status or "idle"
            flags = []
        counts[state].append(row.name)
        if "requires_attention" in flags or state in ("paused", "error", "in_maintenance"):
            problems.append((row, state, flags))

    lines = [f"*Стан ферми* — {len(rows)} принтерів", ""]
    for state in [
        "printing", "operational", "online", "print_pending",
        "awaiting_bed_clear", "in_maintenance", "paused",
        "idle", "not_connected", "offline", "error",
    ]:
        names = counts.get(state)
        if not names:
            continue
        emoji = _STATE_EMOJI.get(state, "•")
        label = _STATE_LABEL.get(state, state)
        lines.append(f"{emoji} {label}: {len(names)}")

    if problems:
        lines.append("")
        lines.append("*Потребують уваги:*")
        for printer, state, flags in problems:
            emoji = _STATE_EMOJI.get(state, "⚠️")
            label = _STATE_LABEL.get(state, state)
            tail = " ⚠️ потребує уваги" if "requires_attention" in flags else ""
            lines.append(f"{emoji} {_esc(printer.name)} — {label}{tail}")

    lines.append("")
    lines.append(f"_{settings.FARM_PUBLIC_URL}/dashboard_")
    return "\n".join(lines)


# ── 09:00 broadcast ──────────────────────────────────────────────────────────

async def send_daily_plan_to_all() -> None:
    """Called by scheduler at 09:00. Sends plan to every linked active user."""
    with SessionLocal() as db:
        text = build_daily_plan_text(db)
        chat_ids = [
            row[0]
            for row in db.query(User.telegram_chat_id)
            .filter(User.is_active.is_(True), User.telegram_chat_id.isnot(None))
            .all()
        ]
    if not chat_ids:
        log.info("Daily plan: no linked users to send to")
        return
    sent = 0
    for chat_id in chat_ids:
        ok = await telegram_bot.send_message(int(chat_id), text)
        sent += int(ok)
    log.info("Daily plan: sent to %d/%d users", sent, len(chat_ids))
