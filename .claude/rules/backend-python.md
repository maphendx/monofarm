---
paths:
  - "backend/**/*.py"
---

# Backend (FastAPI / SQLAlchemy)

Long-form context stays in root `CLAUDE.md`. When editing Python under `backend/`:

- **Python 3.14**: use `bcrypt` + **PyJWT**; do not add `passlib`, `python-jose`, or pinned `psycopg-binary`.
- **Moonraker**: normalize printer URLs with `_api_base()` before HTTP; tolerate timeouts → treat as offline where the code already does.
- **Slots**: `loaded_filaments` and API `slot_map` are **0-based**; UI is 1-based at render only.
- **Tests**: integration tests use `printfarm_test` DB and mocks; app **lifespan** (scheduler, MQTT, Telegram) does not run under typical test client usage.
