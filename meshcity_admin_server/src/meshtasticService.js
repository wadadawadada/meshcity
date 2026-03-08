const crypto = require("crypto");
const { spawn } = require("child_process");
const path = require("path");
const { createMeshcityGame } = require("./game");

const BOT_TICK_MS = 4000;
const ECONOMY_TICK_MS = 20000;
const BOT_ACTION_MIN_MS = 8000;
const BOT_ACTION_MAX_MS = 18000;
const STARTING_CREDITS = 1200;
const FOUNDATION_CLAIM_COST = 140;
const BASE_CLAIM_COST = 90;
const CLAIM_GROWTH_COST = 10;
const CLAIM_RESERVE_CREDITS = 140;
const BUILD_RESERVE_CREDITS = 180;
const LOW_CREDIT_THRESHOLD = 180;
const STABLE_CREDIT_THRESHOLD = 420;
const MAX_OFFERS_PER_PLAYER = 6;
const RESOURCES = ["wood", "stone", "iron", "copper", "crystal", "food"];
const BUILDING_COSTS = {
  home: 60,
  farm: 90,
  mill: 110,
  mine: 130,
  shop: 150,
  hall: 220
};
const BUILDING_INCOME = {
  home: { credits: 3, food: 1 },
  farm: { food: 3, credits: 1 },
  mill: { wood: 3, credits: 1 },
  mine: { stone: 2, iron: 1, copper: 1, credits: 1 },
  shop: { credits: 6 },
  hall: { credits: 4, food: 1, wood: 1, stone: 1 }
};
const TERRAIN_HARVEST_WEIGHT = {
  town: 8,
  mountain: 7,
  forest: 6,
  plain: 5,
  road: 2,
  sand: 1,
  water: 1
};
const RESOURCE_TARGETS = {
  wood: 16,
  stone: 14,
  iron: 6,
  copper: 4,
  crystal: 2,
  food: 18
};
const SELL_CONFIG = {
  wood: { keep: 12, lot: 8, minPrice: 7, maxPrice: 10 },
  stone: { keep: 10, lot: 7, minPrice: 8, maxPrice: 11 },
  food: { keep: 14, lot: 10, minPrice: 6, maxPrice: 8 },
  iron: { keep: 4, lot: 4, minPrice: 14, maxPrice: 18 },
  copper: { keep: 3, lot: 3, minPrice: 13, maxPrice: 17 },
  crystal: { keep: 1, lot: 2, minPrice: 26, maxPrice: 32 }
};
const NAME_START = ["al", "be", "ca", "de", "el", "fa", "ga", "ha", "io", "ka", "la", "ma", "na", "or", "ra", "sa", "ta", "ve", "za"];
const NAME_MID = ["ri", "lo", "mi", "no", "va", "te", "di", "ra", "li", "so", "ke", "zu", "ne", "fi", "do", "re", "si", "mo"];
const NAME_END = ["n", "r", "s", "l", "m", "d", "th", "x", "v", "on", "en", "is", "or", "an", "el", "ar"];
const BOT_CHAT_LINES = [
  "surveying sector",
  "claiming new ground",
  "running inventory",
  "market scan online",
  "slow and steady",
  "route update"
];

