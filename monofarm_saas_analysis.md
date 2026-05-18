# Monofarm — Повний SaaS Аналіз та Дорожня Карта

> Версія: травень 2026. Базується на живому аудиті кодової бази.

---

## Виконавче резюме

Monofarm — це вертикальний SaaS для управління 3D print farms: підтримка Bambu Lab (MQTT), Klipper/Moonraker, планування змін, завдання операторів, склад філаменту, Telegram-нотифікації та білінг через Lemon Squeezy. Архітектура: FastAPI + SQLAlchemy + Alembic (бекенд), Next.js + TypeScript (фронтенд), PostgreSQL.

**Загальна оцінка архітектури: 7.5 / 10**

Проект суттєво перевищує рівень pet project. Є повноцінна Organization модель з планами, PLAN_LIMITS, Lemon Squeezy білінг, per-org Bambu credentials у БД, onboarding flow, CI pipeline. SimplyPrint видалено — позиціонування як self-contained SaaS правильне. Кілька критичних питань залишаються відкритими у TECH_DEBT.md і потребують закриття перед комерційним запуском.

---

## Поточний стан (перевірено аудитом)

### ✅ Вже реалізовано

| Компонент | Деталь |
|-----------|--------|
| **Multi-tenant моделі** | `Organization` таблиця з `id`, `slug`, `plan`, `plan_expires_at`, `payment_subscription_id` |
| **Per-org Bambu credentials** | `bambu_email`, `bambu_password`, `bambu_refresh_token`, `bambu_region` у БД замість `.env` |
| **PLAN_LIMITS enforcement** | `{"printers": 3/10/30/100, "users": 1/3/10/999}` по планах free/starter/pro/farm |
| **PLAN_PRICE_USD** | free $0 / starter $19 / pro $49 / farm $99 |
| **Lemon Squeezy білінг** | checkout, webhook з HMAC, cancel subscription, status endpoint |
| **`get_current_org` dependency** | Повноцінний org-scoped dependency у `api/deps.py` |
| **Billing scoped queries** | `Printer.organization_id == org.id`, `User.organization_id == org.id` у billing.py |
| **Bambu multi-org init** | Lifespan ітерує по всіх `Organization` і викликає `await bambu.init(org)` |
| **SimplyPrint видалено** | Сервіс видалено, конфіг очищено, `PrinterKind` не має `simplyprint` |
| **Onboarding flow** | Фронтенд підтримує `bambu | moonraker | manual` типи підключення |
| **i18n** | `en.ts` + `uk.ts` у frontend |
| **CI pipeline** | GitHub Actions |
| **TECH_DEBT.md** | Явний трекінг боргу |

### ⚠️ Залишковий стан (потребує уваги)

| Проблема | Файл | Пріоритет |
|----------|------|-----------|
| 1 коментар `# manual / simplyprint` | `services/print_tracker.py:33` | 🟢 Low |
| `allow_origins` — перевірити чи не wildcard | `main.py` → `settings.cors_origins_list` | 🟡 Medium |
| In-process services у lifespan | `main.py` — Telegram + scheduler + Bambu MQTT | 🟡 Medium |
| Module-level Bambu state dicts | `services/bambu.py` | 🟡 Medium |
| Відсутній Redis | Moonraker cache, Bambu cache — in-memory | 🔴 High |
| Файли на локальному диску | `data/gcodes/` | 🔴 High |
| Pydantic v2 ConfigDict | `schemas/*.py` — застарілий синтаксис | 🟡 Medium |
| 16 frontend lint errors | `react-hooks/set-state-in-effect` | 🟡 Medium |
| OctoPrint shim — JWT як API key | `api/octoprint.py` | 🟡 Medium |
| Відсутні frontend тести | `SendModal`, `PrinterCard`, `PrinterDetailModal` | 🟡 Medium |
| `plan_expires_at` enforcement | Перевірити чи є middleware/guard | 🔴 High |
| Telegram — long-polling | `services/telegram_bot.py` | 🟢 Low |
| APScheduler timezone per-org | Scheduler глобальний — 09:00 Kyiv time | 🟡 Medium |

---

## Критичні проблеми

### 1. Відсутній Redis — shared cache

Три окремі in-memory cache системи живуть у runtime пам'яті:

- `services/moonraker.py` → `_status_cache` (10s TTL), `_meta_cache` (300s TTL)
- `services/bambu.py` → `_state_cache`, `_ams_cache` (module-level dicts)

