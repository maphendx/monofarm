# Monofarm — Roadmap + Build Playbook

**Оновлено:** 2026-05-29 · Аналіз: [RELEASE_AUDIT.md](RELEASE_AUDIT.md)

> Це не просто список — це **playbook для виконання**. Для кожної задачі: які файли, який підхід, які граблі, як перевірити, що блокує (я vs користувач).
> Майбутній Claude: читай розділ «Граблі кодбази» ПЕРЕД тим, як писати код. Ці конвенції вистраждані — порушиш → зламаєш облік/гроші.

---

## North Star — що означає «найкращий продукт» тут

Monofarm — не «ще один моніторинг принтерів». **Moat (перевага) — це ERP-шар поверх ферми.** SimplyPrint/інші вміють у принтери; ніхто не з'єднує `друк → готовий товар → продаж → фінанси` в один цикл для дрібного виробника. Це і є продукт.

**Тому правило пріоритетів:** усе, що зміцнює цикл «друк→товар→гроші» — важливіше за чергову фічу моніторингу. Цілісність конвеєра > кількість функцій.

**Інженерні принципи (тримати завжди):**
- Мінімум коду, що вирішує задачу. Жодних спекулятивних абстракцій.
- Хірургічні зміни — чіпати тільки потрібне, не «покращувати» сусіднє.
- Реюз перед створенням: спершу глянь `src/components/<subfolder>/` і класи в `globals.css` (`.btn`, `.badge`, `.ds-table`, `.surface`).
- Кожна зміна стоку йде через `_apply_movement`. Ніколи не мутуй `StockEntry` напряму.
- Питай, коли бракує контексту (особливо рішення продукту/контент) — не вгадуй.

---

## Порядок збірки (чому саме так)

1. **Етап 1 (цілісність)** — перший, бо розрив «друк↔товар» робить продукт схожим на два застосунки. Усе інше будується поверх цілісного двигуна.
2. **Етап 2 (реклама)** — щойно двигун цілісний, можна вести трафік.
3. **Етап 3 (полірування)** — паралельно з 2, бо незалежне від бекенду.
4. **Етап 4 (стійкість+ERP-дірки)** — перед масштабуванням трафіку.

**Реалістичний таймінг зі мною:** увесь код ~1-2 сфокусовані дні. «Розтягують» не я, а зовнішні залежності (акаунти, контент, тестування на реальних принтерах) — позначені `⛔ потрібен користувач`.

---

## Етап 1 — Функціональна цілісність: ферма = склад 🔴

**Мета:** завершив друк на фермі → товар з'явився на складі, собівартість оновилась, видно в аналітиці. Без ручного дублювання в партіях.

**Ризик: ВИСОКИЙ** — чіпає stock ledger + AVCO (гроші/залишки). Робити з тестами. Спершу прочитати `_apply_movement`, `_update_avco`, `_check_and_auto_replenish` у `api/warehouse.py`.

### 1.1 — `PrintTask.product_id`
- **Файли:** `models/task.py` (додати `product_id: Mapped[int|None] = mapped_column(ForeignKey("wh_products.id", ondelete="SET NULL"), nullable=True, index=True)`), нова Alembic-міграція, Pydantic-схеми в `api/tasks.py`, UI в `components/plan/CreateTaskModal.tsx`.
- **Підхід:** product опційний — не кожен друк це товар на продаж (прототипи, тести). Combobox вибору SKU (реюз патерн з `CellCombobox`/products search).
- **Граблі:** міграція — sequential naming, не редагувати застосовані. `ondelete="SET NULL"` (не CASCADE) — видалення товару не має вбивати історію завдань.
- **Перевірка:** створив завдання з товаром → `product_id` зберігся; без товару — теж ок.

