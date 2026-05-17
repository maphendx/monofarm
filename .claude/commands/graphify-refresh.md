---
description: Refresh Graphify code graph (AST-only update)
allowed-tools: Bash
---

From the **repository root**, prefer the project venv when present:

```bash
. .venv-graphify/bin/activate 2>/dev/null || true
graphify update .
```

If the tool reports no topology changes, that is normal. Mention:

- `graphify update . --force` to rewrite outputs anyway
- `graphify extract .` when an LLM API key is configured, for full semantic extraction (see `graphify --help`)
