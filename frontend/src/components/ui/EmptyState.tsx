import Link from "next/link";

/**
 * Friendly empty-state: dashed card, icon, title, optional description + CTA.
 * Use on first-run screens so new accounts don't see bare/blank pages.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: { label: string; href?: string; onClick?: () => void };
  className?: string;
}) {
  return (
    <div
      className={[
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--border-strong)] px-6 py-14 text-center",
        className,
      ].join(" ")}
    >
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-2xl bg-[var(--surface-hi)] text-[var(--text-faint)]">
          {icon}
        </div>
      )}
      <div>
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        {description && (
          <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--text-muted)]">{description}</p>
        )}
      </div>
      {action &&
        (action.href ? (
          <Link href={action.href} className="btn btn-primary btn-sm mt-1">
            {action.label}
          </Link>
        ) : (
          <button onClick={action.onClick} className="btn btn-primary btn-sm mt-1" type="button">
            {action.label}
          </button>
        ))}
    </div>
  );
}
