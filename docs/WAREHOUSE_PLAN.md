# Warehouse / Production CRM — план модуля

> Другий модуль платформи monofarm. Перший модуль (Printer CRM) — це live-моніторинг та керування принтерами (готовий ~60%). Warehouse — це облік готових виробів, замовлень, складу, собівартості. Аналог Odoo Manufacturing / простий ERP, заточений під 3D-друк.

---

## 1. Архітектура UI: workspace switcher

**НЕ змішувати з Printers в одному сайдбарі.** Різні ментальні моделі, різний tempo, різні юзери.

```
┌─────────────────────────────────────────────┐
│  [🖨 Printers ⇄ 📦 Warehouse]  ← topbar    │
├──────────┬──────────────────────────────────┤
│ Sidebar  │                                  │
│ (модуль) │       Content                    │
│          │                                  │
└──────────┴──────────────────────────────────┘
```

- **Спільне між модулями:** auth, organizations, users, settings, billing
- **Окреме:** routes, sidebar, ментальна модель, дашборди

### Frontend routing
```
src/app/
├── (app)/              # Printer CRM (існуюче)
│   ├── dashboard/
│   ├── printers/
│   ├── tasks/
│   ├── plan/
│   └── files/
└── (warehouse)/        # Warehouse CRM (нове)
    ├── dashboard/
    ├── products/
    ├── orders/
    ├── production/
    ├── stock/
    ├── materials/
    ├── customers/
    └── reports/
```

`(app)` та `(warehouse)` — Next.js route groups, кожна зі своїм `layout.tsx` та власним `Sidebar`. Topbar спільний, з перемикачем модулів.

### Backend routing
```
backend/app/
├── api/
│   ├── (existing: printers, tasks, plan, files…)
│   └── warehouse/
│       ├── products.py        # /api/warehouse/products
│       ├── orders.py          # /api/warehouse/orders
│       ├── stock.py           # /api/warehouse/stock
│       ├── production.py      # /api/warehouse/production
│       ├── customers.py       # /api/warehouse/customers
│       └── reports.py         # /api/warehouse/reports
└── models/
    └── warehouse/
        ├── product.py
        ├── order.py
        ├── stock.py
        ├── customer.py
        └── production_job.py
```

Все в тій самій Postgres БД, тій самій SQLAlchemy `Base`. Розділення лише за іменами таблиць (`warehouse_products`, `warehouse_orders`, …) і модулями коду.

---

## 2. Data Model

### Core entities

#### `Product` (`warehouse_products`)
SKU готового виробу, який ферма друкує і продає.
```python
class Product:
    id, organization_id (FK), created_at
    sku: str              # "VASE-001"
    name: str             # "Геометрична ваза"
    description: str
    photo_url: str | None
    base_price: Decimal   # ціна продажу
    cost_estimate: Decimal  # розрахункова собівартість
    print_time_minutes: int  # очікуваний час друку
    weight_grams: int     # вага виробу
    active: bool
    # зв'язки:
    gcode_file_id: int | None  # FK на існуючий GcodeFile
    bom: list[BomItem]         # bill of materials (філамент)
```

#### `ProductVariant` (`warehouse_product_variants`)
Колір/розмір/матеріал — варіації одного SKU.
```python
class ProductVariant:
    id, product_id (FK), organization_id
    sku_suffix: str       # "-RED" → full sku = "VASE-001-RED"
    name: str             # "Червоний"
    color_hex: str | None
    filament_type: str    # PLA / PETG / ABS
    photo_url: str | None
```

#### `BomItem` (`warehouse_bom_items`) — bill of materials
Скільки якого матеріалу потрібно на 1 одиницю продукту/варіанту.
```python
class BomItem:
    id, product_id | variant_id, organization_id
    filament_color_id: int (FK)  # існуюча таблиця
    grams: Decimal
```

#### `StockLocation` (`warehouse_stock_locations`)
Полиці/коробки/склади. На старті — один дефолтний "Main warehouse".
```python
class StockLocation:
    id, organization_id, name, code
    parent_id: int | None  # для ієрархії (Склад → Полиця → Коробка)
```

