# SimplyPrint — Архітектура запуску друку для monofarm
> Документ для Claude Code: як саме SimplyPrint організовує print dispatch,
> щоб monofarm не будував "сторонню чергу", а дотримувався тієї ж логіки.

---

## TL;DR — Головна ідея SimplyPrint

SimplyPrint **не має окремої "черги завдань" на бекенді для відправки на принтер**.  
Вся логіка — в одному REST-виклику `POST /printers/actions/CreateJob`.  
Файл вже завантажений → ти передаєш його ID → принтер починає друк.  
Статус відстежується через **webhooks** (push) або **polling** `GET /printers/Get?pid=`.  
Ніякого "dispatch worker", ніякого "job state machine" на стороні клієнта — всі стани живуть **на боці SimplyPrint**.

---

## Частина 1 — REST API: повний flow запуску

### Базова URL
```
https://api.simplyprint.io/{companyId}/{endpoint}
```
- `companyId` — числовий ID акаунту/організації (отримується через OAuth `/account/GetUser`)
- Авторизація: `X-API-KEY: {key}` (або `Authorization: Bearer {token}` для OAuth)

---

### Крок 1: Завантаження файлу

```
POST https://files.simplyprint.io/{companyId}/files/Upload
Header: X-API-KEY: {key}
Content-Type: multipart/form-data

Form fields:
  file        — бінарний .gcode або .3mf
  name        — (опц.) назва файлу
  auto_slice  — (опц.) true якщо завантажуєш .stl і хочеш авто-нарізання
```

**Response:**
```json
{
  "status": true,
  "message": null,
  "file": {
    "id": "a1b2c3d4e5f6...",       // filesystem ID (UUID-подібний)
    "name": "benchy.gcode",
    "analysis": {
      "slicer": "PrusaSlicer",
      "filament": [8.15],           // г на екструдер
      "estimate": 4862,             // секунди
      "temps": {
        "tool": { "T0": 215 },
        "bed": 60
      },
      "modelSize": { "x": 60, "y": 60, "z": 48 }
    }
  }
}
```

**Ключове**: `file.id` — це `filesystem` ID, який використовується в `CreateJob`.  
Файл зберігається у файловому сховищі SimplyPrint і доступний повторно.

---

### Крок 2: Запуск друку (CreateJob)

```
POST https://api.simplyprint.io/{companyId}/printers/actions/CreateJob?pid=1234
Header: X-API-KEY: {key}
Content-Type: application/json
```

**Body — джерело файлу (вибрати одне):**
```json
{ "filesystem": "a1b2c3d4e5f6..." }      // файл з бібліотеки (завантажений через Upload)
{ "file_id": "a1b2c3d4e5f6..." }          // тимчасовий API file (не зберігається в бібліотеці)
{ "queue_file": 638 }                      // конкретний queue item ID
{ "next_queue_item": true }                // автоматично вибрати наступний з черги (Plan: Print Farm)
{ "reprint": 495462 }                      // перезапуск за job ID
{ "multi_queue": { "638": [1234, 1235] } } // різні queue items на різні принтери
```

**Body — опції (додаються до будь-якого джерела):**
```json
{
  "mms_map": [0, 1, 2, 3],             // маппінг AMS/MMU лотків: T0→E0, T1→E1...
  "start_options": {},                  // heat soak, probe, тощо
  "custom_fields": [],                  // кастомні поля до завдання
  "skipped_objects": []                 // об'єкти, які пропустити (exclude list)
}
```

**Query параметри:**
- `pid` — один або кілька printer ID через кому: `?pid=1234,1235`
- Всі принтери мають бути в стані `operational`

