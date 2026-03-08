function normalizeText(v) {
  return String(v || "").trim().toLowerCase();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toKey(x, y) {
  return `${x},${y}`;
}

function fromKey(key) {
  const [xRaw, yRaw] = String(key || "").split(",");
  const x = Number(xRaw);
  const y = Number(yRaw);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function parseNickname(value) {
  const nickname = String(value || "").trim().replace(/\s+/g, " ");
  if (nickname.length < 3 || nickname.length > 20) return null;
  if (/^(y|yes|n|no)$/i.test(nickname)) return null;
  return nickname;
}

function parseCommand(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return { cmd: "", args: [] };
  const parts = raw.split(/\s+/g);
  return { cmd: normalizeText(parts[0]), args: parts.slice(1) };
}

function normalizeHelpCategory(raw) {
  const key = normalizeText(raw);
  const aliases = {
    base: "core",
    basics: "core",
    core: "core",
    city: "core",
    claim: "expansion",
    territory: "expansion",
    land: "expansion",
    expansion: "expansion",
    map: "expansion",
    gather: "economy",
    economy: "economy",
    build: "economy",
    trade: "market",
    market: "market",
    social: "social",
    chat: "social",
    system: "system",
    misc: "system"
  };
  return aliases[key] || "";
}

function helpCategoryText(category) {
  const c = normalizeHelpCategory(category);
  if (c === "core") {
    return "HELP CORE:\nSTART - start player session\nNAME <district> - name your district after first claim\nSTATUS - player and district summary\nRESOURCES - resource stock\nPAUSE - pause session\nCONTINUE - resume session";
  }
  if (c === "expansion") {
    return "HELP EXPANSION:\nMOVE <n|s|e|w>\nSCAN - inspect nearby tiles\nTILE [x y] - tile owner/building info\nLAND - land summary and next claim cost\nCLAIM <x> <y> - first claim starts your district, next claims must be adjacent";
  }
  if (c === "economy") {
    return "HELP ECONOMY:\nHARVEST [x y] - collect district income from a tile\nBUILD <home|farm|mill|mine|shop|hall> <x> <y>\nBuild only on claimed plain/forest/mountain/town tiles";
  }
  if (c === "market") {
    return "HELP MARKET:\nTRADE LIST\nTRADE SELL <resource> <qty> <unitPrice>\nTRADE BUY <offerId> <qty>\nTRADE CANCEL <offerId>";
  }
  if (c === "social") {
    return "HELP SOCIAL:\nCHAT <message> - show bubble above player\nCHAT CLEAR - remove bubble";
  }
  if (c === "system") {
    return "HELP SYSTEM:\nHELP - categories\nHELP <category> - quick category help\nMap + instructions: https://meshcity.fun";
  }
  return "";
}

const STARTING_CREDITS = 1200;
const BASE_CLAIM_COST = 90;
const CLAIM_GROWTH_COST = 10;
const FOUNDATION_CLAIM_COST = 140;
const MAX_OFFERS_PER_PLAYER = 6;
const TARGET_CONCURRENT_PLAYERS = 20;
const RESOURCES = ["wood", "stone", "iron", "copper", "crystal", "food"];
const RES_LABEL = { wood: "Wood", stone: "Stone", iron: "Iron", copper: "Copper", crystal: "Crystal", food: "Food" };

const YIELDS = {
  plain: { food: [3, 6], wood: [1, 2], stone: [0, 1] },
  sand: { food: [0, 1] },
  forest: { wood: [4, 8], food: [1, 3], stone: [0, 1] },
  mountain: { stone: [4, 8], iron: [2, 5], copper: [1, 3], crystal: [0, 1] },
  road: { stone: [1, 2], food: [1, 2] },
  town: { food: [2, 4], wood: [1, 2], stone: [1, 2] },
  water: { food: [1, 3] }
};

const BUILDINGS = {
  home: { label: "Home", costCredits: 60, minLevel: 1, slotCost: 1, yields: { credits: 2, food: 1 } },
  farm: { label: "Farm", costCredits: 90, minLevel: 1, slotCost: 1, yields: { food: 4 } },
  mill: { label: "Mill", costCredits: 110, minLevel: 1, slotCost: 1, yields: { wood: 4 } },
  mine: { label: "Mine", costCredits: 130, minLevel: 1, slotCost: 1, yields: { stone: 3, iron: 1 } },
  shop: { label: "Shop", costCredits: 150, minLevel: 1, slotCost: 1, yields: { credits: 5 } },
  hall: { label: "Hall", costCredits: 220, minLevel: 3, slotCost: 2, yields: { credits: 2, food: 1, wood: 1, stone: 1 } }
};

function rng(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function ensureResources(input) {
  const next = {};
  for (const key of RESOURCES) next[key] = Math.max(0, Number(input && input[key]) || 0);
  return next;
}

function addResources(base, delta) {
  const next = { ...base };
  for (const [k, v] of Object.entries(delta || {})) next[k] = Math.max(0, (Number(next[k]) || 0) + Number(v));
  return next;
}

function subResources(base, delta) {
  const next = { ...base };
  for (const [k, v] of Object.entries(delta || {})) next[k] = Math.max(0, (Number(next[k]) || 0) - Number(v));
  return next;
}

function hasResources(base, need) {
  return Object.entries(need || {}).every(([k, v]) => (Number(base[k]) || 0) >= Number(v));
}

function resSummary(res) {
  return RESOURCES.map((k) => `${RES_LABEL[k]}:${Math.max(0, Number(res[k]) || 0)}`).join(" ");
}

function parseResource(raw) {
  const key = normalizeText(raw);
  if (RESOURCES.includes(key)) return key;
  const map = { lumber: "wood", ore: "iron", meal: "food" };
  return map[key] || null;
}

function parseDistrictName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name.length < 3 || name.length > 24) return null;
  if (/^(y|yes|n|no|help|start|claim|name)$/i.test(name)) return null;
  return name;
}

function districtLevelFromLand(landCount) {
  const count = Math.max(0, Number(landCount) || 0);
  if (count >= 19) return 5;
  if (count >= 13) return 4;
  if (count >= 8) return 3;
  if (count >= 4) return 2;
  return 1;
}

function normalizeBuildingType(type) {
  const key = normalizeText(type);
  const aliases = {
    sawmill: "mill",
    market: "shop"
  };
  return aliases[key] || key;
}

function normalizeBuildingsMap(input) {
  const next = {};
  if (!input || typeof input !== "object") return next;
  for (const [cell, raw] of Object.entries(input)) {
    if (!fromKey(cell)) continue;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const normalized = list
      .map((item) => normalizeBuildingType(item))
      .filter(Boolean);
    if (normalized.length) next[cell] = normalized;
  }
  return next;
}

function totalBuildingCount(buildings) {
  return Object.values(buildings || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

function avatarForNodeId(nodeId) {
  const avatars = ["\u{1F9D1}", "\u{1F9D1}\u200D\u{1F9B0}", "\u{1F9D1}\u200D\u{1F9B1}", "\u{1F9D1}\u200D\u{1F9B3}", "\u{1F9D1}\u200D\u{1F9B2}"];
  const source = String(nodeId || "meshcity");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 33 + source.charCodeAt(i)) >>> 0;
  }
  return avatars[hash % avatars.length];
}

function ensurePlayerShape(player) {
  const stats = player.stats || {};
  const g = player.gameState || {};
  const legacyInventory = Array.isArray(g.inventory) ? g.inventory : [];
  const resources = ensureResources(g.resources || {});
  const claimedCells = Array.isArray(g.claimedCells) ? g.claimedCells.filter((k) => fromKey(k)) : [];
  const cityCore = fromKey(g.cityCore || "") ? String(g.cityCore) : (claimedCells[0] || null);
  const buildings = normalizeBuildingsMap(g.buildings);
  const districtName = g.districtName ? String(g.districtName).slice(0, 24) : (g.cityName ? String(g.cityName).slice(0, 24) : "");
  if (!g.migratedToMeshcity && legacyInventory.length) {
    resources.wood += Math.min(6, legacyInventory.length * 2);
    resources.stone += Math.min(4, legacyInventory.length);
    resources.food += 2;
  }

  return {
    ...player,
    isBot: Boolean(player.isBot),
    botProfile: player.botProfile && typeof player.botProfile === "object"
      ? {
        pace: String(player.botProfile.pace || "slow"),
        createdBy: player.botProfile.createdBy ? String(player.botProfile.createdBy).slice(0, 40) : "admin",
        createdAt: player.botProfile.createdAt || null
      }
      : null,
    shortName: player.shortName || "Citizen",
    avatar: player.avatar ? String(player.avatar) : avatarForNodeId(player.nodeId),
    registered: Boolean(player.registered),
    registrationState: player.registrationState || "pending_confirmation",
    stats: {
      level: Number(stats.level) > 0 ? Number(stats.level) : 1,
      hp: Number(stats.hp) > 0 ? Number(stats.hp) : 10,
      xp: Number(stats.xp) >= 0 ? Number(stats.xp) : 0,
      credits: Number(stats.credits) >= 0 ? Number(stats.credits) : STARTING_CREDITS
    },
    gameState: {
      hasStarted: Boolean(g.hasStarted),
      sessionActive: Boolean(g.sessionActive),
      location: g.location || "Sector 0:0",
      position: g.position && Number.isInteger(g.position.x) && Number.isInteger(g.position.y) ? g.position : null,
      resources,
      claimedCells,
      buildings,
      cityLevel: districtLevelFromLand(claimedCells.length),
      cityCore,
      cityName: districtName,
      districtName,
      chatBubble: g.chatBubble ? String(g.chatBubble).slice(0, 80) : "",
      awaitingHelpCategory: Boolean(g.awaitingHelpCategory),
      awaitingDistrictName: Boolean(g.awaitingDistrictName),
      lastActionAt: g.lastActionAt || null,
      startedAt: g.startedAt || null,
      migratedToMeshcity: true
    }
  };
}

function createMeshcityGame({ store, sendDirectMessage }) {
  function isRestrictedLandTile(tile) {
    const terrain = String(tile && tile.terrain ? tile.terrain : "plain").toLowerCase();
    return terrain === "water" || terrain === "sand" || terrain === "road";
  }

  function tileSlotsForPlayer(player, cellKey) {
    return player && player.gameState && player.gameState.cityCore === cellKey ? 3 : 2;
  }

  function getPlayer(nodeId) {
    const found = store.getPlayers().find((p) => p.nodeId === nodeId) || null;
    return found ? ensurePlayerShape(found) : null;
  }

  function isSpawnableTile(world, x, y) {
    const tile = world.map.tiles[toKey(x, y)] || { terrain: "plain", blocked: false };
    if (tile.blocked) return false;
    if (isRestrictedLandTile(tile)) return false;
    if (owner(world, x, y)) return false;
    return true;
  }

  function pickSpawnPosition(world, nodeId) {
    const occupied = new Map();
    for (const [otherNodeId, pos] of Object.entries(world.playerPositions || {})) {
      if (!pos || otherNodeId === String(nodeId)) continue;
      occupied.set(otherNodeId, { x: Number(pos.x), y: Number(pos.y) });
    }

    const candidates = [];
    for (let y = 0; y < world.map.height; y += 1) {
      for (let x = 0; x < world.map.width; x += 1) {
        if (!isSpawnableTile(world, x, y)) continue;
        const occupiedHere = Array.from(occupied.values()).some((pos) => pos.x === x && pos.y === y);
        if (occupiedHere) continue;
        candidates.push({ x, y });
      }
    }

    if (!candidates.length) {
      return {
        x: Math.floor(world.map.width / 2),
        y: Math.floor(world.map.height / 2)
      };
    }

    const spaced = candidates.filter((candidate) => (
      Array.from(occupied.values()).every((pos) => Math.abs(pos.x - candidate.x) + Math.abs(pos.y - candidate.y) >= 4)
    ));
    const pool = spaced.length ? spaced : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function getPos(nodeId) {
    const world = store.getWorld();
    const known = world.playerPositions[nodeId];
    if (known) return { x: known.x, y: known.y };
    const spawn = pickSpawnPosition(world, nodeId);
    store.setPlayerPosition(nodeId, spawn.x, spawn.y);
    return spawn;
  }

  function syncPos(player) {
    const pos = getPos(player.nodeId);
    return { ...player, gameState: { ...player.gameState, position: pos, location: `Sector ${pos.x}:${pos.y}` } };
  }

  function savePlayer(player) {
    const next = syncPos(ensurePlayerShape(player));
    const players = store.getPlayers();
    const idx = players.findIndex((p) => p.nodeId === next.nodeId);
    if (idx >= 0) players[idx] = next; else players.push(next);
    store.savePlayers(players);
    return next;
  }

  function owner(world, x, y) {
    return world.landClaims[toKey(x, y)] || null;
  }

  function neighbors(x, y, world) {
    const list = [{ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }];
    return list.filter((c) => c.x >= 0 && c.y >= 0 && c.x < world.map.width && c.y < world.map.height);
  }

  function canClaim(nodeId, x, y, world, claims) {
    if (owner(world, x, y)) return { ok: false, reason: "Tile already owned." };
    const tile = world.map.tiles[toKey(x, y)] || { terrain: "plain", blocked: false };
    if (tile.blocked) return { ok: false, reason: "Tile is blocked." };
    if (isRestrictedLandTile(tile)) return { ok: false, reason: "You cannot claim water, sand or road tiles." };
    if (!claims.length) return { ok: true };
    const set = new Set(claims);
    const adj = neighbors(x, y, world).some((c) => set.has(toKey(c.x, c.y)));
    return adj ? { ok: true } : { ok: false, reason: "New claim must be adjacent to your territory." };
  }

  function setOwner(world, x, y, nodeId) {
    world.landClaims[toKey(x, y)] = nodeId;
    store.saveWorld(world);
  }

  function claimCost(nextCount) {
    return BASE_CLAIM_COST + Math.max(0, nextCount - 1) * CLAIM_GROWTH_COST;
  }

  function playerSoftLandCap(world, player) {
    const area = Math.max(1, world.map.width * world.map.height);
    const sharedPlayableArea = Math.floor(area * 0.5);
    const basePerPlayer = Math.max(10, Math.floor(sharedPlayableArea / TARGET_CONCURRENT_PLAYERS));
    const cityBonus = Math.max(0, (Number(player.gameState.cityLevel) || 1) - 1) * 2;
    return basePerPlayer + cityBonus;
  }

  function dynamicClaimCost(nextCount, world, player) {
    const base = claimCost(nextCount);
    const softCap = playerSoftLandCap(world, player);
    if (nextCount <= softCap) return base;
    const over = nextCount - softCap;
    return base + over * over * 12;
  }

  function ownerName(nodeId) {
    if (!nodeId) return null;
    const p = getPlayer(nodeId);
    return p ? p.shortName : nodeId;
  }

  function findNearestClaimable(world, startX, startY) {
    const maxRadius = Math.max(world.map.width, world.map.height);
    for (let radius = 0; radius <= maxRadius; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const x = clamp(startX + dx, 0, world.map.width - 1);
          const y = clamp(startY + dy, 0, world.map.height - 1);
          const tile = world.map.tiles[toKey(x, y)] || { terrain: "plain", blocked: false };
          if (tile.blocked) continue;
          if (isRestrictedLandTile(tile)) continue;
          if (owner(world, x, y)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  function tileSummary(world, x, y) {
    const key = toKey(x, y);
    const tile = world.map.tiles[key] || { terrain: "plain", blocked: false, label: "" };
    const ownerId = owner(world, x, y);
    const player = ownerId ? getPlayer(ownerId) : null;
    const building = player && player.gameState && player.gameState.buildings ? player.gameState.buildings[key] || [] : [];
    const isCityCore = Boolean(player && player.gameState && player.gameState.cityCore === key);
    const districtName = player && player.gameState ? (player.gameState.districtName || player.gameState.cityName || "") : "";
    const attrs = [
      `Tile ${key}`,
      `Terrain ${tile.terrain}${tile.blocked ? " (blocked)" : ""}`,
      `Owner ${ownerId ? `${ownerName(ownerId)} (${ownerId})` : "free"}`,
      `District ${districtName || "none"}`,
      `HQ ${isCityCore ? "yes" : "no"}`,
      `Buildings ${building.length ? building.join(", ") : "none"}`,
      `Landmark ${tile.label || "none"}`
    ];
    return attrs.join(" | ");
  }

  function hasMarket(player) {
    return Object.values(player.gameState.buildings).some((list) => Array.isArray(list) && list.includes("shop"));
  }

  function findOffer(world, id) {
    return (world.marketOffers || []).find((o) => o.id === id) || null;
  }

  function saveOffer(world, offer) {
    const list = Array.isArray(world.marketOffers) ? world.marketOffers : [];
    const idx = list.findIndex((o) => o.id === offer.id);
    if (idx >= 0) list[idx] = offer; else list.push(offer);
    world.marketOffers = list;
    store.saveWorld(world);
  }

  function removeOffer(world, id) {
    world.marketOffers = (world.marketOffers || []).filter((o) => o.id !== id);
    store.saveWorld(world);
  }

  async function startGame(message, player) {
    const now = new Date().toISOString();

    const next = savePlayer({
      ...player,
      stats: { ...player.stats, credits: Math.max(player.stats.credits, STARTING_CREDITS) },
      gameState: {
        ...player.gameState,
        hasStarted: true,
        sessionActive: true,
        startedAt: player.gameState.startedAt || now,
        lastActionAt: now
      },
      updatedAt: now
    });

    const claimText = next.gameState.cityCore
      ? `HQ: ${next.gameState.cityCore}`
      : `No land claimed yet. Use CLAIM <x> <y> on a free tile (${FOUNDATION_CLAIM_COST} CR for first claim).`;
    await sendDirectMessage(message, `Player ready, ${next.shortName}. ${claimText} Use HELP. Map + instructions: https://meshcity.fun`);
  }

  async function continueGame(message, player) {
    const next = savePlayer({
      ...player,
      gameState: { ...player.gameState, sessionActive: true, lastActionAt: new Date().toISOString() },
      updatedAt: new Date().toISOString()
    });
    await sendDirectMessage(message, `Session resumed. Pos [${next.gameState.position.x},${next.gameState.position.y}] CR:${next.stats.credits}`);
  }

  async function handleGameCommand(message, player) {
    const textRaw = String(message.text || "").trim();
    const text = normalizeText(textRaw);
    const { cmd, args } = parseCommand(textRaw);
    let next = ensurePlayerShape(player);

    if (next.gameState.awaitingDistrictName && cmd !== "help" && cmd !== "name") {
      await sendDirectMessage(message, "Name your district first: NAME <district name>.");
      return;
    }

    if (next.gameState.awaitingHelpCategory && cmd !== "help") {
      const categoryText = helpCategoryText(cmd);
      if (categoryText) {
        next = savePlayer({
          ...next,
          gameState: { ...next.gameState, awaitingHelpCategory: false, lastActionAt: new Date().toISOString() },
          updatedAt: new Date().toISOString()
        });
        await sendDirectMessage(message, categoryText);
        return;
      }
    }

    if (cmd === "help") {
      const categoryText = helpCategoryText(args[0]);
      if (categoryText) {
        await sendDirectMessage(message, categoryText);
        return;
      }
      next = savePlayer({
        ...next,
        gameState: { ...next.gameState, awaitingHelpCategory: true, lastActionAt: new Date().toISOString() },
        updatedAt: new Date().toISOString()
      });
      await sendDirectMessage(message, "HELP categories: CORE, EXPANSION, ECONOMY, MARKET, SOCIAL, SYSTEM.\nSend category name (example: SOCIAL).\nMap + instructions: https://meshcity.fun");
      return;
    }

    if (cmd === "status") {
      const world = store.getWorld();
      const landCount = next.gameState.claimedCells.length;
      const cap = playerSoftLandCap(world, next);
      const hqState = next.gameState.cityCore ? next.gameState.cityCore : "not claimed";
      await sendDirectMessage(message, `${next.shortName} | District ${next.gameState.districtName || "unnamed"} | CR ${next.stats.credits} | Land ${landCount}/${cap} soft | LV ${next.gameState.cityLevel} | HQ ${hqState} | Buildings ${totalBuildingCount(next.gameState.buildings)} | Pos [${next.gameState.position.x},${next.gameState.position.y}] | ${resSummary(next.gameState.resources)}`);
      return;
    }

    if (cmd === "name") {
      if (!next.gameState.cityCore) {
        await sendDirectMessage(message, "Claim your first tile first.");
        return;
      }
      const districtName = parseDistrictName(args.join(" "));
      if (!districtName) {
        await sendDirectMessage(message, "Usage: NAME <district name> (3-24 chars).");
        return;
      }
      next = savePlayer({
        ...next,
        gameState: {
          ...next.gameState,
          districtName,
          cityName: districtName,
          awaitingDistrictName: false,
          lastActionAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      });
      await sendDirectMessage(message, `District named: ${districtName}.`);
      return;
    }

    if (cmd === "resources") {
      await sendDirectMessage(message, `Resources: ${resSummary(next.gameState.resources)}`);
      return;
    }

    if (cmd === "land") {
      const world = store.getWorld();
      const claims = next.gameState.claimedCells;
      if (!claims.length) {
        await sendDirectMessage(message, `No land yet. Use CLAIM <x> <y> on a free tile (${FOUNDATION_CLAIM_COST} CR for first claim).`);
        return;
      }
      const preview = claims.slice(0, 8).join(" ");
      const nextCost = dynamicClaimCost(claims.length + 1, world, next);
      const cap = playerSoftLandCap(world, next);
      await sendDirectMessage(message, `Land ${claims.length} tiles. District ${next.gameState.districtName || "unnamed"}. LV ${next.gameState.cityLevel}. HQ ${next.gameState.cityCore || "n/a"}. Next claim cost ${nextCost} CR. Cells: ${preview}${claims.length > 8 ? " ..." : ""}`);
      return;
    }

    if (cmd === "found") {
      await sendDirectMessage(message, "FOUND is retired. Use CLAIM <x> <y>. Your first claim becomes your HQ.");
      return;
    }

    if (cmd === "tile" || cmd === "inspect") {
      const world = store.getWorld();
      const x = args[0] === undefined ? next.gameState.position.x : intOrNull(args[0]);
      const y = args[1] === undefined ? next.gameState.position.y : intOrNull(args[1]);
      if (x === null || y === null) {
        await sendDirectMessage(message, "Usage: TILE <x> <y>");
        return;
      }
      if (x < 0 || y < 0 || x >= world.map.width || y >= world.map.height) {
        await sendDirectMessage(message, "Coordinates out of map.");
        return;
      }
      await sendDirectMessage(message, tileSummary(world, x, y));
      return;
    }

    if (cmd === "move") {
      const dir = normalizeText(args[0]);
      const dirs = { n: { dx: 0, dy: -1 }, s: { dx: 0, dy: 1 }, e: { dx: 1, dy: 0 }, w: { dx: -1, dy: 0 } };
      if (!dirs[dir]) {
        await sendDirectMessage(message, "Usage: MOVE <n|s|e|w>");
        return;
      }
      const world = store.getWorld();
      const cur = world.playerPositions[next.nodeId] || getPos(next.nodeId);
      const nx = clamp(cur.x + dirs[dir].dx, 0, world.map.width - 1);
      const ny = clamp(cur.y + dirs[dir].dy, 0, world.map.height - 1);
      const tile = world.map.tiles[toKey(nx, ny)] || { terrain: "plain", blocked: false };
      if (tile.blocked || tile.terrain === "water") {
        await sendDirectMessage(message, tile.terrain === "water" ? "You cannot move into water." : "Tile is blocked.");
        return;
      }
      store.setPlayerPosition(next.nodeId, nx, ny);
      next = savePlayer({
        ...next,
        gameState: { ...next.gameState, position: { x: nx, y: ny }, location: `Sector ${nx}:${ny}`, lastActionAt: new Date().toISOString() },
        updatedAt: new Date().toISOString()
      });
      await sendDirectMessage(message, `Moved to [${nx},${ny}] (${tile.terrain}).`);
      return;
    }

    if (cmd === "scan") {
      const world = store.getWorld();
      const pos = next.gameState.position;
      const cells = [{ x: pos.x, y: pos.y }, ...neighbors(pos.x, pos.y, world)];
      const lines = cells.map((c) => {
        const key = toKey(c.x, c.y);
        const tile = world.map.tiles[key] || { terrain: "plain", blocked: false };
        const o = owner(world, c.x, c.y);
        const ownText = !o ? "free" : o === next.nodeId ? "yours" : `owned by ${ownerName(o)}`;
        return `${key} ${tile.terrain}${tile.blocked ? " blocked" : ""} ${ownText}`;
      });
      await sendDirectMessage(message, `Scan:\n${lines.join("\n")}`);
      return;
    }

    if (cmd === "claim") {
      const world = store.getWorld();
      const x = intOrNull(args[0]);
      const y = intOrNull(args[1]);
      if (x === null || y === null) {
        await sendDirectMessage(message, "Usage: CLAIM <x> <y>");
        return;
      }
      if (x < 0 || y < 0 || x >= world.map.width || y >= world.map.height) {
        await sendDirectMessage(message, "Coordinates out of map.");
        return;
      }
      const claims = [...next.gameState.claimedCells];
      const key = toKey(x, y);
      if (claims.includes(key)) {
        await sendDirectMessage(message, "This tile is already yours.");
        return;
      }
      const check = canClaim(next.nodeId, x, y, world, claims);
      if (!check.ok) {
        await sendDirectMessage(message, check.reason);
        return;
      }
      const isFirstClaim = claims.length === 0;
      const cost = isFirstClaim ? FOUNDATION_CLAIM_COST : dynamicClaimCost(claims.length + 1, world, next);
      if (next.stats.credits < cost) {
        await sendDirectMessage(message, `Not enough credits. Need ${cost} CR.`);
        return;
      }
      setOwner(world, x, y, next.nodeId);
      claims.push(key);
      next = savePlayer({
        ...next,
        stats: { ...next.stats, credits: next.stats.credits - cost },
        gameState: {
          ...next.gameState,
          claimedCells: claims,
          cityCore: next.gameState.cityCore || key,
          awaitingDistrictName: next.gameState.cityCore ? next.gameState.awaitingDistrictName : true,
          lastActionAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      });
      await sendDirectMessage(message, isFirstClaim
        ? `First land claim secured at ${key}. HQ established. Cost ${cost} CR. Now name your district: NAME <district name>.`
        : `Claimed ${key} for ${cost} CR. Expand only from adjacent tiles.`);
      return;
    }

    if (cmd === "harvest" || cmd === "mine") {
      const world = store.getWorld();
      const x = args[0] === undefined ? next.gameState.position.x : intOrNull(args[0]);
      const y = args[1] === undefined ? next.gameState.position.y : intOrNull(args[1]);
      if (x === null || y === null) {
        await sendDirectMessage(message, "Usage: HARVEST <x> <y>");
        return;
      }
      const key = toKey(x, y);
      if (!next.gameState.claimedCells.includes(key)) {
        await sendDirectMessage(message, "Harvest only on your claimed tiles.");
        return;
      }
      const tile = world.map.tiles[key] || { terrain: "plain" };
      const base = YIELDS[tile.terrain] || YIELDS.plain;
      const gains = {};
      for (const [r, [min, max]] of Object.entries(base)) gains[r] = rng(min, max);
      let creditGain = tile.terrain === "town" ? 3 : tile.terrain === "plain" ? 2 : 0;
      const buildingList = next.gameState.buildings[key] || [];
      for (const type of buildingList) {
        if (!BUILDINGS[type]) continue;
        for (const [r, bonus] of Object.entries(BUILDINGS[type].yields || {})) {
          if (r === "credits") {
            creditGain += bonus;
          } else {
            gains[r] = (gains[r] || 0) + bonus;
          }
        }
      }
      next = savePlayer({
        ...next,
        stats: { ...next.stats, credits: next.stats.credits + creditGain },
        gameState: { ...next.gameState, resources: addResources(next.gameState.resources, gains), lastActionAt: new Date().toISOString() },
        updatedAt: new Date().toISOString()
      });
      const gainsText = [
        `CR +${creditGain}`,
        ...Object.entries(gains).map(([r, n]) => `${RES_LABEL[r]} +${n}`)
      ].join(", ");
      await sendDirectMessage(message, `Harvested ${key} (${tile.terrain}). ${gainsText}.`);
      return;
    }

    if (cmd === "build") {
      const type = normalizeBuildingType(args[0]);
      const x = intOrNull(args[1]);
      const y = intOrNull(args[2]);
      if (!BUILDINGS[type] || x === null || y === null) {
        await sendDirectMessage(message, "Usage: BUILD <home|farm|mill|mine|shop|hall> <x> <y>");
        return;
      }
      const key = toKey(x, y);
      if (!next.gameState.claimedCells.includes(key)) {
        await sendDirectMessage(message, "Build only on your claimed tile.");
        return;
      }
      const world = store.getWorld();
      const tile = world.map.tiles[key] || { terrain: "plain", blocked: false };
      if (isRestrictedLandTile(tile)) {
        await sendDirectMessage(message, "You cannot build on water, sand or road.");
        return;
      }
      const recipe = BUILDINGS[type];
      if (next.gameState.cityLevel < recipe.minLevel) {
        await sendDirectMessage(message, `${recipe.label} unlocks at district level ${recipe.minLevel}.`);
        return;
      }
      const existing = next.gameState.buildings[key] || [];
      const usedSlots = existing.reduce((sum, item) => sum + (BUILDINGS[item] ? BUILDINGS[item].slotCost : 1), 0);
      const maxSlots = tileSlotsForPlayer(next, key);
      if (usedSlots + recipe.slotCost > maxSlots) {
        await sendDirectMessage(message, `No free building slots on ${key}. Slots ${usedSlots}/${maxSlots}.`);
        return;
      }
      if (type === "hall") {
        const alreadyHasHall = Object.values(next.gameState.buildings).some((list) => Array.isArray(list) && list.includes("hall"));
        if (alreadyHasHall) {
          await sendDirectMessage(message, "Only one HALL per district.");
          return;
        }
        if (next.gameState.cityCore !== key) {
          await sendDirectMessage(message, "HALL can be built only on your HQ tile.");
          return;
        }
      }
      if (next.stats.credits < recipe.costCredits) {
        await sendDirectMessage(message, `Need ${recipe.costCredits} CR.`);
        return;
      }
      next = savePlayer({
        ...next,
        stats: { ...next.stats, credits: next.stats.credits - recipe.costCredits },
        gameState: {
          ...next.gameState,
          buildings: { ...next.gameState.buildings, [key]: [...existing, type] },
          lastActionAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      });
      await sendDirectMessage(message, `${recipe.label} built at ${key}. Slots ${usedSlots + recipe.slotCost}/${maxSlots}.`);
      return;
    }

    if (cmd === "trade") {
      const sub = normalizeText(args[0]);
      const sArgs = args.slice(1);

      if (sub === "list") {
        const world = store.getWorld();
        const offers = (world.marketOffers || []).filter((o) => o.sellerNodeId !== next.nodeId);
        if (!offers.length) {
          await sendDirectMessage(message, "No offers right now.");
          return;
        }
        const players = store.getPlayers();
        const lines = offers.slice(0, 8).map((o) => {
          const seller = players.find((p) => p.nodeId === o.sellerNodeId);
          return `${o.id}: ${o.resource} x${o.qty} @ ${o.unitPrice} CR (${seller ? seller.shortName : o.sellerNodeId})`;
        });
        await sendDirectMessage(message, `Market:\n${lines.join("\n")}`);
        return;
      }

      if (sub === "sell") {
        if (!hasMarket(next)) {
          await sendDirectMessage(message, "Build SHOP first.");
          return;
        }
        const resource = parseResource(sArgs[0]);
        const qty = intOrNull(sArgs[1]);
        const price = intOrNull(sArgs[2]);
        if (!resource || qty === null || price === null || qty <= 0 || price <= 0) {
          await sendDirectMessage(message, "Usage: TRADE SELL <resource> <qty> <unitPrice>");
          return;
        }
        const have = Number(next.gameState.resources[resource]) || 0;
        if (have < qty) {
          await sendDirectMessage(message, `Not enough ${resource}.`);
          return;
        }
        const world = store.getWorld();
        const myOffers = (world.marketOffers || []).filter((o) => o.sellerNodeId === next.nodeId);
        if (myOffers.length >= MAX_OFFERS_PER_PLAYER) {
          await sendDirectMessage(message, `Offer limit ${MAX_OFFERS_PER_PLAYER}.`);
          return;
        }
        const offer = {
          id: `O${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase(),
          sellerNodeId: next.nodeId,
          sellerName: next.shortName,
          resource,
          qty,
          unitPrice: price,
          createdAt: new Date().toISOString()
        };
        saveOffer(world, offer);
        next = savePlayer({
          ...next,
          gameState: {
            ...next.gameState,
            resources: { ...next.gameState.resources, [resource]: have - qty },
            lastActionAt: new Date().toISOString()
          },
          updatedAt: new Date().toISOString()
        });
        await sendDirectMessage(message, `Offer ${offer.id} created.`);
        return;
      }

      if (sub === "buy") {
        const id = String(sArgs[0] || "").trim().toUpperCase();
        const qty = intOrNull(sArgs[1]);
        if (!id || qty === null || qty <= 0) {
          await sendDirectMessage(message, "Usage: TRADE BUY <offerId> <qty>");
          return;
        }
        const world = store.getWorld();
        const offer = findOffer(world, id);
        if (!offer) {
          await sendDirectMessage(message, "Offer not found.");
          return;
        }
        if (offer.sellerNodeId === next.nodeId) {
          await sendDirectMessage(message, "Cannot buy your own offer.");
          return;
        }
        if (qty > offer.qty) {
          await sendDirectMessage(message, `Only ${offer.qty} left.`);
          return;
        }
        const total = qty * offer.unitPrice;
        if (next.stats.credits < total) {
          await sendDirectMessage(message, `Need ${total} CR.`);
          return;
        }
        const seller = getPlayer(offer.sellerNodeId);
        if (!seller) {
          removeOffer(world, id);
          await sendDirectMessage(message, "Seller missing; offer removed.");
          return;
        }
        next = savePlayer({
          ...next,
          stats: { ...next.stats, credits: next.stats.credits - total },
          gameState: {
            ...next.gameState,
            resources: addResources(next.gameState.resources, { [offer.resource]: qty }),
            lastActionAt: new Date().toISOString()
          },
          updatedAt: new Date().toISOString()
        });
        savePlayer({
          ...seller,
          stats: { ...seller.stats, credits: seller.stats.credits + total },
          gameState: { ...seller.gameState, lastActionAt: new Date().toISOString() },
          updatedAt: new Date().toISOString()
        });
        if (qty === offer.qty) removeOffer(world, id); else saveOffer(world, { ...offer, qty: offer.qty - qty });
        await sendDirectMessage(message, `Bought ${offer.resource} x${qty} for ${total} CR.`);
        return;
      }

      if (sub === "cancel") {
        const id = String(sArgs[0] || "").trim().toUpperCase();
        if (!id) {
          await sendDirectMessage(message, "Usage: TRADE CANCEL <offerId>");
          return;
        }
        const world = store.getWorld();
        const offer = findOffer(world, id);
        if (!offer) {
          await sendDirectMessage(message, "Offer not found.");
          return;
        }
        if (offer.sellerNodeId !== next.nodeId) {
          await sendDirectMessage(message, "Can cancel only your offer.");
          return;
        }
        removeOffer(world, id);
        next = savePlayer({
          ...next,
          gameState: {
            ...next.gameState,
            resources: addResources(next.gameState.resources, { [offer.resource]: offer.qty }),
            lastActionAt: new Date().toISOString()
          },
          updatedAt: new Date().toISOString()
        });
        await sendDirectMessage(message, `Offer ${id} canceled.`);
        return;
      }

      await sendDirectMessage(message, "Usage: TRADE LIST | TRADE SELL <resource> <qty> <unitPrice> | TRADE BUY <offerId> <qty> | TRADE CANCEL <offerId>");
      return;
    }

    if (cmd === "chat") {
      const payload = String(args.join(" ")).trim();
      if (!payload) {
        await sendDirectMessage(message, "Usage: CHAT <message> | CHAT CLEAR");
        return;
      }
      if (normalizeText(payload) === "clear" || normalizeText(payload) === "off") {
        next = savePlayer({
          ...next,
          gameState: { ...next.gameState, chatBubble: "", lastActionAt: new Date().toISOString() },
          updatedAt: new Date().toISOString()
        });
        await sendDirectMessage(message, "Chat bubble cleared.");
        return;
      }
      const bubble = payload.slice(0, 80);
      next = savePlayer({
        ...next,
        gameState: { ...next.gameState, chatBubble: bubble, lastActionAt: new Date().toISOString() },
        updatedAt: new Date().toISOString()
      });
      await sendDirectMessage(message, `Chat bubble set: "${bubble}"`);
      return;
    }

    if (text === "pause" || text === "exit") {
      savePlayer({
        ...next,
        gameState: { ...next.gameState, sessionActive: false, lastActionAt: new Date().toISOString() },
        updatedAt: new Date().toISOString()
      });
      await sendDirectMessage(message, "Session paused. Send CONTINUE.");
      return;
    }

    if (text === "continue" || text === "resume") {
      await sendDirectMessage(message, "Session already active.");
      return;
    }

    await sendDirectMessage(message, "Unknown command. Send HELP.");
  }

  return {
    async handleDirectMessage(message) {
      const text = normalizeText(message.text);
      const existing = syncPos(ensurePlayerShape(getPlayer(message.from) || {
        nodeId: message.from,
        shortName: message.fromName || "Citizen",
        registered: false,
        registrationState: "pending_confirmation",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stats: { level: 1, hp: 10, xp: 0, credits: STARTING_CREDITS },
        gameState: {
          hasStarted: false,
          sessionActive: false,
          resources: ensureResources({ wood: 8, stone: 6, food: 4 }),
          claimedCells: [],
          buildings: {},
          cityLevel: 1,
          districtName: "",
          awaitingDistrictName: false
        }
      }));

      if (!getPlayer(message.from)) {
        savePlayer(existing);
        await sendDirectMessage(message, "Welcome to MESHCITY. Register now? Reply Y or N. Map + instructions: https://meshcity.fun");
        return;
      }

      if (!existing.registered && existing.registrationState === "pending_confirmation") {
        if (text === "y" || text === "yes") {
          savePlayer({ ...existing, registrationState: "awaiting_nickname", updatedAt: new Date().toISOString() });
          await sendDirectMessage(message, "Send player name (3-20 chars).");
          return;
        }
        if (text === "n" || text === "no") {
          savePlayer({ ...existing, registrationState: "declined", updatedAt: new Date().toISOString() });
          await sendDirectMessage(message, "Registration canceled. Send Y later.");
          return;
        }
        await sendDirectMessage(message, "Reply Y to register or N to decline.");
        return;
      }

      if (!existing.registered && existing.registrationState === "declined") {
        if (text === "y" || text === "yes") {
          savePlayer({ ...existing, registrationState: "awaiting_nickname", updatedAt: new Date().toISOString() });
          await sendDirectMessage(message, "Send player name (3-20 chars).");
          return;
        }
        await sendDirectMessage(message, "You are not registered. Send Y to join MESHCITY.");
        return;
      }

      if (!existing.registered && existing.registrationState === "awaiting_nickname") {
        if (text === "n" || text === "no") {
          savePlayer({ ...existing, registrationState: "declined", updatedAt: new Date().toISOString() });
          await sendDirectMessage(message, "Registration canceled.");
          return;
        }
        const nickname = parseNickname(message.text);
        if (!nickname) {
          await sendDirectMessage(message, "Name must be 3-20 chars.");
          return;
        }
        savePlayer({ ...existing, shortName: nickname, avatar: existing.avatar || avatarForNodeId(existing.nodeId), registered: true, registrationState: "registered", updatedAt: new Date().toISOString() });
        await sendDirectMessage(message, `Registration complete, ${nickname}. You receive ${STARTING_CREDITS} CR. Send START, move on the map, CLAIM your first tile, then NAME your district.`);
        return;
      }

      if (existing.registered) {
        if (!existing.gameState.hasStarted) {
          if (text === "start" || text === "begin") {
            await startGame(message, existing);
            return;
          }
          await sendDirectMessage(message, "Send START to begin as player.");
          return;
        }

        if (!existing.gameState.sessionActive) {
          if (text === "continue" || text === "resume" || text === "start") {
            await continueGame(message, existing);
            return;
          }
          await sendDirectMessage(message, "Send CONTINUE to resume.");
          return;
        }

        await handleGameCommand(message, existing);
      }
    }
  };
}

module.exports = { createMeshcityGame };
