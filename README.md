# monofarm

Multi-tenant SaaS для управління 3D print farm: моніторинг принтерів (Snapmaker U1 через Moonraker + Bambu Lab через Cloud MQTT), план друку, центральне сховище нарізок, task manager, облік пластику, warehouse/ERP модуль (продукти, склад, замовлення, виробничі партії, cash flow). Telegram-бот для сповіщень. Інтеграція з OrcaSlicer через OctoPrint API shim. Білінг через Lemon Squeezy.

## Стек

- **Backend:** FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL 16 + APScheduler
- **Frontend:** Next.js 16 (App Router) + TypeScript + Tailwind v4 + Bun
- **Auth:** JWT, ролі `admin` / `operator` / `manager`, multi-tenant `Organization`
- **Cache:** Redis (Upstash) — shared cross-worker; in-process dict fallback
- **Storage:** Cloudflare R2 (S3-compatible) — presigned URLs; local disk fallback
- **Bot:** `python-telegram-bot` 21+, вбудований у FastAPI lifespan
- **Інтеграції:** Moonraker REST, Bambu Lab Cloud (MQTT + FTPS), OctoPrint shim
- **Білінг:** Lemon Squeezy — free / starter / pro / farm
- **Деплой:** Docker Compose (web + worker), Cloudflare Tunnel + Access

## Структура

