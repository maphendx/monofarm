# Claude Code (`.claude/`)

This folder is the project **control center** for Claude Code: settings, hooks, rules, commands, and agents. See the [directory reference](https://code.claude.com/docs/en/claude-directory.md).

| Path | Purpose |
|------|---------|
| `settings.json` | Shared permissions and hooks (e.g. Graphify PreToolUse). Safe to commit. |
| `settings.local.json` | Personal overrides (gitignored). |
| `rules/` | Path-scoped instructions; load when matching files are in play. |
| `commands/` | Slash workflows you trigger (`/backend-test`, etc.). |
| `agents/` | Custom subagents for delegated tasks. |

For private preferences without polluting team context, use root **`CLAUDE.local.md`** (gitignored).
