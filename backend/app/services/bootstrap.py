import logging

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_password
from app.models.organization import Organization, _slugify
from app.models.user import User, UserRole


log = logging.getLogger(__name__)


def seed_admin(db: Session) -> None:
    """Create the default organization and initial admin user if none exist."""
    if db.query(User).count() > 0:
        return

    # Create default org, seeding Bambu creds from .env if present
    org = Organization(
        name="Default Farm",
        slug="default-farm",
        bambu_email=settings.BAMBU_EMAIL,
        bambu_password=settings.BAMBU_PASSWORD,
        bambu_refresh_token=settings.BAMBU_REFRESH_TOKEN,
        bambu_region=settings.BAMBU_REGION,
    )
    db.add(org)
    db.flush()

    admin = User(
        organization_id=org.id,
        email=settings.ADMIN_EMAIL,
        password_hash=hash_password(settings.ADMIN_PASSWORD),
        name="Admin",
        role=UserRole.admin,
    )
    db.add(admin)
    db.commit()
    log.info("Seeded default org (id=%s) and admin user %s", org.id, settings.ADMIN_EMAIL)