#### `StockItem` (`warehouse_stock_items`)
Поточний залишок продукту в локації. Не зберігати в `Product` напряму — багато локацій можливо.
```python
class StockItem:
    id, product_id | variant_id, location_id, organization_id
    quantity: int
    reserved: int   # зарезервовано під замовлення
    available: int  # quantity - reserved (computed)
```

#### `StockMove` (`warehouse_stock_moves`)
Журнал руху товару. Кожна зміна `StockItem.quantity` має `StockMove` запис.
```python
class StockMove:
    id, organization_id, created_at
    product_id | variant_id, location_from_id | None, location_to_id | None
    quantity: int
    reason: enum  # production | sale | return | adjustment | transfer
    reference_id: int | None  # order_id / production_job_id / тощо
    user_id: int (FK)
    note: str
```

#### `Customer` (`warehouse_customers`)
```python
class Customer:
    id, organization_id, created_at
    name: str
    email: str | None
    phone: str | None
    address: str | None
    company: str | None
    notes: str
    # computed: total_orders, total_revenue
```

#### `Order` (`warehouse_orders`)
```python
class Order:
    id, organization_id, created_at
    number: str           # "ORD-2026-0001" auto-generated
    customer_id: int (FK)
    status: enum          # draft | confirmed | in_production | ready | shipped | delivered | cancelled
    due_date: date | None
    total_amount: Decimal # сума замовлення
    paid: bool
    notes: str
    lines: list[OrderLine]
```

#### `OrderLine` (`warehouse_order_lines`)
```python
class OrderLine:
    id, order_id (FK), organization_id
    product_id | variant_id (FK)
    quantity: int
    unit_price: Decimal
    total: Decimal  # quantity * unit_price
```

#### `ProductionJob` (`warehouse_production_jobs`)
**Ключова інтеграція.** Один job = "надрукуй N штук цього SKU для замовлення X".
Job генерує N `PrintTask`-ів (з існуючої моделі) — по одному на кожен запуск принтера.
```python
class ProductionJob:
    id, organization_id, created_at
    order_id: int | None (FK)      # може бути null — друк "на склад"
    product_id | variant_id (FK)
    quantity_total: int             # скільки треба надрукувати
    quantity_done: int              # скільки вже надруковано
    status: enum                    # pending | in_progress | done | cancelled
    print_tasks: list[PrintTask]    # FK з PrintTask.production_job_id
```

### Інтеграція з існуючими таблицями

| Існуюча таблиця | Зміна |
|------------------|-------|
| `Filament` | Залишається як є, але концептуально стає частиною Warehouse → відображається в "Materials" |
| `FilamentColor` | Без змін. Використовується в `BomItem` |
| `PrintTask` | Додати `production_job_id: int | None` FK |
| `GcodeFile` | Без змін. `Product.gcode_file_id` посилається сюди |

---

## 3. Бізнес-логіка (sync між модулями)

### Сценарій: замовлення → друк → склад

```
1. Менеджер створює Order для Customer (3 шт. VASE-001-RED)
   → OrderLine: product=VASE-001, variant=RED, qty=3
   → Order.status = "confirmed"

2. Менеджер натискає "Generate production"
   → створюється ProductionJob(product=VASE-001-RED, qty=3, order_id=…)
   → автоматично резервується матеріал: StockMove(filament -X грам, reserved)
   → Order.status = "in_production"

3. Оператор бачить job у списку Production
   → натискає "Send to printer" → створюється PrintTask на конкретному принтері
   → файл надсилається через існуючий /api/files/{id}/send/{printer_id}
   → PrintTask.production_job_id = N

4. Принтер закінчив друк (Moonraker/Bambu сповіщає)
   → PrintTask.status = "done"
   → ProductionJob.quantity_done += 1
   → StockMove(product +1, reason="production")
   → списується факт. витрачений матеріал

5. Коли ProductionJob.quantity_done == quantity_total:
   → ProductionJob.status = "done"
   → Order.status = "ready"
   → нотифікація менеджеру

6. Менеджер позначає Order як "shipped" → "delivered"
   → StockMove(product -N, reason="sale")
   → Customer.total_orders += 1
```

