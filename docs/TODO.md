# Monofarm — що ще зробити

_Оновлено: 2026-06-15_

---

## 🔴 Баги (зламано зараз)

| # | Проблема | Файл | Деталь |
|---|---|---|---|
| 1 | **Дашборд: «Активні партії» завжди 0** | `warehouse/page.tsx:113` | `filter(b.status === "active")` — такого статусу немає, enum: `draft\|open\|closed`. Виправити на `"open"` |
| 2 | **Дашборд: «Нові замовлення» завжди 0** | `warehouse/page.tsx:115` | `pendingOrders = 0` — захардкоджено, API не викликається |
| 3 | **MONO-500 часті вильоти** | невідомо | клієнтська React-помилка, не видно в логах; потрібен Sentry або тимчасово показати `error.message` у `ErrorScreen` |

---

## 🟠 Чого не вистачає — Склад (порівняно з Ordage)

### Закупівлі (Purchase Orders)
- Немає сторінки `/warehouse/purchases`
- Немає моделі `PurchaseOrder` / `PurchaseOrderItem` в БД
- Є `PURCHASE_IN` рух, але його можна додати тільки вручну через «Рух»
- **Потрібно:** форма закупівлі (контрагент-постачальник + позиції + ціна) → автоматично `_update_avco` → `PURCHASE_IN` по кожній позиції → оновлення балансу контрагента

### Варіанти товарів
- Ordage підтримує варіанти (розмір, колір) в рамках одного товару
- У монофарм кожен варіант — окремий товар із власним SKU
- **Потрібно:** поле `parent_product_id` + вибір атрибутів (розмір S/M/L тощо)

### Документи (Накладні, Рахунки)
- Ordage генерує PDF-накладні і рахунки-фактури
- У монофарм є тільки PDF-ярлики для філаменту
- **Потрібно:** `POST /warehouse/orders/{id}/invoice` → reportlab PDF → завантаження

### Оплата замовлень
- Немає поля `payment_status` (paid/partial/unpaid) на замовленні
- Немає прив'язки `CashTransaction` → `Order`
- **Потрібно:** при оплаті замовлення → автоматично створювати транзакцію + оновлювати баланс контрагента

### Міжскладські переміщення (Transfer)
- Є тип руху `TRANSFER`, але немає окремого UI
- **Потрібно:** форма «Перемістити товар: з складу A → склад B»

### Аналітика собівартості
- Є AVCO і `material_cost_uah` на задачах, але немає зведеної аналітики прибутковості по SKU
- **Потрібно:** сторінка "Revenue – COGS = Gross profit" по кожному товару за місяць

### Баланс контрагентів
- Модель `Counterparty.balance` є, але нема UI де це видно і нема логіки авто-оновлення
- **Потрібно:** при `CashTransaction` з `counterparty_id` → оновлювати `balance`; в UI контрагентів показувати борг / переплату

### Каса — доробки для Sunmi M2
- Немає друку чеку на термопринтер (58мм): `window.print()` + `@media print` CSS
- Немає вібрації при скані: `navigator.vibrate(100)` після успішного `handleScanEnter`
- Немає нумпаду для кількості (замість `<input type="number">` — велика числова клавіатура)

### Повернення товарів
- Є `RETURN_IN` у MovementType, але немає UI для оформлення повернення
- Потрібна кнопка «Повернення» на сторінці замовлення → авто-рух `RETURN_IN` + зміна статусу

### Термін резерву замовлень
- `Order.reserved_qty` блокується при резервуванні, але ніколи автоматично не звільняється
- **Потрібно:** поле `reserved_until: Date` + APScheduler job (щоночі) → авто-зняття резерву

### Assembly Scanner (режим складання)
- Є сторінка `/warehouse/assembly` для менеджера
- Немає мобільного режиму для робітника зі сканером: відскануй QR партії → введи кількість → підтвердь
- **Потрібно:** окремий `/warehouse/assembly/scan` (мобільний, повноекранний)

---

## 🟠 Чого не вистачає — Принт-ферма (порівняно з SimplyPrint)

### AI Failure Detection
- SimplyPrint (Beta): детектує Spaghetti, Warping, Blobbing через камеру
- Configurable: notification threshold (%), action threshold (%), sensitivity (Low–Very High)
- Actions: Do nothing / Cancel / Pause (з Cool hotend, Retract, Lift extruder)
- **У монофарм:** є Telegram-алерти про помилки, але немає AI-аналізу камери

### Автоматичний друк (AutoPrint / Queue matching)
- SimplyPrint: після завершення принту → авто-старт наступного з черги
- Smart matching: bed size, extruder count, material type, nozzle size, material color, temperatures, custom tags
- **У монофарм:** ручне планування через drag-and-drop на `/plan`; немає авто-матчингу

