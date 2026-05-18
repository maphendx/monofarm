# Contributing to monofarm

## Branches

| Branch | Призначення |
|--------|-------------|
| `main` | Production. Завжди стабільна. Деплоїться автоматично. |
| `dev`  | Staging / integration. Всі PR ідуть сюди. |
| `feature/xxx` | Нова функціональність — гілкується від `dev`. |
| `fix/xxx` | Баг-фікс — від `dev` (або від `main` для hotfix). |

## Workflow

```bash
# 1. Взяти свіже з dev
git checkout dev && git pull

# 2. Створити гілку
git checkout -b feature/printer-groups

# 3. Розробляти, комітити
git commit -m "feat: add printer groups endpoint"

# 4. Push і відкрити PR → dev
git push -u origin feature/printer-groups
```

## Commit messages

```
feat: нова функція
fix: виправлення бага
chore: рефакторинг / залежності / CI
docs: документація
agent: зміни в agent/
```

## Версіювання агента

При змінах у `agent/` — збампати версію в **трьох** файлах:
- `agent/monofarm_agent.py`
- `agent/monofarm_tray.py`
- `backend/app/api/agent.py`

Схема: `major.minor.patch`
- **patch** — дрібний фікс, UI твік
- **minor** — нова фіча, нова секція
- **major** — великий реліз

## Локальний запуск

```bash
# Backend
cd backend && pip install -r requirements.txt
docker compose up -d db
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend && bun install && bun run dev

# Tests
cd backend && pytest
ruff check .
```

## PR Checklist

- Тести проходять
- Lint чистий
- Міграція додана якщо змінилась схема
- `.env.example` оновлений якщо нові змінні
