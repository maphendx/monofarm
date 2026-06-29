---
name: "source-command-frontend-check"
description: "Run frontend lint and production build"
---

# source-command-frontend-check

Use this skill when the user asks to run the migrated source command `frontend-check`.

## Command Template

From the **repository root**:

```bash
cd frontend && bun run lint && bun run build
```

Summarize pass/fail and any actionable errors.
