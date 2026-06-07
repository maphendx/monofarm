# План реалізації Bambu Cloud Print рівня Printago / AAAA+

## Мета
Побудувати в Monofarm повністю production-ready підсистему Bambu Cloud Print рівня Printago: надійний cloud dispatch, відстеження життєвого циклу job, MQTT-кореляція, retries, idempotency, observability, security та admin diagnostics.

## Принципи
- Не патчити поточний flow точково — винести Bambu Cloud Print в окрему підсистему.
- API-запит не повинен виконувати повний cloud dispatch синхронно.
- Кожен print має мати власний job record та correlation ID.
- Cloud-виклики мають бути idempotent, retry-safe і audit-friendly.
- MQTT/state telemetry повинна підтверджувати фактичний старт/хід/фініш друку.
- Усі секрети шифруються, логуються лише в redacted вигляді.

## Цільова архітектура
1. Auth layer
2. Device layer
3. Dispatch layer
4. Job tracking layer
5. Observability + admin diagnostics

---

## Фаза 1 — Data model і міграції

### 1.1. Розширити модель Organization
Файл: `backend/app/models/organization.py`

Додати поля:
- `bambu_access_token` (encrypted)
- `bambu_refresh_token` (encrypted)
- `bambu_access_token_expires_at`
- `bambu_auth_type` (`password`, `email_code`, `oauth_like`)
- `bambu_user_id`
- `bambu_last_auth_success_at`
- `bambu_last_auth_error`
- `bambu_reauth_required` (bool)

Примітки:
- Поточне поле `bambu_refresh_token` зараз фактично інколи зберігає access token. Потрібно виконати migration strategy без зламу існуючих org.
- Додати compatibility layer на перехідний період.

### 1.2. Створити нову модель `BambuCloudJob`
Новий файл: `backend/app/models/bambu_cloud_job.py`

Поля:
- `id`
- `organization_id`
- `printer_id`
- `gcode_file_id`
- `created_by_user_id`
- `printer_bambu_dev_id`
- `file_name`
- `file_sha256`
- `file_size`
- `region`
- `dispatch_mode` (`cloud`)
- `status` (`queued`, `validating`, `creating_project`, `uploading`, `task_creating`, `task_created`, `acknowledged`, `printing`, `paused`, `completed`, `failed`, `cancelled`, `lost`)
- `status_reason`
- `correlation_id`
- `idempotency_key`
- `bambu_project_id`
- `bambu_model_id`
- `bambu_task_id`
- `request_payload_json`
- `project_response_json`
- `task_response_json`
- `error_code`
- `error_details_json`
- `retry_count`
- `created_at`
- `updated_at`
- `uploaded_at`
- `task_created_at`
- `printer_ack_at`
- `started_printing_at`
- `completed_at`
- `failed_at`
- `last_mqtt_at`

Індекси:
- `(organization_id, created_at desc)`
- `(printer_id, status)`
- `(idempotency_key)` unique
- `(correlation_id)` unique
- `(printer_bambu_dev_id, status)`

### 1.3. Розширити `PrintHistory`
Файл: `backend/app/models/print_history.py`

Додати поля:
- `bambu_cloud_job_id`
- `result_reason`
- `source` (`cloud`, `lan`, `moonraker`, `manual`)
- `created_by_user_id`
- `file_sha256`
- `bambu_task_id`
- `bambu_project_id`

### 1.4. Alembic міграції
Файли:
- `backend/alembic/versions/<new>.py`

Завдання:
- створити таблицю `bambu_cloud_jobs`
- додати нові колонки в `organizations`
- додати нові колонки в `print_history`
- додати потрібні індекси і constraints

---

## Фаза 2 — Auth/token manager

### 2.1. Винести auth-логіку в окремий сервіс
Новий файл: `backend/app/services/bambu_auth.py`

Реалізувати:
- `get_valid_access_token(org_id: int) -> str`
- `refresh_access_token(org_id: int) -> str`
- `login_with_password(org_id: int) -> str`
- `login_with_email_code(email, code, region) -> AuthResult`
- `mark_reauth_required(org_id: int, reason: str)`
- `store_auth_result(...)`

### 2.2. Locking
Додати per-org lock на refresh/login, щоб уникнути одночасного refresh storm.

### 2.3. Refactor `api/orgs.py`
Файл: `backend/app/api/orgs.py`

Змінити:
- `/me/bambu-send-code`
- `/me/bambu-verify-code`

Після verify:
- заповнювати нові поля
- не плутати access/refresh token
- перезапускати Bambu init через сервісний метод

### 2.4. Backward compatibility
У `bambu.py` та auth manager додати fallback на старі поля, доки всі org не мігровані.

---

## Фаза 3 — Dispatch engine

### 3.1. Створити окремий dispatch service
Новий файл: `backend/app/services/bambu_dispatch.py`

Реалізувати функції:
- `build_idempotency_key(...)`
- `create_cloud_job(...)`
- `prepare_cloud_job(...)`
- `dispatch_cloud_job(job_id: int)`
- `create_project_with_retry(...)`
- `upload_project_with_retry(...)`
- `create_task_with_retry(...)`
- `fail_job(...)`
- `advance_job_status(...)`
- `attach_task_response(...)`

