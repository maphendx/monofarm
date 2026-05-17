# monofarm — повний брифінг для Claude агента

> Документ описує проект станом на **2026-05-17**. Читай перед будь-якою роботою над кодом.

---

## 1. Що це за продукт

**monofarm** — SaaS-платформа для управління 3D-фермами. Два модулі:

1. **Printer CRM** (~70% готово) — live-моніторинг принтерів, завдання на друк, план дня, Telegram-боти, filament inventory. Аналог SimplyPrint.
2. **Production/Warehouse CRM** (~5% готово) — облік готових виробів, замовлення, склад, собівартість. Аналог мінімального Odoo для 3D-друку. Детальний план: `docs/WAREHOUSE_PLAN.md`.

**Перший клієнт = сам власник**: ферма ~32 принтери. Платить SimplyPrint $119/міс — monofarm має коштувати дешевше і давати більше.

**Мова коду:** Python 3.14 (backend), TypeScript (frontend).  
**Мова UI:** переважно українська.  
**Засновник:** Україна, Львів.

---

## 2. Стек

### Backend
| Компонент | Технологія |
|-----------|-----------|
| Framework | FastAPI (async) |
| DB | PostgreSQL 16 (SQLAlchemy 2, `Mapped` style) |
| Migrations | Alembic (`0001`..`0015`) |
| Auth | PyJWT + bcrypt (НЕ passlib/python-jose — зламані на Python 3.14) |
| HTTP bearer | `HTTPBearer` (не OAuth2PasswordBearer) |
| Scheduler | APScheduler (30s print tracker, 09:00 Kyiv daily report) |
| Telegram | python-telegram-bot 21+ |
| Bambu MQTT | paho-mqtt |
| Printer HTTP | httpx (async) / requests (sync via to_thread) |
| Settings | pydantic-settings (.env file) |

### Frontend
| Компонент | Технологія |
|-----------|-----------|
| Framework | Next.js 16 App Router |
| Styling | Tailwind v4 (перезапуск dev server після globals.css!) |
| Runtime | Bun |
| Dark mode | class-based `.dark` (custom-variant в globals.css) |
| Icons | SVG inline (heroicons-style, НЕ emoji) |
| HTTP client | `lib/api.ts` — інжектить JWT з localStorage |

### Інфраструктура
- Docker Compose: PostgreSQL 16 на :5432
- Agent: Python агент на Raspberry Pi (WebSocket тунель до сервера)

---

## 3. Структура проекту