### 1.2 — Лінк `ProductionBatch` ↔ ферма
- **Файли:** `models/warehouse.py` (батч уже має `order_id`; додати опц. зв'язок із завданнями друку — або `print_task_id` на батчі, або `batch_id` на `PrintTask`).
- **Підхід:** обрати один напрямок. Простіше: `PrintTask.batch_id` (одна партія = багато завдань друку на різних принтерах).
- **Граблі:** не ламати наявний флоу ручних партій — лінк опційний.

### 1.3 — Авто-`PRODUCTION_IN` при завершенні друку 🎯 (ядро етапу)
- **Файл:** `api/tasks.py` — хендлер завершення завдання (~рядок 300, де вже списується філамент).
- **Підхід:** після підрахунку `pieces_ok`, якщо `task.product_id` заданий:
  1. визначити склад готової продукції (потрібна логіка «дефолтний finished-goods warehouse» для орг — додати поле або брати перший `physical`);
  2. `_update_avco(product_id, pieces_ok, unit_cost, db)` **ПЕРЕД** рухом;
  3. `_apply_movement(PRODUCTION_IN, qty=pieces_ok, warehouse_to=...)`.
- **Граблі:** ⚠️ **порядок критичний** — AVCO рахується ДО `_apply_movement` (інакше зіпсується історія собівартості). Брак (`pieces_defective`) НЕ оприбутковувати (опційно — `WRITE_OFF`/`DEFECT` рух). `_check_and_auto_replenish` НЕ викликати тут (це не SALE/PRODUCTION_OUT).
- **Перевірка:** інтеграційний тест — завершив завдання на 10 шт → `StockEntry.quantity += 10`, рух `PRODUCTION_IN` створено, `cost_price` оновлено.

### 1.4 — Реальна собівартість друку → AVCO
- **Файл:** `api/tasks.py` + `_calc_cost`/`_update_avco` у `warehouse.py`.
- **Підхід:** `unit_cost` для AVCO = матеріал (`material_cost_uah`/pieces) + електрика + праця (тарифи з `org.electricity_rate`/`org.labor_rate`). Зараз `material_cost_uah` лишається тільки на завданні — провести його в `Product.cost_price`.
- **Граблі:** ділення на `pieces_ok` (не на `quantity`!) — собівартість на реально придатну штуку. Захист від `pieces_ok == 0`.

### 1.5 — «У виробництво» з замовлення
- **Файл:** `api/warehouse.py` (`ProductionBatch.order_id` уже існує) + UI в `warehouse/orders/page.tsx`.
- **Підхід:** кнопка на замовленні → створює партію(ї) на бракуючу к-сть (`desired − available`) для позицій без достатнього залишку.
- **Граблі:** реюз `CreateBatchModal`. Не створювати партію якщо залишку достатньо.

**✅ Готово коли:** друк партії → залишок готової продукції виріс автоматично + `cost_price` оновився + видно в аналітиці складу. Цикл «замовлення→друк→товар→продаж→гроші» суцільний.

---

## Етап 2 — Блокери реклами 🔴

### 2.1 — Лендінг на `/`
- **Файл:** `frontend/src/app/page.tsx` (зараз редірект). Винести редірект логіку: лендінг для гостя, `/dashboard` для залогіненого.
- **⛔ потрібен користувач:** меседж/позиціонування, ціни, скріншоти. Я зроблю структуру+верстку; контент — рішення продукту.
- **Підхід:** hero + value prop (наголос на ERP-цикл, не моніторинг) + фічі + ціни (з `OrgPlan`) + CTA «Спробувати безкоштовно» → `/register`.

### 2.2 — `/terms` + `/privacy`
- **Файли:** `app/terms/page.tsx`, `app/privacy/page.tsx`.
- **⛔ потрібен користувач:** юр-реквізити компанії. Я дам шаблон під Lemon Squeezy + GDPR; фінальний текст — юрист/користувач.
- **Чому блокер:** Lemon Squeezy, Google/Meta Ads не пускають без Privacy URL.

### 2.3 — GA4 + Meta Pixel
- **Файли:** `app/layout.tsx` (скрипти), util для подій.
- **⛔ потрібен користувач:** GA4 Measurement ID, Meta Pixel ID.
- **Підхід:** події `sign_up`, `start_trial`, `upgrade_plan`. Через `next/script` (strategy="afterInteractive").

### 2.4 — Email + скидання паролю
- **Файли:** `services/email.py` (новий), `api/auth.py` (ендпоінти `forgot-password`/`reset-password`), фронт `app/forgot-password`, `app/reset-password`.
- **⛔ потрібен користувач:** Resend/SendGrid API-ключ.
- **Граблі:** токен скидання — підписаний JWT з коротким TTL (реюз `core/security.py`, PyJWT). Не світити, чи існує email (anti-enumeration).

**✅ Готово коли:** реклама→лендінг→реєстрація трекається→пароль відновлюється.

---

## Етап 3 — Полірування 🟠

### 3.1 — Toast + ConfirmDialog (замінити 35 нативних діалогів)
- **Файли:** додати `sonner`; новий `components/ui/ConfirmDialog.tsx` (на базі `components/ui/Modal`). Замінити `alert()/confirm()` у 16 файлах (список у RELEASE_AUDIT §2.1).
- **Підхід:** `toast.success/error` замість `alert`; `ConfirmDialog` (промісифікований) замість `confirm`. Реюз існуючого `Modal`.
- **Граблі:** `Toaster` додати в `app/(app)/layout.tsx`. Не плодити нових модалок — один ConfirmDialog.

### 3.2 — Мобільна верстка
- **Файли:** `app/(app)/layout.tsx` (зараз фікс `pl-14`/`pl-[220px]`, нема брейкпоінтів), `components/layout/Sidebar.tsx`.
- **Підхід:** `<md` — drawer-сайдбар + hamburger у topbar; таблиці складу → горизонтальний скрол або картки на мобільному.
- **⛔ часткова залежність:** візуальні ітерації — кидай скріни, я правлю.
- **Граблі:** Tailwind v4 — **рестарт `bun run dev` після змін `globals.css`**.

### 3.3 / 3.4 — `error.tsx` + `not-found.tsx`
- **Файли:** `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`.
- **Підхід:** дружній екран у стилі застосунку + кнопка «На дашборд»/«Оновити». Дизайн-токени з `globals.css`.

### 3.5 — Empty-states
- **Файли:** dashboard, history, cashflow, production, analytics.
- **Підхід:** іконка + текст + CTA («Додай перший принтер»→`/settings`, «Створи замовлення» тощо). Реюз патерн empty-state із `zones/page.tsx` (там уже є гарний приклад).

### 3.6 — Прибрати `/design-system` з прод-білду
- **Файл:** `app/(app)/design-system/page.tsx` (33KB dev). Видалити або за env-гейтом (`NODE_ENV !== production`).

### 3.7 — Продуктовий onboarding
- **Файл:** наявний `app/onboarding` лише для агента. Розширити: first-run чеклист (додай принтер / створи товар / зроби специфікацію).
- **Підхід:** checklist-картка на дашборді поки порожньо, не блокуючий візард.

**✅ Готово коли:** новий клієнт із телефона бачить охайний цілісний інтерфейс без браузерних діалогів і голих екранів.

---

## Етап 4 — Стійкість + дірки ERP 🟡

| # | Задача | Файли / нотатки |
|---|---|---|
| 4.1 | **Sentry** (бек+фронт) | `main.py` lifespan + `app/layout.tsx`. ⛔ DSN від користувача |
| 4.2 | **Rate-limit** auth | `slowapi` на `/auth/login`,`/auth/register`. По IP |
| 4.3 | **Закупівлі (Purchase Orders)** | Нові моделі `PurchaseOrder`+`PurchaseOrderItem`, приймання → `PURCHASE_IN` через `_apply_movement` (+`_update_avco` ПЕРЕД). Дзеркало sales-Order. UI під `/warehouse` |
| 4.4 | **Термін резерву** | `Order.reserved_until` + APScheduler-job авто-звільнення `reserved_qty`. Реюз `services/scheduler.py` |
| 4.5 | **Мультивалютність** | `Order.exchange_rate`+дата, або прибрати `currency`. Рішення продукту ⛔ |
| 4.6 | Email-верифікація | поверх 2.4 |
| 4.7 | OG-картинка + meta | `app/layout.tsx` metadata, `public/og.png` |
| 4.8 | Валюта UI ↔ бекенд | зараз лише localStorage; синк з `org.currency` |
| 4.9 | Фронт-тести | критичні флоу: login, create order, close batch, complete print→stock |

**✅ Готово коли:** витримує трафік, повний цикл закупівля-виробництво-продаж, резерви не «течуть».

---

## Граблі кодбази (читати ПЕРЕД кодом) ⚠️

**Backend:**
- **Stock ledger:** усі зміни стоку через `_apply_movement(movement, db)`. Ніколи не писати в `StockEntry` напряму.
- **AVCO:** `_update_avco(...)` викликати **ПЕРЕД** `_apply_movement` для вхідних (PURCHASE_IN, PRODUCTION_IN). Неправильний порядок псує собівартість.
- **Auto-replenish:** `_check_and_auto_replenish` тільки після SALE_OUT/PRODUCTION_OUT. НЕ після ADJUSTMENT/ручних.
- **State machines:** Order `new→reserved→shipped→cancelled` (не пропускати стани). Batch `draft→open→closed` (закриття незворотне).
- **Slots:** 0-based усюди (DB, gcode T0..T3, API). UI показує 1-based — конвертувати лише на рендері.
- **Moonraker URL:** завжди через `_api_base(url)` (зрізає path + `?printer=`).
- **Python 3.14:** НЕ `passlib`/`python-jose`/`psycopg-binary`. Тільки `bcrypt`, `PyJWT`, `psycopg[binary]`.
- **Міграції:** sequential naming, ніколи не редагувати застосовані.
- **Org isolation:** кожен запит фільтрувати по `organization_id`. `get_current_org()` авто-даунгрейдить протерміновані плани.

**Frontend:**
- **Компоненти лише в підпапках** (`ui/`,`warehouse/`,`printers/`...). Імпорт `@/components/<subfolder>/<C>` — плоский шлях зламаний.
- **Реюз перед створенням:** перевір список компонентів + класи `globals.css`.
- **Дизайн-токени:** тільки `var(--*)`. Ніколи сирий Tailwind-палітр (`bg-blue-500`) чи hex у layout/state.
- **Tailwind v4:** рестарт dev-сервера після `globals.css`.
- **Dark mode:** клас `.dark`, `dark:` варіант. Ніколи `prefers-color-scheme`.
- **API:** `api<T>(path)` інжектить JWT; для `FormData` НЕ ставити `Content-Type`.
- **Double-submit:** `useRef` inFlight-guard, не `useState`.

**Тести:**
- Окрема БД `printfarm_test`. `pytest tests/unit -q` без БД. Зовнішні сервіси мокаються. Lifespan НЕ виконується в тестах (scheduler/MQTT/TG не стартують).
- Після змін коду: `graphify update .` (без API-вартості).

---

## Стратегія тестування цілісності (Етап 1)

Найризикованіше — облік. Мінімум перед мерджем:
1. Unit: `_update_avco` при змішаних собівартостях.
2. Integration: завершення завдання друку з `product_id` → перевірити `StockEntry.quantity`, рух `PRODUCTION_IN`, `Product.cost_price`.
3. Integration: завершення без `product_id` → сток НЕ змінюється (зворотна сумісність).
4. Edge: `pieces_ok=0`, нема дефолтного складу, видалений товар.

---

## ⛔ Що потрібно від користувача (не моя швидкість)

- Лендінг: меседж, ціни, скріншоти
- Юр-сторінки: реквізити компанії
- Акаунти+ключі: GA4, Meta Pixel, Resend/SendGrid, Sentry DSN, бойові Lemon Squeezy
- Рішення: чи потрібна мультивалютність
- Тестування на реальних принтерах (Snapmaker/Bambu) — не відтворюється кодом
- Візуальні ітерації мобілки (скріни)

---

## Вже зроблено (не чіпати)

Баг доходу в аналітиці (тепер `total_revenue`) · Assembly-мок видалено · пагінація рухів (cursor) · часткова оплата (`/payments`) · live `printed_qty` · тарифи електрика/праця в Settings · sidebar чистий · `/filament` коректний редірект · фільтри-дропдауни на всіх сторінках складу · дворівнева навігація складу.