### 3.2. Retry policy
Вимоги:
- 401/403 -> refresh/login -> один повтор
- 5xx/timeouts -> exponential backoff 3-5 разів
- network errors -> retryable
- validation errors -> non-retryable

### 3.3. Idempotency
При створенні job:
- якщо існує job з тим самим `idempotency_key` у незавершеному/успішному стані -> повертати його замість створення нового.

### 3.4. File integrity
Під час `prepare_cloud_job(...)`:
- перевірка `.3mf`
- `sha256`
- `file_size`
- нормалізація filename
- optional sanity-check структури 3mf

---

## Фаза 4 — API refactor

### 4.1. Refactor `send_to_printer`
Файл: `backend/app/api/files.py`

Замість прямого виклику `bambu_svc.cloud_upload_and_print(...)`:
- створювати `BambuCloudJob`
- класти job в чергу
- повертати `202 Accepted` + `job_id` + status `queued`

### 4.2. Нові API endpoints
Новий/оновлений файл: `backend/app/api/files.py` або окремий `backend/app/api/bambu_jobs.py`

Додати:
- `GET /bambu-jobs/{job_id}`
- `GET /bambu-jobs` (list/filter)
- `POST /bambu-jobs/{job_id}/retry`
- `POST /bambu-jobs/{job_id}/cancel`
- `GET /printers/{id}/active-job`
- `GET /orgs/me/bambu-health`

### 4.3. DTO/schema updates
Файли:
- `backend/app/schemas/...`

Додати Pydantic schema для:
- `BambuCloudJobOut`
- `BambuHealthOut`
- `BambuJobListOut`
- `BambuRetryResult`

---

## Фаза 5 — Worker/queue

### 5.1. Створити worker для Bambu jobs
Новий файл: `backend/app/workers/bambu_jobs.py`

Реалізувати:
- polling/queue consumer
- `run_bambu_cloud_job(job_id)`
- retry scheduling
- dead-letter handling

### 5.2. Вибір механізму черги
Якщо вже є інфраструктура Redis/workers — використати її.
Інакше:
- Redis queue
- або APScheduler only as temporary bridge (не рекомендовано для production)

### 5.3. Concurrency control
- lock per `printer_id`
- org-level rate limit
- max concurrent uploads per org

---

## Фаза 6 — MQTT correlation та state machine

### 6.1. Розширити `_on_message`
Файл: `backend/app/services/bambu.py`

Завдання:
- при кожному status update шукати активний `BambuCloudJob` для `dev_id`
- оновлювати job state:
  - `task_created` -> `acknowledged`
  - `acknowledged` -> `printing`
  - `printing` -> `completed/failed/cancelled`
- оновлювати `last_mqtt_at`
- зберігати `progress_pct`, `eta_minutes`, `error_msg`

### 6.2. State machine rules
Новий файл: `backend/app/services/bambu_job_state.py`

Описати дозволені transitions і заборонити нелогічні стрибки.

### 6.3. Lost/stuck detection
Scheduler/worker має позначати jobs як `lost` або `stuck`, якщо:
- task створено, але немає ack
- немає MQTT heartbeats надто довго
- друк завис у проміжному стані

---

## Фаза 7 — Print history integration

### 7.1. Автоматично створювати `PrintHistory`
При переході job у `printing` або `completed`:
- створити/оновити `PrintHistory`
- зв'язати з `bambu_cloud_job_id`

### 7.2. Finalization
При `completed/failed/cancelled`:
- обчислити duration
- записати result/result_reason
- записати task/project ids

---

## Фаза 8 — Observability

### 8.1. Structured logs
Файли:
- `backend/app/services/bambu.py`
- `backend/app/services/bambu_dispatch.py`
- `backend/app/services/bambu_auth.py`

Додати event-based logs:
- `bambu.auth.login.success`
- `bambu.auth.login.failed`
- `bambu.cloud.job.created`
- `bambu.cloud.project.created`
- `bambu.cloud.upload.completed`
- `bambu.cloud.task.created`
- `bambu.cloud.job.failed`
- `bambu.mqtt.state.changed`

У кожному логові:
- `org_id`
- `printer_id`
- `dev_id`
- `job_id`
- `correlation_id`

### 8.2. Metrics
Додати counters/timers:
- auth success/fail
- refresh success/fail
- dispatch latency
- upload latency
- task create latency
- print success rate
- error rate by error_code

### 8.3. Admin diagnostics endpoint
Додати `GET /orgs/me/bambu-health`
Повернути:
- auth configured?
- reauth required?
- region
- user_id present?
- cloud mqtt connected?
- printers discovered
- printers online
- last auth success
- last auth error
- active job count
- stuck job count

---

## Фаза 9 — Error taxonomy

### 9.1. Створити error codes enum
Новий файл: `backend/app/services/bambu_errors.py`

