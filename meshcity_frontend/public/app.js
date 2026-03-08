function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const config = window.MESHCITY_CONFIG || {};
const BACKEND_URL = String(config.BACKEND_URL || "").replace(/\/+$/, "");

const state = {
  world: null,
  players: [],
  logs: [],
  server: {
    serverOnline: false,
    lastSeenAt: null
  }
};

const view = {
  baseTile: 18,
  zoom: 1,
  minZoom: 0.5,
  maxZoom: 3.2,
  hasInitialCenter: false,
  pinchStartDistance: 0,
  pinchStartZoom: 1,
  drag: {
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0
  }
};

let eventSource = null;
let pollTimer = null;

function setStatus(text, online) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.classList.toggle("online", Boolean(online));
}

function updateServerStatus(viaPoll) {
  if (state.server.serverOnline) {
    setStatus("SERVER ONLINE", true);
    return;
  }
  setStatus("SERVER OFFLINE", false);
}

function formatTime(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString();
}

async function fetchState() {
  const res = await fetch(`${BACKEND_URL}/api/public/state`, {
    headers: { Accept: "application/json" }
  });

  if (!res.ok) {
    throw new Error(`Backend error: ${res.status}`);
  }

  return res.json();
}

function terrainColor(terrain) {
  const key = String(terrain || "plain").toLowerCase();
  if (key === "water") return "#246ca6";
  if (key === "forest") return "#2d7a46";
  if (key === "mountain") return "#777";
  if (key === "road") return "#7f6f56";
  if (key === "town") return "#b98552";
  if (key === "sand") return "#d3bd7a";
  return "#5e8f4c";
}

function ownerColor(nodeId, alpha = 0.22) {
  const input = String(nodeId || "none");
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 360;
  }
  return `hsla(${hash}, 80%, 55%, ${alpha})`;
}

function playerColor(nodeId) {
  return ownerColor(nodeId, 1);
}

function currentTileSize() {
  return Math.max(6, Math.round(view.baseTile * view.zoom));
}

function parseCoordKey(key) {
  const [xRaw, yRaw] = String(key || "").split(",");
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return null;
  }
  return { x, y };
}

function resourceEmoji(entity) {
  const type = String(entity && entity.type ? entity.type : "").toLowerCase();
  const resource = String(entity && entity.meta && entity.meta.resource ? entity.meta.resource : "").toLowerCase();
  const key = resource || type;
  if (key === "wood") return "\u{1FAB5}";
  if (key === "stone") return "\u{1FAA8}";
  if (key === "iron") return "\u{26CF}";
  if (key === "copper") return "\u{1FA99}";
  if (key === "crystal") return "\u{1F48E}";
  if (key === "food") return "\u{1F33E}";
  return "\u{2753}";
}

function buildingEmoji(type) {
  const key = String(type || "").toLowerCase();
  if (key === "mine") return "\u{26CF}";
  if (key === "mill") return "\u{1FAB5}";
  if (key === "farm") return "\u{1F33E}";
  if (key === "shop") return "\u{1F3EA}";
  if (key === "home") return "\u{1F3E0}";
  if (key === "hall") return "\u{1F3DB}";
  return "\u{1F3D8}";
}

function getBuildingByCell() {
  const map = new Map();
  for (const player of state.players) {
    const buildings = player && player.gameState && player.gameState.buildings ? player.gameState.buildings : {};
    for (const [coordKey, raw] of Object.entries(buildings)) {
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (!list.length) continue;
      if (!map.has(coordKey)) {
        map.set(coordKey, []);
      }
      for (const item of list) {
        map.get(coordKey).push({
          nodeId: player.nodeId,
          playerName: player.shortName,
          type: String(item || "building")
        });
      }
    }
  }
  return map;
}

