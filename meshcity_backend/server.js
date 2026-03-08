const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(path.join(process.cwd(), ".env"));

const PORT = Number(process.env.PORT || 4100);
const HOST = String(process.env.HOST || "0.0.0.0");
const POLL_INTERVAL_MS = Math.max(300, Number(process.env.POLL_INTERVAL_MS || 1000));
const MAX_LOGS = Math.max(20, Number(process.env.MAX_LOGS || 120));
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || "*");
const SOURCE_DATA_DIR = path.resolve(process.cwd(), process.env.SOURCE_DATA_DIR || "../data");
const ADMIN_SYNC_TOKEN = String(process.env.ADMIN_SYNC_TOKEN || "");
const ADMIN_ONLINE_TTL_MS = Math.max(5000, Number(process.env.ADMIN_ONLINE_TTL_MS || 15000));

const WORLD_FILE = path.join(SOURCE_DATA_DIR, "world.json");
const PLAYERS_FILE = path.join(SOURCE_DATA_DIR, "players.json");
const LOGS_FILE = path.join(SOURCE_DATA_DIR, "logs.json");
const ADMIN_STATE_FILE = path.join(SOURCE_DATA_DIR, "admin_state.json");

const sseClients = new Set();
let cache = {
  signature: "",
  state: buildPublicState()
};

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function getFilesSignature() {
  const files = [WORLD_FILE, PLAYERS_FILE, LOGS_FILE, ADMIN_STATE_FILE];
  return files.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      return `${filePath}:missing`;
    }
  }).join("|");
}

function readAdminState() {
  const payload = safeReadJson(ADMIN_STATE_FILE, {});
  const lastSeenAt = payload && payload.lastSeenAt ? String(payload.lastSeenAt) : null;
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  const serverOnline = Number.isFinite(lastSeenMs) && (Date.now() - lastSeenMs) <= ADMIN_ONLINE_TTL_MS;
  return {
    serverOnline,
    lastSeenAt
  };
}

function parsePlayerLog(log) {
  const scope = String(log && log.scope ? log.scope : "").toLowerCase();
  const message = String(log && log.message ? log.message : "");

  if (scope === "rx") {
    const match = message.match(/^Direct message from\s+(![a-z0-9]+):\s*(.*)$/i);
    if (!match) {
      return null;
    }
    return {
      id: String(log.id || ""),
      timestamp: log.timestamp || new Date().toISOString(),
      scope,
      direction: "from_player",
      nodeId: match[1],
      text: match[2],
      message
    };
  }

  if (scope === "tx") {
    const match = message.match(/^DM queued to\s+(![a-z0-9]+):\s*(.*)$/i);
    if (!match) {
      return null;
    }
    return {
      id: String(log.id || ""),
      timestamp: log.timestamp || new Date().toISOString(),
      scope,
      direction: "to_player",
      nodeId: match[1],
      text: match[2],
      message
    };
  }

  return null;
}

function sanitizeWorld(world) {
  const safeWorld = world && typeof world === "object" ? world : {};
  const map = safeWorld.map && typeof safeWorld.map === "object" ? safeWorld.map : {};
  const entities = Array.isArray(safeWorld.entities) ? safeWorld.entities : [];

  return {
    name: String(safeWorld.name || "World Map"),
    map: {
      width: Number(map.width || 0),
      height: Number(map.height || 0),
      tiles: map.tiles && typeof map.tiles === "object" ? map.tiles : {}
    },
    playerPositions: safeWorld.playerPositions && typeof safeWorld.playerPositions === "object"
      ? safeWorld.playerPositions
      : {},
    landClaims: safeWorld.landClaims && typeof safeWorld.landClaims === "object"
      ? safeWorld.landClaims
      : {},
    entities: entities
      .map((entity) => ({
        id: String(entity && entity.id ? entity.id : ""),
        type: String(entity && entity.type ? entity.type : ""),
        name: String(entity && entity.name ? entity.name : ""),
        x: Number(entity && entity.x),
        y: Number(entity && entity.y),
        meta: entity && entity.meta && typeof entity.meta === "object" ? entity.meta : {}
      }))
      .filter((entity) =>
        entity.id &&
        Number.isInteger(entity.x) &&
        Number.isInteger(entity.y)
      ),
    updatedAt: safeWorld.updatedAt || null
  };
}