**Наслідки:** При рестарті процесу всі принтери "офлайн" протягом 10–30 секунд. При `uvicorn --workers N` — кожен worker має незалежний стан, юзер бачить різні дані залежно від того, який worker відповів. При multi-org — якщо два org мають принтер з однаковим `dev_id`, стан перетирається.

**Рішення:**
```python
# requirements.txt
redis[hiredis]>=5.0
# services/cache.py
import redis.asyncio as aioredis

_redis: aioredis.Redis | None = None

def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis

async def cache_set(key: str, value: str, ttl: int) -> None:
    await get_redis().setex(key, ttl, value)

async def cache_get(key: str) -> str | None:
    return await get_redis().get(key)
```

### 2. Файли на локальному диску

Gcodes і 3mf зберігаються у `data/gcodes/<uuid>.<ext>`. Немає квот per-tenant, немає backup isolation, неможлива горизонтальна масштабованість.

**Рішення — S3-compatible (Cloudflare R2 або Tigris):**
```python
# services/storage.py
import boto3
from botocore.config import Config

def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT_URL,
        aws_access_key_id=settings.S3_ACCESS_KEY,
        aws_secret_access_key=settings.S3_SECRET_KEY,
        config=Config(signature_version="s3v4"),
    )

async def upload_file(org_id: int, file_id: int, data: bytes, ext: str) -> str:
    key = f"orgs/{org_id}/gcodes/{file_id}{ext}"
    get_s3_client().put_object(Bucket=settings.S3_BUCKET, Key=key, Body=data)
    return key

def get_presigned_url(key: str, expires: int = 3600) -> str:
    return get_s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": key},
        ExpiresIn=expires,
    )
```

### 3. In-process сервіси у lifespan

Telegram long-polling + APScheduler + Bambu MQTT запускаються **в одному FastAPI процесі**. При `uvicorn --workers 2+` виникають дублікати.

**Рішення — worker separation:**
```dockerfile
# docker-compose.yml
services:
  web:
    command: uvicorn app.main:app --workers 4
    environment:
      WORKERS: web

  worker:
    command: python -m app.workers.main
    environment:
      WORKERS: scheduler,telegram,bambu_mqtt
```

### 4. `plan_expires_at` enforcement

Потрібно переконатися що є middleware або dependency guard, який перевіряє `org.plan_expires_at` і блокує API при простроченому плані.

**Рішення:**
```python
# api/deps.py
def get_current_org(...) -> Organization:
    ...
    if org.plan != OrgPlan.free and org.plan_expires_at:
        if org.plan_expires_at < datetime.utcnow():
            org.plan = OrgPlan.free
            db.commit()
    return org
```

---

## Серйозні проблеми (scaling)

### 5. Module-level Bambu state leaks

`services/bambu.py` зберігає state як module-level dicts. При ситуаціях де два org мають схожі Bambu device ID — cross-org pollution.

**Рішення — клас BambuClient per-org:**
```python
class BambuOrgClient:
    def __init__(self, org_id: int):
        self.org_id = org_id
        self._state_cache: dict[str, dict] = {}
        self._ams_cache: dict[str, list] = {}
        self._subscribers: dict[str, set] = {}

# app.state замість module-level:
_clients: dict[int, BambuOrgClient] = {}

async def init(org: Organization) -> None:
    client = BambuOrgClient(org.id)
    _clients[org.id] = client
    await client.connect(org.bambu_email, org.bambu_password, org.bambu_region)
```

### 6. OctoPrint shim — JWT як API key

JWT (30-денний lifespan) зберігається у plain-text конфізі OrcaSlicer. При витоку — повний доступ до акаунту на 30 днів.

**Рішення — scoped API keys:**
```python
class ApiKey(Base):
    __tablename__ = "api_keys"
    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    key_hash: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    scopes: Mapped[str] = mapped_column(String(512), default="files:upload,printer:read")
    last_used_at: Mapped[datetime | None]
    expires_at: Mapped[datetime | None]
    is_active: Mapped[bool] = mapped_column(default=True)
```

### 7. Telegram scheduler — глобальний timezone

APScheduler запускається з `09:00 Europe/Kyiv` для всіх org. Це не підходить для tenant'ів з іншим часовим поясом.

**Рішення:** Додати `timezone` поле до `Organization` (`default="Europe/Kyiv"`), scheduler читає timezone per-org при плануванні задачі.

---

## Технічний борг (hygiene)

### 8. Pydantic v2 ConfigDict — механічна заміна

