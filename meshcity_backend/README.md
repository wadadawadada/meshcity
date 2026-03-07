# meshcity_backend

Read-only backend for public broadcast of MESHCITY world map, player list, and player action logs.

## Run

1. Create `.env` from `.env.example`
2. Start:

```powershell
npm start
```

## API

- `GET /health`
- `GET /api/public/state`
- `GET /api/public/stream` (Server-Sent Events)

Notes:
- No write/admin endpoints.
- `world.entities` and device status are not exposed.
- Logs are filtered to player DM activity (`rx`/`tx`).