function sanitizePlayers(players, world) {
  const playerPositions = world.playerPositions || {};
  const list = Array.isArray(players) ? players : [];

  return list.map((player) => {
    const gameState = player && player.gameState && typeof player.gameState === "object"
      ? player.gameState
      : {};
    const stats = player && player.stats && typeof player.stats === "object"
      ? player.stats
      : {};
    const claimedCells = Array.isArray(gameState.claimedCells) ? gameState.claimedCells : [];

    return {
      nodeId: String(player && player.nodeId ? player.nodeId : ""),
      shortName: String(player && player.shortName ? player.shortName : "Unknown"),
      avatar: String(player && player.avatar ? player.avatar : ""),
      registered: Boolean(player && player.registered),
      registrationState: String(player && player.registrationState ? player.registrationState : "unknown"),
      updatedAt: player && player.updatedAt ? player.updatedAt : null,
      position: playerPositions[player && player.nodeId ? player.nodeId : ""] || null,
      stats: {
        level: Number(stats.level || 0),
        hp: Number(stats.hp || 0),
        xp: Number(stats.xp || 0),
        credits: Number(stats.credits || 0)
      },
      gameState: {
        hasStarted: Boolean(gameState.hasStarted),
        sessionActive: Boolean(gameState.sessionActive),
        location: String(gameState.location || ""),
        cityName: String(gameState.cityName || ""),
        districtName: String(gameState.districtName || ""),
        cityLevel: Number(gameState.cityLevel || 1),
        claimedCellsCount: claimedCells.length,
        claimedCells: claimedCells.map((cell) => String(cell)),
        buildings: gameState.buildings && typeof gameState.buildings === "object" ? gameState.buildings : {},
        resources: gameState.resources && typeof gameState.resources === "object" ? gameState.resources : {},
        cityCore: gameState.cityCore ? String(gameState.cityCore) : null,
        lastActionAt: gameState.lastActionAt || null,
        startedAt: gameState.startedAt || null
      }
    };
  });
}

function buildPublicState() {
  const worldPayload = safeReadJson(WORLD_FILE, {});
  const playersPayload = safeReadJson(PLAYERS_FILE, { players: [] });
  const logsPayload = safeReadJson(LOGS_FILE, { logs: [] });

  const world = sanitizeWorld(worldPayload);
  const players = sanitizePlayers(playersPayload.players, world);
  const playerLogs = (Array.isArray(logsPayload.logs) ? logsPayload.logs : [])
    .map(parsePlayerLog)
    .filter(Boolean)
    .slice(-MAX_LOGS);

  return {
    updatedAt: new Date().toISOString(),
    world,
    players,
    logs: playerLogs,
    server: readAdminState()
  };
}

function getCachedState() {
  const signature = getFilesSignature();
  if (signature !== cache.signature) {
    cache = {
      signature,
      state: buildPublicState()
    };
  }
  return cache.state;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function streamState(res) {
  res.write(`event: state\n`);
  res.write(`data: ${JSON.stringify(getCachedState())}\n\n`);
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN
  });

  sseClients.add(res);
  streamState(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
}

setInterval(() => {
  const previousSignature = cache.signature;
  const state = getCachedState();
  if (cache.signature === previousSignature) {
    return;
  }

  for (const client of sseClients) {
    streamState(client);
  }

  if (sseClients.size > 0) {
    for (const client of sseClients) {
      client.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }
  }
}, POLL_INTERVAL_MS);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "meshcity_backend" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/public/state") {
    sendJson(res, 200, getCachedState());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/public/stream") {
    handleSse(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/sync") {
    if (!ADMIN_SYNC_TOKEN) {
      sendJson(res, 503, { error: "ADMIN_SYNC_TOKEN is not configured" });
      return;
    }

    const providedToken = String(req.headers["x-admin-sync-token"] || "");
    if (!providedToken || providedToken !== ADMIN_SYNC_TOKEN) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const body = await readBody(req);
      if (!body || typeof body !== "object") {
        sendJson(res, 400, { error: "JSON body is required" });
        return;
      }

      if (body.world && typeof body.world === "object") {
        writeJson(WORLD_FILE, body.world);
      }
      if (Array.isArray(body.players)) {
        writeJson(PLAYERS_FILE, { players: body.players });
      }
      if (Array.isArray(body.logs)) {
        writeJson(LOGS_FILE, { logs: body.logs });
      }
      const syncTime = body && body.admin && body.admin.lastSeenAt
        ? String(body.admin.lastSeenAt)
        : new Date().toISOString();
      writeJson(ADMIN_STATE_FILE, { lastSeenAt: syncTime });

      cache.signature = "";
      sendJson(res, 200, { ok: true });
      return;
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Sync failed" });
      return;
    }
  }

  sendJson(res, 404, {
    error: `Route not found: ${req.method} ${url.pathname}`
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[meshcity_backend] listening on http://${HOST}:${PORT}`);
  console.log(`[meshcity_backend] source data dir: ${SOURCE_DATA_DIR}`);
});