```python
# ЗАСТАРІЛИЙ (зламається в Pydantic v3):
class Config:
    from_attributes = True

# ПРАВИЛЬНИЙ:
model_config = ConfigDict(from_attributes=True)
```

Bash-команда для знаходження всіх файлів:
```bash
grep -rn "class Config:" backend/app/schemas/ --include="*.py"
```

### 9. Frontend lint — 16 errors

Патерн `react-hooks/set-state-in-effect`:
```tsx
// ПРОБЛЕМА:
useEffect(() => {
  setData(result); // setState всередині effect
}, [result]);

// РІШЕННЯ — event-driven або useMemo:
const data = useMemo(() => transform(result), [result]);
```

CI lint зараз `advisory` — не ламає build. Рекомендується перевести на `error` після виправлення всіх 16.

### 10. Залишковий коментар simplyprint

```bash
# Знайти і прибрати:
grep -rn "simplyprint" backend/app/ --include="*.py" | grep -v __pycache__
# Результат: services/print_tracker.py:33
```

### 11. Frontend тести — відсутні

Найвища ймовірність регресій у цих компонентах:
- `SendModal` — slot-remap логіка (T0/T1 swap)
- `PrinterCard` — live status rendering
- `PrinterDetailModal` — складний state

```typescript
// Приклад: vitest + testing-library
import { render, screen } from "@testing-library/react";
import { SendModal } from "./SendModal";

test("slot remap не створює колізії", () => {
  const result = remapSlots({ T0: "PLA", T1: "PETG" }, { T0: "PETG", T1: "PLA" });
  expect(result).not.toContain("collision");
});
```

---

## Що зроблено добре

| Аспект | Деталь |
|--------|--------|
| **Organization модель** | Повноцінна з планами, billing fields, Bambu credentials |
| **Per-org Bambu credentials у БД** | Не в `.env` — правильний multi-tenant підхід |
| **Lemon Squeezy інтеграція** | HMAC webhook, checkout, cancel — production-ready |
| **PLAN_LIMITS enforcement** | Limits визначені і використовуються у billing status |
| **Lifespan multi-org Bambu init** | `for org in orgs: await bambu.init(org)` — правильна ітерація |
| **`get_current_org` dependency** | Org-scoped context в кожному endpoint |
| **Two-pass slot remap** | Placeholder стратегія для T0/T1 swap — елегантне рішення |
| **asyncio.gather для паралельних запитів** | SP + Bambu + Moonraker паралельно |
| **i18n готовність** | `en.ts` + `uk.ts` |
| **Transaction rollback у тестах** | Ізольовані тести з мок-сервісами |
| **CLAUDE.md + TECH_DEBT.md** | Висока документаційна зрілість |
| **SimplyPrint видалено** | Чисте позиціонування як standalone SaaS |

---

## Пріоритизований план роботи

### 🔴 Фаза 1 — Reliability (тиждень 1–2)

Ці задачі блокують безпечний запуск:

**1. Перевірити `plan_expires_at` enforcement**
- Перевірити `api/deps.py` → чи є downgrade-to-free при простроченому плані
- Додати якщо відсутнє (5 рядків коду)
- Написати тест

**2. Redis для shared cache**
- Додати `redis[hiredis]` у requirements
- Створити `services/cache.py` з `cache_get/cache_set/cache_delete`
- Замінити `_status_cache` у `moonraker.py`
- Замінити `_state_cache`, `_ams_cache` у `bambu.py` (або перенести у `BambuOrgClient`)

**3. S3-compatible storage для файлів**
- Зареєструватися на Cloudflare R2 (безкоштовно до 10GB)
- Додати `boto3` у requirements
- Створити `services/storage.py`
- Змінити `api/files.py` — завантажувати у R2, зберігати key у БД
- Додати quota check при upload

**4. BambuOrgClient клас (замість module-level dicts)**
- Перенести `_state_cache`, `_ams_cache` у клас
- Зберігати `_clients: dict[int, BambuOrgClient]` у `app.state`

### 🟡 Фаза 2 — Production Hardening (тиждень 3)

**5. Worker separation**
- Окремий entrypoint `workers/main.py` для scheduler + Telegram + Bambu MQTT
- Docker Compose з `web` і `worker` сервісами

**6. Scoped API keys для OctoPrint shim**
- Таблиця `ApiKey` з `key_hash`, `scopes`, `expires_at`
- Endpoint `POST /api/api-keys` (admin only)
- OctoPrint shim приймає Bearer token, перевіряє через `api_keys` таблицю

