# monofarm: оцінка й план переходу backend на Go

Дата: 2026-09-11. Статус: план, міграцію не розпочато.

## Рішення

Повне переписування зараз не рекомендоване без підтвердженого обмеження Python/FastAPI або довгострокового рішення підтримувати Go командою. Рекомендовано вимірювання та обмежений Go-пілот, після якого можна залишити гібридну систему або продовжити міграцію доменів. Сучасність мови не є самостійним критерієм успіху.

Зміна backend не повинна бути одним релізом із запланованою модернізацією TypeScript/Bun/Next. Виправлення відомих проблем білінгу й безпеки виконати незалежно; не переносити їх як бажану поведінку до нового backend.

## Переваги та межі

- Go має легкі goroutines, паралельне виконання на ядрах і context cancellation. Це зручна основа для великої кількості мережевих з'єднань, але потребує bounded queues, backpressure та контролю lifecycle.
- Є потенціал зменшити CPU/RSS на однаковому навантаженні. Кратність виграшу для monofarm не виміряна; Go також має GC та може витрачати багато пам'яті на буфери.
- Компіляція перевіряє типи між модулями; однак не доводить правильність org scope, авторизації чи складського ledger.
- Compiled binary спрощує deployment окремого сервісу. Повністю статична збірка залежить від CGO/native dependencies; multi-service система не стає автоматично простішою.
- Є стандартні засоби тестування, race detector, fuzzing, profiling і vulnerability analysis.
- Go не прискорює очікування принтера/Bambu API/БД саме по собі, не виправляє SQL і не скасовує міжпроцесну маршрутизацію.

## Вартість саме для monofarm

Мігрує не лише HTTP framework: Pydantic validation/serialization, dependency auth, SQLAlchemy transactions, Alembic lifecycle, JWT/bcrypt/Fernet, Redis routing, MQTT, HTTP/FTPS, storage, Telegram, scheduler, ReportLab, Pillow, openpyxl.

Найдорожчі області: склад і AVCO; завершення друку → склад; Bambu acknowledgments/AutoPrint; session revocation і tenant boundaries; відновлення перерваних потоків; документи та імпорт/експорт.

Python-агент є окремим продуктом. Заміна FastAPI не потребує переписування агента або зміни його wire protocol.

## Архітектура переходу

Зберегти зовнішній API host і URL. Reverse proxy направляє явно перенесені маршрути у Go, решту — у FastAPI. Не створювати багато мікросервісів: спочатку один Go deployment із чіткими модулями; окремий gateway process лише для виправданої lifecycle/scaling межі.

PostgreSQL залишається існуючим джерелом істини. На перехідний період один schema migration runner (Alembic), одна система-власник запису кожного домену/організації. Не використовувати dual write або fallback mutation після неоднозначного результату.

Для Go кандидат: стандартний net/http, pgx для PostgreSQL, sqlc для перевірюваних SQL-access methods, явні DTO/validation та OpenAPI contract. Конкретні версії клієнтів Redis/MQTT/S3/WebSocket і ліцензії перевірити під час пілота. Не очікувати, що ORM автоматично відтворить поведінку SQLAlchemy.

## Етап 0 — вимірювання та критерій інвестиції

1. Профілювати API, SQL, event loop, worker, Redis, transfers і streams окремо. Фіксувати p50/p95/p99, RSS/CPU, connection counts, timeouts та throughput.
2. Навантаження: невелика ферма, типова цільова ферма і прогнозований пік; однакові дані/машина/налаштування БД. Для принтерів — simulator і записані очищені повідомлення.
3. Спочатку прибрати підтверджені проблеми SQL, блокувальних викликів і необмежених буферів у поточному backend. Оптимізований Python — контроль для Go.
4. Погодити критерій: менша вартість за потрібного SLO, достатній запас під прогнозоване навантаження або виміряне спрощення супроводу. Врахувати витрати міграції та двох стеків.
5. Якщо користь недостатня — завершити пілот без решти переписування. Не обіцяти конкретний строк до цієї оцінки.

## Етап 1 — контракти й безпечна основа

- Експортувати OpenAPI і сформувати black-box tests незалежні від реалізації сервера; Python HTTP-тести можна запускати проти Go, імпорти Python helpers — ні.
- Зберегти методи/paths, pagination, порядок, enum strings, decimal serialization, null/omitted, UTC/timezones, коди помилок включно з validation, CORS/cache headers, multipart і download semantics.
- Перевірити JWT typ/ver/exp, актуальні user role/org/active/session_version, API keys, password revocation, platform-admin impersonation. Shared gateway headers не є доказом identity без захищеної внутрішньої межі.
- Зберегти 0-based slots, double extension .gcode.3mf, двопрохідний remap і Bambu AMS semantics.
- Перевірити читання існуючих bcrypt hashes і Fernet ciphertext через сумісні vetted implementations/test vectors. Не замінювати криптоформат без окремої міграції.
- Go skeleton: deadlines, graceful shutdown, limits, JSON logs/traces, readiness, unit/integration tests, race/fuzz checks, govulncheck та pinned toolchain.

