---
paths:
  - "backend/app/api/**"
  - "backend/app/schemas/**"
---

# API conventions

Long-form context in root `CLAUDE.md`. Rules for every new endpoint.

## URL prefix

All routers are registered under `/api` in `main.py`. Router-level `prefix=` does not include `/api` — it gets prepended at registration. Final URLs: `/api/printers`, `/api/warehouse`, etc.

## Auth — always both deps together

```python
org: Organization = Depends(get_current_org),
user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
```

- `get_current_org()` — resolves org from JWT, auto-downgrades expired plans to `free`, returns `Organization`.
- `require_roles(*roles)` — returns the authenticated `User`; raises 403 if role not in list.
- **Always use both.** `get_current_org` alone does not check role. `require_roles` alone does not return the org.
- Name the org param `org` and the user param `user` or `_user` (prefix `_` when unused).

## Org isolation — mandatory filter on every query

Every DB query must filter by `organization_id`. Never omit this:

```python
# correct
db.query(Printer).filter_by(organization_id=org.id, id=printer_id).first()

# wrong — leaks other orgs' data
db.query(Printer).filter_by(id=printer_id).first()
```

Use the existing `_get_product()` / `_get_warehouse()` / `_get_spec()` helpers in `warehouse.py` — they already include org isolation and raise 404 correctly.

## Role conventions

| Endpoint type | Roles |
| --- | --- |
| Read-only data | `admin, operator, manager` (or `get_current_org` only if truly public within org) |
| Create / update | `admin, operator` |
| Delete / destructive | `admin` |
| User management, org settings, billing | `admin` only |

## Pagination

No framework-level pagination yet — large lists are returned in full. For new endpoints on potentially large tables (movements, history, orders) add `skip: int = 0, limit: int = 100` query params and apply `.offset(skip).limit(limit)` on the query.

## Response patterns

- Use Pydantic `response_model=` on every endpoint.
- `POST` → `status_code=201`, return created object.
- `DELETE` → `status_code=204`, return `None`.
- `PATCH` → return updated object.
- Raise `HTTPException(404)` when resource not found, `403` for permission denied, `400` for business rule violations (not validation errors).

## Schema naming

`XxxCreate` for POST body, `XxxUpdate` for PATCH body, `XxxOut` for responses. Keep schemas in `app/schemas/` — never define Pydantic models inline in the router file.
