# MESHCITY

Official site: https://meshcity.fun

MESHCITY is a Meshtastic-powered persistent **TEXT-FIRST** strategy/survival game.
Core gameplay works inside your local Meshtastic mesh network and can run **without internet access**.
For convenience, a separate public web stack is also provided (backend + frontend website) for broadcast/observation.

## Repository Layout

This workspace now has three separate applications:

- `admin_server` - main game/admin service for game masters
- `backend` - read-only public API (snapshot + SSE)
- `frontend` - public website UI for map/players/logs

If your local folder names include the `meshcity_` prefix (`meshcity_admin_server`, `meshcity_backend`, `meshcity_frontend`), they correspond 1:1 to the roles above.

## What Each App Does

### 1) `admin_server` (core game app)

Main responsibilities:
- Meshtastic device connection and DM command handling
- game logic, world updates, player actions
- admin dashboard and moderation actions
- persistence in JSON data files (`world`, `players`, `logs`, `device`)

This is the authoritative source of game state.

### 2) `backend` (public read-only API)

Main responsibilities:
- read state produced by `admin_server`
- expose safe public endpoints
- provide realtime stream for observers

Typical endpoints:
- `GET /health`
- `GET /api/public/state`
- `GET /api/public/stream` (SSE)

No admin/write endpoints should be exposed here.

### 3) `frontend` (public website)

Main responsibilities:
- display read-only map/player/log broadcast
- consume `backend` snapshot + stream endpoints
- provide an accessible external view for users who are not on the local admin network

This app does not modify game state.

## Data Flow

1. `admin_server` updates game state files.
2. `backend` reads and sanitizes that data.
3. `frontend` renders it via REST + SSE.

## Local Run (separate apps)

Requirements:
- Node.js 18+
- (optional) Python + Meshtastic tooling for real radio integration

Run each app from its own folder:

```powershell
# admin_server
cd .\admin_server
npm start

# backend
cd ..\backend
npm start

# frontend
cd ..\frontend
npm start
```

Default local ports (example):
- admin_server: `3000`
- backend: `4100`
- frontend: `4200`

## Core Gameplay Commands (radio DM)

- `START`, `PAUSE`, `CONTINUE`
- `NAME <district>`, `STATUS`, `RESOURCES`
- `MOVE <n|s|e|w>`, `SCAN`, `TILE [x y]`, `LAND`, `CLAIM <x> <y>`
- `HARVEST [x y]`, `BUILD <home|farm|mill|mine|shop|hall> <x> <y>`
- `TRADE LIST`, `TRADE SELL`, `TRADE BUY`, `TRADE CANCEL`
- `CHAT <message>`, `CHAT CLEAR`
- `HELP` with categories: `CORE`, `EXPANSION`, `ECONOMY`, `MARKET`, `SOCIAL`, `SYSTEM`