```
monofarm/
├── backend/
│   ├── app/
│   │   ├── api/           # FastAPI роутери
│   │   │   ├── auth.py          # POST /api/auth/login, /register
│   │   │   ├── printers.py      # CRUD + live status + control
│   │   │   ├── tasks.py         # PrintTask CRUD
│   │   │   ├── farm_tasks.py    # FarmTask CRUD
│   │   │   ├── filaments.py     # Filament inventory
│   │   │   ├── filament_colors.py
│   │   │   ├── files.py         # GcodeFile upload/send
│   │   │   ├── plan.py          # Daily plan (PlanEntry)
│   │   │   ├── users.py         # User management
│   │   │   ├── orgs.py          # Org registration + settings
│   │   │   ├── billing.py       # Lemon Squeezy / Paddle billing
│   │   │   ├── agent.py         # WebSocket endpoint for local agent
│   │   │   ├── octoprint.py     # OctoPrint API shim (for OrcaSlicer)
│   │   │   ├── analytics.py     # Usage stats
│   │   │   ├── history.py       # Print history log
│   │   │   └── deps.py          # get_current_user, get_current_org, require_roles
│   │   ├── models/        # SQLAlchemy models
│   │   │   ├── organization.py  # Organization, OrgPlan, PLAN_LIMITS
│   │   │   ├── user.py          # User, UserRole
│   │   │   ├── printer.py       # Printer, PrinterKind
│   │   │   ├── task.py          # PrintTask, FarmTask
│   │   │   ├── filament.py      # Filament
│   │   │   ├── filament_color.py
│   │   │   ├── gcode_file.py    # GcodeFile
│   │   │   ├── plan.py          # PlanEntry
│   │   │   └── print_history.py # PrintHistory
│   │   ├── services/
│   │   │   ├── bambu.py         # Bambu Cloud HTTP + MQTT
│   │   │   ├── moonraker.py     # Moonraker REST (sync, via to_thread)
│   │   │   ├── tunnel.py        # WebSocket reverse tunnel manager
│   │   │   ├── telegram_bot.py  # PTB 21+ bot
│   │   │   ├── daily_report.py  # 09:00 broadcast
│   │   │   ├── print_tracker.py # APScheduler 30s state tracker
│   │   │   ├── gcode_meta.py    # Parse slicer comments from .gcode/.3mf
│   │   │   ├── scheduler.py     # APScheduler setup
│   │   │   └── bootstrap.py     # Seed default org + admin on startup
│   │   └── core/
│   │       ├── config.py        # Settings (pydantic-settings)
│   │       ├── security.py      # JWT encode/decode, bcrypt
│   │       └── db.py            # SessionLocal, get_db
│   ├── alembic/versions/        # 0001..0015
│   ├── data/gcodes/             # uploaded gcode/3mf files
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── app/
│       │   ├── (app)/           # Printer CRM (authenticated)
│       │   │   ├── dashboard/
│       │   │   ├── printers/[id]/
│       │   │   ├── tasks/
│       │   │   ├── plan/
│       │   │   ├── files/
│       │   │   ├── filament/
│       │   │   ├── history/
│       │   │   ├── analytics/
│       │   │   ├── users/
│       │   │   ├── settings/    # Billing + Bambu creds + Agent + Danger zone
│       │   │   └── setup/       # Printer brand/model setup guide
│       │   ├── login/
│       │   ├── register/
│       │   └── onboarding/
│       ├── components/
│       │   ├── PrinterCard.tsx
│       │   ├── PrinterDetailModal.tsx
│       │   ├── DashboardPet.tsx     # анімований pixel-art ghost mascot
│       │   ├── ThemeToggle.tsx
│       │   ├── Topbar.tsx
│       │   └── plan/
│       └── lib/
│           ├── api.ts           # fetch wrapper з JWT
│           ├── types.ts         # TypeScript типи
│           ├── auth-context.tsx # useUser() hook
│           └── printerLabels.ts # state → label/color mapping
├── agent/
│   ├── monofarm_agent.py        # Python агент (WebSocket клієнт + Moonraker proxy)
│   ├── install.sh               # one-liner installer (venv, no sudo)
│   └── Dockerfile
└── docs/
    ├── WAREHOUSE_PLAN.md        # Детальний план Warehouse модуля
    └── AGENT_BRIEFING.md        # Цей файл
```

---

## 4. Data Model (ключові моделі)

### Organization
```python
class Organization(Base):
    id, name, slug (unique), created_at
    plan: OrgPlan          # free | starter | pro | farm
    payment_customer_id    # Paddle/LS customer ID
    payment_subscription_id
    plan_expires_at
    bambu_email, bambu_password, bambu_refresh_token, bambu_region
```

**PLAN_LIMITS:** free(3p/1u) | starter(10p/3u) | pro(30p/10u) | farm(50p/999u)  
**PLAN_PRICE_USD:** free($0) | starter($19) | pro($49) | farm($99)

### User
```python
class User(Base):
    id, organization_id (FK), email, hashed_password
    role: UserRole         # admin | operator | manager
    is_active: bool
    telegram_chat_id, telegram_link_code
    # permissions (TODO: add can_access_printers/warehouse/finance)
```

### Printer
```python
class Printer(Base):
    id, organization_id (FK), name, kind: PrinterKind
    # PrinterKind: snapmaker_u1 | bambu | other (simplyprint видалено)
    moonraker_url          # для Klipper/Moonraker
    bambu_dev_id, bambu_access_code, bambu_dev_ip, bambu_model
    manual_status, manual_job, manual_eta_minutes  # для "other"
    loaded_filaments: JSONB  # [{slot, color, type, color_name}] — 0-based!
    sort_order: int
```

