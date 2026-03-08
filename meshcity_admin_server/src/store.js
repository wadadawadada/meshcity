const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const LOGS_FILE = path.join(DATA_DIR, "logs.json");
const DEVICE_FILE = path.join(DATA_DIR, "device.json");
const WORLD_FILE = path.join(DATA_DIR, "world.json");

function defaultWorld() {
  return {
    name: "Untitled Map",
    map: {
      width: 48,
      height: 28,
      tiles: {}
    },
    entities: [],
    playerPositions: {},
    landClaims: {},
    marketOffers: [],
    updatedAt: new Date().toISOString()
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toCoordKey(x, y) {
  return `${x},${y}`;
}

function normalizeWorldShape(world) {
  const fallback = defaultWorld();
  const map = world && typeof world === "object" ? world.map || {} : {};
  const width = clamp(Number(map.width) || fallback.map.width, 10, 120);
  const height = clamp(Number(map.height) || fallback.map.height, 10, 120);
  const tiles = map.tiles && typeof map.tiles === "object" ? map.tiles : {};

  const normalizedTiles = {};
  for (const [coord, tile] of Object.entries(tiles)) {
    if (!tile || typeof tile !== "object") {
      continue;
    }

    const [xRaw, yRaw] = String(coord).split(",");
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      continue;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      continue;
    }

    normalizedTiles[toCoordKey(x, y)] = {
      terrain: String(tile.terrain || "plain"),
      blocked: Boolean(tile.blocked),
      label: tile.label ? String(tile.label).slice(0, 36) : ""
    };
  }

  const entitiesRaw = Array.isArray(world && world.entities) ? world.entities : [];
  const entities = entitiesRaw
    .map((entity) => ({
      id: String(entity.id || ""),
      type: String(entity.type || "event"),
      name: String(entity.name || "Entity"),
      x: Number(entity.x),
      y: Number(entity.y),
      hp: Number.isFinite(Number(entity.hp)) ? Number(entity.hp) : null,
      meta: entity.meta && typeof entity.meta === "object" ? entity.meta : {}
    }))
    .filter((entity) =>
      entity.id &&
      Number.isInteger(entity.x) &&
      Number.isInteger(entity.y) &&
      entity.x >= 0 &&
      entity.y >= 0 &&
      entity.x < width &&
      entity.y < height &&
      entity.type !== "enemy"
    );

  const positionsRaw = world && world.playerPositions && typeof world.playerPositions === "object"
    ? world.playerPositions
    : {};
  const playerPositions = {};
  for (const [nodeId, position] of Object.entries(positionsRaw)) {
    if (!position || typeof position !== "object") {
      continue;
    }
    const x = Number(position.x);
    const y = Number(position.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      continue;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      continue;
    }
    playerPositions[String(nodeId)] = {
      x,
      y,
      updatedAt: position.updatedAt || null
    };
  }

  const claimsRaw = world && world.landClaims && typeof world.landClaims === "object"
    ? world.landClaims
    : {};
  const landClaims = {};
  for (const [coord, nodeId] of Object.entries(claimsRaw)) {
    const [xRaw, yRaw] = String(coord).split(",");
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      continue;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      continue;
    }
    const id = String(nodeId || "").trim();
    if (!id) {
      continue;
    }
    landClaims[toCoordKey(x, y)] = id;
  }

  const offersRaw = Array.isArray(world && world.marketOffers) ? world.marketOffers : [];
  const marketOffers = offersRaw
    .map((offer) => ({
      id: String(offer.id || ""),
      sellerNodeId: String(offer.sellerNodeId || ""),
      sellerName: String(offer.sellerName || ""),
      resource: String(offer.resource || "").toLowerCase(),
      qty: Number(offer.qty),
      unitPrice: Number(offer.unitPrice),
      createdAt: offer.createdAt || null
    }))
    .filter((offer) =>
      offer.id &&
      offer.sellerNodeId &&
      Number.isInteger(offer.qty) &&
      offer.qty > 0 &&
      Number.isInteger(offer.unitPrice) &&
      offer.unitPrice > 0
    );

  return {
    name: world && world.name ? String(world.name).slice(0, 40) : fallback.name,
    map: {
      width,
      height,
      tiles: normalizedTiles
    },
    entities,
    playerPositions,
    landClaims,
    marketOffers,
    updatedAt: world && world.updatedAt ? world.updatedAt : fallback.updatedAt
  };
}

