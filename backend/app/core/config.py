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

    LMSQ_API_KEY: str = ""          # Lemon Squeezy API key
    LMSQ_WEBHOOK_SECRET: str = ""   # from LS dashboard → webhooks
    LMSQ_STORE_ID: str = ""         # numeric store ID from LS URL
    LMSQ_VARIANT_STARTER: str = ""  # variant ID for each plan
    LMSQ_VARIANT_PRO: str = ""
    LMSQ_VARIANT_FARM: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