function getResourceEntities() {
  const entities = Array.isArray(state.world && state.world.entities) ? state.world.entities : [];
  const landClaims = state.world && state.world.landClaims && typeof state.world.landClaims === "object"
    ? state.world.landClaims
    : {};
  const visibleCells = new Set();

  for (const player of state.players) {
    if (!player || !player.position) continue;
    const px = Number(player.position.x);
    const py = Number(player.position.y);
    if (!Number.isInteger(px) || !Number.isInteger(py)) continue;

    // Current cell + 8 neighbors (scan-like visibility radius).
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        visibleCells.add(`${px + dx},${py + dy}`);
      }
    }
  }

  return entities.filter((entity) => {
    const type = String(entity && entity.type ? entity.type : "").toLowerCase();
    const resource = String(entity && entity.meta && entity.meta.resource ? entity.meta.resource : "").toLowerCase();
    const isResource = ["wood", "stone", "iron", "copper", "crystal", "food"].includes(type) ||
      ["wood", "stone", "iron", "copper", "crystal", "food"].includes(resource);
    if (!isResource) return false;

    const key = `${Number(entity.x)},${Number(entity.y)}`;
    const openedByVision = visibleCells.has(key);
    const openedByClaim = Boolean(landClaims[key]);
    return openedByVision || openedByClaim;
  });
}

function getPlayerByNodeId(nodeId) {
  return state.players.find((player) => player.nodeId === nodeId) || null;
}

function formatIsoDate(iso) {
  if (!iso) return "n/a";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function getOpenedCellSet() {
  const openedCells = new Set();
  const landClaims = state.world && state.world.landClaims && typeof state.world.landClaims === "object"
    ? state.world.landClaims
    : {};

  for (const coord of Object.keys(landClaims)) {
    openedCells.add(coord);
  }

  for (const player of state.players) {
    if (!player || !player.position) continue;
    const px = Number(player.position.x);
    const py = Number(player.position.y);
    if (!Number.isInteger(px) || !Number.isInteger(py)) continue;

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        openedCells.add(`${px + dx},${py + dy}`);
      }
    }
  }

  return openedCells;
}

function getCellData(x, y) {
  const world = state.world || {};
  const tiles = world.map && world.map.tiles && typeof world.map.tiles === "object" ? world.map.tiles : {};
  const tile = tiles[`${x},${y}`] || { terrain: "plain", blocked: false, label: "" };
  const landClaims = world.landClaims && typeof world.landClaims === "object" ? world.landClaims : {};
  const ownerNodeId = landClaims[`${x},${y}`] || "";
  const ownerPlayer = ownerNodeId ? getPlayerByNodeId(ownerNodeId) : null;
  const players = state.players.filter((player) =>
    player &&
    player.position &&
    Number(player.position.x) === x &&
    Number(player.position.y) === y
  );
  const entities = Array.isArray(world.entities)
    ? world.entities.filter((entity) => Number(entity.x) === x && Number(entity.y) === y)
    : [];

  const buildings = [];
  for (const player of state.players) {
    const raw = player && player.gameState && player.gameState.buildings
      ? player.gameState.buildings[`${x},${y}`]
      : null;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const type of list) {
      buildings.push({
        type: String(type || "building"),
        nodeId: player.nodeId,
        playerName: player.shortName
      });
    }
  }

  return {
    tile,
    players,
    entities,
    ownerNodeId,
    ownerPlayer,
    isCityCore: state.players.some((player) => player && player.gameState && player.gameState.cityCore === `${x},${y}`),
    buildings,
    districtName: ownerPlayer && ownerPlayer.gameState
      ? ownerPlayer.gameState.districtName || ownerPlayer.gameState.cityName || ""
      : ""
  };
}