function seededRand(seed) {
  let state = Math.floor(Number(seed) || Date.now()) % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function generateWorldLayout(width, height, seed = Date.now()) {
  const rand = seededRand(seed);
  const tiles = {};
  const entities = [];
  const archetypes = [
    { name: "frontier", water: 0.2, mountain: 0.7, forest: 0.5, riverChance: 0.4, roadDensity: 0.65, townCount: 3 },
    { name: "wetlands", water: 0.28, mountain: 0.78, forest: 0.56, riverChance: 0.72, roadDensity: 0.52, townCount: 4 },
    { name: "highlands", water: 0.14, mountain: 0.58, forest: 0.47, riverChance: 0.32, roadDensity: 0.6, townCount: 3 },
    { name: "archipelago", water: 0.34, mountain: 0.73, forest: 0.45, riverChance: 0.15, roadDensity: 0.42, townCount: 5 }
  ];
  const archetype = archetypes[Math.floor(rand() * archetypes.length)];
  const seedA = Math.floor(rand() * 999999) + 11;
  const seedB = Math.floor(rand() * 999999) + 97;
  const seedC = Math.floor(rand() * 999999) + 193;
  const offX = Math.floor(rand() * 5000);
  const offY = Math.floor(rand() * 5000);

  function hash2d(ix, iy, s) {
    let h = (
      Math.imul(ix | 0, 374761393) ^
      Math.imul(iy | 0, 668265263) ^
      Math.imul(s | 0, 1442695041)
    ) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967295;
  }

  function smoothstep(v) {
    return v * v * (3 - 2 * v);
  }

  function valueNoise2d(x, y, freq, s) {
    const sx = x * freq;
    const sy = y * freq;
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const tx = smoothstep(sx - x0);
    const ty = smoothstep(sy - y0);

    const n00 = hash2d(x0, y0, s);
    const n10 = hash2d(x1, y0, s);
    const n01 = hash2d(x0, y1, s);
    const n11 = hash2d(x1, y1, s);

    const nx0 = n00 + (n10 - n00) * tx;
    const nx1 = n01 + (n11 - n01) * tx;
    return nx0 + (nx1 - nx0) * ty;
  }

  function fractalNoise2d(x, y, octaves, baseFreq, s) {
    let freq = baseFreq;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i += 1) {
      sum += valueNoise2d(x, y, freq, s + i * 137) * amp;
      norm += amp;
      freq *= 2;
      amp *= 0.5;
    }
    return sum / Math.max(1e-9, norm);
  }

  const townNames = [
    "Relay Hub", "Iron Market", "Dust Port", "Verdant Post", "Old Bastion", "Mist Junction",
    "Ridge Camp", "Copper Gate", "Signal Outpost", "Echo Crossing", "Ember Reach", "South Relay"
  ];
  const poiNames = {
    mountain: ["Echo Peak", "Broken Ridge", "Watch Crag", "Ash Summit"],
    forest: ["Whisper Grove", "Thorn Hollow", "Shaded Glade", "Hunter Run"],
    water: ["Flood Basin", "Sunken Ring", "Blue Marsh", "Mist Delta"],
    plain: ["Dust Flats", "Signal Field", "Red Dunes", "Open Steppe"],
    road: ["Caravan Mile", "Checkpoint 7", "Rust Turn", "Old Tradeway"]
  };

  const townCells = [];
  const roadCells = new Set();

  function at(x, y) {
    return tiles[toCoordKey(clamp(x, 0, width - 1), clamp(y, 0, height - 1))];
  }

  function markRoadPath(from, to, wobble = 0.2) {
    let x = from.x;
    let y = from.y;
    let guard = width * height * 2;
    while ((x !== to.x || y !== to.y) && guard > 0) {
      roadCells.add(toCoordKey(x, y));
      const moveHorizontal = x !== to.x && (y === to.y || rand() > 0.45);
      if (moveHorizontal) {
        x += x < to.x ? 1 : -1;
      } else if (y !== to.y) {
        y += y < to.y ? 1 : -1;
      }
      if (rand() < wobble) {
        const axis = rand() > 0.5 ? "x" : "y";
        if (axis === "x") {
          x = clamp(x + (rand() > 0.5 ? 1 : -1), 0, width - 1);
        } else {
          y = clamp(y + (rand() > 0.5 ? 1 : -1), 0, height - 1);
        }
      }
      guard -= 1;
    }
    roadCells.add(toCoordKey(to.x, to.y));
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const elevationBase = fractalNoise2d(x + offX, y + offY, 4, 0.082, seedA);
      const moistureBase = fractalNoise2d(x + offX + 113, y + offY + 59, 3, 0.09, seedB);
      const roughnessBase = fractalNoise2d(x + offX + 271, y + offY + 147, 2, 0.14, seedC);
      const elevation = clamp(0.5 + (elevationBase - 0.5) * 1.9, 0, 1);
      const moisture = clamp(0.5 + (moistureBase - 0.5) * 1.8, 0, 1);
      const roughness = clamp(0.5 + (roughnessBase - 0.5) * 1.6, 0, 1);
      const edgeDx = Math.min(x, width - 1 - x) / Math.max(1, width * 0.5);
      const edgeDy = Math.min(y, height - 1 - y) / Math.max(1, height * 0.5);
      const edgeFactor = Math.min(edgeDx, edgeDy);
      const coastalBoost = (1 - edgeFactor) * 0.07;
      const e = elevation * 0.84 + roughness * 0.16 - coastalBoost;

      let terrain = "plain";
      if (e < archetype.water - (moisture < 0.32 ? 0.02 : 0)) {
        terrain = "water";
      } else if (e > archetype.mountain - roughness * 0.05) {
        terrain = "mountain";
      } else if (moisture > archetype.forest) {
        terrain = "forest";
      }

      const blocked = terrain === "water" ? rand() > 0.18 : terrain === "mountain" ? rand() > 0.3 : false;
      tiles[toCoordKey(x, y)] = { terrain, blocked, label: "" };
    }
  }

  if (rand() < archetype.riverChance) {
    let x = clamp(Math.floor(width * (0.1 + rand() * 0.8)), 1, width - 2);
    let y = 0;
    for (let i = 0; i < height * 2.2; i += 1) {
      const key = toCoordKey(x, y);
      tiles[key] = { ...tiles[key], terrain: "water", blocked: true };
      if (rand() < 0.52) {
        x = clamp(x + (rand() > 0.5 ? 1 : -1), 0, width - 1);
      }
      y = clamp(y + (rand() > 0.2 ? 1 : 0), 0, height - 1);
      if (y >= height - 1) {
        break;
      }
    }
  }

  const desiredTowns = clamp(archetype.townCount + Math.floor(rand() * 2), 3, 6);
  let attempts = 0;
  while (townCells.length < desiredTowns && attempts < width * height * 3) {
    attempts += 1;
    const x = Math.floor(rand() * width);
    const y = Math.floor(rand() * height);
    const tile = at(x, y);
    if (!tile || tile.terrain === "water" || tile.terrain === "mountain") {
      continue;
    }
    let tooClose = false;
    for (const town of townCells) {
      const dx = town.x - x;
      const dy = town.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < Math.max(6, Math.min(width, height) * 0.16)) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const name = townNames[Math.floor(rand() * townNames.length)];
    townCells.push({ x, y, name });
    tiles[toCoordKey(x, y)] = { terrain: "town", blocked: false, label: name };
  }

  if (townCells.length < 2) {
    townCells.push(
      { x: clamp(Math.floor(width * 0.25), 1, width - 2), y: clamp(Math.floor(height * 0.3), 1, height - 2), name: "Relay Hub" },
      { x: clamp(Math.floor(width * 0.7), 1, width - 2), y: clamp(Math.floor(height * 0.7), 1, height - 2), name: "Iron Market" }
    );
    for (const town of townCells) {
      tiles[toCoordKey(town.x, town.y)] = { terrain: "town", blocked: false, label: town.name };
    }
  }

  for (let i = 0; i < townCells.length - 1; i += 1) {
    markRoadPath(townCells[i], townCells[i + 1], 0.15 + (1 - archetype.roadDensity) * 0.22);
  }
  if (townCells.length > 2 && rand() < 0.75) {
    markRoadPath(townCells[0], townCells[townCells.length - 1], 0.24);
  }

  for (const key of roadCells) {
    const tile = tiles[key];
    if (!tile) continue;
    if (tile.terrain !== "town") {
      tiles[key] = { ...tile, terrain: "road", blocked: false };
    }
  }

  const poiTargets = Math.max(6, Math.floor((width * height) / 180));
  let poiPlaced = 0;
  let poiAttempts = 0;
  while (poiPlaced < poiTargets && poiAttempts < poiTargets * 20) {
    poiAttempts += 1;
    const x = Math.floor(rand() * width);
    const y = Math.floor(rand() * height);
    const key = toCoordKey(x, y);
    const tile = tiles[key];
    if (!tile || tile.label || tile.blocked) {
      continue;
    }
    if (rand() < 0.78 && tile.terrain !== "mountain" && tile.terrain !== "water") {
      continue;
    }
    const pool = poiNames[tile.terrain] || poiNames.plain;
    tile.label = pool[Math.floor(rand() * pool.length)];
    poiPlaced += 1;
  }

  const terrainBuckets = {
    plain: [],
    forest: [],
    water: [],
    mountain: [],
    town: [],
    road: []
  };
  for (const [key, tile] of Object.entries(tiles)) {
    if (!terrainBuckets[tile.terrain]) {
      terrainBuckets[tile.terrain] = [];
    }
    if (!tile.blocked) {
      const [xRaw, yRaw] = key.split(",");
      terrainBuckets[tile.terrain].push({ x: Number(xRaw), y: Number(yRaw), terrain: tile.terrain, label: tile.label || "" });
    }
  }

  function pickFromTerrains(terrains) {
    const pool = [];
    for (const terrain of terrains) {
      const arr = terrainBuckets[terrain] || [];
      for (const item of arr) {
        pool.push(item);
      }
    }
    if (!pool.length) {
      return null;
    }
    return pool[Math.floor(rand() * pool.length)];
  }

  function nearestTownDistance(x, y) {
    let best = Number.POSITIVE_INFINITY;
    for (const town of townCells) {
      const dx = town.x - x;
      const dy = town.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) {
        best = d;
      }
    }
    return best;
  }

  function spawnEntity(type, name, x, y, hp = null, meta = {}) {
    entities.push({
      id: `entity_${type}_${entities.length + 1}_${Math.floor(rand() * 9999)}`,
      type,
      name,
      x,
      y,
      hp,
      meta
    });
  }

  const lootNames = ["Stone Depot", "Timber Crate", "Food Caravan", "Metal Stockpile", "Builder Toolkit", "Supply Cache"];
  const eventNames = ["Road Repair", "Festival Plaza", "Market Day", "Bridge Upgrade", "Granary Expansion", "Transit Survey"];
  const npcNames = ["Master Builder", "Quartermaster", "Town Planner", "Bridge Engineer", "Merchant Guild", "Surveyor"];
  const landmarkNames = ["Watch Tower", "Canal Node", "Warehouse", "Foundry Site", "Workshop", "City Gate"];

  const mapArea = width * height;
  const lootCount = Math.max(12, Math.floor(mapArea * 0.02));
  const eventCount = Math.max(8, Math.floor(mapArea * 0.012));
  const npcCount = Math.max(6, Math.floor(mapArea * 0.009));
  const landmarkCount = Math.max(6, Math.floor(mapArea * 0.01));

  for (let i = 0; i < lootCount; i += 1) {
    const pos = pickFromTerrains(["plain", "forest", "road", "town"]);
    if (!pos) break;
    const tier = rand() > 0.9 ? "epic" : rand() > 0.68 ? "rare" : rand() > 0.4 ? "uncommon" : "common";
    spawnEntity("loot", lootNames[Math.floor(rand() * lootNames.length)], pos.x, pos.y, null, {
      tier,
      biome: pos.terrain
    });
  }

  for (let i = 0; i < eventCount; i += 1) {
    const pos = pickFromTerrains(["road", "plain", "town", "forest"]);
    if (!pos) break;
    spawnEntity("event", eventNames[Math.floor(rand() * eventNames.length)], pos.x, pos.y, null, {
      biome: pos.terrain,
      archetype: archetype.name
    });
  }

  for (let i = 0; i < npcCount; i += 1) {
    const pos = pickFromTerrains(["town", "road", "forest"]);
    if (!pos) break;
    spawnEntity("npc", npcNames[Math.floor(rand() * npcNames.length)], pos.x, pos.y, null, {
      biome: pos.terrain
    });
  }

  for (let i = 0; i < landmarkCount; i += 1) {
    const pos = pickFromTerrains(["town", "road", "plain"]);
    if (!pos) break;
    spawnEntity("landmark", landmarkNames[Math.floor(rand() * landmarkNames.length)], pos.x, pos.y, null, {
      biome: pos.terrain
    });
  }

  return {
    map: { width, height, tiles },
    entities
  };
}

