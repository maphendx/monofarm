"use client";

const TOPICS = [
  {
    icon: "🚀",
    title: "Початок роботи",
    desc: "Налаштування акаунту, принтерів, перший друк",
    articles: 4,
    color: "#3b82f6",
  },
  {
    icon: "🖨",
    title: "Принтери",
    desc: "Підключення Bambu Lab, Klipper/Moonraker, Snapmaker",
    articles: 6,
    color: "#8b5cf6",
  },
  {
    icon: "📦",
    title: "Склад і ERP",
    desc: "Номенклатура, залишки, замовлення, виробничі партії",
    articles: 8,
    color: "#10b981",
  },
  {
    icon: "🏷",
    title: "Мітки і QR",
    desc: "Шаблони міток, друк на Zebra, сканер складу",
    articles: 3,
    color: "#f59e0b",
  },
  {
    icon: "📊",
    title: "Аналітика",
    desc: "Звіти по виробництву, маржинальність, собівартість",
    articles: 3,
    color: "#ef4444",
  },
  {
    icon: "🤖",
    title: "Автоматизація",
    desc: "Telegram-сповіщення, планування, API-ключі",
    articles: 4,
    color: "#06b6d4",
  },
];

export default function LearnPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-10 py-4">

      {/* Hero */}
      <div className="text-center space-y-3">
        <div className="flex justify-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-[var(--accent)]/10 text-3xl">
            📚
          </div>
        </div>
        <h1 className="text-2xl font-bold">Learning Center</h1>
        <p className="text-sm text-[var(--text-muted)] max-w-md mx-auto">
          Гайди, відео та поради щоб отримати максимум від Monofarm
        </p>
      </div>

      {/* Topic grid */}
      <section>
        <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Теми</p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {TOPICS.map(topic => (
            <div key={topic.title}
              className="group cursor-pointer rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5 transition-all hover:border-[var(--border-strong)] hover:shadow-sm">
              <div className="mb-3 flex items-center gap-3">
                <span className="text-2xl">{topic.icon}</span>
                <div className="h-1 flex-1 rounded-full opacity-30" style={{ background: topic.color }} />
              </div>
              <p className="font-semibold text-sm">{topic.title}</p>
              <p className="mt-1 text-xs text-[var(--text-faint)] leading-snug">{topic.desc}</p>
              <p className="mt-3 text-[10px] text-[var(--text-faint)]">{topic.articles} статей</p>
            </div>
          ))}
        </div>
      </section>

      {/* Coming soon banner */}
      <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-hi)] px-6 py-8 text-center">
        <p className="text-sm font-medium text-[var(--text-muted)]">Повноцінна база знань у розробці</p>
        <p className="mt-1 text-xs text-[var(--text-faint)]">
          Наразі всі питання — в Telegram або на{" "}
          <a href="mailto:support@monofarm.app" className="text-[var(--accent)] hover:underline">
            support@monofarm.app
          </a>
        </p>
      </div>

    </div>
  );
}
