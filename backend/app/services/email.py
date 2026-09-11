"""Transactional email via Resend HTTP API.

Without RESEND_API_KEY → log-only (dev). Never raises — email failure must
not break the auth flow (anti-enumeration: caller always returns the same response).
"""
import logging

import requests

from app.core.config import settings

log = logging.getLogger(__name__)
_RESEND_URL = "https://api.resend.com/emails"


def _send(to: str, subject: str, html: str) -> bool:
    if not settings.RESEND_API_KEY:
        if settings.ENV == "production":
            log.error("Email delivery disabled: RESEND_API_KEY is not configured")
            return False
        log.info("[email dev] to=%s subj=%s\n%s", to, subject, html)
        return True
    try:
        resp = requests.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
            json={
                "from": settings.EMAIL_FROM,
                "to": [to],
                "reply_to": settings.EMAIL_REPLY_TO,
                "subject": subject,
                "html": html,
            },
            timeout=10,
        )
        if resp.status_code >= 300:
            log.error("Resend delivery failed with status %s", resp.status_code)
            return False
        return True
    except Exception:  # noqa: BLE001
        log.exception("Resend send failed")
        return False


def send_password_reset(to: str, name: str, reset_url: str) -> bool:
    return _send(to, "Відновлення паролю MonoFarm", _render_reset(name or to, reset_url))


def send_welcome(to: str, name: str) -> bool:
    return _send(to, "Вітаємо у MonoFarm", _render_welcome(name or to))


def send_email_verification(to: str, name: str, verify_url: str) -> bool:
    return _send(to, "Підтвердіть email у MonoFarm", _render_verify(name or to, verify_url))


def send_invite(to: str, inviter_name: str, org_name: str, invite_url: str) -> bool:
    return _send(to, f"Запрошення до {org_name} у MonoFarm", _render_invite(inviter_name, org_name, invite_url))


# ── HTML templates ────────────────────────────────────────────────────────────

def _base(title: str, body: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="uk">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:system-ui,sans-serif;color:#e5e5e5">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0"
             style="background:#141414;border:1px solid #262626;border-radius:12px;padding:40px 32px">
        <tr><td>
          <p style="margin:0 0 24px;font-size:22px;font-weight:600;color:#fff">monofarm</p>
          {body}
          <hr style="border:none;border-top:1px solid #262626;margin:32px 0">
          <p style="margin:0;font-size:12px;color:#525252">
            Це автоматичний лист. Відповідати не потрібно —
            пишіть на <a href="mailto:support@monofarm.app"
            style="color:#06b6d4">support@monofarm.app</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def _render_reset(name: str, reset_url: str) -> str:
    body = f"""
      <h2 style="margin:0 0 8px;font-size:18px;color:#fff">Відновлення паролю</h2>
      <p style="margin:0 0 24px;color:#a3a3a3">Привіт, {name}!</p>
      <p style="margin:0 0 24px;color:#a3a3a3">
        Ми отримали запит на скидання паролю вашого акаунту MonoFarm.
        Посилання дійсне {settings.PASSWORD_RESET_TTL_MINUTES}&nbsp;хвилин.
      </p>
      <a href="{reset_url}"
         style="display:inline-block;padding:12px 24px;background:#0891b2;color:#fff;
                text-decoration:none;border-radius:8px;font-weight:500">
        Встановити новий пароль
      </a>
      <p style="margin:24px 0 0;font-size:13px;color:#525252">
        Якщо ви не запитували скидання — проігноруйте цей лист.
      </p>"""
    return _base("Відновлення паролю MonoFarm", body)


def _render_verify(name: str, verify_url: str) -> str:
    body = f"""
      <h2 style="margin:0 0 8px;font-size:18px;color:#fff">Підтвердіть ваш email</h2>
      <p style="margin:0 0 24px;color:#a3a3a3">Привіт, {name}!</p>
      <p style="margin:0 0 24px;color:#a3a3a3">
        Натисніть кнопку нижче щоб підтвердити адресу email.
        Посилання дійсне 72&nbsp;години.
      </p>
      <a href="{verify_url}"
         style="display:inline-block;padding:12px 24px;background:#0891b2;color:#fff;
                text-decoration:none;border-radius:8px;font-weight:500">
        Підтвердити email
      </a>
      <p style="margin:24px 0 0;font-size:13px;color:#525252">
        Якщо ви не реєструвались — проігноруйте цей лист.
      </p>"""
    return _base("Підтвердіть email — MonoFarm", body)


def _render_invite(inviter_name: str, org_name: str, invite_url: str) -> str:
    body = f"""
      <h2 style="margin:0 0 8px;font-size:18px;color:#fff">Вас запрошено до {org_name}</h2>
      <p style="margin:0 0 24px;color:#a3a3a3">
        <strong style="color:#fff">{inviter_name}</strong> запрошує вас приєднатись до
        команди <strong style="color:#fff">{org_name}</strong> у MonoFarm.
      </p>
      <a href="{invite_url}"
         style="display:inline-block;padding:12px 24px;background:#0891b2;color:#fff;
                text-decoration:none;border-radius:8px;font-weight:500">
        Прийняти запрошення
      </a>
      <p style="margin:24px 0 0;font-size:13px;color:#525252">
        Посилання дійсне 7 днів.
      </p>"""
    return _base(f"Запрошення до {org_name} — MonoFarm", body)


def _render_welcome(name: str) -> str:
    body = f"""
      <h2 style="margin:0 0 8px;font-size:18px;color:#fff">Вітаємо у MonoFarm!</h2>
      <p style="margin:0 0 24px;color:#a3a3a3">Привіт, {name}!</p>
      <p style="margin:0;color:#a3a3a3">
        Ваш акаунт успішно створено. Увійдіть і налаштуйте свою 3D-ферму.
      </p>"""
    return _base("Вітаємо у MonoFarm", body)
