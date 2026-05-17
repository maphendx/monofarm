---
paths:
  - "frontend/**/*.tsx"
  - "frontend/**/*.ts"
---

# Frontend (Next.js)

Long-form context stays in root `CLAUDE.md`. When editing under `frontend/`:

- **Tooling**: Bun; **Tailwind v4** in `app/globals.css` — **restart** `bun run dev` after changing that file.
- **API client**: `src/lib/api.ts` — inject JWT from storage; **omit** `Content-Type: application/json` for `FormData` bodies.
- **Dark mode**: class-based `.dark` (see layout script in `CLAUDE.md`).