function drawWorld() {
  if (!state.world || !state.world.map) {
    return;
  }

  const canvas = document.getElementById("map-canvas");
  const world = state.world;
  const width = Number(world.map.width || 0);
  const height = Number(world.map.height || 0);
  const tile = currentTileSize();
  const landClaims = world.landClaims && typeof world.landClaims === "object" ? world.landClaims : {};
  const buildingByCell = getBuildingByCell();
  const resources = getResourceEntities();

  canvas.width = Math.max(1, width * tile);
  canvas.height = Math.max(1, height * tile);

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = `${x},${y}`;
      const tileData = world.map.tiles[key] || { terrain: "plain", blocked: false };
      ctx.fillStyle = terrainColor(tileData.terrain);
      ctx.fillRect(x * tile, y * tile, tile, tile);

      const ownerNodeId = landClaims[key];
      if (ownerNodeId) {
        ctx.fillStyle = ownerColor(ownerNodeId, 0.24);
        ctx.fillRect(x * tile + 1, y * tile + 1, tile - 2, tile - 2);
      }

      if (tileData.blocked && tileData.terrain !== "water") {
        ctx.fillStyle = "rgba(130, 0, 0, 0.24)";
        ctx.fillRect(x * tile, y * tile, tile, tile);
      }

      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.strokeRect(x * tile + 0.5, y * tile + 0.5, tile - 1, tile - 1);

      const buildings = buildingByCell.get(key) || [];
      if (buildings.length) {
        const building = buildings[0];
        ctx.font = `${Math.max(8, Math.round(tile * 0.58))}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "#fff";
        ctx.fillText(buildingEmoji(building.type), x * tile + 1, y * tile + tile - 1);
      }
    }
  }

  if (tile >= 10) {
    for (const entity of resources) {
      const x = Number(entity.x);
      const y = Number(entity.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      ctx.font = `${Math.max(8, Math.round(tile * 0.5))}px sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#fff";
      ctx.fillText(resourceEmoji(entity), (x + 1) * tile - 1, y * tile + 1);
    }
  }

  for (const player of state.players) {
    if (!player.position) continue;
    const px = Number(player.position.x);
    const py = Number(player.position.y);
    if (!Number.isInteger(px) || !Number.isInteger(py)) continue;

    const cx = px * tile + tile / 2;
    const cy = py * tile + tile / 2;

    ctx.fillStyle = playerColor(player.nodeId);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(4, tile * 0.3), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();

    const avatar = player.avatar ? String(player.avatar) : "\u{1F9D1}";
    ctx.font = `${Math.max(10, Math.round(tile * 0.75))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(avatar, cx, cy + 0.5);
  }

  document.getElementById("map-title").textContent = world.name || "MAP";
}

function centerMapOnCoord(x, y) {
  const wrap = document.getElementById("map-wrap");
  const tile = currentTileSize();
  const targetX = Math.max(0, x * tile + tile / 2 - wrap.clientWidth / 2);
  const targetY = Math.max(0, y * tile + tile / 2 - wrap.clientHeight / 2);
  wrap.scrollLeft = targetX;
  wrap.scrollTop = targetY;
}

function openPlayerModal(player) {
  const modal = document.getElementById("player-modal");
  const body = document.getElementById("player-modal-body");
  const stats = player && player.stats ? player.stats : {};
  const gameState = player && player.gameState ? player.gameState : {};
  const resources = gameState.resources && typeof gameState.resources === "object" ? gameState.resources : {};
  const claimedList = Array.isArray(gameState.claimedCells) ? gameState.claimedCells : [];
  const buildingEntries = Object.entries(gameState.buildings && typeof gameState.buildings === "object" ? gameState.buildings : {});
  const totalBuildings = buildingEntries.reduce((sum, [, list]) => sum + (Array.isArray(list) ? list.length : (list ? 1 : 0)), 0);
  const position = player && player.position ? `${player.position.x},${player.position.y}` : "n/a";

  body.innerHTML = `
    <article class="player-card">
      <div class="player-hero">
        <div class="player-avatar">${escapeHtml(player.avatar || "\u{1F9D1}")}</div>
        <div>
          <div class="player-name">${escapeHtml(player.shortName || "Unknown")}</div>
          <div class="player-node">${escapeHtml(player.nodeId || "n/a")}</div>
        </div>
      </div>
      <div class="player-stats-grid">
        <div class="player-stat-box"><span>Credits</span><strong>${escapeHtml(stats.credits ?? 0)}</strong></div>
        <div class="player-stat-box"><span>Land</span><strong>${escapeHtml(claimedList.length)}</strong></div>
        <div class="player-stat-box"><span>Land LV</span><strong>${escapeHtml(gameState.cityLevel ?? 1)}</strong></div>
        <div class="player-stat-box"><span>Status</span><strong>${escapeHtml(gameState.sessionActive ? "ACTIVE" : "PAUSED")}</strong></div>
      </div>
      <div class="player-meta-grid">
        <div><span>District</span><strong>${escapeHtml(gameState.districtName || gameState.cityName || "unnamed")}</strong></div>
        <div><span>Position</span><strong>${escapeHtml(position)}</strong></div>
        <div><span>Location</span><strong>${escapeHtml(gameState.location || "n/a")}</strong></div>
        <div><span>Claims</span><strong>${escapeHtml(claimedList.join(" ") || "n/a")}</strong></div>
        <div><span>Started</span><strong>${escapeHtml(formatIsoDate(gameState.startedAt))}</strong></div>
        <div><span>Last Action</span><strong>${escapeHtml(formatIsoDate(gameState.lastActionAt))}</strong></div>
        <div><span>State</span><strong>${escapeHtml(player.registrationState || "unknown")}</strong></div>
        <div><span>Level / HP / XP</span><strong>${escapeHtml(stats.level ?? 0)} / ${escapeHtml(stats.hp ?? 0)} / ${escapeHtml(stats.xp ?? 0)}</strong></div>
      </div>
      <div class="player-resource-block">
        <span>Resources</span>
        <div class="player-resource-grid">
          <div>WOOD ${escapeHtml(resources.wood ?? 0)}</div>
          <div>STONE ${escapeHtml(resources.stone ?? 0)}</div>
          <div>IRON ${escapeHtml(resources.iron ?? 0)}</div>
          <div>COPPER ${escapeHtml(resources.copper ?? 0)}</div>
          <div>CRYSTAL ${escapeHtml(resources.crystal ?? 0)}</div>
          <div>FOOD ${escapeHtml(resources.food ?? 0)}</div>
        </div>
      </div>
      <div class="player-building-block">
        <span>Buildings (${totalBuildings})</span>
        <div class="player-building-list">
          ${buildingEntries.length ? buildingEntries.map(([cell, list]) => (
            `<button class="cell-jump-btn" data-coord="${escapeHtml(cell)}" type="button">${escapeHtml(cell)}: ${escapeHtml((Array.isArray(list) ? list : [list]).join(", "))}</button>`
          )).join("") : `<div class="player-building-empty">No buildings</div>`}
        </div>
      </div>
    </article>
  `;

  for (const button of body.querySelectorAll(".cell-jump-btn")) {
    button.addEventListener("click", () => {
      const coord = button.getAttribute("data-coord");
      const parsed = parseCoordKey(coord);
      if (!parsed) return;
      closePlayerModal();
      openCellModal(parsed.x, parsed.y);
    });
  }

  modal.classList.remove("hidden");
}

function closePlayerModal() {
  document.getElementById("player-modal").classList.add("hidden");
}

function openCellModal(x, y) {
  const modal = document.getElementById("cell-modal");
  const body = document.getElementById("cell-modal-body");
  const { tile, players, entities, ownerNodeId, ownerPlayer, isCityCore, buildings, districtName } = getCellData(x, y);
  const ownerLabel = ownerPlayer ? `${ownerPlayer.shortName} (${ownerPlayer.nodeId})` : ownerNodeId || "free";
  const locationLabel = districtName || tile.label || "Unnamed land";

  body.innerHTML = `
    <article class="cell-card">
      <div class="cell-title">CELL [${x},${y}]</div>
      <div class="cell-subtitle">${escapeHtml(tile.terrain)}${tile.blocked ? " / BLOCKED" : ""}</div>
      <div class="cell-subtitle">${escapeHtml(locationLabel)}</div>
      <div class="cell-info-grid">
        <div><span>Owner</span><strong>${escapeHtml(ownerLabel)}</strong></div>
        <div><span>HQ</span><strong>${isCityCore ? "yes" : "no"}</strong></div>
      </div>
      <div class="cell-section">
        <span>Buildings</span>
        <div class="cell-chip-row">
          ${buildings.length ? buildings.map((building) => (
            `<span class="cell-chip">${escapeHtml(buildingEmoji(building.type))} ${escapeHtml(building.type)}${building.playerName ? ` / ${escapeHtml(building.playerName)}` : ""}</span>`
          )).join("") : `<span class="cell-empty">none</span>`}
        </div>
      </div>
      <div class="cell-section">
        <span>Players</span>
        <div class="cell-chip-row">
          ${players.length ? players.map((player) => (
            `<button class="cell-player-link" data-node-id="${escapeHtml(player.nodeId)}" type="button">${escapeHtml(player.avatar || "\u{1F9D1}")} ${escapeHtml(player.shortName || "Unknown")}</button>`
          )).join("") : `<span class="cell-empty">none</span>`}
        </div>
      </div>
      <div class="cell-section">
        <span>Entities</span>
        <div class="cell-chip-row">
          ${entities.length ? entities.map((entity) => (
            `<span class="cell-chip">${escapeHtml(resourceEmoji(entity))} ${escapeHtml(entity.name || entity.type || "entity")}</span>`
          )).join("") : `<span class="cell-empty">none</span>`}
        </div>
      </div>
    </article>
  `;

  for (const button of body.querySelectorAll(".cell-player-link")) {
    button.addEventListener("click", () => {
      const nodeId = button.getAttribute("data-node-id");
      const player = getPlayerByNodeId(nodeId);
      if (!player) return;
      closeCellModal();
      openPlayerModal(player);
    });
  }

  modal.classList.remove("hidden");
}

function closeCellModal() {
  document.getElementById("cell-modal").classList.add("hidden");
}

function renderPlayers() {
  const body = document.getElementById("players-body");
  document.getElementById("player-count").textContent = String(state.players.length);

  if (!state.players.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty">NO PLAYERS</td></tr>`;
    return;
  }

  const players = state.players
    .slice()
    .sort((a, b) => Number(b.stats.credits || 0) - Number(a.stats.credits || 0));

  body.innerHTML = players
    .map((player) => {
      const pos = player.position ? `${player.position.x},${player.position.y}` : "-";
      return `
        <tr class="player-row" data-node-id="${escapeHtml(player.nodeId || "")}">
          <td class="player-name-cell">${escapeHtml(player.avatar || "\u{1F9D1}")} ${escapeHtml(player.shortName || "Unknown")}</td>
          <td>${escapeHtml(player.nodeId || "-")}</td>
          <td>${escapeHtml(pos)}</td>
          <td>${escapeHtml(player.stats.credits || 0)}</td>
        </tr>
      `;
    })
    .join("");

  for (const row of body.querySelectorAll(".player-row")) {
    row.addEventListener("click", () => {
      const nodeId = row.getAttribute("data-node-id");
      const player = getPlayerByNodeId(nodeId);
      if (player) {
        openPlayerModal(player);
      }
    });
  }
}

