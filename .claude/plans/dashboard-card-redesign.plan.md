# Plan: редизайн картки принтера на дашборді (стиль 3DQue, токени monofarm)

**Мета:** зробити стан кожного принтера миттєво зчитуваним і додати камеру прямо в картку.
**Візуальне ТЗ (source of truth):** `.claude/plans/dashboard-card-redesign-mockup.html` — відкрий у браузері, це точний макет усіх станів в обох темах. Копіюй саме ці класи/розміри/токени.
**Складність:** Medium. **Тільки візуал** — не чіпати логіку станів, WS-потік, backend, групування/drag.

## Обрані рішення (затверджені користувачем)
- Стриманіший банер (не повна заливка 3DQue).
- **Акцентна смуга — ЗВЕРХУ** картки (`box-shadow: inset 0 3px 0 var(--rail)`), не зліва.
- Стек інструментів **⚙ ▤ ✛** справа в шапці.
- **Камера в картці**: клік по ▤ перемикає вміст картки на живий фід + керування, без переходу на сторінку.
- Зручні теги: рядок «Теги» + кнопка `+` + заповнені кольорові чипи.

## Файли
| Файл | Дія | Що робити |
|---|---|---|
| `frontend/src/app/globals.css` | UPDATE | Нові класи банера/тегів/камери на токенах; смуга зверху; `.progress` 4→6px. ⚠️ рестарт `bun run dev` (Tailwind v4). |
| `frontend/src/components/printers/PrinterCard.tsx` | UPDATE | Шапка→банер; стек ⚙▤✛; тумблер камери (`useState` cam-open); теги з `+`; прогрес+ETA в рядок; чип «Забрати стіл». |
| `frontend/src/app/(app)/dashboard/page.tsx` | UPDATE | Дзеркалити банер+теги у `PrinterPhotoCard` (view «Фото»), щоб не розсинхронити. |
| `frontend/src/lib/translations/uk.ts`, `en.ts` | UPDATE | Ключі: «Забрати стіл», «Гріє стіл», «Теги», «Назад до статусу», camera-controls. Обидві мови. |

## Деталі реалізації

### 1. Банер стану (globals.css)
- `.printer-card`: прибрати `border-top: 3px` підхід, замінити на `box-shadow: inset 0 3px 0 var(--rail)` + `overflow:hidden`. Rail = колір стану per-modifier (`--rail: var(--state-print/ok/warn/error)`, для idle/offline `transparent`).
- Банер-шапка: тонований фон `color-mix(in srgb, var(--state-*) 8-12%, var(--surface))`, назва + пігулка стану (mono, uppercase, filled tint).
- Всі кольори/розміри — з mockup HTML (класи `.band`, `.name`, `.pill`, `.tools`, `.tool`).
- **Тільки токени `var(--*)`** — жодного raw Tailwind (`bg-blue-500`) чи hex у станах.

### 2. Стек інструментів ⚙ ▤ ✛
- Вертикальний стек 26px кнопок у шапці справа. Іконки = ті ж lucide-стиль SVG, що в mockup (gear / video / maximize).
- ⚙ = наявний `onSettings`. ✛ = відкрити деталі (наявний `onClick`). ▤ = тумблер камери (нове).

### 3. Камера в картці (ключове)
- `const [camOpen, setCamOpen] = useState(false)`. Клік ▤ → toggle. Кнопка активна (accent) коли відкрито.
- Коли `camOpen`: сховати статус-body, показати фід + `.cam-controls`.
- **Перевикористати наявний плеєр**: прочитати `frontend/src/components/printers/PrinterDetailModal.tsx` — там уже працює go2rtc-стрім (`GO2RTC_URL`, webcam URL принтера). Витягнути той самий `<img>`/`<video>`/webrtc-компонент, НЕ писати новий плеєр.
- Контроли в камера-режимі: пауза/стоп/додому/світло — мапити на наявні `act(e, "pause"|"cancel"|...)`. Якщо якоїсь дії нема — показати лише доступні. Знизу «← Назад до статусу» → `setCamOpen(false)`.
- Камеру показувати лише коли принтер її має (webcam URL / go2rtc доступний). Немає → не рендерити кнопку ▤.

### 4. Теги з `+`
- Рядок: label «Теги» + `.tag-add` (кнопка `+`, наявний потік додавання тегів якщо є, інакше no-op-заглушка з TODO) + чипи.
- Кольорові чипи (`loaded_filaments`) = **заповнені** (`background: color`, білий текст), як у mockup `.tag.color`. Модель/матеріал = outline-чипи.

### 5. Прогрес + ETA + черга
- `.progress` 4→6px, `border-radius: full`, fill = колір стану.
- Під баром рядок: `{pct}% · {eta} · {finish}` моно, `font-variant-numeric: tabular-nums`.
- Позиція в черзі `N / M` праворуч від файлу — **лише якщо дані реально є** в типі `Printer`/plan; немає → пропустити (не вигадувати).
- «Гріє стіл» як підстан коли гріється і pct≈0.
- Стан `awaiting_bed_clear`/`needsClearBed` → зелена кнопка «Забрати стіл» (наявний `act(e, "clear-bed")`).

## Правила (з AGENTS.md / rules)
- Компонент лишається в `printers/`, імпорт `@/components/printers/...`.
- Тільки токени `var(--*)`, обидві теми (`.dark`), ніякого `prefers-color-scheme`.
- Стани через class-модифікатори (як наявний `TONE_CLASS`).
- `useRef` для in-flight guard дій (не `useState`).
- Нові тексти — в обидва `uk.ts` і `en.ts`.

## Валідація
```bash
cd frontend && bun run lint && bun run build   # типи + білд мають пройти
# візуально: 320/768/1440, світла+темна, стани printing/paused/error/collect/idle/offline, тумблер камери
```

## Деплой (за конвенцією проєкту)
```bash
# lowercase-коміт (без Co-Authored-By / згадок Claude — див. memory feedback_commit_style)
git add -A && git commit -m "feat: банер стану + камера в картці принтера на дашборді"
git push origin main            # Dokploy авто-білдить на push у main
gh run list --limit 3           # ПЕРЕВІРИТИ що CI зелений — інакше Deploy тихо скіпнеться
```
Якщо CI червоний — полагодити, поки не зелений. Підтвердити, що Dokploy підхопив деплой.

## Acceptance
- [ ] Банер зі смугою зверху в усіх станах, обидві теми.
- [ ] Стек ⚙▤✛; ▤ перемикає камеру в картці з наявного go2rtc-стріму.
- [ ] Теги з `+` і заповненими кольоровими чипами.
- [ ] Прогрес 6px + ETA-рядок; «Забрати стіл» для завершених.
- [ ] `PrinterPhotoCard` синхронний із новим виглядом.
- [ ] `bun run build` + `lint` зелені; CI зелений; задеплоєно.