### Інші
- `PrintTask` — завдання на друк. `filament_meta: JSONB` (types, colors, used_g, estimated_minutes)
- `FarmTask` — організаційне завдання (не пов'язане з принтером)
- `PlanEntry` — printer × task × date (план дня)
- `Filament` — інвентар нитки (grams_remaining, min_grams)
- `GcodeFile` — файли (stored_name = UUID на диску, filament_meta з парсингу)
- `PrintHistory` — лог завершених принтів (auto-tracked)

---

## 5. Критичні конвенції

### Slots: завжди 0-based в БД і API
- `loaded_filaments[0]` = Slot 1 в UI
- `slot_map: {0: 1, 1: 0}` — API для переставлення слотів
- Конвертація 0→1 тільки при рендерингу

### Moonraker URL normalization
```python
url = _api_base(user_url)  # strips path and ?printer= query params
```
Завжди через `_api_base()` перед HTTP-запитом.

### Printer states (уніфіковані)
`idle | printing | paused | operational | error | offline | unknown`  
+ transient: `pausing | resuming | cancelling`

### JWT
- Payload: `{sub: user_id, role, org_id, exp}`
- Bearer token у заголовку для API
- `?token=` query param для WebSocket і camera stream (img тег не може слати заголовки)

### Python 3.14 заборони
- НЕ використовувати: `passlib`, `python-jose`, `psycopg-binary` (pinned)
- Використовувати: `bcrypt` напряму, `PyJWT`, `psycopg[binary]>=3.3.0`

### Bambu
- Google/email-code акаунти: username з префіксом `u_`
- Зберігати `accessToken`, не `refreshToken`
- Profile API для отримання `user_id`
- MQTT: `device/{dev_id}/report` → `_state_cache[dev_id]`
- AMS трейдані: `ams.ams[N].tray[M]` в MQTT report

### Moonraker caching
- `_status_cache` (10s TTL), `_meta_cache` (300s TTL)
- Після pause/resume/cancel: `_status_cache.pop(url)` для примусового оновлення

### Local Agent (тунель)
- Агент на Pi підключається до `/api/agent/connect?token=<jwt>` (WebSocket)
- `services/tunnel.py` маршрутизує Moonraker-запити через WS
- `GET /api/agent/status` — перевірка підключення
- Файли агента сервуються з `GET /agent/{filename}` (monofarm_agent.py, install.sh, Dockerfile)

### 3MF files
- `.gcode.3mf` — подвійне розширення
- `"".join(path.suffixes)` — зберігати повне розширення
- `parse_gcode()` перевіряє `.3mf` в `path.suffixes` і відкриває як ZIP

---

## 6. Підписка і білінг

**Статус:** код написаний, білінг НЕ активний (Paddle верифікація не завершена).

**Платіжний провайдер: Paddle** (Merchant of Record, підтримує Україну)  
- Stripe: заблокований для UA
- Lemon Squeezy: теж заблокований (використовує Stripe для виплат)
- Поточний код у `billing.py` написаний під Lemon Squeezy API — потребує переписки під Paddle

**Для верифікації Paddle потрібно:**
1. Публічний домен (ще не розгорнуто)
2. Сторінки: `/pricing`, `/terms`, `/privacy`, `/refund` — ще не створені

**Планові ціни:**
| Plan | Printers | Users | Price |
|------|----------|-------|-------|
| Free | 3 | 1 | $0 |
| Starter | 10 | 3 | $19/mo |
| Pro | 30 | 10 | $49/mo |
| Farm | 50 | ∞ | $99/mo |

**Майбутнє:** Estonia OÜ → Stripe (тоді лише `billing.py` переписується).

---

## 7. Що НЕ зроблено (пріоритетна черга)

### Потрібно для MVP launch
- [ ] Paddle верифікація (потрібен домен + 4 сторінки)
- [ ] `billing.py` переписати під Paddle API (зараз LemonSqueezy формат)
- [ ] Production deploy (Docker, домен, SSL, Nginx/Caddy, backup)
- [ ] `/pricing`, `/terms`, `/privacy`, `/refund` сторінки в Next.js
- [ ] Email verification при реєстрації
- [ ] Password reset flow
- [ ] Org settings UI — `PUT /api/orgs/me/settings` через фронтенд (налаштування Bambu)
- [ ] User permission flags: `can_access_printers`, `can_access_warehouse`, `can_view_finance` на моделі User (заплановано для warehouse)

### Backend інтеграції (після MVP)
- [ ] OctoPrint (`services/octoprint.py`) — найвищий пріоритет
- [ ] PrusaLink (`services/prusalink.py`)
- [ ] Elegoo Cloud
- [ ] Bambu LAN-only (без cloud)

### Warehouse модуль (Phase 1 — ~2 тижні)
Детально в `docs/WAREHOUSE_PLAN.md`. Рішення:
- B2C + B2B обидва типи клієнтів
- Multi-currency з v1
- Print-to-order + print-to-stock
- Internal-only (без public storefront в MVP)
- Permissions per module
- Telegram-нотифікації клієнтів
- Workspace switcher у topbar (окремий від Printer CRM)

Нові моделі: `Product`, `ProductVariant`, `BomItem`, `StockLocation`, `StockItem`, `StockMove`, `Customer`, `Order`, `OrderLine`, `ProductionJob`

---

## 8. UI/UX правила (НЕ порушувати)

- **Без emoji** — тільки SVG icons (heroicons-style, 24×24, strokeWidth=1.6-1.8)
- **Sidebar** (collapsible, CSS-only, w-14→w-220px) — не повертати topbar
- **Dashboard card:** click body → navigate, gear icon (hover) → modal
- **AmsDisplay** — код є, але НЕ рендерити (двічі відкочували). Чекає інтеграції з filament assignment
- **ControlPanel** — collapsible accordion внизу printer detail page
- **Settings** → modal (gear icon в header), не inline card
- **Dark mode** — class-based `.dark`, скрипт у `<head>` запобігає flash
- **Tailwind v4** — перезапускати `bun run dev` після змін в `globals.css`

---

## 9. ENV variables (backend/.env)

```env
DATABASE_URL=postgresql+psycopg://printfarm:printfarm@localhost:5432/printfarm
SECRET_KEY=<random 32+ chars>
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<password>

# Bambu Lab (опціонально — без них Bambu принтери не з'являться)
BAMBU_EMAIL=
BAMBU_PASSWORD=
BAMBU_REFRESH_TOKEN=
BAMBU_REGION=eu   # us | eu | cn

# Telegram (опціонально)
TG_BOT_TOKEN=
TG_REPORT_CHAT_ID=

# URLs
FARM_PUBLIC_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000

# Billing — Paddle (після верифікації)
LMSQ_API_KEY=         # тимчасово LS формат, переписати під Paddle
LMSQ_WEBHOOK_SECRET=
LMSQ_STORE_ID=
LMSQ_VARIANT_STARTER=
LMSQ_VARIANT_PRO=
LMSQ_VARIANT_FARM=
```

---

## 10. Команди для запуску

```bash
# Backend
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
docker compose up -d          # PostgreSQL
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
bun install
bun run dev    # :3000 — перезапуск після globals.css змін!

# Тести
cd backend
pytest                        # всі тести (потрібен printfarm_test DB)
pytest tests/unit -q          # unit тести (без DB)
ruff check .                  # lint

# Агент (тест)
curl http://localhost:8000/agent/install.sh | bash -s -- \
  --token <JWT> --server http://localhost:8000
```

---

## 11. Бренд і дизайн

- **Назва:** monofarm
- **Mascot:** pixel-art ghost (8px unit, 14×11 units) — `frontend/public/logo.svg`, `logo-icon.svg`
- **Design system:** industrial-minimalist (Bambu Studio × Linear)
- **Кольори:** нейтральні (neutral-900/100 для акцентів), blue=printing, green=ok, amber=warn, red=error
- **Числа:** monospace шрифт для температур/відсотків
- **Кнопки:** mechanical/tactile feel (shadow, crisp borders)
- **Заборонено:** градієнти, blur, purple gradients, generic fonts (Inter/Arial/Roboto)

---

## 12. Поточний стан міграцій

| # | Назва | Що робить |
|---|-------|-----------|
| 0001 | initial | Base tables |
| 0002 | telegram_fields | User.telegram_chat_id |
| 0003 | moonraker_and_files | Moonraker URL, GcodeFile |
| 0004 | filament_meta | PrintTask.filament_meta JSONB |
| 0005 | printer_sort_order | Printer.sort_order |
| 0006 | printer_groups | PrinterGroup |
| 0007 | printer_loaded_filaments | Printer.loaded_filaments JSONB |
| 0008 | filament_colors | FilamentColor |
| 0009 | gcode_files | GcodeFile storage |
| 0010 | gcode_file_meta | GcodeFile.filament_meta |
| 0011 | bambu_printers | Bambu fields на Printer |
| 0012 | organizations | Organization + org_id на всіх таблицях |
| 0013 | print_history | PrintHistory table |
| 0014 | billing | plan, payment_* на Organization |
| 0015 | rename_payment_fields | stripe_* → payment_* |
