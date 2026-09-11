# План модернізації frontend monofarm

Дата перевірки: 2026-09-11. Статус: Етапи 0-5 реалізовано локально, верифіковано (typecheck, lint, test, build пройдено успішно).

## Ціль

Перейти на TypeScript 7, Bun 1.4 та Next.js 16.3 і застосувати їхні можливості до реальних сценаріїв monofarm: навігації, живих статусів, великих списків, розробки й перевірок. Оновлення інструментів і зміни поведінки інтерфейсу випускати окремими перевірюваними кроками.

## Перевірена вихідна точка

| Компонент | Поточний стан | Ціль першого релізу |
| --- | --- | --- |
| Next.js / eslint-config-next | 16.2.6 / 16.2.6 | 16.3.5 / 16.3.5 |
| TypeScript | package.json: ^5; локально 5.9.3 | Native compiler 7.0.2 |
| Bun | локально 1.4.2; CI: latest; Docker: 1-alpine | 1.4.2 локально, CI та Docker |
| React / React DOM | 19.2.4 | Узгоджений стабільний patch, перевірений на момент виконання; не оновлювати на canary |
| ESLint TypeScript parser | локально 8.59.2 | Сумісний parser; поточний registry latest 8.70.0 підтримує TS <6.1 |

Версії перевірено через npm registry. Перед виконанням повторити перевірку patch-релізів і security advisories у вибраних major/minor лінійках; зафіксувати точні версії й lockfile. Локальний Node — 24.15.0, @types/node задано ^20: узгодити типи з фактично підтримуваним runtime, не додавати глобальні типи без потреби.

Останні перевірки в цій сесії: 67 frontend-тестів пройшли; ESLint — 9 помилок і 180 попереджень. Це вихідний стан, не результат модернізації. Поточний робочий каталог містить значні попередні зміни; їх зберегти й відокремити від міграції.

## Важлива сумісність TypeScript 7

TS 7.0 не має старого JavaScript compiler API. Next 16.3 підтримує перевірку через CLI, але ESLint та старі language-service plugins можуть потребувати TS 6 API.

