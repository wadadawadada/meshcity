# MESHCITY

Official site: https://meshcity.fun

MESHCITY is a Meshtastic-powered persistent strategy/survival game.
Players interact with the game by sending direct messages over mesh radio, while game masters run a local admin server to control operations and monitor the world.

This repository currently contains:
- the **main admin server** (root project)
- a **public read-only backend** (`meshcity_backend`)
- a **public broadcast frontend** (`meshcity_frontend`)

## Project Structure

- `server.js` (root): main admin server entrypoint (game master machine)
- `src/`: core game logic, Meshtastic integration, API handlers, storage
- `public/`: admin dashboard frontend
- `data/`: runtime data (`world.json`, `players.json`, `logs.json`, `device.json`)
- `meshcity_backend/`: read-only broadcast API + SSE stream for public map
- `meshcity_frontend/`: public user-facing realtime map UI
- `scripts/start-public-stack.ps1`: starts public backend+frontend in separate terminals
- `scripts/stop-public-stack.ps1`: stops public backend+frontend by ports

## Architecture

### 1. Admin Server (main/root project)
The root folder is the core system used by the game master.
It handles:
- live Meshtastic device connection
- player command parsing
- game state updates
- world management
- admin dashboard and moderation tooling
- persistence to `data/*.json`

### 2. Public Backend (`meshcity_backend`)
A safe, read-only service for publishing world state.
It exposes only broadcast data:
- world map
- player list
- player action logs
- SSE realtime stream

No admin/write routes are exposed here.

### 3. Public Frontend (`meshcity_frontend`)
A player-facing broadcast UI (Windows-95-inspired style) that shows:
- live world map
- player table
- player action logs
- player modal details
- zoom/pinch controls

This frontend cannot edit map, delete players, or run admin actions.

## Data Flow

1. Admin server updates game state in `data/` JSON files.
2. Public backend reads those files and sanitizes output.
3. Public frontend consumes:
   - `GET /api/public/state` (snapshot)
   - `GET /api/public/stream` (SSE realtime)

## Core Gameplay Commands

### Core
- `START` - start player session
- `NAME <district>` - set district name (after first claim)
- `STATUS` - player and district summary
- `RESOURCES` - resource stock
- `PAUSE` - pause session
- `CONTINUE` - resume session

### Expansion
- `MOVE <n|s|e|w>` - move on map
- `SCAN` - inspect nearby tiles
- `TILE [x y]` - show tile owner/buildings/resources
- `LAND` - territory summary and next claim cost
- `CLAIM <x> <y>` - claim adjacent valid land

### Economy
- `HARVEST [x y]` - collect district income from a tile
- `BUILD <home|farm|mill|mine|shop|hall> <x> <y>` - build on valid claimed tile

### Market
- `TRADE LIST`
- `TRADE SELL <resource> <qty> <unitPrice>`
- `TRADE BUY <offerId> <qty>`
- `TRADE CANCEL <offerId>`

### Social
- `CHAT <message>`
- `CHAT CLEAR`

### Help Categories (radio flow)
- `HELP`, then one category:
  - `CORE`
  - `EXPANSION`
  - `ECONOMY`
  - `MARKET`
  - `SOCIAL`
  - `SYSTEM`

## Local Run Guide

## Requirements
- Node.js 18+
- (Optional for real radio integration) Python + Meshtastic CLI/package

## A) Run Admin Server (main)
From repo root:

```powershell
npm start
```

Admin dashboard default URL:
- `http://localhost:3000`

## B) Run Public Broadcast Stack
From repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-public-stack.ps1
```

This starts:
- public backend: `http://localhost:4100`
- public frontend: `http://localhost:4200`

Stop stack:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-public-stack.ps1
```

## Environment Variables

## Root `.env` (admin context)
Example:

```env
PORT=3000
SIGNALING_BACKEND_URL=http://localhost:4100
PUBLIC_BROADCAST_BACKEND_URL=http://localhost:4100
PUBLIC_BROADCAST_FRONTEND_URL=http://localhost:4200
```

## `meshcity_backend/.env`
Example:

```env
PORT=4100
HOST=0.0.0.0
SOURCE_DATA_DIR=../data
FRONTEND_ORIGIN=*
POLL_INTERVAL_MS=1000
MAX_LOGS=120
```

## `meshcity_frontend/.env`
Example:

```env
PORT=4200
HOST=0.0.0.0
BACKEND_URL=http://localhost:4100
SIGNALING_BACKEND_URL=http://localhost:4100
```

## Deployment Notes (Railway / cloud)

Typical setup:
1. Deploy `meshcity_backend` as a service.
2. Deploy `meshcity_frontend` as a separate service.
3. Set `BACKEND_URL` in frontend env to the deployed backend URL.
4. Set CORS in backend with `FRONTEND_ORIGIN` to frontend domain.

After deployment, replace local URLs in env files with your Railway URLs.

## What the Public Frontend Shows

- map name from world metadata
- tile terrain + ownership overlay
- players (including avatar emoji)
- player territories and buildings
- discovered/open resources (not full hidden resource map)
- realtime logs of player actions

## What the Public Frontend Does NOT Allow

- no admin controls
- no map editing
- no player deletion
- no device connection controls

## Troubleshooting

## "Cannot access server"
- verify process is running on expected port
- check `.env` values
- check Windows firewall for ports 3000/4100/4200
- hard refresh browser (`Ctrl+F5`)

## Public frontend opens but no data
- verify backend URL in `meshcity_frontend/.env`
- verify backend health: `http://localhost:4100/health`
- verify state endpoint: `http://localhost:4100/api/public/state`

## Mesh device issues
- confirm device appears on correct COM port
- reconnect from admin dashboard
- check admin logs in `data/logs.json`

## License / Project Links

- Official game site: https://meshcity.fun