## Етап 2 — два обмежені пілоти

Пілот A: чистий read-only endpoint, наприклад список категорій складу після підтвердження відсутності side effects. Він перевіряє auth, SQL, DTO і deployment, але сам по собі не доводить виграш Go для realtime.

Пілот B: стендовий agent gateway із simulator, uploads/camera streams/reconnects. Перевірити ресурсну перевагу в області, де вона очікується.

Shadow comparison дозволений тільки для перевірених операцій без side effects. Не дублювати довільні GET: поточні reads можуть оновлювати тариф, опитувати пристрої або змінювати кеш. Для таких випадків використовувати fixtures/відокремлений стенд.

Вихід: contract parity і виміряна користь. Go може залишитися невеликим сервісом; це нормальний фінальний результат, якщо повна міграція не окупається.

## Етап 3 — agent gateway, якщо пілот успішний

- Перенести socket ownership і transport lifecycle як цілісну область; бізнес-команди спочатку залишаються у Python.
- Відтворити Redis leases, connection fencing, permits/ACK, fragmentation, progress, bounded camera queues, cancellation, TTL і fail-closed semantics.
- Зберегти перевірку tenant admin і періодичне відкликання agent session.
- Один socket owner та один executor на конкретну організацію/connection. Перемикати контрольовано з drain/reconnect, а не випадково балансувати активні з'єднання.
- Python/Go Redis compatibility довести contract tests до змішаного запуску. ACK означає transport delivery, не фізичне виконання.
- Go Redis client не має автоматично повторювати неоднозначно доставлений command publish; перевірити фактичні retry defaults.
- Redis HA, bandwidth і protocol design залишаються окремими завданнями. Зміна мови не робить Pub/Sub durable.

## Етап 4 — домени HTTP API та workers

Після відпрацювання read-only маршрутизації переносити незалежні домени, встановлюючи єдиного writer для кожного. Орієнтовний порядок: каталоги/довідники; організації/користувачі після повного security parity; file metadata/storage; jobs/history; інтеграції та scheduler.

Стан підписок і білінг переносити лише після виправлення поточних багів і появи незалежного lifecycle test suite. Один webhook processor та один scheduler leader у будь-який момент.

Не розривати існуючу транзакцію на Python→Go HTTP-виклики посеред commit. Перед переносом визначити всі її entrypoints, включно з worker і суміжними доменами.

## Етап 5 — склад і виробництво

- Окремі tests для stock/reserved/cells, AVCO, partial completion, брак, returns, transfers, cancellations, concurrent updates та повторних подій.
- Використовувати точні decimal/integer representations; не переводити Numeric суми у float64.
- Зберегти locking, isolation і порядок AVCO/movement; відтворити standalone vs batch path.
- Мігрувати всі пов'язані writers разом: завершення print task, filaments, batch close, orders і movements. Межа маршруту не завжди збігається з межею транзакції.
- На cutover звірити залишки, резерви й ledger на незмінному зрізі; мати maintenance/drain варіант, якщо live switch не можна зробити безпечним.

## Етап 6 — завершення повного переходу, якщо це залишається ціллю

- PDF/labels, зображення, XLSX і Telegram можуть тимчасово лишитися Python workers. Це гібрид, а не 100% Go backend.
- Для повного Go перенесення замінити ці реалізації й перевірити документні/візуальні результати, Unicode, баркоди та сумісність імпорту.
- Після зникнення всіх FastAPI routes/jobs вимкнути Python API. Після заміни всіх Python workers і передачі schema migration ownership можна прибрати Python backend runtime; edge agent не входить у цей критерій.
- Alembic applied migrations не переписувати. Перехід на новий migration runner — окрема baseline-процедура зі збереженою історією та перевіреним станом БД.

## Приймання та відкат

Для кожного етапу: black-box contracts, PostgreSQL/Redis integration, tenant isolation, timeouts/cancellation, resource limits і регресійні сценарії. Фізичні команди перевіряти на окремому тестовому обладнанні; не відтворювати production-команди повторно.

Rollback повертає traffic/writer ownership після зупинки нових writers і завершення/обліку in-flight операцій. Попередній код повинен уміти читати нові записи; використовувати expand/contract schema changes. Перемикання proxy не відкочує дані або фізичний друк.

Після кожного пілота переглядати рішення та estimate. Повний перенос має вартість інвентаризації доменів, переносу, валідації обладнання й періоду стабілізації; кількість згенерованих рядків Go не вимірює готовність.

## Джерела

- https://go.dev/doc/effective_go
- https://go.dev/doc/gc-guide
- https://go.dev/doc/database/execute-transactions
- https://go.dev/doc/security/
- https://fastapi.tiangolo.com/async/
- https://pkg.go.dev/github.com/jackc/pgx/v5
- https://docs.sqlc.dev/en/latest/
- Локальні: backend/requirements.txt, app/api/deps.py, app/core/security.py, app/services/encryption.py, app/services/tunnel_router.py, app/api/tasks.py, app/api/warehouse_modules/, docs/AGENT_TUNNEL_ROUTING.md.
