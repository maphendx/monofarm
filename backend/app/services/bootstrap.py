import logging

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_password
from app.models.organization import Organization
from app.models.user import User, UserRole


log = logging.getLogger(__name__)


def seed_admin(db: Session) -> None:
    """Create the default organization and initial admin user if none exist."""
    _seed_platform_admin(db)

    if (
        db.query(User).filter(User.organization_id.isnot(None)).count() > 0
        or db.query(Organization).filter_by(slug="default-farm").count() > 0
    ):
        return

    from app.services.encryption import encrypt
    # Create default org, seeding Bambu creds from .env if present
    org = Organization(
        name="Default Farm",
        slug="default-farm",
        bambu_email=encrypt(settings.BAMBU_EMAIL),
        bambu_password=encrypt(settings.BAMBU_PASSWORD),
        bambu_refresh_token=encrypt(settings.BAMBU_REFRESH_TOKEN),
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


def _seed_platform_admin(db: Session) -> None:
    """Optionally create the global platform operator outside tenant context."""
    email = settings.PLATFORM_ADMIN_EMAIL.strip().lower()
    password = settings.PLATFORM_ADMIN_PASSWORD
    if not email or not password:
        return
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        return
    admin = User(
        organization_id=None,
        email=email,
        password_hash=hash_password(password),
        name="Platform Admin",
        role=UserRole.admin,
    )
    db.add(admin)
    db.commit()
    log.info("Seeded platform admin user %s", email)