Кандидат конфігурації за офіційною рекомендацією Microsoft:

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@7.0.2",
    "typescript": "npm:@typescript/typescript6@6.0.2"
  }
}
```

Це TS 7 для `tsc` і сумісний TS 6 API для інструментів, а не повне видалення TS 6. На чистій інсталяції перевірити, що локальний `tsc --version` показує 7.0.2, ESLint завантажує TS 6, а `next build` справді використовує native CLI. Next документує CLI як default у 16.3; сторінка перемикача має experimental-позначку, тому цей шлях окремо перевірити у staging. Не вимикати перевірку типів через `ignoreBuildErrors`.

## Етап 0 — відтворювана база

- Визначити baseline commit і поточний production image; підготувати ізольовану гілку/checkout без втрати попередніх змін.
- Записати версії, результати lint/test/typecheck/build, cold/warm build time, пам'ять контейнера та навігацію dashboard → files → queue → warehouse.
- Встановити, чи `next` фактично запускається Node або Bun: `bun run` сам по собі не доводить runtime дочірнього CLI.
- Визначити бюджет регресій до змін: нуль нових помилок типів/тестів, нуль міжорганізаційних витоків, нуль повторних фізичних команд.

## Етап 1 — Bun і Next, без зміни моделі даних

Файли: frontend/package.json, frontend/bun.lock, frontend/Dockerfile, .github/workflows/ci.yml, документація запуску.

- Закріпити Bun 1.4.2 у CI, обох Docker stages та packageManager. Перевірити доступність потрібного image tag/архітектури; для релізу зберегти digest.
- Оновити Next і eslint-config-next разом до 16.3.5. Зберегти security headers.
- Перевірити React/React DOM, ESLint і транзитивні peer dependencies; не оновлювати всі пакети однією командою latest.
- Перевірити роботу Next явно під Bun, якщо це обраний production runtime; закріпити його в scripts. Node fallback — окремо перевірений артефакт, а не прихована різниця середовищ.
- Виміряти cold/warm Turbopack build. Налаштувати CI build cache із ключами версій/lockfile; не переносити runtime-кеш клієнтських даних між релізами.
- Оцінити standalone output для меншого runtime image окремим кроком після перевірки потрібних assets/native dependencies.

Вихід: відтворювана інсталяція, тестування, production build і запуск Docker; smoke-перевірки автентифікації, thumbnails, файлів і live-статусів.

## Етап 2 — TypeScript 7 та строгі перевірки

Файли: package.json, bun.lock, tsconfig.json, за потреби tsconfig.test.json, eslint.config.mjs, CI.

- Використати TS 6 як діагностичний міст від 5.9: прибрати deprecated flags без постійного ignoreDeprecations; порівняти діагностики з TS 7.
- Встановити native TS 7 і сумісний API для ESLint; перевірити резолюцію aliases у Bun та Linux/Alpine.
- Явно визначити потрібні global types. У проєкті є bun:test, але немає прямої devDependency на Bun types: додати сумісні типи й окрему конфігурацію тестів, якщо потрібно.
- Перевірити rootDir/include, side-effect CSS imports, allowJs, generated Next route types і різницю типізації DOM/React. Не ставити rootDir=src навмання: next.config.ts і згенеровані файли лежать поза src.
- Урахувати, що новий Next CLI checker перевіряє весь tsconfig, включно з тестами; за потреби розділити app/test configs, але обидва перевіряти в CI.
- Додати окремий typecheck script із попередньою генерацією Next types; підтвердити версію native compiler у логах CI.
- Виправити наявні 9 lint errors і ввімкнути обов'язковий lint gate. Сторонній vendor JS виключати тільки вузьким правилом, не вимикати lint для всього frontend.
- Перевірити IDE/LSP: не вважати старий Next TypeScript plugin сумісним із новим сервером автоматично.

Вихід: native TS 7 реально перевіряє застосунок і тести; ESLint і Next build працюють; типова безпека не ослаблена.

## Етап 3 — типізовані маршрути й React Compiler

- Увімкнути typedRoutes; виправити Link/router переходи та helper signatures, не маскувати помилки масовим `as Route`.
- Увімкнути стабільний React Compiler спочатку в annotation mode, із потрібним compiler package.
- Пілоти: картки принтерів, списки файлів, read-only таблиці складу. За профайлером порівняти кількість/вартість рендерів.
- Після пілота перевірити складні області: DnD-календар, SendModal, live subscriptions, refs і замикання callbacks. Зберегти inFlight guards.
- Розширювати охоплення compiler після успішних перевірок; не видаляти весь useMemo/useCallback механічно.

Вихід: маршрути перевіряються типами, compiler реально обробляє вибрані компоненти, взаємодії й live-оновлення не регресували.

## Етап 4 — Instant Navigations і Cache Components

- Підготувати route-level loading/Suspense та серверний каркас сторінок із клієнтськими інтерактивними частинами.
- Пілотувати `cacheComponents: true` і `partialPrefetching: true` в окремій гілці; перевірити всі маршрути, оскільки конфігурація впливає на застосунок загалом.
- Почати зі статичного каркаса files/queue/warehouse та публічних сторінок; виміряти shell navigation окремо від часу отримання свіжих даних.
- Використати Instant Insights і Navigation Inspector для визначення блокуючих ділянок; додати Playwright assertions через instant() для очікуваного каркаса.
- Не показувати cached telemetry як підтверджений поточний стан принтера. Зберегти WebSocket freshness/reconnect semantics.
- Наявна auth-модель читає JWT у localStorage, тому Server Components не можуть просто перенести туди authenticated api(). Перший крок — кешований неперсональний каркас. Для серверного отримання приватних даних потрібен окремий дизайн серверної сесії/BFF з перевіркою org, ролі та відкликання.
- Будь-який кеш приватних даних потребує перевіреної авторизації, namespace організації/прав і правильної інвалідації. Logout, account switch та impersonation перевірити окремо.
- Залишки й фінансові дані після мутації перевіряти на сервері; кеш не є джерелом істини.

Вихід: очікуваний каркас доступний без очікування API, актуальні дані підвантажуються коректно; немає stale-success або чужих даних після зміни акаунта.

## Етап 5 — сучасні взаємодії та інструменти Bun

- `useTransition` — для важких фільтрів/навігації; `useOptimistic` — для безпечних оборотних дій з rollback (наприклад, перейменування або тег).
- Для друку, списання товару й платежів показувати pending до серверного/приладового підтвердження. Не показувати оптимістичне фізичне виконання.
- Ці React APIs не є новими саме в Next 16.3, але їх застосування входить у модернізацію.
- Використати Bun parallel test/task execution для незалежних задач. Спочатку усунути залежність тестів від shared mocks/storage; не паралелити generation/build/typecheck, якщо вони пишуть одні generated files.
- Додати dependency audit і розглядати fixes через review. Перевірити dedupe/prune для lockfile та production image; не застосовувати автоматичні major fixes.
- Використовувати CPU/heap profiling Bun для виміряних проблем. Bun.cron/SQL/S3 не переносити у frontend заради новизни: ці обов'язки вже мають backend-власників.

## Експериментальний контур

Rust React Compiler у Turbopack перевірити окремо після стабільного compiler. Порівняти build time, outputs і browser smoke. Інші experimental опції додавати лише з конкретною метрикою користі, окремим прапорцем і відкатом. Позначка experimental не повинна непомітно перетворитися на обіцянку production-надійності.

## Приймання та випуск

1. Чиста frozen-lockfile інсталяція в Linux image; versions/CLI resolution записані.
2. Lint, app/test typecheck, Bun tests, production build — успішні.
3. Browser smoke: login/logout/account switch, dashboard live update, files/AuthImage, SendModal slot mapping, queue drag, warehouse edit, error/retry, українська/англійська, вузький екран.
4. Tenant cache regression: два акаунти, однакові printer LAN addresses, back/forward, відкриті вкладки, impersonation.
5. Стендові фізичні команди тільки на тестовому обладнанні; замоканий браузерний тест не підтверджує фізичну сумісність.
6. Порівняння cold/warm build, typecheck, пам'яті й навігації на однакових даних та машині. Не обіцяти vendor benchmark speedups для monofarm.
7. Випуск за етапами на staging, потім контрольований production rollout. Старий immutable frontend image зберегти для відкату.
8. Відкат: попередній image/lockfile/config; відключення нових оптимізацій окремо. Якщо пізніше змінюється auth/BFF, потрібен власний сумісний план rollout/rollback.

## Джерела

- https://nextjs.org/blog/next-16-3
- https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli
- https://nextjs.org/docs/app/api-reference/config/next-config-js/reactCompiler
- https://nextjs.org/docs/app/api-reference/config/next-config-js/typedRoutes
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://typescript-eslint.io/users/dependency-versions/
- https://bun.sh/blog/bun-v1.4
- https://bun.sh/blog/bun-v1.4.2
- npm registry metadata: next@16.3.5, eslint-config-next@16.3.5, typescript@7.0.2, @typescript/typescript6@6.0.2, bun@1.4.2, @typescript-eslint/parser@8.70.0.