### Staggers Start (розподіл старту)
- SimplyPrint: якщо кілька принтерів стартують одночасно — розкидає старти в часі
- Щоб не завершувались одночасно (не встигнеш очищати)
- **У монофарм:** немає

### Теги на файлах і принтерах
- SimplyPrint: tags на файлах і принтерах → smart queue matching по тегах
- Custom Tags: `printer.custom_tag_attached` event для вебхуків
- **У монофарм:** немає тегової системи

### Gcode Macros бібліотека
- SimplyPrint: Named GCode snippets (reusable library), On cancel/pause/resume hooks, Printer control + Calibration macros
- **У монофарм:** немає; є тільки ручне відправлення команд через Moonraker

### Вебхуки
- SimplyPrint: POST на Discord/Slack/custom URL при `job.started`, `job.done`, `job.failed`
- **У монофарм:** є Telegram-сповіщення, але немає HTTP вебхуків

### Custom Fields
- SimplyPrint: додаткові поля до Maintenance tasks і Filament information (Select, Email, тощо)
- **У монофарм:** немає розширення полів через UI

### Трекінг філаменту (детальний)
- SimplyPrint: per-spool tracking — NFC тег, штрихкод, фізичне місце (Location), прив'язка до принтера/екструдера
- 306 котушок з прогрес-барами (X/Y g залишилось), автоімпорт з Bambu
- **У монофарм:** є `Filament.grams_remaining`, але немає NFC, локацій, прив'язки до конкретного екструдера

### Print Queue Groups
- SimplyPrint: черга організована по групах (наприклад по клієнту), 1-Click Print вибирає принтер авто
- Налаштування: "Process queue group fully before moving to next"
- **У монофарм:** є `PrintTask` kanban, але немає груп черги і автоматичного запуску

### Статистика (розширена)
- SimplyPrint: Cancel reasons (чому скасовано), Printer activity heatmap per day, Cost per job, Filament used per job
- Export print history до CSV
- **У монофарм:** є базова аналітика, але немає причин скасування, heat-map, вартості на задачу, експорту

### Обслуговування (Maintenance)
- SimplyPrint: Templates задач ТО, Schedules (раз на 30/90 днів), Parts inventory (сопла, тефлонові трубки, PEI-листи), Problems log
- **У монофарм:** є `FarmTask` (загальні задачі), але немає прив'язки до конкретного принтера, запчастин, розкладу

### Браузерне розширення
- SimplyPrint: Chrome/Firefox/Edge — надсилає файли з Thingiverse/Printables в 1 клік
- **У монофарм:** є OctoPrint shim для OrcaSlicer, але немає браузерного розширення

### Інтеграції з CAD
- SimplyPrint: Fusion 360, Blender, SketchUp, Tinkercad → пряма відправка на принтер
- **У монофарм:** немає

---

## 🟡 Поліш

| Що | Де | Деталь |
|---|---|---|
| Замінити `alert()` на toast | `cashregister`, `bank-accounts`, `movements`, `orders`, `production` | `useConfirm` і `toast.error` вже є |
| Фільтр по даті на сторінці рухів | `movements/page.tsx` | зараз тільки по типу; потрібен date-range |
| Пошук на сторінці замовлень | `orders/page.tsx` | пошук по номеру/клієнту |
| Дашборд: графік продажів | `warehouse/page.tsx` | зараз нема, є тільки таблиця рухів |
| Дашборд: виручка за сьогодні/місяць | `warehouse/page.tsx` | KPI-картка з сум `SALE_OUT` за cashflow |
| Сторінка аналітики: фільтр по категорії | `analytics/page.tsx` | зараз тільки по товару |
| Видалення складу — guard | `warehouses/page.tsx` | не давати видаляти якщо є stock або рухи |
| Export history до CSV | `history/page.tsx` | SimplyPrint має, ми немає |
| Причина скасування задачі | `PrintTask` | додати поле `cancel_reason`, показувати в history |
| Друк з черги в 1 клік | `/plan` | сейчас треба перетягувати; кнопка "Призначити авто" |

---

## ⛔ Питання до тебе

- Чи потрібен модуль Закупівель — так/ні
- Як рахувати баланс контрагента: тільки через CashTransaction чи через рухи теж
- Що робити з резервом якщо замовлення прострочено — скасовувати авто чи тільки попереджати
- AI Failure Detection — чи є сенс будувати своє (через go2rtc + ML) чи пропустити
- Maintenance module — потрібен чи FarmTask вистачає