function renderLogs() {
  const root = document.getElementById("logs");
  document.getElementById("log-count").textContent = String(state.logs.length);

  if (!state.logs.length) {
    root.innerHTML = `<div class="empty">NO LOGS</div>`;
    return;
  }

  root.innerHTML = state.logs
    .slice()
    .reverse()
    .map((log) => `
      <div class="log-row">
        <span class="log-time">${escapeHtml(formatTime(log.timestamp))}</span>
        <span class="log-node">${escapeHtml(log.nodeId || "")}</span>
        <span class="log-text">${escapeHtml(log.text || log.message || "")}</span>
      </div>
    `)
    .join("");
}

function applyPayload(payload, options = {}) {
  state.world = payload && payload.world ? payload.world : null;
  state.players = Array.isArray(payload && payload.players) ? payload.players : [];
  state.logs = Array.isArray(payload && payload.logs) ? payload.logs : [];
  state.server = payload && payload.server && typeof payload.server === "object"
    ? {
      serverOnline: Boolean(payload.server.serverOnline),
      lastSeenAt: payload.server.lastSeenAt || null
    }
    : {
      serverOnline: false,
      lastSeenAt: null
    };

  drawWorld();
  if (!view.hasInitialCenter) {
    const firstPlayerWithPosition = state.players.find((player) =>
      player &&
      player.position &&
      Number.isInteger(Number(player.position.x)) &&
      Number.isInteger(Number(player.position.y))
    );
    if (firstPlayerWithPosition) {
      centerMapOnCoord(Number(firstPlayerWithPosition.position.x), Number(firstPlayerWithPosition.position.y));
      view.hasInitialCenter = true;
    }
  }
  renderPlayers();
  renderLogs();
  updateServerStatus(Boolean(options.viaPoll));
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const payload = await fetchState();
      applyPayload(payload, { viaPoll: true });
    } catch (error) {
      setStatus("SERVER OFFLINE", false);
    }
  }, 5000);
}

