# Changelog

## [Unreleased]

### Agent
- Browser-based UI замість tkinter (порт 4747)
- Auto-update при запуску і кожні 6 годин
- Секція принтерів з локальною доступністю
- Кнопка ручного оновлення
- Версіювання: `0.x.x`

### Backend
- OctoPrint API shim для OrcaSlicer
- Bambu LAN FTPS upload через агент
- Redis cache для статусів (10s TTL)
- S3/R2 storage для gcode файлів
- API keys (`/api/api-keys`)
- go2rtc інтеграція для камер

### Frontend
- SendModal з slot remapping
- Filament compatibility badges (✓/~/✕)
- Dark mode (class-based, Tailwind v4)
- OrcaSlicer `?highlight=<id>` auto-open

---

Формат: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