Коди:
- `AUTH_INVALID`
- `AUTH_EXPIRED`
- `REGION_MISMATCH`
- `DEVICE_NOT_FOUND`
- `DEVICE_OFFLINE`
- `PROJECT_CREATE_FAILED`
- `OSS_UPLOAD_FAILED`
- `TASK_CREATE_FAILED`
- `MQTT_NOT_CONNECTED`
- `MQTT_ACK_TIMEOUT`
- `PRINT_FAILED_HMS`
- `PRINT_CANCELLED_BY_USER`
- `RETRY_EXHAUSTED`
- `INVALID_3MF`
- `IDEMPOTENCY_REPLAY`

### 9.2. UI-safe messages
Для кожного error code дати:
- technical message
- user-friendly message
- retryable flag

---

## Фаза 10 — Security

### 10.1. Secrets hygiene
- Ніколи не логувати raw access/refresh tokens
- Redact email/access_code/token в exceptions/logs
- Переглянути всі log.exception у Bambu flow

### 10.2. RBAC
Перевірити:
- хто може connect/disconnect Bambu
- хто може send print
- хто може retry/cancel jobs
- хто бачить diagnostics

### 10.3. Rate limits
Додати rate limits на:
- send-code
- verify-code
- print dispatch
- retry job

---

## Фаза 11 — Frontend/API contract

### 11.1. UI flow
Потрібно реалізувати або оновити фронтенд під такі стани:
- `Bambu connected`
- `Needs reauth`
- `MQTT degraded`
- `Queued`
- `Uploading`
- `Waiting for printer`
- `Printing`
- `Paused`
- `Completed`
- `Failed`

### 11.2. Printer settings UI
Для Bambu принтера показувати:
- cloud vs lan mode
- dev_id
- model
- online
- last seen
- active job

### 11.3. Jobs UI
Сторінка або drawer з історією job:
- status timeline
- errors
- retries
- payload summary
- raw diagnostic info for admins

---

## Фаза 12 — Тести

### 12.1. Unit tests
Файли:
- `backend/tests/services/test_bambu_auth.py`
- `backend/tests/services/test_bambu_dispatch.py`
- `backend/tests/services/test_bambu_state_machine.py`

Покрити:
- token refresh flows
- retry logic
- idempotency
- status transitions
- error mapping

### 12.2. Integration tests
- mock Bambu `/project`
- mock OSS upload
- mock `/task`
- test `send_to_printer` -> queue -> worker -> job completed
- test 401->refresh->retry
- test duplicate click/idempotency replay

### 12.3. MQTT simulation tests
- fake MQTT report payloads
- verify job transitions via `_on_message`
- verify lost/stuck detection

### 12.4. Regression tests
- старий org config не ламається
- старий cloud flow мігрує плавно
- LAN path лишається робочим

---

## Фаза 13 — Rollout strategy

### 13.1. Feature flag
Додати feature flag:
- `BAMBU_CLOUD_JOB_V2_ENABLED`

### 13.2. Shadow mode
Перший етап:
- створювати job records і diagnostics
- але ще використовувати старий direct dispatch

Другий етап:
- нові org -> тільки через worker/job system

Третій етап:
- всі org перевести на job system

### 13.3. Backfill/migration
- backfill `PrintHistory` links де можливо
- migrate old auth fields
- cleanup legacy paths після стабілізації

---

## Definition of Done (AAAA+)
Система вважається готовою, якщо:
- Bambu account можна підключити через email-code без ручного втручання
- принтери discovery/claim працюють стабільно
- `send to printer` створює job, а не виконує cloud dispatch у request thread
- кожен job має повний lifecycle і correlation ID
- duplicate send не створює double-print
- 401/timeout/5xx обробляються retries/refresh логікою
- MQTT підтверджує реальний старт/стан/завершення друку
- є admin diagnostics + health endpoint
- є structured logs + metrics
- є unit/integration tests на критичні сценарії
- є feature-flag rollout plan
- legacy orgs не ламаються

---

## Пріоритети для Claude Code

### P0 — обов'язково спочатку
1. Міграції + `BambuCloudJob`
2. Auth manager + нова token model
3. Dispatch service + idempotency
4. Refactor `send_to_printer` на queue/job
5. Worker execution path
6. MQTT correlation

### P1
7. PrintHistory integration
8. Admin diagnostics endpoint
9. Error taxonomy
10. Structured logs + metrics

### P2
11. Frontend job timeline
12. Rate limits / security hardening
13. Shadow rollout / feature flag cleanup

---

## Інструкція для Claude Code
1. Спочатку зроби аналіз наявних моделей і сервісів, але не змінюй усе хаотично.
2. Почни з міграцій і нової моделі `BambuCloudJob`.
3. Потім створи `bambu_auth.py` і винеси token lifecycle туди.
4. Потім створи `bambu_dispatch.py` з ідемпотентним dispatch flow.
5. Потім переведи `send_to_printer` на створення job замість прямого dispatch.
6. Далі створи worker execution.
7. Потім додай MQTT correlation і state machine.
8. Після цього — diagnostics, tests, cleanup legacy code.
9. На кожному кроці не ломи LAN path і backward compatibility.
10. Кожен етап завершуй тестами і коротким технічним changelog.
