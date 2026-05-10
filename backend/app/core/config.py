from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str
    SECRET_KEY: str
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 43200

    ADMIN_EMAIL: str = "admin@example.com"
    ADMIN_PASSWORD: str = "change-me"

    SIMPLYPRINT_API_KEY: str = ""
    SIMPLYPRINT_ORG_ID: str = ""

    TG_BOT_TOKEN: str = ""
    TG_REPORT_CHAT_ID: str = ""
    FARM_PUBLIC_URL: str = "http://localhost:3000"

    TIMEZONE: str = "Europe/Kiev"
    CORS_ORIGINS: str = "http://localhost:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