**Response (успіх — 200):**
```json
{
  "status": true,
  "message": null,
  "files": [
    {
      "name": "benchy.gcode",
      "analysis": { ... },              // те саме що при Upload
      "printers": [1234],               // принтери, на яких стартувало
      "queued": false,                  // true якщо прийшов з черги
      "cost": [
        {
          "estimate": false,
          "total_cost": 1.42,
          "lines": [
            { "id": 1, "label": "Material usage", "cost": 0.35 },
            { "id": 3, "label": "Machine run time", "cost": 0.97 },
            { "id": 4, "label": "Energy cost", "cost": 0.10 }
          ]
        }
      ]
    }
  ],
  "jobIds": [495462],                   // ← головне: job ID для відстеження
  "staggeredPrinterIds": []            // принтери в PRINT_PENDING (відкладений старт)
}
```

**Response (потрібне підтвердження — коли увімкнений approval flow):**
```json
{
  "status": true,
  "token": "confirm_token_abc123"       // передати в StartPrint для підтвердження
}
```

**Response (помилки):**
```json
{ "status": false, "message": "Printer is not operational" }
{ "status": false, "error": "quota_exceeded", "quota_failures": [...] }
{ "status": false, "balance_insufficient": true, "estimated_cost": 1.42 }
```

---

### Крок 3: Контроль активного друку

```
POST /printers/actions/Pause?pid=1234
POST /printers/actions/Resume?pid=1234
POST /printers/actions/Cancel?pid=1234
```

**Cancel body:**
```json
{
  "reason": 3,                          // cancel reason ID (якщо обліковий запис вимагає)
  "comment": "Nozzle clogged",
  "return_to_queue": true,              // повернути файл в чергу
  "return_position": "top"             // "top" | "bottom" | "original" | "custom"
}
```

**Після завершення друку — очистити стіл:**
```
POST /printers/actions/ClearBed?pid=1234
Body: { "success": true, "rating": 4 }
```
Це переводить принтер із `awaiting_bed_clear` → `operational` і дозволяє наступний AutoPrint.

---

## Частина 2 — Стани принтера

Всі стани з поля `printer.state` у відповіді `GET /printers/Get`:

| Стан | Значення |
|---|---|
| `operational` | Готовий. Приймає `CreateJob` |
| `printing` | Друкує |
| `paused` | Пауза |
| `pausing` | Переходить на паузу |
| `resuming` | Відновлюється |
| `cancelling` | Скасовується |
| `awaiting_bed_clear` | Друк завершений, стіл не прибраний |
| `print_pending` | Відкладений старт (staggered queue) |
| `in_maintenance` | Режим обслуговування |
| `downloading` | Завантажує файл для друку |
| `error` | Помилка |
| `offline` | Недоступний |

**Складні макроси** (для фільтрації в `POST /printers/Get`):
- `idle` — operational + online
- `can_accept_commands` — може приймати MQTT команди
- `was_printing_when_offline` — впав під час друку
- `awaiting_bed_clear` ≠ `print_pending` — ці два різні, не плутати!

---

## Частина 3 — Черга (Queue)

SimplyPrint queue — це **глобальна черга файлів**, яка **не запускає друк сама по собі**.  
Вона лише зберігає файли з пріоритетами. Запуск — завжди через `CreateJob`.

### Додати в чергу
```
POST /{companyId}/queue/AddItem
Body:
{
  "filesystem": "a1b2c3d4...",    // або
  "file_id": "a1b2c3d4...",
  "groups": [1, 2],               // для яких груп принтерів підходить
  "copies": 3,                    // кількість копій
  "priority": 5                   // 1-10, вищий = важливіший
}
```

**Response:**
```json
{
  "status": true,
  "item": {
    "id": 638,                    // queue item ID → використовується в CreateJob
    "name": "benchy.gcode",
    "copies": 3,
    "priority": 5
  }
}
```

### Отримати чергу
```
GET /{companyId}/queue/Get
Response: { "items": [ { "id": 638, "name": "...", ... } ] }
```

### Видалити з черги
```
DELETE /{companyId}/queue/DeleteItem?id=638
```

### AutoPrint — автоматичний запуск з черги
AutoPrint — це функція SimplyPrint, яка **сама викликає `CreateJob` з `next_queue_item: true`** коли принтер звільняється.  
Це не черга завдань — це подія "принтер operational → взяти наступний item з queue → запустити".