function createMeshtasticService({ store }) {
  let bridgeProcess = null;
  let bridgeBuffer = "";
  let bridgeState = {
    mode: "simulation",
    port: null
  };
  const botRuntime = new Map();
  let lastEconomyTickAt = 0;

  const game = createMeshcityGame({
    store,
    async sendDirectMessage(target, text) {
      const destinationId = typeof target === "string" ? target : target.from;
      const destinationNum = typeof target === "object" ? target.fromNum || null : null;
      const syntheticTarget = Boolean(typeof target === "object" && (target.synthetic || target.isBot));
      const device = store.getDeviceState();
      device.lastMessageAt = new Date().toISOString();
      store.saveDeviceState(device);

      if (!syntheticTarget && device.transport === "serial" && bridgeProcess) {
        try {
          bridgeProcess.stdin.write(`${JSON.stringify({
            action: "send_text",
            destinationId,
            destinationNum,
            text
          })}\n`);
        } catch (error) {
          store.appendLog("error", `Failed to queue DM to ${destinationId}: ${error.message}`);
        }
      } else if (!syntheticTarget && device.transport === "serial") {
        store.appendLog("error", `Cannot send DM to ${destinationId}: serial bridge is not running`);
      }

      store.appendLog("tx", `DM queued to ${destinationId}: ${text}`);
    }
  });

  function randomBetween(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function generateNodeId(existingIds) {
    let nodeId = "";
    do {
      nodeId = `!${crypto.randomBytes(4).toString("hex")}`;
    } while (existingIds.has(nodeId));
    return nodeId;
  }

  function toKey(x, y) {
    return `${x},${y}`;
  }

  function addResources(base, delta) {
    const next = { ...(base || {}) };
    for (const resource of RESOURCES) {
      next[resource] = Math.max(0, Number(next[resource]) || 0);
    }
    for (const [key, value] of Object.entries(delta || {})) {
      next[key] = Math.max(0, (Number(next[key]) || 0) + (Number(value) || 0));
    }
    return next;
  }

  function districtLevelFromLand(landCount) {
    const count = Math.max(0, Number(landCount) || 0);
    if (count >= 19) return 5;
    if (count >= 13) return 4;
    if (count >= 8) return 3;
    if (count >= 4) return 2;
    return 1;
  }

  function claimCost(nextCount) {
    return BASE_CLAIM_COST + Math.max(0, nextCount - 1) * CLAIM_GROWTH_COST;
  }

  function offerPriceBounds(resource) {
    const config = SELL_CONFIG[resource];
    if (!config) {
      return { min: 8, max: 16 };
    }
    return { min: config.minPrice, max: config.maxPrice };
  }

  function playerHasShop(player) {
    const buildings = player && player.gameState && player.gameState.buildings ? player.gameState.buildings : {};
    return Object.values(buildings).some((list) => Array.isArray(list) && list.includes("shop"));
  }

  function getOwnedOffers(nodeId, world) {
    return (Array.isArray(world.marketOffers) ? world.marketOffers : []).filter((offer) => offer.sellerNodeId === nodeId);
  }

  function estimatePassiveIncome(player, world) {
    const claims = Array.isArray(player.gameState && player.gameState.claimedCells) ? player.gameState.claimedCells : [];
    const buildings = player.gameState && player.gameState.buildings ? player.gameState.buildings : {};
    const income = {
      credits: Math.max(1, Math.floor(claims.length / 2)),
      food: Math.max(1, Math.floor(claims.length / 4))
    };

    for (const key of claims) {
      const tile = world.map.tiles[key] || { terrain: "plain" };
      if (tile.terrain === "town") income.credits += 2;
      if (tile.terrain === "forest") income.wood = (income.wood || 0) + 1;
      if (tile.terrain === "mountain") income.stone = (income.stone || 0) + 1;
    }

    for (const list of Object.values(buildings)) {
      if (!Array.isArray(list)) continue;
      for (const type of list) {
        const bonus = BUILDING_INCOME[type];
        if (!bonus) continue;
        for (const [key, value] of Object.entries(bonus)) {
          income[key] = (income[key] || 0) + value;
        }
      }
    }

    return income;
  }

  function runEconomyTick() {
    const now = Date.now();
    if (now - lastEconomyTickAt < ECONOMY_TICK_MS) {
      return;
    }
    lastEconomyTickAt = now;

    const players = getPlayers();
    if (!players.length) {
      return;
    }

    const world = store.getWorld();
    let changed = false;
    const nextPlayers = players.map((player) => {
      if (!player || !player.registered || !player.gameState || !player.gameState.hasStarted) {
        return player;
      }
      const claims = Array.isArray(player.gameState.claimedCells) ? player.gameState.claimedCells : [];
      if (!claims.length) {
        return player;
      }

      const income = estimatePassiveIncome(player, world);
      const creditIncome = Math.max(0, Number(income.credits) || 0);
      const resourceIncome = { ...income };
      delete resourceIncome.credits;
      const nextResources = addResources(player.gameState.resources, resourceIncome);
      const nextCredits = Math.max(0, Number(player.stats && player.stats.credits) || 0) + creditIncome;
      changed = true;

      return {
        ...player,
        updatedAt: new Date(now).toISOString(),
        stats: {
          ...player.stats,
          credits: nextCredits
        },
        gameState: {
          ...player.gameState,
          resources: nextResources,
          cityLevel: districtLevelFromLand(claims.length),
          lastEconomyTickAt: new Date(now).toISOString()
        }
      };
    });

    if (changed) {
      store.savePlayers(nextPlayers);
    }
  }

  function nameKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function capitalize(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function generateBotNameCandidate() {
    const start = NAME_START[Math.floor(Math.random() * NAME_START.length)];
    const mid = NAME_MID[Math.floor(Math.random() * NAME_MID.length)];
    const end = NAME_END[Math.floor(Math.random() * NAME_END.length)];
    const withMid = Math.random() > 0.35;
    const raw = withMid ? `${start}${mid}${end}` : `${start}${end}`;
    return capitalize(raw.slice(0, 20));
  }

  function pickUniqueBotName(usedNames = new Set()) {
    for (let i = 0; i < 320; i += 1) {
      const candidate = generateBotNameCandidate();
      const key = nameKey(candidate);
      if (!candidate || usedNames.has(key)) continue;
      usedNames.add(key);
      return candidate;
    }

    const fallback = `Nova${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, "");
    const fallbackName = capitalize(fallback.slice(0, 20));
    usedNames.add(nameKey(fallbackName));
    return fallbackName;
  }

  function looksBotLikeName(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized.includes("bot")
      || normalized.includes("drone")
      || normalized.includes("unit")
      || normalized.includes("relay")
      || normalized.includes("grid")
      || normalized.includes("signal")
      || normalized.includes("cinder")
      || normalized.includes("dust")
      || normalized.includes("scout")
      || normalized.includes("rover");
  }

  function normalizeExistingBotIdentity(player, usedNames = new Set()) {
    if (!player || !player.isBot) {
      return player;
    }
    const currentName = String(player.shortName || "").trim();
    const firstWordName = currentName.split(/\s+/)[0] || "";
    const normalizedFirstWord = capitalize(firstWordName).replace(/[^a-z]/gi, "");
    const firstWordKey = nameKey(normalizedFirstWord);
    const nextName = looksBotLikeName(currentName) || /\d/.test(currentName) || /\s/.test(currentName)
      ? pickUniqueBotName(usedNames)
      : (!normalizedFirstWord || usedNames.has(firstWordKey))
        ? pickUniqueBotName(usedNames)
        : normalizedFirstWord;
    const nextAvatar = player.avatar === "\u{1F916}" || !String(player.avatar || "").trim()
      ? null
      : player.avatar;
    if (nextName && !usedNames.has(nameKey(nextName))) {
      usedNames.add(nameKey(nextName));
    }
    if (nextName === player.shortName && nextAvatar === player.avatar) {
      return player;
    }
    return {
      ...player,
      shortName: nextName || pickUniqueBotName(usedNames),
      avatar: nextAvatar || undefined,
      updatedAt: new Date().toISOString()
    };
  }

  function scheduleBot(nodeId, delayMs = randomBetween(BOT_ACTION_MIN_MS, BOT_ACTION_MAX_MS)) {
    const entry = botRuntime.get(nodeId) || {};
    botRuntime.set(nodeId, {
      ...entry,
      nextActionAt: Date.now() + delayMs,
      running: false
    });
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function createBotMessage(player, text) {
    return {
      from: player.nodeId,
      fromName: player.shortName || "Bot",
      text,
      channel: "direct",
      synthetic: true,
      isBot: true
    };
  }

  async function dispatchBotCommand(player, text) {
    store.appendLog("bot", `${player.shortName || player.nodeId}: ${text}`);
    await game.handleDirectMessage(createBotMessage(player, text));
    scheduleBot(player.nodeId);
  }

  function getPlayers() {
    return store.getPlayers();
  }

  function getPlayer(nodeId) {
    return getPlayers().find((player) => player.nodeId === nodeId) || null;
  }

  function updatePlayer(nodeId, updater) {
    const players = getPlayers();
    const index = players.findIndex((player) => player.nodeId === nodeId);
    if (index < 0) {
      return null;
    }
    const current = players[index];
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    players[index] = next;
    store.savePlayers(players);
    return next;
  }

  function isRestrictedTile(tile) {
    const terrain = String(tile && tile.terrain ? tile.terrain : "plain").toLowerCase();
    return Boolean(tile && tile.blocked) || terrain === "water" || terrain === "sand" || terrain === "road";
  }

  function coordKey(x, y) {
    return `${x},${y}`;
  }

  function fromCoordKey(key) {
    const [xRaw, yRaw] = String(key || "").split(",");
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return null;
    }
    return { x, y };
  }

  function neighbors(x, y, world) {
    const list = [
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 }
    ];
    return list.filter((cell) => cell.x >= 0 && cell.y >= 0 && cell.x < world.map.width && cell.y < world.map.height);
  }

  function directionToward(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
      return dx > 0 ? "e" : "w";
    }
    if (dy !== 0) {
      return dy > 0 ? "s" : "n";
    }
    return null;
  }

  function firstClaimTarget(player, world) {
    const pos = world.playerPositions[player.nodeId];
    if (!pos) {
      return null;
    }
    const maxRadius = Math.max(world.map.width, world.map.height);
    for (let radius = 0; radius <= maxRadius; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const x = pos.x + dx;
          const y = pos.y + dy;
          if (x < 0 || y < 0 || x >= world.map.width || y >= world.map.height) continue;
          const key = coordKey(x, y);
          if (world.landClaims[key]) continue;
          const tile = world.map.tiles[key] || { terrain: "plain", blocked: false };
          if (isRestrictedTile(tile)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  function expansionTarget(player, world) {
    const claims = Array.isArray(player.gameState && player.gameState.claimedCells) ? player.gameState.claimedCells : [];
    const candidates = [];
    for (const claim of claims) {
      const cell = fromCoordKey(claim);
      if (!cell) continue;
      for (const neighbor of neighbors(cell.x, cell.y, world)) {
        const key = coordKey(neighbor.x, neighbor.y);
        if (world.landClaims[key]) continue;
        const tile = world.map.tiles[key] || { terrain: "plain", blocked: false };
        if (isRestrictedTile(tile)) continue;
        candidates.push(neighbor);
      }
    }
    if (!candidates.length) {
      return null;
    }
    const pos = world.playerPositions[player.nodeId] || { x: 0, y: 0 };
    candidates.sort((a, b) => {
      const da = Math.abs(a.x - pos.x) + Math.abs(a.y - pos.y);
      const db = Math.abs(b.x - pos.x) + Math.abs(b.y - pos.y);
      return da - db;
    });
    return candidates[0];
  }

  function buildingPlan(player, world) {
    const claims = Array.isArray(player.gameState && player.gameState.claimedCells) ? player.gameState.claimedCells : [];
    const buildings = player.gameState && player.gameState.buildings ? player.gameState.buildings : {};
    const cityCore = player.gameState ? player.gameState.cityCore : null;
    const level = Number(player.gameState && player.gameState.cityLevel) || 1;
    const credits = Number(player.stats && player.stats.credits) || 0;
    const hasShop = playerHasShop(player);
    const options = [];

    for (const key of claims) {
      const cell = fromCoordKey(key);
      if (!cell) continue;
      const tile = world.map.tiles[key] || { terrain: "plain", blocked: false };
      const existing = Array.isArray(buildings[key]) ? buildings[key] : [];
      const usedSlots = existing.reduce((sum, type) => sum + (type === "hall" ? 2 : 1), 0);
      const maxSlots = cityCore === key ? 3 : 2;
      if (usedSlots >= maxSlots) continue;

      if (level >= 3 && cityCore === key && !Object.values(buildings).some((list) => Array.isArray(list) && list.includes("hall")) && credits - BUILDING_COSTS.hall >= BUILD_RESERVE_CREDITS && usedSlots <= 1) {
        return { type: "hall", x: cell.x, y: cell.y };
      }

      if (!hasShop && (tile.terrain === "town" || tile.terrain === "plain") && credits - BUILDING_COSTS.shop >= BUILD_RESERVE_CREDITS - 40) {
        options.push({ type: "shop", x: cell.x, y: cell.y, weight: tile.terrain === "town" ? 10 : 9 });
      }
      if (tile.terrain === "mountain" && credits - BUILDING_COSTS.mine >= BUILD_RESERVE_CREDITS) options.push({ type: "mine", x: cell.x, y: cell.y, weight: 7 });
      if (tile.terrain === "forest" && credits - BUILDING_COSTS.mill >= BUILD_RESERVE_CREDITS) options.push({ type: "mill", x: cell.x, y: cell.y, weight: 6 });
      if ((tile.terrain === "plain" || tile.terrain === "town") && credits - BUILDING_COSTS.farm >= BUILD_RESERVE_CREDITS) options.push({ type: "farm", x: cell.x, y: cell.y, weight: 5 });
      if (credits - BUILDING_COSTS.home >= BUILD_RESERVE_CREDITS) options.push({ type: "home", x: cell.x, y: cell.y, weight: 2 });
    }

    if (!options.length) {
      return null;
    }
    options.sort((a, b) => b.weight - a.weight);
    return options[0];
  }

  function marketBuyPlan(player, world) {
    const offers = Array.isArray(world.marketOffers) ? world.marketOffers : [];
    const credits = Number(player.stats && player.stats.credits) || 0;
    const resources = player.gameState && player.gameState.resources ? player.gameState.resources : {};
    const sortedOffers = offers
      .filter((offer) => offer.sellerNodeId !== player.nodeId && Number.isInteger(offer.qty) && offer.qty > 0 && Number.isInteger(offer.unitPrice) && offer.unitPrice > 0)
      .slice()
      .sort((a, b) => a.unitPrice - b.unitPrice);

    for (const offer of sortedOffers) {
      const target = RESOURCE_TARGETS[offer.resource] || 0;
      const have = Number(resources[offer.resource]) || 0;
      const shortage = Math.max(0, target - have);
      if (!shortage) continue;
      const bounds = offerPriceBounds(offer.resource);
      if (offer.unitPrice > bounds.max) continue;
      if (offer.sellerNodeId === player.nodeId) continue;
      const maxAffordable = Math.floor(credits / offer.unitPrice);
      const qty = Math.min(offer.qty, Math.max(0, maxAffordable), shortage, offer.resource === "food" ? 8 : 4);
      if (qty > 0) {
        return { id: offer.id, qty };
      }
    }
    return null;
  }

  function marketSellPlan(player, world) {
    if (!playerHasShop(player)) {
      return null;
    }
    const resources = player.gameState && player.gameState.resources ? player.gameState.resources : {};
    const myOffers = getOwnedOffers(player.nodeId, world);
    if (myOffers.length >= MAX_OFFERS_PER_PLAYER) {
      return null;
    }
    for (const resource of RESOURCES) {
      const config = SELL_CONFIG[resource];
      if (!config) continue;
      const have = Number(resources[resource]) || 0;
      const alreadyListed = myOffers
        .filter((offer) => offer.resource === resource)
        .reduce((sum, offer) => sum + (Number(offer.qty) || 0), 0);
      const surplus = have - config.keep - alreadyListed;
      if (surplus <= 0) continue;
      const price = randomBetween(config.minPrice, config.maxPrice);
      return { resource, qty: Math.min(config.lot, surplus), unitPrice: price };
    }
    return null;
  }

  function harvestTarget(player, world) {
    const claims = Array.isArray(player.gameState && player.gameState.claimedCells) ? player.gameState.claimedCells : [];
    if (!claims.length) {
      return null;
    }

    let best = null;
    for (const key of claims) {
      const cell = fromCoordKey(key);
      if (!cell) continue;
      const tile = world.map.tiles[key] || { terrain: "plain" };
      const buildings = Array.isArray(player.gameState.buildings && player.gameState.buildings[key]) ? player.gameState.buildings[key] : [];
      const buildingBonus = buildings.length * 3;
      const score = (TERRAIN_HARVEST_WEIGHT[tile.terrain] || 4) + buildingBonus;
      if (!best || score > best.score) {
        best = { x: cell.x, y: cell.y, score };
      }
    }
    return best;
  }

  function needsRecovery(player) {
    const credits = Number(player.stats && player.stats.credits) || 0;
    const resources = player.gameState && player.gameState.resources ? player.gameState.resources : {};
    return credits < LOW_CREDIT_THRESHOLD || (Number(resources.food) || 0) < 8;
  }

  function canAffordClaim(player) {
    const claims = Array.isArray(player.gameState && player.gameState.claimedCells) ? player.gameState.claimedCells : [];
    const credits = Number(player.stats && player.stats.credits) || 0;
    const nextCost = claims.length === 0 ? FOUNDATION_CLAIM_COST : claimCost(claims.length + 1);
    return credits >= nextCost + CLAIM_RESERVE_CREDITS;
  }

  function botStepCommand(player) {
    const textState = normalizeText(player.registrationState);
    if (!player.registered && textState === "pending_confirmation") {
      return "y";
    }
    if (!player.registered && textState === "awaiting_nickname") {
      return player.shortName || `Bot${Math.floor(Math.random() * 1000)}`;
    }
    if (!player.registered && textState === "declined") {
      return "y";
    }
    if (!player.gameState || !player.gameState.hasStarted) {
      return "start";
    }
    if (!player.gameState.sessionActive) {
      return "continue";
    }
    if (player.gameState.awaitingDistrictName && player.gameState.cityCore) {
      const suffix = String(player.nodeId || "").slice(-3).replace(/[^a-z0-9]/gi, "").toUpperCase() || "BOT";
      return `name ${player.shortName || "Bot"} ${suffix}`.slice(0, 28);
    }

    const world = store.getWorld();
    const pos = world.playerPositions[player.nodeId] || player.position || (player.gameState && player.gameState.position) || null;
    if (!pos) {
      return null;
    }

    const currentKey = coordKey(pos.x, pos.y);
    const claims = Array.isArray(player.gameState.claimedCells) ? player.gameState.claimedCells : [];
    const credits = Number(player.stats && player.stats.credits) || 0;
    const hasShop = playerHasShop(player);

    if (!claims.length) {
      const target = firstClaimTarget(player, world);
      if (!target) return "scan";
      if (credits < FOUNDATION_CLAIM_COST) {
        return Math.random() < 0.5 ? "status" : "scan";
      }
      if (target.x === pos.x && target.y === pos.y) {
        return `claim ${target.x} ${target.y}`;
      }
      const dir = directionToward(pos, target);
      return dir ? `move ${dir}` : "scan";
    }

    if (needsRecovery(player)) {
      const target = harvestTarget(player, world);
      if (target) {
        if (target.x === pos.x && target.y === pos.y) {
          return `harvest ${target.x} ${target.y}`;
        }
        const dir = directionToward(pos, target);
        if (dir) {
          return `move ${dir}`;
        }
      }
    }

    if (claims.includes(currentKey) && (Math.random() < 0.48 || credits < STABLE_CREDIT_THRESHOLD)) {
      return `harvest ${pos.x} ${pos.y}`;
    }

    if (!hasShop && credits >= BUILDING_COSTS.shop + 40) {
      const build = buildingPlan(player, world);
      if (build && build.type === "shop") {
        return `build ${build.type} ${build.x} ${build.y}`;
      }
    }

    if (Math.random() < 0.24) {
      const sell = marketSellPlan(player, world);
      if (sell && sell.qty > 0) {
        return `trade sell ${sell.resource} ${sell.qty} ${sell.unitPrice}`;
      }
    }

    if (Math.random() < 0.2) {
      const buy = marketBuyPlan(player, world);
      if (buy) {
        return `trade buy ${buy.id} ${buy.qty}`;
      }
    }

    if (Math.random() < 0.18 && credits >= STABLE_CREDIT_THRESHOLD) {
      const build = buildingPlan(player, world);
      if (build) {
        return `build ${build.type} ${build.x} ${build.y}`;
      }
    }

    if (Math.random() < 0.08) {
      return `chat ${BOT_CHAT_LINES[Math.floor(Math.random() * BOT_CHAT_LINES.length)]}`;
    }

    if (credits >= STABLE_CREDIT_THRESHOLD && canAffordClaim(player)) {
      const claimTarget = expansionTarget(player, world);
      if (claimTarget) {
        if (claimTarget.x === pos.x && claimTarget.y === pos.y) {
          return `claim ${claimTarget.x} ${claimTarget.y}`;
        }
        const dir = directionToward(pos, claimTarget);
        if (dir) {
          return `move ${dir}`;
        }
      }
    }

    const roamTargets = neighbors(pos.x, pos.y, world).filter((cell) => {
      const tile = world.map.tiles[coordKey(cell.x, cell.y)] || { terrain: "plain", blocked: false };
      return !Boolean(tile.blocked) && String(tile.terrain) !== "water";
    });
    if (roamTargets.length) {
      const target = roamTargets[Math.floor(Math.random() * roamTargets.length)];
      const dir = directionToward(pos, target);
      if (dir) {
        return `move ${dir}`;
      }
    }

    return Math.random() < 0.5 ? "status" : "scan";
  }

  async function runBotStep(player) {
    const command = botStepCommand(player);
    if (!command) {
      scheduleBot(player.nodeId);
      return;
    }
    await dispatchBotCommand(player, command);
  }

  async function tickBots() {
    runEconomyTick();

    const players = getPlayers();
    const usedNames = new Set(
      players
        .filter((player) => player && !player.isBot)
        .map((player) => nameKey(player.shortName))
        .filter(Boolean)
    );
    let normalizedPlayers = null;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      const normalized = normalizeExistingBotIdentity(player, usedNames);
      if (normalized !== player) {
        if (!normalizedPlayers) {
          normalizedPlayers = players.slice();
        }
        normalizedPlayers[index] = normalized;
      }
    }
    const activePlayers = normalizedPlayers || players;
    if (normalizedPlayers) {
      store.savePlayers(normalizedPlayers);
    }
    const botIds = new Set(activePlayers.filter((player) => player && player.isBot).map((player) => player.nodeId));

    for (const nodeId of Array.from(botRuntime.keys())) {
      if (!botIds.has(nodeId)) {
        botRuntime.delete(nodeId);
      }
    }

    for (const player of activePlayers) {
      if (!player || !player.isBot) continue;
      const runtime = botRuntime.get(player.nodeId) || { nextActionAt: 0, running: false };
      if (runtime.running || runtime.nextActionAt > Date.now()) continue;

      botRuntime.set(player.nodeId, { ...runtime, running: true });
      try {
        await runBotStep(player);
      } catch (error) {
        store.appendLog("error", `Bot ${player.nodeId} failed: ${error.message}`);
        scheduleBot(player.nodeId, BOT_ACTION_MAX_MS);
      } finally {
        const current = botRuntime.get(player.nodeId) || {};
        botRuntime.set(player.nodeId, { ...current, running: false });
      }
    }
  }

  async function bootstrapBot(nodeId) {
    const current = getPlayer(nodeId);
    if (!current) {
      return null;
    }
    const setupMessages = ["hello", "y", current.shortName || "Bot", "start"];
    for (const text of setupMessages) {
      const latest = getPlayer(nodeId) || current;
      await game.handleDirectMessage(createBotMessage(latest, text));
    }
    return getPlayer(nodeId);
  }

  async function createBot() {
    const nodeId = generateNodeId(new Set(getPlayers().map((player) => String(player.nodeId || ""))));
    const usedNames = new Set(getPlayers().map((player) => nameKey(player.shortName)).filter(Boolean));
    const nickname = pickUniqueBotName(usedNames).slice(0, 20);
    const now = new Date().toISOString();

    store.savePlayers([
      ...getPlayers(),
      {
        nodeId,
        shortName: nickname,
        isBot: true,
        registered: false,
        registrationState: "pending_confirmation",
        createdAt: now,
        updatedAt: now,
        botProfile: {
          pace: "slow",
          createdBy: "admin",
          createdAt: now
        },
        stats: { level: 1, hp: 10, xp: 0, credits: STARTING_CREDITS },
        gameState: {
          hasStarted: false,
          sessionActive: false,
          resources: { wood: 8, stone: 6, iron: 0, copper: 0, crystal: 0, food: 4 },
          claimedCells: [],
          buildings: {},
          cityLevel: 1,
          districtName: "",
          awaitingDistrictName: false
        }
      }
    ]);

    await bootstrapBot(nodeId);
    updatePlayer(nodeId, (player) => ({
      ...player,
      isBot: true,
      botProfile: {
        pace: "slow",
        createdBy: "admin",
        createdAt: now
      },
      updatedAt: new Date().toISOString()
    }));
    scheduleBot(nodeId, randomBetween(3000, 7000));
    store.appendLog("admin", `Bot added: ${nickname} (${nodeId})`);
    return getPlayer(nodeId);
  }

  function bootstrapDeviceState() {
    const current = store.getDeviceState();
    if (current.status === "connected" || current.status === "connecting") {
      store.saveDeviceState({
        ...current,
        status: "disconnected"
      });
      store.appendLog("device", "Recovered from stale startup state: set to disconnected");
    }
  }

  bootstrapDeviceState();
  setInterval(() => {
    void tickBots();
  }, BOT_TICK_MS);

  function restoreConnectionFromSavedState() {
    const current = store.getDeviceState();
    if (current.transport !== "serial") {
      return null;
    }

    try {
      const nextState = connectSerial(current.port || null);
      store.appendLog(
        "device",
        `Auto-connect requested on startup using ${current.port || "auto-detect"}`
      );
      return nextState;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.appendLog("error", `Auto-connect failed on startup: ${message}`);
      return null;
    }
  }

  function setDisconnected(message) {
    const nextState = {
      ...store.getDeviceState(),
      status: "disconnected",
      connectedAt: null
    };
    store.saveDeviceState(nextState);
    if (message) {
      store.appendLog("device", message);
    }
    bridgeProcess = null;
    bridgeBuffer = "";
    bridgeState = {
      mode: "simulation",
      port: null
    };
    return nextState;
  }

  async function handleIncomingMessage(message) {
    const device = store.getDeviceState();
    device.lastMessageAt = new Date().toISOString();
    store.saveDeviceState(device);

    if (message.channel === "public") {
      store.appendLog("rx", `Public message ignored from ${message.from}: ${message.text}`);
      return { ignored: true };
    }

    if (message.channel !== "direct") {
      store.appendLog("rx", `Unknown channel ignored from ${message.from}`);
      return { ignored: true };
    }

    store.appendLog("rx", `Direct message from ${message.from}: ${message.text}`);
    await game.handleDirectMessage(message);
    return { ok: true };
  }

  function handleBridgeEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "connected") {
      const nextState = {
        ...store.getDeviceState(),
        status: "connected",
        transport: "serial",
        connectedAt: new Date().toISOString(),
        deviceName: event.deviceName || "Heltec V3",
        localNodeId: event.localNodeId || null,
        localNodeNum: event.localNodeNum || null,
        port: event.port || bridgeState.port
      };
      store.saveDeviceState(nextState);
      store.appendLog("device", `Serial connection established on ${nextState.port || "auto"}`);
      return;
    }

    if (event.type === "log") {
      store.appendLog(event.scope || "bridge", event.message || "bridge event");
      return;
    }

    if (event.type === "receive_text") {
      void handleIncomingMessage({
        from: event.fromId || String(event.from || "!unknown"),
        fromNum: event.from || null,
        fromName: event.fromName || "Unknown traveler",
        text: event.text || "",
        channel: event.channel || "public"
      });
      return;
    }

    if (event.type === "error") {
      store.appendLog("error", event.message || "Meshtastic bridge error");
      return;
    }

    if (event.type === "connection_lost") {
      setDisconnected("Connection to device lost");
    }
  }

  function connectSerial(port) {
    if (bridgeProcess) {
      throw new Error("Device is already connected");
    }

    const scriptPath = path.join(process.cwd(), "scripts", "meshtastic_bridge.py");
    const args = [scriptPath];
    if (port) {
      args.push("--port", port);
    }

    bridgeProcess = spawn("python", args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    bridgeState = {
      mode: "serial",
      port: port || null
    };

    bridgeProcess.stdout.on("data", (chunk) => {
      bridgeBuffer += chunk.toString("utf8");
      const lines = bridgeBuffer.split(/\r?\n/);
      bridgeBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          handleBridgeEvent(JSON.parse(line));
        } catch (error) {
          store.appendLog("error", `Bridge JSON parse error: ${line}`);
        }
      }
    });

    bridgeProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        store.appendLog("bridge", message);
      }
    });

    bridgeProcess.on("exit", (code) => {
      if (bridgeProcess) {
        setDisconnected(`Bridge process exited with code ${code}`);
      }
    });

    const pendingState = {
      ...store.getDeviceState(),
      status: "connecting",
      transport: "serial",
      connectedAt: null,
      port: port || null
    };
    store.saveDeviceState(pendingState);
    store.appendLog("device", `Opening serial connection ${port || "auto-detect"}`);
    return pendingState;
  }

  return {
    getStatus() {
      return store.getDeviceState();
    },

    connect(transport = "simulation", options = {}) {
      if (transport === "serial") {
        return connectSerial(options.port || null);
      }

      const nextState = {
        ...store.getDeviceState(),
        status: "connected",
        transport,
        connectedAt: new Date().toISOString(),
        port: null
      };
      store.saveDeviceState(nextState);
      store.appendLog("device", `Connected using ${transport} transport`);
      return nextState;
    },

    disconnect() {
      if (bridgeProcess) {
        try {
          bridgeProcess.stdin.write(`${JSON.stringify({ action: "disconnect" })}\n`);
        } catch (error) {
          store.appendLog("error", `Failed to signal bridge disconnect: ${error.message}`);
        }

        try {
          bridgeProcess.kill();
        } catch (error) {
          store.appendLog("error", `Failed to stop bridge process: ${error.message}`);
        }
      }

      return setDisconnected("Disconnected from device");
    },

    async receiveMessage(message) {
      return handleIncomingMessage(message);
    },

    async createBot() {
      return createBot();
    },

    restoreConnectionFromSavedState() {
      return restoreConnectionFromSavedState();
    }
  };
}

module.exports = {
  createMeshtasticService
};