**7. CORS hardening**
- Перевірити `settings.cors_origins_list` — чи не містить `*` в production
- Додати `allow_origin_regex` для `*.yourdomain.com` якщо потрібно

**8. Pydantic ConfigDict migration**
- `grep -rn "class Config:" backend/app/schemas/` → механічна заміна у всіх файлах

**9. APScheduler timezone per-org**
- Додати `timezone: str` поле до `Organization` (default: `Europe/Kyiv`)
- Scheduler читає timezone при плануванні daily report

### 🟢 Фаза 3 — Polish (тиждень 4)

**10. Виправити 16 frontend lint errors**
- `npm run lint` → знайти всі `react-hooks/set-state-in-effect`
- Замінити на `useMemo` або event-driven патерни
- Перевести CI lint з `advisory` на `error`

**11. Vitest тести для критичних компонентів**
- `SendModal` — slot remap без колізій
- `PrinterCard` — rendering для кожного `PrinterKind`
- Billing status display

**12. Прибрати залишковий коментар simplyprint**
- `services/print_tracker.py:33` — прибрати `# manual / simplyprint`

**13. Telegram webhook mode**
- Налаштувати HTTPS webhook endpoint
- Прибрати long-polling з lifespan (зменшить навантаження при масштабуванні)

---

## Стратегія монетизації

### Позиціонування

**Головна конкурентна перевага:** Monofarm підтримує Bambu Lab через MQTT — SimplyPrint не підтримує. Це єдиний диференціатор, якого достатньо для pitch до будь-якої ферми з Bambu принтерами.

Pitch: *"SimplyPrint не працює з Bambu Lab. Monofarm — працює."*

### Тарифні плани (поточні)

| План | Ціна | Принтери | Юзери | Цільова аудиторія |
|------|------|----------|-------|-------------------|
| Free | $0 | 3 | 1 | Тестування, хоббісти |
| Starter | $19/міс | 10 | 3 | Мала ферма, side business |
| Pro | $49/міс | 30 | 10 | Середня ферма |
| Farm | $99/міс | 100 | 999 | Великі комерційні ферми |

### Рекомендації по цінах

Farm план за $99 для 100 принтерів виглядає дешево. Ферма з 50+ принтерами легко генерує $10k+/міс виручки, а їх операційна проблема (моніторинг, планування, склад) коштує дорожче. Після перших 5 клієнтів — провести price discovery: чи готові Farm клієнти платити $199–$299 за більш розширені функції (детальна аналітика, SLA, пріоритетна підтримка).

### Канали залучення перших клієнтів

- Reddit: r/3Dprinting, r/BambuLab, r/prusa3d
- Facebook Groups: "3D Print Farm Owners", "Bambu Lab Users"
- Discord: Bambu Lab офіційний сервер
- YouTube: огляд продукту (Bambu MQTT інтеграція — рідкість)
- LinkedIn: таргет "3D printing business", "print farm owner"

---

## Технічний стек (фінальна оцінка)

| Компонент | Технологія | Оцінка |
|-----------|------------|--------|
| **Backend framework** | FastAPI | ✅ Правильний вибір |
| **ORM** | SQLAlchemy 2.0 Mapped | ✅ Сучасний підхід |
| **Міграції** | Alembic | ✅ |
| **Auth** | PyJWT + bcrypt | ✅ Без зайвих залежностей |
| **Billing** | Lemon Squeezy | ✅ Найлегший старт для SaaS |
| **Frontend** | Next.js + TypeScript | ✅ |
| **Real-time (Bambu)** | MQTT (paho) | ✅ Єдиний вірний підхід |
| **Scheduled jobs** | APScheduler | ⚠️ Потребує worker separation |
| **Notifications** | Telegram (python-telegram-bot) | ⚠️ Перевести на webhook |
| **Cache** | In-memory | 🔴 Замінити на Redis |
| **File storage** | Local disk | 🔴 Замінити на S3/R2 |
| **DB** | PostgreSQL | ✅ |

---

## Висновок

Monofarm знаходиться у точці, коли продукт достатньо зрілий для перших платних клієнтів, але потребує закриття двох інфраструктурних блокерів (Redis + S3) та верифікації `plan_expires_at` enforcement перед активним масштабуванням. Після цього — це повноцінний комерційний продукт із чіткою ринковою нішею і сильним технічним фундаментом.

**Наступний крок:** виконати `plan_expires_at` audit (30 хвилин), потім інтегрувати Redis (1 день), потім R2 (1 день). Три дні роботи відкривають безпечний шлях до launch.