### Витрати матеріалу: BOM vs реальність
- BOM — це **очікуваний** розхід (з ваги виробу + margin).
- При завершенні друку отримуємо **фактичний** розхід зі слайсера (`filament_meta.used_g` з `GcodeFile`).
- Списуємо факт, не BOM.
- Різниця між плановим і фактичним → у звіт.

---

## 4. UI структура

### Warehouse sidebar
```
┌─ Dashboard       — KPI: продажі, склад, виробництво
├─ Products        — каталог SKU
├─ Orders          — замовлення (kanban / list)
├─ Production      — активні джоби, черга
├─ Stock           — залишки по локаціях
├─ Materials       — філаменти (читає Filament + FilamentColor)
├─ Customers       — клієнти
└─ Reports         — виручка, маржа, обертовість
```

### Ключові screens

**Dashboard:**
- Виручка за період (графік)
- Топ-5 продуктів
- Open orders (count + total $)
- Low stock alerts
- Active production jobs

**Products list:**
- Grid з фото, name, sku, stock count, base_price
- Click → product detail (з варіантами, BOM, історією продажів)

**Orders kanban:**
- Колонки: Draft / Confirmed / In Production / Ready / Shipped
- Drag & drop між статусами

**Production:**
- Список ProductionJob
- Inline-кнопка "Send to printer" → відкриває існуючий SendModal зі списком сумісних принтерів

**Stock view:**
- Таблиця: product × location → quantity
- Filter by low stock, by category

---

## 5. Фази реалізації

### Phase 1: MVP Catalog + Manual Orders (~1.5 тижні)
**Мета:** менеджер може створити продукти, прийняти замовлення, бачити склад.

- [ ] Моделі: `Product`, `ProductVariant`, `StockLocation`, `StockItem`, `Customer`, `Order`, `OrderLine`
- [ ] Міграція Alembic + дефолтна локація "Main warehouse" при онбордингу
- [ ] API: CRUD для всіх вищезгаданих
- [ ] Frontend route group `(warehouse)` + workspace switcher у topbar
- [ ] Sidebar з 4 пунктами (Products, Orders, Stock, Customers)
- [ ] Products grid + детальна сторінка
- [ ] Orders list + create form (вручну)
- [ ] Stock view (плоска таблиця)
- [ ] Customers list

**Чого нема:** автоматичної інтеграції з принтерами, BOM, звітів.

### Phase 2: Production integration (~1.5 тижні)
**Мета:** Order → автоматично PrintTask → списання матеріалу.

- [ ] Модель `ProductionJob`, додати `production_job_id` у `PrintTask`
- [ ] Модель `BomItem` + UI для редагування BOM у Product
- [ ] Endpoint `POST /api/warehouse/orders/{id}/produce` → створює `ProductionJob`
- [ ] Production page (список jobs + "Send to printer" reuse existing flow)
- [ ] Hook у завершенні PrintTask: оновити `ProductionJob.quantity_done`, створити `StockMove`
- [ ] Автоматичне списання філаменту по факту (з `filament_meta`)
- [ ] Connect `Filament` page під "Materials" в warehouse sidebar (з оновленим UI)

### Phase 3: Costing & Reports (~1 тиждень)
**Мета:** менеджер бачить маржу і прибутковість.

- [ ] Cost calculator: material + machine_time × rate + electricity
- [ ] Settings: machine hourly rate, kWh price
- [ ] Auto-update `Product.cost_estimate` коли змінюється BOM або rates
- [ ] Reports page: виручка / cost / маржа за період
- [ ] Sales by product / by customer
- [ ] Stock valuation

### Phase 4: Advanced (later)
- Multi-location stock + transfers
- Reservations / backorders
- Returns / refunds
- Barcode scanning (мобілка)
- Stripe integration для прийому оплат
- Customer portal (B2B клієнти бачать свої замовлення)
- Public catalog (як Etsy-store)

---

## 6. Технічні рішення