function startSse() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`${BACKEND_URL}/api/public/stream`);

  eventSource.addEventListener("state", (event) => {
    try {
      const payload = JSON.parse(event.data);
      applyPayload(payload, { viaPoll: false });
    } catch (error) {
      setStatus("SERVER OFFLINE", false);
    }
  });

  eventSource.onerror = () => {
    setStatus("SERVER OFFLINE", false);
    eventSource.close();
    startPolling();
    setTimeout(() => {
      startSse();
    }, 3000);
  };
}

function setZoom(nextZoom, focusClientX = null, focusClientY = null) {
  const wrap = document.getElementById("map-wrap");
  const prev = view.zoom;
  const clamped = Math.max(view.minZoom, Math.min(view.maxZoom, nextZoom));
  if (Math.abs(clamped - prev) < 0.0001) {
    return;
  }

  let focusX = wrap.clientWidth / 2;
  let focusY = wrap.clientHeight / 2;
  if (focusClientX !== null && focusClientY !== null) {
    const rect = wrap.getBoundingClientRect();
    focusX = focusClientX - rect.left;
    focusY = focusClientY - rect.top;
  }

  const worldX = wrap.scrollLeft + focusX;
  const worldY = wrap.scrollTop + focusY;

  view.zoom = clamped;
  drawWorld();

  const ratio = view.zoom / prev;
  wrap.scrollLeft = worldX * ratio - focusX;
  wrap.scrollTop = worldY * ratio - focusY;
}

