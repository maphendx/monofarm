# monofarm API — повний довідник + Bruno

Базовий URL локально: `http://localhost:8000`  
OpenAPI (Swagger): `http://localhost:8000/docs`  
Джерело правди: `backend/app/api/*.py`, `backend/app/main.py`

Колонка **UI** показує, чи викликає endpoint фронтенд (`frontend/src/`):  
✓ — використовується, — — тільки зовнішні клієнти / інфраструктура.

---

## Швидкий старт у Bruno

1. Встанови [Bruno](https://www.usebruno.com/) (desktop).
2. **Open Collection** → вибери папку `bruno/monofarm` у цьому репозиторії.
3. У правому верхньому куті обери environment **local**.
4. Відредагуй `environments/local.bru`: `adminEmail`, `adminPassword` (з `backend/.env`: `ADMIN_EMAIL`, `ADMIN_PASSWORD`).
5. Запусти бекенд: `./start.sh` або `cd backend && uvicorn app.main:app --reload --port 8000`.
6. Виконай **Auth → Login** — скрипт збереже `token` у змінні колекції.
7. Решта запитів підхоплюють `Authorization: Bearer {{token}}` автоматично (через auth inherit у `collection.bru`).

### Змінні середовища (Bruno)

| Змінна | Приклад | Опис |
|--------|---------|------|
| `baseUrl` | `http://localhost:8000` | API |
| `adminEmail` | `admin@example.com` | Логін |
| `adminPassword` | `…` | Пароль |
| `token` | *(авто)* | JWT після Login |
| `printerId` | `1` | ID принтера для path |
| `fileId` | `1` | ID файлу в бібліотеці |
| `taskId` | `1` | ID print task |
| `planEntryId` | `1` | ID запису плану |
| `userId` | `2` | ID користувача |
| `filamentId` | `1` | ID котушки |
| `colorId` | `1` | ID кольору палітри |
| `groupId` | `1` | ID групи принтерів |
| `apiKey` | `mf_…` | Scoped key (OctoPrint) |
| `planDate` | `2026-05-19` | Дата плану `YYYY-MM-DD` |

### Авторизація

| Тип | Заголовок | Де |
|-----|-----------|-----|
| JWT (основний) | `Authorization: Bearer <token>` | Майже всі `/api/*` |
| JWT у query | `?token=<jwt>` | webcam snapshot, camera stream |
| OctoPrint API key | `X-Api-Key: <jwt або mf_…>` | `/api/version`, `/api/printer`, `POST /api/files/local` |
| Webhook Lemon Squeezy | `x-signature: <hmac sha256 hex>` | `POST /api/billing/webhook` |
| Без auth | — | `GET /api/health`, `POST /api/orgs/register`, `POST /api/auth/login`, `GET /api/agent/version`, `GET /agent/*` |

### Ролі

- **будь-який** залогінений: `admin`, `operator`, `manager`
- **admin + operator**: керування принтерами, планом, філаментом
- **admin + operator + manager**: upload файлів, print/farm tasks, send to printer
- **тільки admin**: users, billing checkout/cancel, bulk delete printers, org Bambu settings

---

## Системні

| Method | Path | Auth | UI | Body / Query | Примітки |
|--------|------|------|----|--------------|----------|
| GET | `/api/health` | — | — | — | `{"ok": true}` |
| POST | `/api/internal/send-plan-now` | admin JWT | — | — | Тест: розіслати план у Telegram зараз |
| GET | `/agent/{filename}` | — | — | `filename` ∈ `monofarm_agent.py`, `monofarm_tray.py`, `install.sh`, `install.ps1`, `Dockerfile`, `requirements.txt`, `bambu_camera_test.py` | Статичні файли агента |

---

## Auth — `/api/auth`

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| POST | `/api/auth/login` | — | ✓ | `{"email":"…","password":"…"}` → `{"access_token":"…","token_type":"bearer"}` |
| GET | `/api/auth/me` | JWT | ✓ | — → `UserOut` |

---

## Organizations — `/api/orgs`

| Method | Path | Auth | UI | Body / Query |
|--------|------|------|----|--------------|
| POST | `/api/orgs/register` | — | ✓ | `{"org_name":"…","admin_name":"…","admin_email":"…","admin_password":"…"}` (min 8) → TokenResponse |
| GET | `/api/orgs/me` | JWT | ✓ | — → OrgSettingsOut |
| PUT | `/api/orgs/me/settings` | admin | — | `{"bambu_email"?,"bambu_password"?,"bambu_refresh_token"?,"bambu_region"?}` (`us`/`eu`/`cn`) |
| GET | `/api/orgs/me/bambu-status` | admin | — | — debug MQTT/tokens |
| POST | `/api/orgs/me/bambu-send-code` | admin | ✓ | `{"email":"…","region":"eu"}` |
| POST | `/api/orgs/me/bambu-verify-code` | admin | ✓ | `{"email":"…","code":"123456","region":"eu"}` |

---

## Users — `/api/users` (admin)

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| GET | `/api/users` | admin | ✓ | — |
| POST | `/api/users` | admin | ✓ | `{"email","password","name","role":"operator\|manager\|admin"}` |
| PATCH | `/api/users/{user_id}` | admin | ✓ | `{"name"?,"role"?,"is_active"?,"password"?}` |
| POST | `/api/users/{user_id}/telegram/link` | admin | — | — → `{code, bot_username, deep_link, expires_at}` |
| DELETE | `/api/users/{user_id}/telegram` | admin | ✓ | — |
| DELETE | `/api/users/{user_id}` | admin | ✓ | 204 |

---

## API Keys — `/api/api-keys`

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| GET | `/api/api-keys` | JWT | — | — список ключів (без raw value) |
| POST | `/api/api-keys` | JWT | — | `{"name":"OrcaSlicer","scopes":"files:upload"}` → **key показується один раз** |
| DELETE | `/api/api-keys/{key_id}` | JWT | — | 204 |

---

## Printer groups — `/api/printer-groups`

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| GET | `/api/printer-groups` | JWT | ✓ | — |
| POST | `/api/printer-groups` | admin, operator | ✓ | `{"name":"Зона A"}` |
| PATCH | `/api/printer-groups/{group_id}` | admin, operator | ✓ | `{"name"?}` |
| DELETE | `/api/printer-groups/{group_id}` | admin, operator | ✓ | 204 |
| POST | `/api/printer-groups/reorder` | admin, operator | ✓ | `[{"id":1,"sort_order":0},…]` |

---

## Printers — `/api/printers`

| Method | Path | Auth | UI | Body / Query |
|--------|------|------|----|--------------|
| GET | `/api/printers/bambu-discover` | JWT | — | UDP LAN discover → `[{dev_id, ip, name, model}]` |
| GET | `/api/printers` | JWT | ✓ | — список + live state (Bambu MQTT / Moonraker) |
| POST | `/api/printers` | admin | ✓ | `PrinterCreate` |
| GET | `/api/printers/{printer_id}` | JWT | ✓ | — один принтер |
| PATCH | `/api/printers/{printer_id}` | admin | ✓ | `PrinterUpdate` |
| POST | `/api/printers/{printer_id}/group` | admin, operator | ✓ | `{"group_id": 1 \| null}` |
| PUT | `/api/printers/{printer_id}/loaded-filaments` | admin, operator | ✓ | **масив** `FilamentSlot[]` (не об'єкт!) |
| POST | `/api/printers/{printer_id}/manual` | admin, operator | ✓ | `{"status"?,"job"?,"eta_minutes"?}` |
| DELETE | `/api/printers/{printer_id}` | admin | ✓ | 204 |
| DELETE | `/api/printers` | admin | ✓ | query `?kind=bambu` (опційно) → `{"deleted": N}` |
| POST | `/api/printers/reorder` | admin, operator | — | `[{"id":1,"sort_order":0},…]` |
| POST | `/api/printers/sync` | admin, operator | ✓ | = GET list (force Bambu import) |
| GET | `/api/printers/{id}/webcam/snapshot` | `?token=<jwt>` | ✓ | JPEG, Moonraker |
| GET | `/api/printers/{id}/camera/stream` | `?token=<jwt>` | ✓ | MJPEG stream, Bambu |
| POST | `/api/printers/{id}/pause` | admin, operator | ✓ | Moonraker only → `{"ok":true,"action":"pause"}` |
| POST | `/api/printers/{id}/resume` | admin, operator | ✓ | Moonraker only |
| POST | `/api/printers/{id}/cancel` | admin, operator | ✓ | Moonraker only |
| POST | `/api/printers/{id}/print/pause` | admin, operator | ✓ | Moonraker **або** Bambu |
| POST | `/api/printers/{id}/print/resume` | admin, operator | ✓ | unified |
| POST | `/api/printers/{id}/print/cancel` | admin, operator | ✓ | unified |
| POST | `/api/printers/{id}/print/clear-bed` | admin, operator | ✓ | підтвердження зняття зі столу |
| POST | `/api/printers/{id}/print/clear-error` | admin, operator | ✓ | скинути помилку |
| POST | `/api/printers/{id}/print/skip-object` | admin, operator | ✓ | Klipper exclude_object |
| POST | `/api/printers/{id}/gcode` | admin, operator | ✓ | `{"script":"G28"}` |
| POST | `/api/printers/{id}/speed-profile` | admin, operator | ✓ | `{"profile":1}` (1–4, Bambu only) |

**PrinterCreate / Update**

```json
{
  "name": "U1-01",
  "kind": "snapmaker_u1",
  "moonraker_url": "http://192.168.1.50",
  "bambu_dev_id": null,
  "bambu_access_code": null,
  "bambu_dev_ip": null,
  "bambu_model": null
}
```

`kind`: `snapmaker_u1` | `bambu` | `other`

**FilamentSlot** (слоти **0-based** у API, UI показує 1-based):

```json
[
  {"slot": 0, "color": "#FF0000", "color_name": "Red", "type": "PLA", "brand": null, "filament_id": null, "empty": false},
  {"slot": 1, "color": "#0000FF", "type": "PETG", "empty": false}
]
```

---

## Print tasks (канбан) — `/api/tasks/print`

| Method | Path | Auth | UI | Body / Query |
|--------|------|------|----|--------------|
| GET | `/api/tasks/print` | JWT | ✓ | `?status=queued\|in_progress\|done\|cancelled` |
| POST | `/api/tasks/print` | admin, operator, manager | ✓ | `PrintTaskCreate` |
| PATCH | `/api/tasks/print/{task_id}` | admin, operator, manager | ✓ | `PrintTaskUpdate` |
| DELETE | `/api/tasks/print/{task_id}` | admin, operator | ✓ | 204 |
| POST | `/api/tasks/print/{task_id}/file` | admin, operator, manager | ✓ | **multipart** `file` (.gcode, .3mf, … max 200MB) |
| GET | `/api/tasks/print/{task_id}/file` | JWT | — | скачати прикріплений файл |
| DELETE | `/api/tasks/print/{task_id}/file` | admin, operator | — | прибрати файл з задачі |

**PrintTaskCreate**

```json
{
  "title": "Корпус v2",
  "quantity": 10,
  "filament_type": "PLA",
  "filament_color": "чорний",
  "estimated_minutes": 120,
  "deadline": "2026-06-01",
  "notes": null
}
```

---

## Farm tasks — `/api/tasks/farm`

| Method | Path | Auth | UI | Body / Query |
|--------|------|------|----|--------------|
| GET | `/api/tasks/farm` | JWT | ✓ | `?status=todo\|in_progress\|done` |
| POST | `/api/tasks/farm` | admin, operator, manager | ✓ | `FarmTaskCreate` |
| PATCH | `/api/tasks/farm/{task_id}` | admin, operator, manager | ✓ | `FarmTaskUpdate` |
| DELETE | `/api/tasks/farm/{task_id}` | admin, operator | ✓ | 204 |

```json
{"title": "Прибрати стіл", "description": null, "deadline": "2026-05-20", "assignee_id": 2}
```

---

## Filaments (склад) — `/api/filaments`

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| GET | `/api/filaments` | JWT | ✓ | — |
| POST | `/api/filaments` | admin, operator | ✓ | `FilamentCreate` |
| PATCH | `/api/filaments/{filament_id}` | admin, operator | ✓ | `FilamentUpdate` |
| POST | `/api/filaments/{filament_id}/adjust` | admin, operator | ✓ | `{"delta_grams": -50, "reason": "друк"}` |
| DELETE | `/api/filaments/{filament_id}` | admin | ✓ | 204 |

---

## Filament colors (палітра) — `/api/filament-colors`

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| GET | `/api/filament-colors` | JWT | ✓ | — |
| POST | `/api/filament-colors` | admin, operator | ✓ | `{"name":"Червоний","hex_color":"#FF0000","sort_order":0}` |
| PATCH | `/api/filament-colors/{color_id}` | admin, operator | ✓ | `FilamentColorUpdate` |
| DELETE | `/api/filament-colors/{color_id}` | admin, operator | ✓ | 204 |

---

## Files (бібліотека gcode/3mf) — `/api/files`

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| GET | `/api/files` | JWT | ✓ | — |
| POST | `/api/files/upload` | admin, operator, manager | ✓ | **multipart** `file` (max 500MB) |
| DELETE | `/api/files/{file_id}` | admin, operator, manager | ✓ | 204 |
| GET | `/api/files/{file_id}/download` | JWT | ✓ | redirect (S3) або FileResponse |
| POST | `/api/files/{file_id}/send/{printer_id}` | admin, operator, manager | ✓ | `SendPayload` (JSON) |

**SendPayload** — слоти **0-based**:

```json
{
  "slot_map": {"0": 1, "1": 0},
  "auto_bed_leveling": true,
  "timelapse": false,
  "ai_detection": null,
  "calibrate_slots": [0, 1]
}
```

- Bambu: лише `.3mf`, `slot_map` → `ams_mapping`
- Moonraker: optional gcode rewrite + upload + start

---

## Plan (план друку) — `/api/plan`

| Method | Path | Auth | UI | Body / Query |
|--------|------|------|----|--------------|
| GET | `/api/plan` | JWT | ✓ | `?plan_date=2026-05-19` (default: сьогодні) |
| POST | `/api/plan` | admin, operator | ✓ | `PlanEntryCreate` |
| PATCH | `/api/plan/{entry_id}` | admin, operator | ✓ | `{"done": true, "note": "…"}` |
| DELETE | `/api/plan/{entry_id}` | admin, operator | ✓ | 204 |
| POST | `/api/plan/{entry_id}/send` | admin, operator | ✓ | Moonraker: upload task file + start |

```json
{"plan_date": "2026-05-19", "printer_id": 1, "task_id": 3, "note": null}
```

---

## Analytics — `/api/analytics`

| Method | Path | Auth | UI | Query |
|--------|------|------|----|-------|
| GET | `/api/analytics/summary` | JWT | — | — tasks counts, plan done, filament g |
| GET | `/api/analytics/daily` | JWT | — | `?days=30` (7–90) |
| GET | `/api/analytics/printers` | JWT | — | — per-printer stats |
| GET | `/api/analytics/filament-usage` | JWT | — | — by material |

---

## Print history — `/api/history`

| Method | Path | Auth | UI | Query |
|--------|------|------|----|-------|
| GET | `/api/history` | JWT | — | `?printer_id=`, `?result=`, `?limit=100` (max 500) |

---

## Billing (Lemon Squeezy) — `/api/billing`

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| GET | `/api/billing/status` | JWT | ✓ | — plan, limits, usage |
| POST | `/api/billing/checkout` | admin | ✓ | `{"plan": "starter"}` → `{"url": "…"}` (`starter`/`pro`/`farm`) |
| POST | `/api/billing/cancel` | admin | ✓ | — downgrade to free |
| POST | `/api/billing/webhook` | HMAC `x-signature` | — | raw Lemon Squeezy payload |

---

## OctoPrint shim (OrcaSlicer) — prefix `/api`

| Method | Path | Auth | UI | Body |
|--------|------|------|----|------|
| GET | `/api/version` | — | — | — handshake |
| GET | `/api/printer` | X-Api-Key | — | — always Operational |
| POST | `/api/files/local` | X-Api-Key | — | multipart `file` |

У OrcaSlicer: Host Type OctoPrint, Hostname = backend, API Key = JWT або `mf_…` key.

---

## Agent (tunnel) — `/api/agent`

| Method | Path | Auth | UI | Примітки |
|--------|------|------|----|----------|
| GET | `/api/agent/version` | — | — | `{"version":"0.4.5"}` |
| GET | `/api/agent/status` | JWT | ✓ | `{"connected": true/false}` |
| WS | `/api/agent/connect?token=<jwt>` | JWT query | — | WebSocket; Bruno не тестує WS нативно — використай `websocat` або UI агента |

---

## Типовий сценарій тесту в Bruno

```
1. Health          → 200 {"ok":true}
2. Auth → Login     → зберегти token
3. Auth → Me        → перевірити role
4. Printers → List  → скопіювати printerId
5. Files → Upload   → multipart, зберегти fileId
6. Files → Send     → POST body slot_map
7. Plan → Get       → plan_date=today
8. Analytics → Summary
```

### Multipart у Bruno

- **Body** → **Multipart Form**
- Поле `file` → тип File → обери `.gcode` / `.3mf`

### Помилки

| Код | Значення |
|-----|----------|
| 401 | Немає / прострочений JWT |
| 403 | Недостатня роль |
| 404 | Не знайдено (чужий org_id) |
| 402 | Ліміт плану (принтери / users) |
| 502 | Moonraker / Bambu недоступний |

---

## Повний підрахунок

| Група | Endpoints | UI ✓ |
|-------|-----------|-------|
| System | 3 | 0 |
| Auth | 2 | 2 |
| Orgs | 6 | 4 |
| Users | 6 | 5 |
| API Keys | 3 | 0 |
| Printer groups | 5 | 5 |
| Printers | 25 | 22 |
| Print tasks | 7 | 5 |
| Farm tasks | 4 | 4 |
| Filaments | 5 | 5 |
| Filament colors | 4 | 4 |
| Files | 5 | 5 |
| Plan | 5 | 5 |
| Analytics | 4 | 0 |
| History | 1 | 0 |
| Billing | 4 | 3 |
| OctoPrint | 3 | 0 |
| Agent (HTTP) | 2 | 1 |
| **Разом HTTP** | **94** | **70** |
| + WebSocket | 1 | — |

Колекція Bruno: `bruno/monofarm/` — по одному `.bru` на кожен HTTP endpoint.

### Не використовуються фронтендом (24 endpoints)

| Endpoint | Клієнт |
|----------|--------|
| `GET /api/health` | інфраструктура / моніторинг |
| `POST /api/internal/send-plan-now` | debug / cron |
| `GET /agent/{filename}` | агент-інсталятор |
| `PUT /api/orgs/me/settings` | Bruno / пряме API |
| `GET /api/orgs/me/bambu-status` | Bruno / debug |
| `POST /api/users/{user_id}/telegram/link` | Bruno / admin CLI |
| `GET /api/api-keys` | Bruno / OrcaSlicer setup |
| `POST /api/api-keys` | Bruno / OrcaSlicer setup |
| `DELETE /api/api-keys/{key_id}` | Bruno / OrcaSlicer setup |
| `GET /api/printers/bambu-discover` | Bruno / admin CLI |
| `POST /api/printers/reorder` | Bruno (drag-and-drop не реалізований) |
| `GET /api/tasks/print/{task_id}/file` | Bruno / прямий download |
| `DELETE /api/tasks/print/{task_id}/file` | Bruno |
| `GET /api/analytics/summary` | Bruno (сторінка аналітики не реалізована) |
| `GET /api/analytics/daily` | Bruno |
| `GET /api/analytics/printers` | Bruno |
| `GET /api/analytics/filament-usage` | Bruno |
| `GET /api/history` | Bruno (сторінка історії не реалізована) |
| `POST /api/billing/webhook` | Lemon Squeezy (зовнішній) |
| `GET /api/version` | OrcaSlicer |
| `GET /api/printer` | OrcaSlicer |
| `POST /api/files/local` | OrcaSlicer |
| `GET /api/agent/version` | агент |
| `WS /api/agent/connect` | агент |