| Питання | Рішення |
|---------|---------|
| Окрема БД для warehouse? | **НІ** — та сама. Префікс `warehouse_` у table names. Однакові org_id |
| Окремий backend сервіс? | **НІ** — той самий FastAPI app. Окремі роутери під `/api/warehouse/*` |
| Decimal для грошей | Так — `Numeric(10, 2)` в Postgres, `Decimal` в Python |
| Currency | На v1 — одна валюта на org (`Organization.currency_code = "UAH"`). Multi-currency — пізніше |
| Auto-generated order numbers | `ORD-{YEAR}-{seq}`, seq per organization |
| Soft delete | Так для `Product`, `Customer`, `Order` (поле `archived_at`) |
| Тести | Той самий `printfarm_test` Postgres |

---

## 7. Що НЕ робити в MVP

- ❌ Не робити multi-warehouse / transfers (одна локація вистачить)
- ❌ Не робити складну ієрархію категорій продуктів (плоский список + tags)
- ❌ Не робити purchase orders / supplier management (це окремий ERP-модуль)
- ❌ Не робити accounting / invoicing PDF (просто статус "paid")
- ❌ Не робити власну CRM-pipeline для leads (Customer = тільки той, у кого є замовлення)

---

## 8. Прийняті рішення (2026-05-17)

| Питання | Рішення | Імплікації |
|---------|---------|------------|
| Клієнти | **B2C + B2B обидва** | `Customer.type: enum(individual\|business)`, додаткові поля для B2B: `company_name`, `vat_number`, `billing_address` ≠ `shipping_address` |
| Валюта | **Multi-currency з початку** | `Organization.currencies: list[str]` (enabled currencies), `Product.prices: list[ProductPrice]` (по валютах), `Order.currency_code` фіксується на момент створення |
| Print mode | **Both: to-order + to-stock** | `ProductionJob.order_id: int \| None` (nullable). `StockItem.reserved` для зарезервованих під orders. Якщо order на SKU зі стоком ≥ qty → пропустити production, лише reserve |
| Storefront | **Internal-only (MVP)** | Жодних публічних роутів. Менеджер сам вводить orders. Storefront — Phase 4+ |
| Roles | **Permissions per module** | На `User`: `can_access_printers: bool`, `can_access_warehouse: bool`, `can_view_finance: bool`. Дефолти від `role` (admin = всі true, operator = printers тільки) |
| Notifications | **Telegram only** | Reuse existing `telegram_bot.py`. `Customer.telegram_chat_id: int \| None` + magic-link linking (як для User). Order status change → автоматичне повідомлення |

### Як це впливає на data model

**Додати:**
```python
class Customer:
    # …попередні поля…
    type: enum  # individual | business
    company_name: str | None
    vat_number: str | None
    billing_address: str | None
    shipping_address: str | None
    telegram_chat_id: int | None
    telegram_link_code: str | None  # для magic-link

class ProductPrice:  # NEW
    id, product_id | variant_id (FK), organization_id
    currency_code: str  # "UAH", "USD", "EUR"
    amount: Decimal

class Order:
    # …попередні поля…
    currency_code: str  # фіксується при створенні

class StockItem:
    # +reserved: int — кількість зарезервована під confirmed orders
    # available = quantity - reserved
```

**Зміни в `Organization`:**
```python
currencies: list[str] = ["UAH"]   # enabled currencies; default UAH
default_currency: str = "UAH"
```

**Зміни в `User`:**
```python
can_access_printers: bool = True
can_access_warehouse: bool = False  # дефолт лише для існуючих юзерів
can_view_finance: bool = False      # фінанси/ціни/маржа
```
При створенні нового user через UI — чекбокси.

### Telegram notifications flow

1. Customer створюється менеджером, отримує `telegram_link_code`
2. Менеджер копіює link `https://t.me/BOT?start=<code>` і шле клієнту
3. Клієнт відкриває → бот лінкує `telegram_chat_id` до Customer
4. Хук `Order.status_changed` → `telegram_bot.send(chat_id, "Ваше замовлення #ORD-2026-0001 готове")`

Стани, які тригерять notification: `confirmed`, `in_production`, `ready`, `shipped`, `delivered`.

### Storefront в майбутньому (Phase 4+)
Не робимо зараз, але data model має бути готовий: `Product.active`, `Product.photo_url`, `Product.description` вже передбачені.