function distance(t1, t2) {
  const dx = t2.clientX - t1.clientX;
  const dy = t2.clientY - t1.clientY;
  return Math.hypot(dx, dy);
}

function midpoint(t1, t2) {
  return {
    x: (t1.clientX + t2.clientX) / 2,
    y: (t1.clientY + t2.clientY) / 2
  };
}

function initMapInteractions() {
  const wrap = document.getElementById("map-wrap");
  const canvas = document.getElementById("map-canvas");

  wrap.addEventListener("wheel", (event) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    setZoom(view.zoom + delta, event.clientX, event.clientY);
  }, { passive: false });

  document.getElementById("zoom-in-btn").addEventListener("click", () => setZoom(view.zoom + 0.15));
  document.getElementById("zoom-out-btn").addEventListener("click", () => setZoom(view.zoom - 0.15));

  wrap.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    view.drag.active = true;
    view.drag.moved = false;
    view.drag.startX = event.clientX;
    view.drag.startY = event.clientY;
    view.drag.startLeft = wrap.scrollLeft;
    view.drag.startTop = wrap.scrollTop;
  });

  window.addEventListener("mousemove", (event) => {
    if (!view.drag.active) return;
    const dx = event.clientX - view.drag.startX;
    const dy = event.clientY - view.drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      view.drag.moved = true;
    }
    wrap.scrollLeft = view.drag.startLeft - dx;
    wrap.scrollTop = view.drag.startTop - dy;
  });

  window.addEventListener("mouseup", () => {
    view.drag.active = false;
  });

  wrap.addEventListener("touchstart", (event) => {
    if (event.touches.length === 2) {
      view.pinchStartDistance = distance(event.touches[0], event.touches[1]);
      view.pinchStartZoom = view.zoom;
      return;
    }

    if (event.touches.length === 1) {
      const t = event.touches[0];
      view.drag.active = true;
      view.drag.moved = false;
      view.drag.startX = t.clientX;
      view.drag.startY = t.clientY;
      view.drag.startLeft = wrap.scrollLeft;
      view.drag.startTop = wrap.scrollTop;
    }
  }, { passive: false });

  wrap.addEventListener("touchmove", (event) => {
    if (event.touches.length === 2) {
      event.preventDefault();
      const nextDistance = distance(event.touches[0], event.touches[1]);
      if (view.pinchStartDistance > 0) {
        const scale = nextDistance / view.pinchStartDistance;
        const center = midpoint(event.touches[0], event.touches[1]);
        setZoom(view.pinchStartZoom * scale, center.x, center.y);
      }
      return;
    }

    if (event.touches.length === 1 && view.drag.active) {
      event.preventDefault();
      const t = event.touches[0];
      const dx = t.clientX - view.drag.startX;
      const dy = t.clientY - view.drag.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        view.drag.moved = true;
      }
      wrap.scrollLeft = view.drag.startLeft - dx;
      wrap.scrollTop = view.drag.startTop - dy;
    }
  }, { passive: false });

  wrap.addEventListener("touchend", () => {
    view.drag.active = false;
    view.pinchStartDistance = 0;
  });

  canvas.addEventListener("click", (event) => {
    if (view.drag.moved || !state.world || !state.world.map) return;

    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / currentTileSize());
    const y = Math.floor((event.clientY - rect.top) / currentTileSize());
    const openedCells = getOpenedCellSet();
    const key = `${x},${y}`;

    const playerAtCell = state.players.find((p) => p.position && p.position.x === x && p.position.y === y);
    if (playerAtCell) {
      openPlayerModal(playerAtCell);
      return;
    }

    if (openedCells.has(key)) {
      openCellModal(x, y);
    }
  });
}