function ensureFile(filePath, initialValue) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialValue, null, 2), "utf8");
  }
}

function readJson(filePath, fallback) {
  ensureFile(filePath, fallback);
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createStore(options = {}) {
  const onPublicStateChanged = typeof options.onPublicStateChanged === "function"
    ? options.onPublicStateChanged
    : null;

  function emitPublicStateChanged() {
    if (!onPublicStateChanged) {
      return;
    }

    try {
      onPublicStateChanged({
        world: readJson(WORLD_FILE, defaultWorld()),
        players: readJson(PLAYERS_FILE, { players: [] }).players,
        logs: readJson(LOGS_FILE, { logs: [] }).logs
      });
    } catch (error) {
      // Ignore sync hook failures to keep local admin state functional.
    }
  }

  ensureFile(PLAYERS_FILE, { players: [] });
  ensureFile(LOGS_FILE, { logs: [] });
  ensureFile(DEVICE_FILE, {
    status: "disconnected",
    transport: "simulation",
    deviceName: "Heltec V3",
    connectedAt: null,
    lastMessageAt: null,
    localNodeId: null,
    localNodeNum: null,
    port: null
  });
  ensureFile(WORLD_FILE, defaultWorld());

  return {
    getPlayers() {
      return readJson(PLAYERS_FILE, { players: [] }).players;
    },

    savePlayers(players) {
      writeJson(PLAYERS_FILE, { players });
      emitPublicStateChanged();
    },

    deletePlayer(nodeId) {
      const payload = readJson(PLAYERS_FILE, { players: [] });
      const nextPlayers = payload.players.filter((player) => player.nodeId !== nodeId);
      writeJson(PLAYERS_FILE, { players: nextPlayers });
      emitPublicStateChanged();
      return nextPlayers.length !== payload.players.length;
    },

    getLogs() {
      return readJson(LOGS_FILE, { logs: [] }).logs;
    },

    appendLog(scope, message, extra = {}) {
      const payload = readJson(LOGS_FILE, { logs: [] });
      payload.logs.push({
        id: `log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        scope,
        message,
        ...extra
      });
      payload.logs = payload.logs.slice(-300);
      writeJson(LOGS_FILE, payload);
      emitPublicStateChanged();
    },

    clearLogs() {
      writeJson(LOGS_FILE, { logs: [] });
      emitPublicStateChanged();
    },

    getDeviceState() {
      return readJson(DEVICE_FILE, {
        status: "disconnected",
        transport: "simulation",
        deviceName: "Heltec V3",
        connectedAt: null,
        lastMessageAt: null,
        localNodeId: null,
        localNodeNum: null,
        port: null
      });
    },

    saveDeviceState(nextState) {
      writeJson(DEVICE_FILE, nextState);
    },

    getWorld() {
      const current = readJson(WORLD_FILE, defaultWorld());
      const normalized = normalizeWorldShape(current);
      if (JSON.stringify(current) !== JSON.stringify(normalized)) {
        writeJson(WORLD_FILE, normalized);
      }
      return normalized;
    },

    saveWorld(nextWorld) {
      const normalized = normalizeWorldShape(nextWorld);
      normalized.updatedAt = new Date().toISOString();
      writeJson(WORLD_FILE, normalized);
      emitPublicStateChanged();
      return normalized;
    },

    setPlayerPosition(nodeId, x, y) {
      const world = this.getWorld();
      const nextX = clamp(Number(x), 0, world.map.width - 1);
      const nextY = clamp(Number(y), 0, world.map.height - 1);
      world.playerPositions[String(nodeId)] = {
        x: nextX,
        y: nextY,
        updatedAt: new Date().toISOString()
      };
      return this.saveWorld(world);
    },

    removePlayerPosition(nodeId) {
      const world = this.getWorld();
      const id = String(nodeId);
      let changed = false;

      if (world.playerPositions[id]) {
        delete world.playerPositions[id];
        changed = true;
      }

      for (const [coord, ownerId] of Object.entries(world.landClaims || {})) {
        if (ownerId === id) {
          delete world.landClaims[coord];
          changed = true;
        }
      }

      const beforeOffers = Array.isArray(world.marketOffers) ? world.marketOffers.length : 0;
      world.marketOffers = (world.marketOffers || []).filter((offer) => offer.sellerNodeId !== id);
      if (world.marketOffers.length !== beforeOffers) {
        changed = true;
      }

      if (!changed) {
        return world;
      }
      return this.saveWorld(world);
    },

    resizeWorld(width, height) {
      const world = this.getWorld();
      const nextWidth = clamp(Number(width), 10, 120);
      const nextHeight = clamp(Number(height), 10, 120);

      const nextTiles = {};
      for (const [coord, tile] of Object.entries(world.map.tiles)) {
        const [xRaw, yRaw] = coord.split(",");
        const x = Number(xRaw);
        const y = Number(yRaw);
        if (x >= 0 && y >= 0 && x < nextWidth && y < nextHeight) {
          nextTiles[coord] = tile;
        }
      }

      const nextEntities = world.entities.filter(
        (entity) => entity.x >= 0 && entity.y >= 0 && entity.x < nextWidth && entity.y < nextHeight
      );

      const nextPlayerPositions = {};
      for (const [nodeId, position] of Object.entries(world.playerPositions)) {
        if (position.x >= 0 && position.y >= 0 && position.x < nextWidth && position.y < nextHeight) {
          nextPlayerPositions[nodeId] = position;
        }
      }

      return this.saveWorld({
        ...world,
        map: {
          width: nextWidth,
          height: nextHeight,
          tiles: nextTiles
        },
        entities: nextEntities,
        playerPositions: nextPlayerPositions
      });
    },

    upsertWorldTile(x, y, patch = {}) {
      const world = this.getWorld();
      const nextX = clamp(Number(x), 0, world.map.width - 1);
      const nextY = clamp(Number(y), 0, world.map.height - 1);
      const key = toCoordKey(nextX, nextY);
      const currentTile = world.map.tiles[key] || {};

      const terrain = patch.terrain ? String(patch.terrain).slice(0, 20) : currentTile.terrain || "plain";
      const blocked = patch.blocked === undefined ? Boolean(currentTile.blocked) : Boolean(patch.blocked);
      const label = patch.label === undefined
        ? String(currentTile.label || "")
        : String(patch.label || "").slice(0, 36);

      world.map.tiles[key] = {
        terrain,
        blocked,
        label
      };
      return this.saveWorld(world);
    },

    upsertWorldEntity(input) {
      const world = this.getWorld();
      const id = String(input.id || `entity_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`);
      const rawType = String(input.type || "event").slice(0, 20).toLowerCase();
      const entityType = rawType === "enemy" ? "event" : rawType;
      const entity = {
        id,
        type: entityType,
        name: String(input.name || "Entity").slice(0, 40),
        x: clamp(Number(input.x), 0, world.map.width - 1),
        y: clamp(Number(input.y), 0, world.map.height - 1),
        hp: Number.isFinite(Number(input.hp)) ? Number(input.hp) : null,
        meta: input.meta && typeof input.meta === "object" ? input.meta : {}
      };

      const index = world.entities.findIndex((item) => item.id === id);
      if (index >= 0) {
        world.entities[index] = entity;
      } else {
        world.entities.push(entity);
      }
      return this.saveWorld(world);
    },

    deleteWorldEntity(entityId) {
      const world = this.getWorld();
      const nextEntities = world.entities.filter((entity) => entity.id !== entityId);
      if (nextEntities.length === world.entities.length) {
        return { removed: false, world };
      }
      const saved = this.saveWorld({
        ...world,
        entities: nextEntities
      });
      return { removed: true, world: saved };
    },

    generateWorld(options = {}) {
      const current = this.getWorld();
      const width = clamp(Number(options.width) || current.map.width, 10, 120);
      const height = clamp(Number(options.height) || current.map.height, 10, 120);
      const seed = Number(options.seed) || Date.now();
      const generated = generateWorldLayout(width, height, seed);

      return this.saveWorld({
        ...current,
        map: generated.map,
        entities: generated.entities
      });
    }
  };
}

module.exports = {
  createStore
};
