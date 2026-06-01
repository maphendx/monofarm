from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # "development" | "production"
    ENV: str = "development"

    DATABASE_URL: str

    @field_validator("DATABASE_URL", mode="before")
    @classmethod
    def _fix_db_scheme(cls, v: str) -> str:
        # Railway provides postgres:// or postgresql:// — psycopg3 needs postgresql+psycopg://
        if v.startswith("postgres://"):
            return v.replace("postgres://", "postgresql+psycopg://", 1)
        if v.startswith("postgresql://"):
            return v.replace("postgresql://", "postgresql+psycopg://", 1)
        return v
    SECRET_KEY: str
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 43200

    ADMIN_EMAIL: str = "admin@example.com"
    ADMIN_PASSWORD: str = "change-me"

    BAMBU_EMAIL: str = ""
    BAMBU_PASSWORD: str = ""
    BAMBU_REFRESH_TOKEN: str = ""
    BAMBU_REGION: str = ""  # "us", "eu", or "cn"; empty = auto from login

    FARM_PUBLIC_URL: str = "http://localhost:3000"

    TIMEZONE: str = "Europe/Kiev"
    CORS_ORIGINS: str = "http://localhost:3000"

    GO2RTC_URL: str = "http://localhost:1984"  # go2rtc sidecar; set empty to disable

    LMSQ_API_KEY: str = ""          # Lemon Squeezy API key
    LMSQ_WEBHOOK_SECRET: str = ""   # from LS dashboard → webhooks
    LMSQ_STORE_ID: str = ""         # numeric store ID from LS URL
    LMSQ_VARIANT_STARTER: str = ""  # monthly variant ID for each plan
    LMSQ_VARIANT_PRO: str = ""
    LMSQ_VARIANT_FARM: str = ""
    LMSQ_VARIANT_STARTER_YEARLY: str = ""  # annual variant IDs (−20%)
    LMSQ_VARIANT_PRO_YEARLY: str = ""
    LMSQ_VARIANT_FARM_YEARLY: str = ""

    # Fernet key for encrypting sensitive DB fields (Bambu credentials).
    # Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # Required when ENV=production — server refuses to start without it.
    ENCRYPTION_KEY: str = ""

    # Set to true in dev (single uvicorn process).
    # False = Telegram + APScheduler + Bambu MQTT run in a separate worker process.
    # Required when running uvicorn --workers N to avoid duplicate bots/schedulers.
    INLINE_WORKERS: bool = False

    REDIS_URL: str = ""             # e.g. redis://localhost:6379 — empty = in-process fallback

    # Resend transactional email (https://resend.com). Empty = log-only (dev).
    RESEND_API_KEY: str = ""
    EMAIL_FROM: str = "MonoFarm <onboarding@resend.dev>"
    EMAIL_REPLY_TO: str = "support@monofarm.app"
    PASSWORD_RESET_TTL_MINUTES: int = 30

    # S3-compatible storage (Cloudflare R2 / AWS S3). Empty = local disk.
    S3_ENDPOINT_URL: str = ""       # e.g. https://ACCOUNT.r2.cloudflarestorage.com
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_BUCKET: str = ""

    @model_validator(mode="after")
    def _check_production_requirements(self) -> "Settings":
        if self.ENV == "production" and not self.ENCRYPTION_KEY:
            raise ValueError(
                "ENCRYPTION_KEY must be set in production. "
                "Generate one: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            )
        return self

    @property
    def cors_origins_list(self) -> list[str]:
        origins = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        # Always include FARM_PUBLIC_URL.
        if self.FARM_PUBLIC_URL and self.FARM_PUBLIC_URL not in origins:
            origins.append(self.FARM_PUBLIC_URL)
        # If FARM_PUBLIC_URL is https://api.example.com, also allow https://example.com
        # (common pattern: backend on api.* subdomain, frontend on root domain).
        for prefix in ("https://api.", "http://api."):
            if self.FARM_PUBLIC_URL.startswith(prefix):
                root = self.FARM_PUBLIC_URL.replace(prefix, prefix[:prefix.index("api.")], 1)
                if root not in origins:
                    origins.append(root)
                break
        return origins


settings = Settings()
