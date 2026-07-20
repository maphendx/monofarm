export interface PrinterAmsSpool {
  key: string;
  label: number;
  empty: boolean;
  hex: string;
  colorName: string | null;
  material: string | null;
  brand: string | null;
  grams: number | null;
  active: boolean;
  rawSlot: number;
  verified: boolean;
}

export interface PrinterAmsGroup {
  title: string | null;
  external: boolean;
  slots: PrinterAmsSpool[];
}

function unitLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function HandySpoolReel({ color, empty }: { color: string; empty: boolean }) {
  return (
    <svg
      aria-hidden="true"
      data-spool-reel="true"
      viewBox="0 0 72 88"
      className="h-[76px] w-[62px] drop-shadow-[0_10px_14px_rgba(0,0,0,0.22)] sm:h-[88px] sm:w-[72px]"
    >
      <path
        d="M19 5C12 12 10 24 10 44s2 32 9 39c5-3 10-5 17-5s12 2 17 5c7-7 9-19 9-39S60 12 53 5c-5 3-10 5-17 5S24 8 19 5Z"
        fill="var(--surface-hi)"
        stroke="var(--border-strong)"
        strokeWidth="1.5"
      />
      <path
        d="M20 18c5 2 10 3 16 3s11-1 16-3c2 8 3 17 3 26s-1 18-3 26c-5-2-10-3-16-3s-11 1-16 3c-2-8-3-17-3-26s1-18 3-26Z"
        fill={empty ? "var(--bg-elevated)" : color}
        opacity={empty ? 0.72 : 0.9}
      />
      <ellipse cx="36" cy="44" rx="13" ry="20" fill="var(--bg)" opacity="0.74" />
      <ellipse cx="36" cy="44" rx="7" ry="11" fill="var(--surface-hi)" stroke="var(--border-strong)" />
      {empty && (
        <path d="M27 34 45 54M45 34 27 54" fill="none" stroke="var(--text-faint)" strokeLinecap="round" strokeWidth="1.5" />
      )}
    </svg>
  );
}

function SpoolButton({
  slot,
  label,
  onClick,
}: {
  slot: PrinterAmsSpool;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      data-active={slot.active ? "true" : "false"}
      aria-label={`${label}: ${slot.empty ? "Порожньо" : [slot.colorName, slot.material].filter(Boolean).join(", ")}`}
      className={[
        "group relative flex min-w-0 flex-col items-center rounded-xl px-1.5 pb-2 pt-2 text-center transition",
        slot.active
          ? "bg-[color-mix(in_srgb,var(--state-print)_10%,transparent)] ring-1 ring-[var(--state-print)]"
          : "hover:bg-[var(--surface-hi)]",
        onClick ? "cursor-pointer" : "cursor-default",
      ].join(" ")}
    >
      <span className="mb-0.5 min-h-4 max-w-full truncate text-[10px] text-[var(--text-faint)]">
        {slot.empty ? "Порожньо" : (slot.material ?? slot.colorName ?? "Філамент")}
      </span>
      <span className="relative">
        <HandySpoolReel color={slot.hex} empty={slot.empty} />
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-semibold text-[var(--text)]">
          {label}
        </span>
        {slot.active && (
          <span className="absolute right-0 top-1 flex size-4 items-center justify-center rounded-full bg-[var(--state-print)] text-[9px] font-bold text-white shadow-sm">
            ✓
          </span>
        )}
      </span>
      <span className="mt-0.5 min-h-4 max-w-full truncate text-[10px] font-medium text-[var(--text-muted)]">
        {slot.empty ? "—" : (slot.colorName ?? slot.brand ?? slot.material)}
      </span>
      {!slot.verified && (
        <span className="text-[9px] text-[var(--state-warn)]" title="Ще не підтверджено принтером">
          очікує синхронізації
        </span>
      )}
    </button>
  );
}

export function PrinterAmsOverview({
  groups,
  onSlotClick,
}: {
  groups: PrinterAmsGroup[];
  onSlotClick?: (rawSlot: number) => void;
}) {
  const amsGroups = groups.filter((group) => !group.external);
  const externalGroups = groups.filter((group) => group.external);

  return (
    <div data-printer-ams="handy" className="space-y-3">
      {amsGroups.map((group, groupIndex) => {
        const letter = unitLetter(groupIndex);
        const synced = group.slots.every((slot) => slot.verified);
        return (
          <section key={`ams-${groupIndex}`} className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="grid h-5 w-9 grid-cols-4 gap-0.5 rounded border border-[var(--border-strong)] p-1" aria-hidden="true">
                  {group.slots.slice(0, 4).map((slot) => (
                    <span key={slot.key} className="rounded-[1px]" style={{ backgroundColor: slot.empty ? "var(--text-dim)" : slot.hex }} />
                  ))}
                </span>
                <span className="text-xs font-semibold text-[var(--text)]">AMS-{letter}</span>
              </div>
              <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                <span className={`size-1.5 rounded-full ${synced ? "bg-[var(--state-ok)]" : "bg-[var(--state-warn)]"}`} />
                {synced ? "синхронізовано" : "очікує даних"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1 p-2 sm:grid-cols-4">
              {group.slots.map((slot) => (
                <SpoolButton
                  key={slot.key}
                  slot={slot}
                  label={`${letter}${slot.label}`}
                  onClick={onSlotClick ? () => onSlotClick(slot.rawSlot) : undefined}
                />
              ))}
            </div>
          </section>
        );
      })}

      {externalGroups.map((group, groupIndex) => (
        <section key={`external-${groupIndex}`} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--text)]">Зовнішня котушка</span>
            <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-faint)]">EXT</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {group.slots.map((slot) => (
              <SpoolButton
                key={slot.key}
                slot={slot}
                label="EXT"
                onClick={onSlotClick ? () => onSlotClick(slot.rawSlot) : undefined}
              />
            ))}
            <p className="max-w-52 text-xs leading-relaxed text-[var(--text-faint)]">
              Пряма подача без AMS. Натисни на котушку, щоб змінити колір або матеріал.
            </p>
          </div>
        </section>
      ))}
    </div>
  );
}
