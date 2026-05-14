# printfarm

Платформа управління 3D-фермою: моніторинг принтерів (SimplyPrint + Snapmaker U1 через Moonraker + Bambu Lab через Cloud MQTT), план друку, центральне сховище нарізок, task manager, облік пластику. Telegram-бот для сповіщень. Інтеграція з OrcaSlicer через OctoPrint API.

## Стек

- **Backend:** FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL 16 + APScheduler
- **Frontend:** Next.js 16 (App Router) + TypeScript + Tailwind v4 + Bun
- **Auth:** JWT, ролі `admin` / `operator` / `manager`
- **Bot:** `python-telegram-bot` 21+ (вбудований у FastAPI lifespan)
- **Інтеграції:** SimplyPrint API, Moonraker REST, Bambu Lab Cloud (MQTT + FTPS), OctoPrint API shim для слайсерів
- **Деплой:** Windows + NSSM, Cloudflare Tunnel + Access

## Структура

```
backend/    FastAPI + Alembic + дані файлів (data/gcodes/)
frontend/   Next.js (App Router)
docs/       Архітектурні нотатки
```

## Перший запуск (macOS / dev)

### 1. Postgres

```bash
docker compose up -d
```

### 2. Backend

```bash
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# відредагуй ADMIN_EMAIL / ADMIN_PASSWORD / SECRET_KEY

alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Перевір:
- `http://localhost:8000/api/health` → `{"ok": true}`
- `http://localhost:8000/docs` → Swagger UI
- `POST /api/auth/login` з `{email, password}` адміна → `access_token`

### 3. Frontend

```bash
cd frontend
bun install
bun run dev   # :3000
```

> Tailwind v4: після зміни `globals.css` обов'язково перезапусти dev server.

## Можливості

### Моніторинг
- Дашборд із живим статусом принтерів (SimplyPrint + Moonraker + Bambu MQTT), оновлення кожні 30с
- Сторінка принтера з телеметрією (температури, прогрес, ETA), оновлення кожні 10с
- Pause/resume/cancel/skip object для Moonraker-принтерів та Bambu Lab

### План друку
- Drag-and-drop задач у щоденний план по принтерах
- Авто-розподіл за сумісністю пластику в слотах

### Файли (центральне сховище нарізок)
- Завантаження `.gcode`, `.gco`, `.bgcode`, `.3mf`, `.gcode.3mf`
- Авто-парсинг slicer-метаданих: типи пластику, кольори по слотах, грами, час друку
- Кольорові свочки на картці файлу
- "Надіслати на принтер" — модаль показує сумісність слотів кольоровими бейджами (✓ збігається / ~ інший тип / ✕ слот пустий)
- **Ремаппінг слотів** — для Moonraker: gcode переписується перед відправкою (`T0`↔`T1` тощо); для Bambu: `ams_mapping` передається в MQTT-команді (без переписування .3mf)

### OrcaSlicer інтеграція
Налаштування у OrcaSlicer → Physical Printer:
- **Host Type:** OctoPrint
- **Hostname:** `http://localhost:8000` (backend)
- **Device UI URL:** `http://localhost:3000` (frontend)
- **API Key:** JWT-токен з браузера (`localStorage.getItem('printfarm_token')`)

Натисни **Print** у Orca → файл прилітає на сервер → автоматично відкривається сторінка `/files` → одразу модаль вибору принтера й ремаппінгу слотів.

### Завдання ферми
Канбан-дошка (todo / в процесі / виконано) з drag-and-drop, дедлайнами, inline quick-add.

### Пластик
Облік залишків, попередження про низькі запаси.

### Telegram-бот
- `/start <code>` — лінкування облікового запису через одноразовий код
- `/план`, `/статус`, `/допомога` — кириличні команди
- 09:00 (Kyiv) автоматично розсилає денний план усім лінкованим користувачам

## Підключення SimplyPrint

`SIMPLYPRINT_API_KEY` і `SIMPLYPRINT_ORG_ID` беруть з `.env`. SimplyPrint-принтери авто-імпортуються в БД при першому виклику `GET /api/printers` — створювати їх вручну не треба.

## Підключення Bambu Lab (P1S, A1, A1 mini)

У `.env` додай облікові дані Bambu Cloud:

```
BAMBU_EMAIL=farm-account@example.com
BAMBU_PASSWORD=your-password
BAMBU_REGION=us                      # us | eu | cn
```

**Або** (рекомендовано при 2FA) — витягни `refresh_token` з конфігу Bambu Studio:
- Windows: `%appdata%\BambuStudio\cloud_user_info.json`
- macOS: `~/Library/Application Support/BambuStudio/cloud_user_info.json`
- Linux: `~/.config/BambuStudio/cloud_user_info.json`

```
BAMBU_REFRESH_TOKEN=<token з файлу>
BAMBU_REGION=us
```

Принтери прив'язані до акаунта автоматично підтягнуться при `GET /api/printers` (як SimplyPrint). Живий стан оновлюється через MQTT.

**Вимоги для надсилання файлів:**
- Сервер повинен бачити IP принтерів по LAN (FTPS :990)
- Файли — лише `.3mf` (Bambu не приймає голий gcode через FTPS+MQTT)
- Access Code принтера заповнюється автоматично з Bambu Cloud

## Підключення Snapmaker U1 (Moonraker)

```bash
cd backend
python -m scripts.seed_u1        # 12 рядків
python -m scripts.seed_u1 6      # N рядків
```

Потім у адмін-панелі пропиши `moonraker_url` для кожного принтера (наприклад `http://192.168.1.50`).

## Деплой (Windows-ферма)

NSSM-сервіси:
- `printfarm-api` — `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- `printfarm-web` — `bun run start` (після `bun run build`)

Postgres: офіційний Windows-інсталер (без Docker Desktop).

Cloudflare Tunnel: `cloudflared service install` → конфіг наводить на `localhost:3000` і `localhost:8000`. Cloudflare Access обмежує доступ за email.

## Сторонні нотатки

- **Python 3.14**: не використовуй `passlib`, `python-jose`, `psycopg-binary` — поламані. Стек: `bcrypt` напряму, `PyJWT`, `psycopg[binary]>=3.3.0`.
- **Chrome блокує `http://192.168.x.x`** з localhost (Private Network Access). Тестуй посилання на Mainsail у Safari або з фермового ПК.
- **Слоти нумеруються з 0 у БД/gcode/API**, з 1 в UI — перетворення лише при рендері.
