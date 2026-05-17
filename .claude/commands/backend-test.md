---
description: Run backend ruff and pytest
allowed-tools: Bash
---

From the **repository root**, run backend checks:

1. `cd backend`
2. Activate the venv if present: `. .venv/bin/activate`
3. `ruff check .`
4. `pytest` (use `pytest tests/unit -q` if the user asked for a quick unit-only pass)

Summarize pass/fail. If the venv is missing, tell them to create it per root `CLAUDE.md` (Commands section).
