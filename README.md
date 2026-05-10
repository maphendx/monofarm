# printfarm

Платформа управління 3D-фермою: моніторинг принтерів (SimplyPrint + ручні Snapmaker U1), щоденний план друку, task manager, облік пластику. Telegram-бот як надбудова для сповіщень.

## Стек

- **Backend:** FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL 16 + APScheduler
- **Frontend:** Next.js 15 (App Router) + TypeScript + Tailwind
- **Auth:** JWT, ролі `admin` / `operator` / `manager`
- **Bot:** `python-telegram-bot` (тонкий клієнт API; додаємо пізніше)
- **Деплой:** Windows + NSSM (три сервіси), Cloudflare Tunnel + Access для зовнішнього доступу

## Структура

```
backend/    FastAPI + Alembic
frontend/   Next.js (порожній — bootstrap'имо через create-next-app)
bot/        Telegram-бот (порожній — додамо після MVP веб-частини)
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
uvicorn app.main:app --reload
```

Перевір:
- `http://localhost:8000/api/health` → `{"ok": true}`
- `http://localhost:8000/docs` → Swagger UI
- `POST /api/auth/login` з `{email, password}` адміна → отримуєш `access_token`

### 3. Frontend

Див. [frontend/README.md](frontend/README.md) — bootstrap через `create-next-app`.

## Поточний стан (MVP, етап 1)

- [x] Скелет монорепо, docker-compose з Postgres
- [x] Бекенд: FastAPI, конфіг, БД, health
- [x] Моделі: `User`, `Printer`, `PrintTask`, `FarmTask`, `PlanEntry`, `Filament`
- [x] Перша Alembic-міграція
- [x] Авторизація (JWT + ролі), сід адміна
- [ ] Frontend: bootstrap Next.js + сторінка логіну
- [ ] Етап 2: принтери + дашборд (синхронізація з SimplyPrint, ручні U1)
- [ ] Етап 3: задачі + план дня
- [ ] Етап 4: Telegram-бот як клієнт API
- [ ] Етап 5: пластик + farm task manager
- [ ] Етап 6: деплой на фермовий ПК (NSSM × 3, Cloudflare Tunnel)

## Підключення SimplyPrint

`SIMPLYPRINT_API_KEY` і `SIMPLYPRINT_ORG_ID` беруть з `.env`. Сервіс синхронізації переноситься з попереднього бота (`3d-bot/bot/simplyprint_client.py`) на етапі 2.

## Деплой (Windows-ферма)

NSSM-сервіси:
- `printfarm-api` — `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- `printfarm-web` — `npm run start` (після `npm run build`)
- `printfarm-bot` — `python -m bot.main` (коли додамо)

Postgres: окремо (рекомендовано офіційний Windows-інсталер, не Docker, щоб не залежати від Docker Desktop).

Cloudflare Tunnel: `cloudflared service install` → tunnel конфіг наводить на `localhost:3000` (фронт) і `localhost:8000` (API). Cloudflare Access обмежує доступ за email (ти, колега, керівник).