---

## Частина 4 — Відстеження стану: Webhooks

SimplyPrint **штовхає** події на твій URL. Ніякого polling не потрібно.

### Налаштування
```
POST /{companyId}/webhooks/Create
Body:
{
  "url": "https://monofarm.app/webhooks/simplyprint",
  "secret": "your_secret_token",
  "events": ["job.started", "job.done", "job.failed", "job.paused", "job.cancelled"]
}
```

Verifier: SimplyPrint додає `X-SP-Secret: your_secret_token` до кожного запиту.

### Формат payload
```json
{
  "webhook_id": 123,
  "event": "job.started",
  "timestamp": 1702659274,
  "data": {
    "job": {
      "id": 495462,
      "uid": "73a90bde-829e-4b7f-ab2b-7be475633144",
      "panel_url": "https://simplyprint.io/panel/jobs/73a90bde-829e-4b7f-ab2b-7be475633144",
      "started": 1702659274,
      "ended": null
    },
    "user": {
      "id": 1234,
      "first_name": "John",
      "last_name": "Doe"
    }
  }
}
```

### Всі події (event names)

**Print Jobs:**
- `job.started` — принтер почав друкувати
- `job.done` — друк завершений успішно
- `job.failed` — друк провалився
- `job.paused` — пауза
- `job.resumed` — відновлений
- `job.cancelled` — скасований
- `job.bed_cleared` — стіл прибраний (після `ClearBed`)
- `job.objects_skipped` — пропустили об'єкти

**Queue:**
- `queue.add_item` — новий item в черзі
- `queue.delete_item` — item видалено
- `queue.move_item` — змінився порядок
- `queue.revive_item` — повернено в чергу після скасування
- `queue.empty` — черга порожня

**Printer:**
- `printer.autoprint_state_changed`
- `printer.nozzle_size_changed`
- `printer.material_changed`
- `printer.custom_tag_assigned` / `detached`
- `printer.out_of_order_state_changed`
- `printer.ai_state_changed`
- `printer.ai_failure_detected`
- `printer.ai_failure_false_positive`

**Company:**
- `company.autoprint_state_changed`

---

## Частина 5 — Polling як fallback

Якщо webhooks недоступні (локальний dev, немає публічного URL):

```
GET /{companyId}/printers/Get?pid=1234
Response: {
  "data": {
    "printer": {
      "state": "printing",
      "online": true
    },
    "job": {
      "id": 495462,
      "filename": "benchy.gcode",
      "progress": 45,
      "time": { "elapsed": 1200, "remaining": 2800 },
      "started": "2026-01-15T10:00:00Z"
    }
  }
}
```

**Farm overview (одним запитом):**
```
GET /{companyId}/printers/GetFarmOverview
Response: {
  "total": 12,
  "buckets": {
    "operational": { "count": 4, "printers": [{"id": 13, "name": "P1"}] },
    "printing":    { "count": 3, "printers": [...] },
    "awaiting_bed_clear": { "count": 1, "printers": [...] },
    ...
  }
}
```

---

## Частина 6 — Як monofarm має це реалізувати

### ❌ Що Claude зробив неправильно
Claude побудував окрему "чергу завдань" на боці monofarm:
- Власний state machine `queued → uploading → dispatching → printing`
- Worker процес, який тягне завдання з Redis/БД і "відправляє" їх
- Власна логіка матчингу принтер↔файл

**Це дублює логіку SimplyPrint і додає зайву складність.**

### ✅ Правильна архітектура

```
Користувач натискає "Друкувати"
        ↓
POST /files/Upload → отримати filesystem_id
        ↓
POST /printers/actions/CreateJob?pid={printer_id}
  Body: { "filesystem": filesystem_id }
        ↓
Отримати jobIds[0] — зберегти в БД як print_job.external_id
        ↓
Webhook "job.started" → оновити стан в БД
Webhook "job.done"    → оновити стан в БД
Webhook "job.failed"  → alert, оновити стан
```