function initModals() {
  const playerModal = document.getElementById("player-modal");
  const cellModal = document.getElementById("cell-modal");
  const helpModal = document.getElementById("help-modal");

  document.getElementById("player-modal-close").addEventListener("click", closePlayerModal);
  playerModal.addEventListener("click", (event) => {
    if (event.target === playerModal) {
      closePlayerModal();
    }
  });

  document.getElementById("cell-modal-close").addEventListener("click", closeCellModal);
  cellModal.addEventListener("click", (event) => {
    if (event.target === cellModal) {
      closeCellModal();
    }
  });

  document.getElementById("help-btn").addEventListener("click", () => helpModal.classList.remove("hidden"));
  document.getElementById("help-modal-close").addEventListener("click", () => helpModal.classList.add("hidden"));
  helpModal.addEventListener("click", (event) => {
    if (event.target === helpModal) {
      helpModal.classList.add("hidden");
    }
  });
}

async function main() {
  if (!BACKEND_URL) {
    setStatus("BACKEND_URL MISSING", false);
    return;
  }

  initMapInteractions();
  initModals();

  try {
    const payload = await fetchState();
    applyPayload(payload, { viaPoll: false });
  } catch (error) {
    setStatus("SERVER OFFLINE", false);
  }

  startSse();
  startPolling();
}

main();
