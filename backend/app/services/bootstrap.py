import logging

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_password
from app.models.user import User, UserRole


log = logging.getLogger(__name__)


def seed_admin(db: Session) -> None:
    """Create the initial admin if no users exist."""
    if db.query(User).count() > 0:
        return
    admin = User(
        email=settings.ADMIN_EMAIL,
        password_hash=hash_password(settings.ADMIN_PASSWORD),
        name="Admin",
        role=UserRole.admin,
    )
    db.add(admin)
    db.commit()
    log.info("Seeded admin user %s", settings.ADMIN_EMAIL)