**Ніякої черги на боці monofarm.** SimplyPrint — це і є черга.

### Таблиця станів print_job в monofarm

| monofarm стан | Тригер | SimplyPrint відповідник |
|---|---|---|
| `uploading` | Після натиску "Print" | — |
| `dispatched` | Після успішного `CreateJob` | `jobIds` отримано |
| `printing` | Webhook `job.started` | `printer.state = printing` |
| `paused` | Webhook `job.paused` | `printer.state = paused` |
| `completed` | Webhook `job.done` | `printer.state = awaiting_bed_clear` |
| `failed` | Webhook `job.failed` | `printer.state = error` |
| `cancelled` | Webhook `job.cancelled` | — |

### Python сервіс dispatch (правильний варіант)

```python
# services/simplyprint_dispatch.py

import httpx
from pathlib import Path

SP_BASE = "https://api.simplyprint.io"
FILES_BASE = "https://files.simplyprint.io"

async def dispatch_print(
    company_id: int,
    api_key: str,
    printer_id: int,
    file_path: Path,
    job_id: int          # monofarm internal job ID
) -> dict:
    headers = {"X-API-KEY": api_key}

    # Крок 1: Upload файлу
    async with httpx.AsyncClient() as client:
        with open(file_path, "rb") as f:
            upload_resp = await client.post(
                f"{FILES_BASE}/{company_id}/files/Upload",
                headers=headers,
                files={"file": (file_path.name, f, "application/octet-stream")},
                timeout=120.0
            )
        upload_resp.raise_for_status()
        upload_data = upload_resp.json()

        if not upload_data.get("status"):
            raise RuntimeError(f"Upload failed: {upload_data.get('message')}")

        filesystem_id = upload_data["file"]["id"]

        # Крок 2: Запуск друку
        create_resp = await client.post(
            f"{SP_BASE}/{company_id}/printers/actions/CreateJob",
            headers={**headers, "Content-Type": "application/json"},
            params={"pid": printer_id},
            json={"filesystem": filesystem_id},
            timeout=30.0
        )
        create_resp.raise_for_status()
        create_data = create_resp.json()

        if not create_data.get("status"):
            raise RuntimeError(f"CreateJob failed: {create_data.get('message')}")

        sp_job_id = create_data["jobIds"][0]

        return {
            "sp_job_id": sp_job_id,
            "filesystem_id": filesystem_id,
            "analysis": upload_data["file"].get("analysis"),
            "cost": create_data["files"][0].get("cost") if create_data.get("files") else None
        }
```

### Webhook receiver (FastAPI)

```python
# routers/webhooks.py

from fastapi import APIRouter, Request, HTTPException
import hmac, hashlib

router = APIRouter()
WEBHOOK_SECRET = "your_secret_token"

@router.post("/webhooks/simplyprint")
async def simplyprint_webhook(request: Request):
    # Перевірка секрету
    secret = request.headers.get("x-sp-secret") or request.headers.get("X-SP-Secret")
    if secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Invalid secret")

    payload = await request.json()
    event = payload["event"]
    data = payload["data"]

    if event == "job.started":
        sp_job_id = data["job"]["id"]
        await update_job_status(sp_job_id, status="printing")

    elif event == "job.done":
        sp_job_id = data["job"]["id"]
        await update_job_status(sp_job_id, status="completed")

    elif event == "job.failed":
        sp_job_id = data["job"]["id"]
        await update_job_status(sp_job_id, status="failed")
        await notify_failure(sp_job_id, data)

    elif event == "job.cancelled":
        sp_job_id = data["job"]["id"]
        await update_job_status(sp_job_id, status="cancelled")

    elif event == "job.bed_cleared":
        sp_job_id = data["job"]["id"]
        await mark_bed_cleared(sp_job_id)

    return {"ok": True}
```

---

## Частина 7 — Порівняння з Bambu LAN dispatch

