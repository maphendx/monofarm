from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str
    SECRET_KEY: str
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 43200

    ADMIN_EMAIL: str = "admin@example.com"
    ADMIN_PASSWORD: str = "change-me"

    BAMBU_EMAIL: str = ""
    BAMBU_PASSWORD: str = ""
    BAMBU_REFRESH_TOKEN: str = ""
    BAMBU_REGION: str = ""  # "us", "eu", or "cn"; empty = auto from login

    TG_BOT_TOKEN: str = ""
    TG_REPORT_CHAT_ID: str = ""
    FARM_PUBLIC_URL: str = "http://localhost:3000"

    TIMEZONE: str = "Europe/Kiev"
    CORS_ORIGINS: str = "http://localhost:3000"

    GO2RTC_URL: str = "http://localhost:1984"  # go2rtc sidecar; set empty to disable

    LMSQ_API_KEY: str = ""          # Lemon Squeezy API key
    LMSQ_WEBHOOK_SECRET: str = ""   # from LS dashboard → webhooks
    LMSQ_STORE_ID: str = ""         # numeric store ID from LS URL
    LMSQ_VARIANT_STARTER: str = ""  # variant ID for each plan
    LMSQ_VARIANT_PRO: str = ""
    LMSQ_VARIANT_FARM: str = ""

    # Fernet key for encrypting sensitive DB fields (Bambu credentials).
    # Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # Empty = encryption disabled (plain text stored — acceptable for dev, not for production).
    ENCRYPTION_KEY: str = ""

    # Set to false when running uvicorn --workers N (use separate worker process instead).
    # True = dev-friendly: Telegram + APScheduler + Bambu MQTT start inside the web process.
    INLINE_WORKERS: bool = True

    REDIS_URL: str = ""             # e.g. redis://localhost:6379 — empty = in-process fallback

    # S3-compatible storage (Cloudflare R2 / AWS S3). Empty = local disk.
    S3_ENDPOINT_URL: str = ""       # e.g. https://ACCOUNT.r2.cloudflarestorage.com
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_BUCKET: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        origins = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        # Always include FARM_PUBLIC_URL so you never have to update CORS_ORIGINS
        # separately when the public URL changes.
        if self.FARM_PUBLIC_URL and self.FARM_PUBLIC_URL not in origins:
            origins.append(self.FARM_PUBLIC_URL)
        return origins


settings = Settings()
