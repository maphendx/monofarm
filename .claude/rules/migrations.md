---
paths:
  - "backend/alembic/**"
---

# Alembic migrations

- **Always use sequential naming:** `0031_description.py`, `0032_description.py` etc. Never commit a migration with the auto-generated UUID filename (`426df3a62f96_...`). Rename immediately after generation.
- **One migration per feature** — don't bundle unrelated schema changes.
- **Never edit an applied migration** — always create a new one.
- Current head: `0030`. Next: `0031`.
- The `revision` and `down_revision` fields inside the file are what Alembic uses — the filename is cosmetic but must be consistent.