```text
backend/    FastAPI + Alembic + міграції
frontend/   Next.js (App Router)
agent/      Local agent (farm PC) — Moonraker proxy + Bambu camera tunnel
bruno/      Bruno API collection (всі ендпоінти)
docs/       Архітектурні нотатки і дизайн
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

### 3. Frontend

```bash
cd frontend
bun install
bun run dev   # :3000
```

> Tailwind v4: після зміни `globals.css` обов'язково перезапусти dev server.

### 4. Redis (опціонально, але рекомендовано)

```bash
# macOS
brew install redis && brew services start redis
```

Або Upstash (free tier): [console.upstash.com](https://console.upstash.com) → Create Database → скопіювати `REDIS_URL`.

```env
REDIS_URL=rediss://default:<password>@<host>.upstash.io:6379
```

Без Redis — автоматично падає на in-process dict (коректно, але не cross-worker).

### 5. S3-файлове сховище (опціонально)

Cloudflare R2: безкоштовно до 10 GB. [dash.cloudflare.com](https://dash.cloudflare.com) → R2 → Create bucket → API Tokens → Create (Object Read & Write).

```env
S3_ENDPOINT_URL=https://<account_id>.r2.cloudflarestorage.com
S3_ACCESS_KEY=<Access Key ID>
S3_SECRET_KEY=<Secret Access Key>
S3_BUCKET=monofarm-files
```

Без S3 — файли зберігаються локально в `data/gcodes/`.

## .env змінні

| Змінна | Обов'язкова | Опис |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `SECRET_KEY` | ✅ | JWT підпис |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅ | Перший адмін |
| `BAMBU_EMAIL` / `BAMBU_PASSWORD` | — | Bambu Cloud (або `BAMBU_REFRESH_TOKEN`) |
| `BAMBU_REGION` | — | `us` / `eu` / `cn` |
| `TG_BOT_TOKEN` | — | Telegram-бот |
| `FARM_PUBLIC_URL` | — | Публічний URL фронтенду |
| `CORS_ORIGINS` | — | Через кому |
| `REDIS_URL` | — | Redis (Upstash або localhost) |
| `S3_ENDPOINT_URL` | — | R2 / S3 endpoint |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | S3 credentials |
| `S3_BUCKET` | — | Bucket name |

## Можливості

### Моніторинг

- Дашборд із живим статусом принтерів (Moonraker + Bambu MQTT через Redis), оновлення кожні 10–30с
- Сторінка принтера: температури, прогрес, ETA, камера (Bambu A1/P1 native TLS через agent tunnel)
- Pause / resume / cancel / skip object для Moonraker і Bambu Lab

### План друку

- Drag-and-drop задач у щоденний план по принтерах
- Авто-розподіл за сумісністю пластику в слотах

### Файли (центральне сховище нарізок)

- Завантаження `.gcode`, `.gco`, `.bgcode`, `.3mf`, `.gcode.3mf`
- Авто-парсинг slicer-метаданих: типи пластику, кольори по слотах, грами, час
- "Надіслати на принтер" — сумісність слотів кольоровими бейджами (✓ / ~ / ✕)
- **Ремаппінг слотів** — Moonraker: gcode переписується (`T0`↔`T1`); Bambu: `ams_mapping` в MQTT

### OrcaSlicer інтеграція

Physical Printer → Host Type: `OctoPrint`, Hostname: backend URL, API Key: JWT токен.
Натисни Print → файл прилітає → автоматично відкривається SendModal.

### Завдання ферми

Канбан-дошка (todo / в процесі / виконано) з drag-and-drop і дедлайнами.

### Пластик

Облік залишків, попередження про низькі запаси.

### Telegram-бот

- `/start <code>` — лінкування облікового запису
- `/план`, `/статус`, `/допомога` — кириличні команди
- 09:00 Kyiv — автоматичний денний план усім лінкованим юзерам

## Warehouse / ERP модуль

Повноцінний ERP поверх print farm:

- **Продукти** — каталог з SKU, штрихкодом, цінами, порогами залишків
- **Специфікації (BOM)** — компоненти + операції (різка / шиття / друк / пакування) з розрахунком собівартості
- **Склад** — зони → комірки → залишки; логування кожного руху (PURCHASE_IN / SALE_OUT / RETURN_IN / TRANSFER / PRODUCTION_IN / PRODUCTION_OUT / WRITE_OFF / ADJUSTMENT)
- **Виробничі партії** — відкриття партії → закриття → автоматичні рухи PRODUCTION_IN/OUT
- **Замовлення** — резервування → відвантаження; джерело: manual або KeyCRM webhook
- **Контрагенти** — постачальники/покупці з балансом
- **Cash flow** — прибутки/витрати по категоріях, зведення
- **Аналітика** — виручка, собівартість, топ продукти, вартість залишків

Інтеграція з KeyCRM: вебхук `POST /api/keycrm/webhook/{org_slug}` → автоматично створює замовлення у складі.

## Підключення Bambu Lab (P1S, A1, A1 mini)

```env
BAMBU_EMAIL=farm@example.com
BAMBU_REGION=us
```

Або (рекомендовано при 2FA):

```env
BAMBU_REFRESH_TOKEN=<token з BambuStudio/cloud_user_info.json>
BAMBU_REGION=us
```

Принтери автоматично підтягнуться при `GET /api/printers`. Жива камера — через local agent (native Bambu binary TLS protocol, порт 6000).

## Підключення Snapmaker U1 (Moonraker)

```bash
cd backend
python -m scripts.seed_u1        # 12 рядків
python -m scripts.seed_u1 6      # N рядків
```

Пропиши `moonraker_url` для кожного принтера в адмін-панелі.

## Local Agent

`agent/monofarm_agent.py` — запускається на фермовому ПК, підключається до хмарного бекенду через WebSocket тунель. Методи: `GET/POST` (HTTP proxy), `STREAM`, `BAMBU_CAMERA` (native TLS), `FFMPEG_STREAM`, `DISCOVER_BAMBU`, `DISCOVER_MOONRAKER`, `BAMBU_UPLOAD`, `BAMBU_MQTT`. Для Bambu LAN-only агент тримає локальний MQTT subscription і пушить live-статус у backend.

```bash
pip install websockets httpx
python agent/monofarm_agent.py --token YOUR_JWT_TOKEN
```

Windows: `agent/monofarm_tray.py` — system tray app з GUI.

## Деплой (production)

Railway: два сервіси з одного Docker образу через `APP_MODE` env var.

- `web` — `APP_MODE=web` → `uvicorn app.main:app --workers 2` (API, `INLINE_WORKERS=false`)
- `worker` — `APP_MODE=worker` → `python -m app.workers.main` (Telegram + APScheduler + Bambu MQTT)

Frontend деплоїться окремим Next.js сервісом. Домен: `monofarm.app`.

## Нотатки

- **Python 3.14**: не використовуй `passlib`, `python-jose`, `psycopg-binary` — поламані. Стек: `bcrypt`, `PyJWT`, `psycopg[binary]>=3.3.0`.
- **Chrome блокує `http://192.168.x.x`** з localhost. Тестуй Mainsail-посилання в Safari або з фермового ПК.
- **Слоти: 0-based** у БД/gcode/API, 1-based лише в UI.
- **Tailwind v4**: перезапуск dev server після зміни `globals.css`.

## Development

### Гілки

| Гілка | Призначення |
| --- | --- |
| `main` | Production. Завжди стабільна. |
| `dev` | Staging / integration. Всі PR ідуть сюди. |
| `feature/xxx` | Нова функціональність — від `dev`. |
| `fix/xxx` | Баг-фікс — від `dev` (або `main` для hotfix). |

### Коміти

```text
feat: нова функція
fix: виправлення бага
chore: рефакторинг / залежності / CI
docs: документація
agent: зміни в agent/
```

### Версіювання агента

При змінах у `agent/` — збампати версію в трьох файлах: `agent/monofarm_agent.py`, `agent/monofarm_tray.py`, `backend/app/api/agent.py`. Схема: `major.minor.patch`.

### PR Checklist

- Тести проходять (`pytest`)
- Lint чистий (`ruff check .`)
- Міграція додана якщо змінилась схема
- `.env.example` оновлений якщо нові змінні

чегра

картинки філаменту в дашпорд

маппінг переролбити  !!!!

chitu 

сортування

кастомізація картки в дашборді

теги файлів кольори

вікно

теги теги

червоним календар




cobra 3  
neptune 4

як запуститься


черга календар багато кількість




сортуваненя  -  черга
