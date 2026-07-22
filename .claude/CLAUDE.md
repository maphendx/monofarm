# Claude Code (`.claude/`)

This folder is the project **control center** for Claude Code: settings, hooks, rules, commands, and agents. See the [directory reference](https://code.claude.com/docs/en/claude-directory.md).

| Path | Purpose |
| --- | --- |
| `settings.json` | Shared permissions and hooks (e.g. Graphify PreToolUse). Safe to commit. |
| `settings.local.json` | Personal overrides (gitignored). |
| `rules/backend-python.md` | Python/FastAPI conventions (slots, Moonraker, Python 3.14). |
| `rules/frontend-next.md` | Next.js conventions (Tailwind v4, API client, design tokens). |
| `rules/components.md` | Component subfolder structure + import paths. |
| `rules/api-conventions.md` | API: URL prefix, auth deps, org isolation, response patterns. |
| `rules/warehouse.md` | Warehouse/ERP: stock ledger, AVCO, order/batch state machines. |
| `rules/agent.md` | Local farm agent: version bumps, wire protocol, auth. |
| `rules/migrations.md` | Alembic: sequential naming, never edit applied migrations. |
| `commands/` | Slash workflows you trigger (`/backend-test`, etc.). |
| `agents/` | Custom subagents for delegated tasks. |
| `skills/apple-design/SKILL.md` | Apple HIG-style motion/interaction design guidance (springs, gestures, materials, typography), from [emilkowalski/skills](https://github.com/emilkowalski/skills). Auto-loaded by Claude Code for gesture/animation/motion frontend work; Codex reads it via the `AGENTS.md` pointer. |

For private preferences without polluting team context, use root **`CLAUDE.local.md`** (gitignored).