| Аспект | SimplyPrint | Bambu LAN (monofarm agent) |
|---|---|---|
| Транспорт файлу | HTTPS multipart POST | FTPS :990 |
| Запуск друку | REST `CreateJob` | MQTT `project_file` command |
| Кореляція job | `jobIds[0]` з response | `task_id` в MQTT команді |
| Статус updates | Webhooks (push) | MQTT `push_status` (real-time) |
| State machine | На боці SimplyPrint | На боці monofarm (bambu_lan_dispatch.py) |
| Queue | SimplyPrint queue (опціонально) | Немає — пряме відправлення |

**Висновок**: для SimplyPrint state machine **не потрібна** — вона вже є на їх боці.  
Для Bambu LAN — state machine потрібна, бо ти сам контролюєш весь flow.  
`bambu_lan_dispatch.py` з `queued → validating → uploading → task_creating → printing` — це правильно для Bambu, але **не для SimplyPrint**.

---

## Частина 8 — Отримати список принтерів

```
POST /{companyId}/printers/Get
Headers: X-API-KEY: {key}
Body:
{
  "page": 1,
  "page_size": 50,
  "status": ["operational", "printing", "paused"]   // фільтр за станом
}
```

**Або один принтер:**
```
GET /{companyId}/printers/Get?pid=1234
```

**Ключові поля відповіді для monofarm:**
```json
{
  "id": 1234,
  "printer": {
    "name": "Bambu P1S #1",
    "state": "operational",
    "online": true,
    "integration": "Bambu",            // якщо Bambu Lab принтер
    "model": {
      "name": "P1S",
      "brand": "Bambu Lab",
      "bedSize": [256, 256],
      "maxHeight": 256
    },
    "temps": {
      "current": { "tool": [215], "bed": 55 },
      "target":  { "tool": [220], "bed": 60 }
    },
    "autoprint": false,
    "awaitingBedClear": false          // true після завершення, до ClearBed
  },
  "job": null                          // або об'єкт з деталями поточного друку
}
```

---

## Частина 9 — Повний flow для monofarm (схема)

```
[Frontend: "Start Print" натиснуто]
              ↓
[Backend: POST /files/Upload → filesystem_id]
              ↓
[Backend: POST /printers/actions/CreateJob?pid=X
  body: { filesystem: filesystem_id }]
              ↓
   ┌──────────────────────┐
   │ Response: jobIds[0]  │
   └──────────────────────┘
              ↓
[DB: INSERT print_job (external_id=jobIds[0], status="dispatched")]
              ↓
[Return 202 до фронтенду: { job_id: internal_id }]

═══════════════════════════════════════════════
[Async: SimplyPrint webhook → POST /webhooks/simplyprint]
  event: "job.started"  → UPDATE print_job SET status="printing"
  event: "job.done"     → UPDATE print_job SET status="completed"
  event: "job.failed"   → UPDATE print_job SET status="failed" + alert
  event: "job.paused"   → UPDATE print_job SET status="paused"
═══════════════════════════════════════════════

[Frontend: polling GET /api/print-jobs/{id} або WebSocket subscribe]
```

---

## Частина 10 — Помилки та edge cases

### Принтер не `operational`
```json
{ "status": false, "message": "Printer is not operational" }
```
→ Показати користувачу стан принтера, не ретраїти автоматично.

### Quota exceeded
```json
{ "status": false, "error": "quota_exceeded", "quota_failures": [...] }
```
→ Показати повідомлення про ліміт плану.

### Staggered start (відкладений)
Якщо принтер зайнятий але увімкнений staggered mode:
```json
{ "staggeredPrinterIds": [1234] }
```
→ Принтер в `print_pending`. Скасувати можна через `CancelPendingPrint?pid=1234`.

### Confirmation required (approval flow)
```json
{ "status": true, "token": "confirm_token_abc123" }
```
→ Треба викликати `POST /printers/actions/StartPrint` з цим токеном.

### Webhook не отримано (timeout 30 сек)
Fallback: `GET /printers/Get?pid=X` і порівняти `job.id` з `external_id`.

---

*Версія: 1.0 | Джерело: apidocs.simplyprint.io | Дата: 2026-06*
