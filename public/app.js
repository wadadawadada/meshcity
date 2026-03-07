async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }

  return response.json().catch(() => ({}));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

const stateCache = {
  players: [],
  logs: [],
  world: null
};
const DEFAULT_MAP_WIDTH = 48;
const DEFAULT_MAP_HEIGHT = 28;

let selectedCell = null;
let mapBusy = false;
let mapZoom = 100;
let mapPanDrag = {
  active: false,
  moved: false,
  startX: 0,
  startY: 0,
  scrollLeft: 0,
  scrollTop: 0
};
let mapPaintDrag = {
  active: false,
  painted: new Set(),
  stroke: []
};
let terrainHistory = {
  undo: [],
  redo: []
};

const mapEditorModeMeta = {
  view: {
    hint: "INSPECT: click a cell to open owner/building/asset details.",
    enable: []
  },
  terrain: {
    hint: "PAINT TERRAIN: choose terrain, optional BLOCKED and DRAW, then click or drag across cells.",
    enable: ["terrain-type", "tile-blocked", "terrain-drag-paint", "terrain-undo-btn", "terrain-redo-btn"]
  },
  entity: {
    hint: "PLACE ASSET: choose asset type + name, then click target cell.",
    enable: ["entity-type", "entity-name"]
  },
  player: {
    hint: "MOVE PLAYER: choose player, then click destination cell.",
    enable: ["player-picker"]
  },
  tools: {
    hint: "MAP TOOLS: resize, autogenerate, export or import world JSON.",
    enable: []
  }
};

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function cloneTileForHistory(tile) {
  return {
    terrain: String(tile && tile.terrain ? tile.terrain : "plain"),
    blocked: Boolean(tile && tile.blocked),
    label: tile && tile.label ? String(tile.label) : ""
  };
}

function localTileAt(x, y) {
  if (!stateCache.world || !stateCache.world.map || !stateCache.world.map.tiles) {
    return cloneTileForHistory(null);
  }
  return cloneTileForHistory(stateCache.world.map.tiles[`${x},${y}`]);
}

function pushTerrainHistory(batch) {
  if (!batch.length) return;
  terrainHistory.undo.push(batch);
  terrainHistory.redo = [];
}

async function applyTerrainHistoryBatch(batch, direction) {
  if (!batch.length) return;
  for (const entry of batch) {
    const tile = direction === "undo" ? entry.before : entry.after;
    await request("/api/world/tile", {
      method: "POST",
      body: JSON.stringify({
        x: entry.x,
        y: entry.y,
        terrain: tile.terrain,
        blocked: tile.blocked,
        label: tile.label
      })
    });
    if (stateCache.world && stateCache.world.map && stateCache.world.map.tiles) {
      stateCache.world.map.tiles[`${entry.x},${entry.y}`] = cloneTileForHistory(tile);
    }
  }
  if (stateCache.world) {
    drawWorldCanvas(stateCache.world);
  }
  updateMapEditorUi();
}

function terrainColor(terrain, x, y) {
  const variant = (x * 19 + y * 13) % 3;
  const shades = {
    plain: ["#4a7b4f", "#437248", "#3d6a42"],
    sand: ["#a58d5a", "#a58d5a", "#a58d5a"],
    forest: ["#2f6a3b", "#2a6035", "#24572f"],
    water: ["#2f5f80", "#2f5f80", "#2f5f80"],
    mountain: ["#5f676b", "#555d62", "#4d555a"],
    town: ["#696046", "#5e5640", "#544e39"],
    road: ["#4b5258", "#454c52", "#3f464c"]
  };
  const key = String(terrain || "plain").toLowerCase();
  const palette = shades[key] || shades.plain;
  return palette[variant];
}

function entityEmoji(type) {
  const key = String(type || "").toLowerCase();
  if (key === "wood") return "\u{1FAB5}";
  if (key === "stone") return "\u{1FAA8}";
  if (key === "iron") return "\u{26CF}";
  if (key === "copper") return "\u{1FA99}";
  if (key === "crystal") return "\u{1F48E}";
  if (key === "food") return "\u{1F33E}";
  if (key === "loot") return "\u{1F4E6}";
  if (key === "npc") return "\u{1F9D1}";
  if (key === "event") return "\u{1F3D7}";
  if (key === "landmark") return "\u{1F3DB}";
  if (key === "project") return "\u{1F6A7}";
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

function ownerPalette(nodeId) {
  const source = String(nodeId || "none");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) % 360;
  }
  const hue = hash;
  return {
    fill: `hsla(${hue}, 80%, 62%, 0.2)`,
    stroke: `hsla(${hue}, 90%, 72%, 0.95)`,
    marker: `hsla(${hue}, 95%, 85%, 0.95)`
  };
}

function renderPorts(ports, currentPort) {
  const select = document.getElementById("port");
  const normalized = Array.isArray(ports) ? ports : [];

  if (!normalized.length) {
    select.innerHTML = `<option value="">AUTO-DETECT</option>`;
    select.value = "";
    return;
  }

  select.innerHTML = [
    `<option value="">AUTO-DETECT</option>`,
    ...normalized.map((port) => (
      `<option value="${escapeHtml(port.device)}">${escapeHtml(port.device)} :: ${escapeHtml(port.description || "Unknown device")}</option>`
    ))
  ].join("");

  if (currentPort && normalized.some((port) => port.device === currentPort)) {
    select.value = currentPort;
  }
}

function renderDevice(device) {
  const statusNode = document.getElementById("device-status");
  const metaNode = document.getElementById("device-meta");

  statusNode.textContent = String(device.status || "offline").toUpperCase();
  statusNode.className = `status-badge ${device.status}`;
  if (metaNode) {
    metaNode.textContent = "";
  }
}

function renderPlayerPicker(players) {
  const picker = document.getElementById("player-picker");
  const current = picker.value;
  picker.innerHTML = players.length
    ? players.map((player) => `<option value="${escapeHtml(player.nodeId)}">${escapeHtml(player.shortName)}</option>`).join("")
    : `<option value="">NO PLAYERS</option>`;
  if (current && players.some((player) => player.nodeId === current)) {
    picker.value = current;
  }

  updateMapEditorUi();
}

function renderPlayers(players) {
  const root = document.getElementById("players");
  document.getElementById("player-count").textContent = String(players.length);

  if (!players.length) {
    root.className = "records empty";
    root.textContent = "NO PLAYERS";
    renderPlayerPicker(players);
    return;
  }

  const rankedPlayers = players.slice().sort((a, b) => {
    const aStats = a.stats || {};
    const bStats = b.stats || {};
    const aLand = Array.isArray(a.gameState && a.gameState.claimedCells) ? a.gameState.claimedCells.length : 0;
    const bLand = Array.isArray(b.gameState && b.gameState.claimedCells) ? b.gameState.claimedCells.length : 0;
    const landDiff = bLand - aLand;
    if (landDiff !== 0) return landDiff;
    const creditsDiff = Number(bStats.credits || 0) - Number(aStats.credits || 0);
    if (creditsDiff !== 0) return creditsDiff;
    return Number(bStats.level || 0) - Number(aStats.level || 0);
  });

  root.className = "records players-list players-table-wrap";
  root.innerHTML = `
    <table class="players-table">
      <thead>
        <tr>
          <th>#</th>
          <th>COLOR</th>
          <th>PLAYER</th>
          <th>STATE</th>
          <th>POS</th>
          <th>LAND</th>
          <th>LAND LV</th>
          <th>CR</th>
          <th>BUILDINGS</th>
          <th>DEL</th>
        </tr>
      </thead>
      <tbody>
      ${rankedPlayers.map((player, index) => {
    const stateRaw = String(player.registrationState || "unknown").toLowerCase();
    const stateLabelByKey = {
      pending_confirmation: "PENDING",
      awaiting_nickname: "AWAITING NAME",
      declined: "DECLINED",
      registered: "ACTIVE"
    };
    const stateLabel = stateLabelByKey[stateRaw] || stateRaw.toUpperCase();
    const statusLabel = player.registered ? "ACTIVE" : stateLabel;
    const pos = player.position ? `${player.position.x},${player.position.y}` : "n/a";
    const stats = player.stats || {};
    const gameState = player.gameState || {};
    const land = Array.isArray(gameState.claimedCells) ? gameState.claimedCells.length : 0;
    const city = Number(gameState.cityLevel || 1);
    const buildingCount = Object.values(gameState.buildings || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    const palette = ownerPalette(player.nodeId);
    const swatchStyle = `--swatch:${palette.stroke};--swatch-fill:${palette.fill};`;

    return `
      <tr class="players-table-row ${player.registered ? "is-registered" : "is-pending"}">
        <td class="player-rank">${index + 1}</td>
        <td><span class="owner-swatch" style="${swatchStyle}" title="Map color for ${escapeHtml(player.shortName)}"></span></td>
        <td class="leaderboard-player">
          <button class="player-open-btn player-name" data-node-id="${escapeHtml(player.nodeId)}" type="button">${escapeHtml(player.avatar || "\u{1F9D1}")} ${escapeHtml(player.shortName)}</button>
          <span class="player-node">${escapeHtml(player.nodeId)}</span>
        </td>
        <td class="leaderboard-state">${escapeHtml(statusLabel)}</td>
        <td class="leaderboard-pos">${escapeHtml(pos)}</td>
        <td>${escapeHtml(land)}</td>
        <td>${escapeHtml(city)}</td>
        <td>${escapeHtml(stats.credits ?? 0)}</td>
        <td>${escapeHtml(buildingCount)}</td>
        <td class="leaderboard-actions">
          <button class="danger delete-player-btn" data-node-id="${escapeHtml(player.nodeId)}" type="button">X</button>
        </td>
      </tr>
  `;
  }).join("")}
      </tbody>
    </table>
  `;

  for (const button of root.querySelectorAll(".delete-player-btn")) {
    button.addEventListener("click", async () => {
      const nodeId = button.getAttribute("data-node-id");
      if (!nodeId) return;
      await request(`/api/players/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
      await refresh();
    });
  }

  for (const button of root.querySelectorAll(".player-open-btn")) {
    button.addEventListener("click", () => {
      const nodeId = button.getAttribute("data-node-id");
      if (!nodeId) return;
      openPlayerModal(nodeId);
    });
  }

  renderPlayerPicker(players);
}

function renderLogs(logs) {
  const root = document.getElementById("logs");
  document.getElementById("log-count").textContent = String(logs.length);

  if (!logs.length) {
    root.className = "records empty";
    root.textContent = "NO LOGS";
    return;
  }

  root.className = "records";
  root.innerHTML = logs.slice().reverse().map((log) => `
    <div class="log">
      <div class="log-time">${escapeHtml(log.timestamp.slice(11, 19))}</div>
      <div class="log-body"><span class="log-scope">[${escapeHtml(log.scope)}]</span> ${escapeHtml(log.message)}</div>
    </div>
  `).join("");
}

function getCellData(x, y) {
  const world = stateCache.world;
  const key = `${x},${y}`;
  const tile = world.map.tiles[key] || { terrain: "plain", blocked: false, label: "" };
  const players = stateCache.players.filter((player) => player.position && player.position.x === x && player.position.y === y);
  const entities = world.entities.filter((entity) => entity.x === x && entity.y === y);
  const ownerNodeId = world.landClaims ? world.landClaims[key] || null : null;
  const ownerPlayer = ownerNodeId ? stateCache.players.find((player) => player.nodeId === ownerNodeId) || null : null;
  const ownerGameState = ownerPlayer && ownerPlayer.gameState ? ownerPlayer.gameState : {};
  const isCityCore = Boolean(ownerGameState.cityCore && ownerGameState.cityCore === key);
  const buildings = ownerGameState.buildings && ownerGameState.buildings[key] ? ownerGameState.buildings[key] : [];
  const districtName = ownerGameState.districtName || ownerGameState.cityName || "";
  return { tile, players, entities, ownerNodeId, ownerPlayer, isCityCore, buildings, districtName };
}

function closeCellModal() {
  document.getElementById("cell-modal").classList.add("hidden");
}

function findPlayerByNodeId(nodeId) {
  return stateCache.players.find((player) => player.nodeId === nodeId) || null;
}

function inventoryEmoji(itemName) {
  const name = String(itemName || "").toLowerCase();
  if (name.includes("dagger") || name.includes("blade") || name.includes("sword")) return "рџ—ЎпёЏ";
  if (name.includes("armor") || name.includes("cloak")) return "рџ›ЎпёЏ";
  if (name.includes("lantern") || name.includes("relic") || name.includes("crystal")) return "рџ”®";
  if (name.includes("med") || name.includes("tonic") || name.includes("potion")) return "рџ§Є";
  if (name.includes("credit") || name.includes("chip")) return "рџ’°";
  if (name.includes("core") || name.includes("signal")) return "рџ“Ў";
  if (name.includes("map") || name.includes("compass")) return "рџ§­";
  return "рџЋ’";
}

function formatIsoDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function closePlayerModal() {
  document.getElementById("player-modal").classList.add("hidden");
}

function openHelpModal() {
  document.getElementById("help-modal").classList.remove("hidden");
}

function closeHelpModal() {
  document.getElementById("help-modal").classList.add("hidden");
}

function openPlayerModal(nodeId) {
  const modal = document.getElementById("player-modal");
  const body = document.getElementById("player-modal-body");
  const player = findPlayerByNodeId(nodeId);
  if (!player) {
    body.innerHTML = `<div class="meta-text">PLAYER NOT FOUND</div>`;
    modal.classList.remove("hidden");
    return;
  }

  const stats = player.stats || {};
  const gameState = player.gameState || {};
  const resources = gameState.resources || {};
  const claimedCells = Array.isArray(gameState.claimedCells) ? gameState.claimedCells : [];
  const buildingEntries = Object.entries(gameState.buildings || {});
  const totalBuildings = buildingEntries.reduce((sum, [, list]) => sum + (Array.isArray(list) ? list.length : 0), 0);
  const position = player.position ? `${player.position.x},${player.position.y}` : "n/a";

  body.innerHTML = `
    <article class="player-modal-profile">
      <div class="player-modal-banner">
        <div class="player-modal-rune">${escapeHtml(player.avatar || "\u{1F9D1}")}</div>
        <div>
          <div class="player-modal-name">${escapeHtml(player.shortName || "Unknown")}</div>
          <div class="player-modal-node">${escapeHtml(player.nodeId || "n/a")}</div>
        </div>
      </div>
      <div class="player-modal-grid">
        <div class="player-stat-card"><span>CREDITS</span><strong>${escapeHtml(stats.credits ?? 0)}</strong></div>
        <div class="player-stat-card"><span>LAND</span><strong>${escapeHtml(claimedCells.length)}</strong></div>
        <div class="player-stat-card"><span>LAND LV</span><strong>${escapeHtml(gameState.cityLevel ?? 1)}</strong></div>
        <div class="player-stat-card"><span>STATUS</span><strong>${escapeHtml(gameState.sessionActive ? "ACTIVE" : "PAUSED")}</strong></div>
      </div>
      <div class="player-modal-meta">
        <div><span>DISTRICT</span><strong>${escapeHtml(gameState.districtName || "unnamed")}</strong></div>
        <div><span>POSITION</span><strong>${escapeHtml(position)}</strong></div>
        <div><span>LOCATION</span><strong>${escapeHtml(gameState.location || "n/a")}</strong></div>
        <div><span>CLAIMS</span><strong>${escapeHtml(claimedCells.slice(0, 8).join(" ") || "n/a")}</strong></div>
        <div><span>STARTED</span><strong>${escapeHtml(formatIsoDate(gameState.startedAt))}</strong></div>
      </div>
      <div class="player-modal-equip">
        <span>RESOURCES</span>
        <div class="equip-row">
          <span>WOOD ${escapeHtml(resources.wood ?? 0)}</span>
          <span>STONE ${escapeHtml(resources.stone ?? 0)}</span>
          <span>IRON ${escapeHtml(resources.iron ?? 0)}</span>
        </div>
        <div class="equip-row">
          <span>COPPER ${escapeHtml(resources.copper ?? 0)}</span>
          <span>CRYSTAL ${escapeHtml(resources.crystal ?? 0)}</span>
          <span>FOOD ${escapeHtml(resources.food ?? 0)}</span>
        </div>
      </div>
      <div class="player-modal-inventory">
        <span>BUILDINGS (${totalBuildings})</span>
        <div class="inventory-grid">
          ${buildingEntries.length ? buildingEntries.map(([cell, list]) => (
            `<div class="inventory-item">${escapeHtml(cell)}: ${escapeHtml((Array.isArray(list) ? list : [list]).join(", "))}</div>`
          )).join("") : `<div class="inventory-item empty-inventory">Empty pack</div>`}
        </div>
      </div>
    </article>
  `;

  modal.classList.remove("hidden");
}

function openCellModal(x, y) {
  const modal = document.getElementById("cell-modal");
  const body = document.getElementById("cell-modal-body");
  const { tile, players, entities, ownerNodeId, ownerPlayer, isCityCore, buildings, districtName } = getCellData(x, y);
  const ownerLabel = ownerPlayer ? `${ownerPlayer.shortName} (${ownerPlayer.nodeId})` : ownerNodeId || "free";
  const locationLabel = districtName || tile.label || "Unnamed land";

  body.innerHTML = `
    <div class="cell-banner">
      <div class="cell-coord">CELL [${x},${y}]</div>
      <div class="cell-biome">${escapeHtml(tile.terrain)}${tile.blocked ? " / BLOCKED" : ""}</div>
      <div class="cell-location">${escapeHtml(locationLabel)}</div>
    </div>
    <div class="modal-row">
      <span class="meta-label">OWNER</span>
      <span class="meta-text">${escapeHtml(ownerLabel)}</span>
    </div>
    <div class="modal-row">
      <span class="meta-label">HQ</span>
      <span class="meta-text">${isCityCore ? "yes" : "no"}</span>
    </div>
    <div class="modal-row">
      <span class="meta-label">BUILDINGS</span>
      <span class="meta-text">${buildings.length ? buildings.map((building) => `${escapeHtml(buildingEmoji(building))} ${escapeHtml(building)}`).join(" | ") : "none"}</span>
    </div>
    <div class="modal-row">
      <span class="meta-label">PLAYERS</span>
      <span class="meta-text">
        ${players.length ? players.map((player) => (
          `<button class="cell-player-link" data-node-id="${escapeHtml(player.nodeId)}" type="button">${escapeHtml(player.avatar || "\u{1F9D1}")} ${escapeHtml(player.shortName)}</button>`
        )).join(" ") : "none"}
      </span>
    </div>
    <div class="modal-row">
      <span class="meta-label">ENTITIES</span>
      <span class="meta-text">
        ${entities.length ? entities.map((entity) => (
          `<button class="inline-danger delete-entity-btn" data-entity-id="${escapeHtml(entity.id)}" type="button">${escapeHtml(entityEmoji(entity.type))} ${escapeHtml(entity.name)} x</button>`
        )).join(" ") : "none"}
      </span>
    </div>
  `;

  for (const button of body.querySelectorAll(".cell-player-link")) {
    button.addEventListener("click", () => {
      const nodeId = button.getAttribute("data-node-id");
      if (!nodeId) return;
      openPlayerModal(nodeId);
    });
  }

  for (const button of body.querySelectorAll(".delete-entity-btn")) {
    button.addEventListener("click", async () => {
      const entityId = button.getAttribute("data-entity-id");
      if (!entityId) return;
      await request(`/api/world/entity/${encodeURIComponent(entityId)}`, { method: "DELETE" });
      await refresh();
      openCellModal(x, y);
    });
  }

  modal.classList.remove("hidden");
}

async function applyMapAction(x, y) {
  if (mapBusy) return;
  const mode = document.getElementById("map-mode").value;
  mapBusy = true;

  try {
    if (mode === "terrain") {
      await applyTerrainEdit(x, y);
      return;
    }

    if (mode === "entity") {
      const rawName = document.getElementById("entity-name").value.trim();
      await request("/api/world/entity", {
        method: "POST",
        body: JSON.stringify({
          x,
          y,
          type: document.getElementById("entity-type").value,
          name: rawName || "Entity"
        })
      });
      return;
    }

    if (mode === "player") {
      const nodeId = document.getElementById("player-picker").value;
      if (!nodeId) {
        setMapEditorHint("MODE: MOVE PLAYER. No players available yet.");
        return;
      }
      await request("/api/world/player-position", {
        method: "POST",
        body: JSON.stringify({ nodeId, x, y })
      });
    }
  } finally {
    mapBusy = false;
  }
}

async function applyTerrainEdit(x, y, options = {}) {
  const historyBatch = Array.isArray(options.historyBatch) ? options.historyBatch : null;
  const before = localTileAt(x, y);
  const terrain = document.getElementById("terrain-type").value;
  const blocked = document.getElementById("tile-blocked").checked;
  const after = {
    terrain,
    blocked,
    label: ""
  };

  if (before.terrain === after.terrain && before.blocked === after.blocked && before.label === after.label) {
    return false;
  }

  await request("/api/world/tile", {
    method: "POST",
    body: JSON.stringify({
      x,
      y,
      terrain: after.terrain,
      blocked: after.blocked,
      label: after.label
    })
  });

  if (stateCache.world && stateCache.world.map && stateCache.world.map.tiles) {
    stateCache.world.map.tiles[`${x},${y}`] = cloneTileForHistory(after);
    drawWorldCanvas(stateCache.world);
  }

  const entry = {
    x,
    y,
    before,
    after: cloneTileForHistory(after)
  };
  if (historyBatch) {
    historyBatch.push(entry);
  } else {
    pushTerrainHistory([entry]);
  }
  updateMapEditorUi();
  return true;
}

function setMapEditorHint(text) {
  const hintNode = document.getElementById("map-editor-hint");
  if (hintNode) {
    hintNode.textContent = text;
  }
}

function updateMapEditorUi() {
  const modeSelect = document.getElementById("map-mode");
  if (!modeSelect) return;

  const mode = modeSelect.value;
  const meta = mapEditorModeMeta[mode] || mapEditorModeMeta.view;
  const groups = document.querySelectorAll("[data-editor-scope]");

  const modeControls = ["terrain-type", "tile-blocked", "terrain-drag-paint", "terrain-undo-btn", "terrain-redo-btn", "entity-type", "entity-name", "player-picker"];
  for (const controlId of modeControls) {
    const element = document.getElementById(controlId);
    if (!element) continue;
    element.disabled = !meta.enable.includes(controlId);
  }

  const undoBtn = document.getElementById("terrain-undo-btn");
  const redoBtn = document.getElementById("terrain-redo-btn");
  if (undoBtn) {
    undoBtn.disabled = mode !== "terrain" || terrainHistory.undo.length === 0 || mapBusy;
  }
  if (redoBtn) {
    redoBtn.disabled = mode !== "terrain" || terrainHistory.redo.length === 0 || mapBusy;
  }

  for (const group of groups) {
    const scope = group.getAttribute("data-editor-scope");
    group.hidden = scope !== "common" && scope !== mode;
  }

  if (mode === "player" && !stateCache.players.length) {
    setMapEditorHint("MODE: MOVE PLAYER. No players available yet.");
    return;
  }

  setMapEditorHint(meta.hint);
}

function getCanvasCellFromPointer(event, canvas, wrap) {
  if (!stateCache.world) return null;
  const rect = canvas.getBoundingClientRect();
  const tile = Number(wrap.dataset.tileSize || "24");
  const x = Math.floor((event.clientX - rect.left) / tile);
  const y = Math.floor((event.clientY - rect.top) / tile);
  if (x < 0 || y < 0 || x >= stateCache.world.map.width || y >= stateCache.world.map.height) return null;
  return { x, y };
}

async function paintTerrainCell(x, y) {
  const key = `${x},${y}`;
  if (mapPaintDrag.painted.has(key)) return;
  mapPaintDrag.painted.add(key);
  selectedCell = { x, y };
  await applyTerrainEdit(x, y, { historyBatch: mapPaintDrag.stroke });
}

function drawWorldCanvas(world) {
  const canvas = document.getElementById("world-canvas");
  const wrap = document.getElementById("world-map-wrap");
  if (!world || !world.map) return;

  const tile = Math.max(5, Math.round(24 * (mapZoom / 100)));
  const width = world.map.width * tile;
  const height = world.map.height * tile;

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const playersByCell = new Map();
  const playersByNodeId = new Map();
  for (const player of stateCache.players) {
    playersByNodeId.set(player.nodeId, player);
    if (!player.position) continue;
    const key = `${player.position.x},${player.position.y}`;
    const arr = playersByCell.get(key) || [];
    arr.push(player);
    playersByCell.set(key, arr);
  }

  const buildingsByCell = new Map();
  for (const player of stateCache.players) {
    const buildings = player && player.gameState && player.gameState.buildings ? player.gameState.buildings : {};
    for (const [key, list] of Object.entries(buildings)) {
      const normalized = Array.isArray(list) ? list : list ? [list] : [];
      if (!buildingsByCell.has(key)) {
        buildingsByCell.set(key, normalized);
      }
    }
  }

  const entitiesByCell = new Map();
  for (const entity of world.entities) {
    const key = `${entity.x},${entity.y}`;
    const arr = entitiesByCell.get(key) || [];
    arr.push(entity);
    entitiesByCell.set(key, arr);
  }

  const emojiFont = Math.max(10, Math.round(tile * 0.5));

  for (let y = 0; y < world.map.height; y += 1) {
    for (let x = 0; x < world.map.width; x += 1) {
      const key = `${x},${y}`;
      const cellX = x * tile;
      const cellY = y * tile;
      const tileData = world.map.tiles[key] || { terrain: "plain", blocked: false };
      const ownerId = world.landClaims ? world.landClaims[key] || null : null;
      const ownerColors = ownerId ? ownerPalette(ownerId) : null;
      const ownerPlayer = ownerId ? playersByNodeId.get(ownerId) || null : null;
      const isCityCore = Boolean(ownerPlayer && ownerPlayer.gameState && ownerPlayer.gameState.cityCore === key);
      const buildingTypes = buildingsByCell.get(key) || [];

      ctx.fillStyle = terrainColor(tileData.terrain, x, y);
      ctx.fillRect(cellX, cellY, tile, tile);

      if (ownerColors) {
        ctx.fillStyle = ownerColors.fill;
        ctx.fillRect(cellX + 1, cellY + 1, tile - 2, tile - 2);
      }

      if (tileData.blocked && tileData.terrain !== "water") {
        ctx.fillStyle = "rgba(145, 47, 47, 0.35)";
        ctx.fillRect(cellX, cellY, tile, tile);
      }

      ctx.strokeStyle = "rgba(7, 17, 10, 0.45)";
      ctx.strokeRect(cellX + 0.5, cellY + 0.5, tile - 1, tile - 1);

      if (ownerColors) {
        const sameOwner = (nx, ny) => {
          const nKey = `${nx},${ny}`;
          return world.landClaims && world.landClaims[nKey] === ownerId;
        };
        ctx.strokeStyle = ownerColors.stroke;
        ctx.lineWidth = Math.max(1.2, tile * 0.08);
        if (!sameOwner(x - 1, y)) {
          ctx.beginPath();
          ctx.moveTo(cellX + 1, cellY + 1);
          ctx.lineTo(cellX + 1, cellY + tile - 1);
          ctx.stroke();
        }
        if (!sameOwner(x + 1, y)) {
          ctx.beginPath();
          ctx.moveTo(cellX + tile - 1, cellY + 1);
          ctx.lineTo(cellX + tile - 1, cellY + tile - 1);
          ctx.stroke();
        }
        if (!sameOwner(x, y - 1)) {
          ctx.beginPath();
          ctx.moveTo(cellX + 1, cellY + 1);
          ctx.lineTo(cellX + tile - 1, cellY + 1);
          ctx.stroke();
        }
        if (!sameOwner(x, y + 1)) {
          ctx.beginPath();
          ctx.moveTo(cellX + 1, cellY + tile - 1);
          ctx.lineTo(cellX + tile - 1, cellY + tile - 1);
          ctx.stroke();
        }
        ctx.lineWidth = 1;
      }

      if (isCityCore) {
        const markerSize = Math.max(4, Math.round(tile * 0.22));
        ctx.fillStyle = ownerColors ? ownerColors.marker : "rgba(255,255,255,0.9)";
        ctx.beginPath();
        ctx.moveTo(cellX + tile / 2, cellY + 3);
        ctx.lineTo(cellX + tile / 2 + markerSize, cellY + tile / 2);
        ctx.lineTo(cellX + tile / 2, cellY + tile - 3);
        ctx.lineTo(cellX + tile / 2 - markerSize, cellY + tile / 2);
        ctx.closePath();
        ctx.fill();
      }

      if (buildingTypes.length) {
        const buildingFont = Math.max(10, Math.round(tile * 0.56));
        ctx.font = `${buildingFont}px sans-serif`;
        ctx.fillStyle = "rgba(255, 245, 220, 0.95)";
        ctx.fillText(buildingEmoji(buildingTypes[0]), cellX + Math.max(2, tile * 0.2), cellY + tile - Math.max(2, tile * 0.12));
        if (buildingTypes.length > 1) {
          ctx.font = `${Math.max(8, Math.round(tile * 0.28))}px Consolas, monospace`;
          ctx.fillStyle = "#ffffff";
          ctx.fillText(`+${buildingTypes.length - 1}`, cellX + 2, cellY + tile - 3);
        }
      }

      const entities = entitiesByCell.get(key) || [];
      if (entities.length) {
        ctx.font = `${emojiFont}px sans-serif`;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(entityEmoji(entities[0].type), cellX + tile - emojiFont - 2, cellY + tile - 3);
      }

      const players = playersByCell.get(key) || [];
      if (players.length) {
        const primaryPlayer = players[0];
        const tokenPalette = primaryPlayer ? ownerPalette(primaryPlayer.nodeId) : null;
        ctx.font = `${Math.max(12, Math.round(tile * 0.92))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const avatar = primaryPlayer && primaryPlayer.avatar ? primaryPlayer.avatar : "\u{1F9D1}";
        if (tokenPalette) {
          ctx.strokeStyle = tokenPalette.stroke;
          ctx.lineWidth = Math.max(1.4, tile * 0.08);
          ctx.strokeText(avatar, cellX + tile / 2, cellY + tile / 2 + Math.max(0, tile * 0.02));
        }
        ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
        ctx.fillText(avatar, cellX + tile / 2, cellY + tile / 2 + Math.max(0, tile * 0.02));
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";

        if (players.length > 1) {
          ctx.font = `${Math.max(8, Math.round(tile * 0.34))}px Consolas, monospace`;
          ctx.fillStyle = "#ffffff";
          ctx.fillText(String(players.length), cellX + 2, cellY + tile - 3);
        }

        const speakingPlayer = players.find((player) => {
          const bubble = player && player.gameState ? String(player.gameState.chatBubble || "") : "";
          return bubble.trim().length > 0;
        });
        if (speakingPlayer) {
          const rawBubble = String(speakingPlayer.gameState.chatBubble || "").trim().slice(0, 80);
          const bubbleText = rawBubble.length > 26 ? `${rawBubble.slice(0, 26)}...` : rawBubble;
          const bubbleFont = Math.max(9, Math.round(tile * 0.34));
          ctx.font = `${bubbleFont}px Consolas, monospace`;
          const textWidth = ctx.measureText(bubbleText).width;
          const bubblePadding = 4;
          const bubbleWidth = Math.max(tile + 10, textWidth + bubblePadding * 2);
          const bubbleHeight = bubbleFont + 7;
          let bubbleX = Math.round(cellX + tile / 2 - bubbleWidth / 2);
          let bubbleY = cellY - bubbleHeight - 5;

          bubbleX = Math.max(2, Math.min(width - bubbleWidth - 2, bubbleX));
          if (bubbleY < 2) {
            bubbleY = cellY + tile + 4;
          }

          ctx.fillStyle = "rgba(248, 237, 206, 0.92)";
          ctx.fillRect(bubbleX, bubbleY, bubbleWidth, bubbleHeight);
          ctx.strokeStyle = "rgba(120, 97, 51, 0.95)";
          ctx.strokeRect(bubbleX + 0.5, bubbleY + 0.5, bubbleWidth - 1, bubbleHeight - 1);

          const tailUp = bubbleY > cellY;
          ctx.beginPath();
          if (tailUp) {
            ctx.moveTo(cellX + tile / 2 - 3, bubbleY);
            ctx.lineTo(cellX + tile / 2 + 3, bubbleY);
            ctx.lineTo(cellX + tile / 2, bubbleY - 5);
          } else {
            ctx.moveTo(cellX + tile / 2 - 3, bubbleY + bubbleHeight);
            ctx.lineTo(cellX + tile / 2 + 3, bubbleY + bubbleHeight);
            ctx.lineTo(cellX + tile / 2, bubbleY + bubbleHeight + 5);
          }
          ctx.closePath();
          ctx.fillStyle = "rgba(248, 237, 206, 0.92)";
          ctx.fill();
          ctx.strokeStyle = "rgba(120, 97, 51, 0.95)";
          ctx.stroke();

          ctx.fillStyle = "#3a321d";
          ctx.fillText(bubbleText, bubbleX + bubblePadding, bubbleY + bubbleHeight - 5);
        }
      }
    }
  }

  if (selectedCell) {
    ctx.strokeStyle = "rgba(226, 255, 232, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(selectedCell.x * tile + 1, selectedCell.y * tile + 1, tile - 2, tile - 2);
  }

  wrap.dataset.tileSize = String(tile);
}

function renderWorld(world) {
  if (!world || !world.map) return;
  const mapNameInput = document.getElementById("map-name");
  const mapWidthInput = document.getElementById("map-width");
  const mapHeightInput = document.getElementById("map-height");
  const activeElement = document.activeElement;
  const worldName = world.name || "Untitled Map";
  if (activeElement !== mapNameInput) {
    mapNameInput.value = worldName;
  }
  if (activeElement !== mapWidthInput) {
    mapWidthInput.value = world.map.width;
  }
  if (activeElement !== mapHeightInput) {
    mapHeightInput.value = world.map.height;
  }
  document.getElementById("map-name-badge").textContent = worldName;
  drawWorldCanvas(world);
}

function applyZoomToUi() {
}

function setMapZoom(nextZoom, focusPoint = null) {
  const wrap = document.getElementById("world-map-wrap");
  const prevZoom = mapZoom;
  const clampedZoom = Math.max(20, Math.min(220, Math.round(nextZoom / 10) * 10));
  if (clampedZoom === prevZoom) {
    applyZoomToUi();
    return;
  }

  let contentX = 0;
  let contentY = 0;
  if (wrap && focusPoint) {
    const rect = wrap.getBoundingClientRect();
    contentX = wrap.scrollLeft + (focusPoint.clientX - rect.left);
    contentY = wrap.scrollTop + (focusPoint.clientY - rect.top);
  }

  mapZoom = clampedZoom;
  applyZoomToUi();
  if (stateCache.world) {
    drawWorldCanvas(stateCache.world);
  }

  if (wrap && focusPoint) {
    const ratio = mapZoom / prevZoom;
    const rect = wrap.getBoundingClientRect();
    wrap.scrollLeft = contentX * ratio - (focusPoint.clientX - rect.left);
    wrap.scrollTop = contentY * ratio - (focusPoint.clientY - rect.top);
  }
}

function initMapPanZoom() {
  const wrap = document.getElementById("world-map-wrap");
  const canvas = document.getElementById("world-canvas");
  document.getElementById("zoom-in-btn").addEventListener("click", () => setMapZoom(mapZoom + 10));
  document.getElementById("zoom-out-btn").addEventListener("click", () => setMapZoom(mapZoom - 10));
  document.getElementById("terrain-undo-btn")?.addEventListener("click", async () => {
    if (!terrainHistory.undo.length || mapBusy) return;
    const batch = terrainHistory.undo.pop();
    if (!batch) return;
    mapBusy = true;
    updateMapEditorUi();
    try {
      await applyTerrainHistoryBatch(batch, "undo");
      terrainHistory.redo.push(batch);
    } finally {
      mapBusy = false;
      updateMapEditorUi();
    }
  });
  document.getElementById("terrain-redo-btn")?.addEventListener("click", async () => {
    if (!terrainHistory.redo.length || mapBusy) return;
    const batch = terrainHistory.redo.pop();
    if (!batch) return;
    mapBusy = true;
    updateMapEditorUi();
    try {
      await applyTerrainHistoryBatch(batch, "redo");
      terrainHistory.undo.push(batch);
    } finally {
      mapBusy = false;
      updateMapEditorUi();
    }
  });

  wrap.addEventListener("wheel", (event) => {
    event.preventDefault();
    setMapZoom(mapZoom + (event.deltaY > 0 ? -10 : 10), event);
  }, { passive: false });

  wrap.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const mode = document.getElementById("map-mode").value;
    const dragPaintEnabled = document.getElementById("terrain-drag-paint")?.checked;
    if (mode === "terrain" && dragPaintEnabled && event.target === canvas) {
      mapPaintDrag.active = true;
      mapPaintDrag.painted = new Set();
      mapPaintDrag.stroke = [];
      mapPanDrag.active = false;
      mapPanDrag.moved = false;
      const cell = getCanvasCellFromPointer(event, canvas, wrap);
      if (cell) {
        void paintTerrainCell(cell.x, cell.y);
      }
      return;
    }
    mapPanDrag.active = true;
    mapPanDrag.moved = false;
    mapPanDrag.startX = event.clientX;
    mapPanDrag.startY = event.clientY;
    mapPanDrag.scrollLeft = wrap.scrollLeft;
    mapPanDrag.scrollTop = wrap.scrollTop;
    wrap.classList.add("is-panning");
  });

  window.addEventListener("mousemove", (event) => {
    if (mapPaintDrag.active) {
      const cell = getCanvasCellFromPointer(event, canvas, wrap);
      if (cell) {
        void paintTerrainCell(cell.x, cell.y);
      }
      return;
    }
    if (!mapPanDrag.active) return;
    const dx = event.clientX - mapPanDrag.startX;
    const dy = event.clientY - mapPanDrag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      mapPanDrag.moved = true;
    }
    wrap.scrollLeft = mapPanDrag.scrollLeft - dx;
    wrap.scrollTop = mapPanDrag.scrollTop - dy;
  });

  window.addEventListener("mouseup", () => {
    if (mapPaintDrag.active) {
      mapPaintDrag.active = false;
      mapPaintDrag.painted = new Set();
      if (mapPaintDrag.stroke.length) {
        pushTerrainHistory(mapPaintDrag.stroke.slice());
        updateMapEditorUi();
      }
      mapPaintDrag.stroke = [];
    }
    if (!mapPanDrag.active) return;
    mapPanDrag.active = false;
    wrap.classList.remove("is-panning");
  });

  canvas.addEventListener("click", async (event) => {
    if (!stateCache.world || mapPanDrag.moved || mapPaintDrag.active) return;
    const cell = getCanvasCellFromPointer(event, canvas, wrap);
    if (!cell) return;
    const { x, y } = cell;

    const mode = document.getElementById("map-mode").value;
    selectedCell = { x, y };
    await applyMapAction(x, y);
    await refresh();
    if (mode === "view") {
      openCellModal(x, y);
    } else {
      closeCellModal();
    }
  });

  applyZoomToUi();
}

function initCellModal() {
  const modal = document.getElementById("cell-modal");
  document.getElementById("cell-modal-close").addEventListener("click", closeCellModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeCellModal();
    }
  });
}

function initPlayerModal() {
  const modal = document.getElementById("player-modal");
  document.getElementById("player-modal-close").addEventListener("click", closePlayerModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closePlayerModal();
    }
  });
}

function initHelpModal() {
  const modal = document.getElementById("help-modal");
  document.getElementById("help-open-btn").addEventListener("click", openHelpModal);
  document.getElementById("help-modal-close").addEventListener("click", closeHelpModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeHelpModal();
    }
  });
}

async function refreshPorts(currentPort = "") {
  const payload = await request("/api/device/ports");
  renderPorts(payload.ports, currentPort);
}

async function refresh() {
  const state = await request("/api/state");
  stateCache.players = Array.isArray(state.players) ? state.players : [];
  stateCache.logs = Array.isArray(state.logs) ? state.logs : [];
  stateCache.world = state.world || null;

  renderDevice(state.device || {});
  renderPlayers(stateCache.players);
  renderLogs(stateCache.logs);
  renderWorld(stateCache.world);
  await refreshPorts((state.device && state.device.port) || "");
}

async function main() {
  document.getElementById("refresh-ports-btn").addEventListener("click", async () => {
    await refreshPorts(document.getElementById("port").value);
  });

  document.getElementById("connect-btn").addEventListener("click", async () => {
    const port = document.getElementById("port").value.trim();
    await request("/api/device/connect", {
      method: "POST",
      body: JSON.stringify({ transport: "serial", port })
    });
    await refresh();
  });

  document.getElementById("disconnect-btn").addEventListener("click", async () => {
    await request("/api/device/disconnect", { method: "POST" });
    await refresh();
  });

  document.getElementById("clear-logs-btn").addEventListener("click", async () => {
    await request("/api/logs/clear", { method: "POST" });
    await refresh();
  });

  document.getElementById("export-players-btn").addEventListener("click", async () => {
    window.location.href = "/api/export/players";
  });

  document.getElementById("resize-map-btn").addEventListener("click", async () => {
    const width = Number(document.getElementById("map-width").value) || DEFAULT_MAP_WIDTH;
    const height = Number(document.getElementById("map-height").value) || DEFAULT_MAP_HEIGHT;
    await request("/api/world/config", {
      method: "POST",
      body: JSON.stringify({ width, height })
    });
    await refresh();
  });

  document.getElementById("save-map-name-btn").addEventListener("click", async () => {
    const name = document.getElementById("map-name").value.trim() || "Untitled Map";
    await request("/api/world/meta", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    setMapEditorHint(`Map name saved: ${name}`);
    await refresh();
  });
  document.getElementById("map-name").addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    document.getElementById("save-map-name-btn").click();
  });

  document.getElementById("generate-map-btn").addEventListener("click", async () => {
    const width = DEFAULT_MAP_WIDTH;
    const height = DEFAULT_MAP_HEIGHT;
    await request("/api/world/generate", {
      method: "POST",
      body: JSON.stringify({ width, height })
    });
    setMapEditorHint("AUTO WORLD generated. Switch to INSPECT and click cells to review details.");
    closeCellModal();
    await refresh();
  });

  document.getElementById("clear-map-btn").addEventListener("click", async () => {
    await request("/api/world/clear", { method: "POST" });
    setMapEditorHint("World cleared to plain terrain.");
    closeCellModal();
    await refresh();
  });

  document.getElementById("export-map-btn").addEventListener("click", () => {
    if (!stateCache.world) {
      setMapEditorHint("Nothing to export yet.");
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadJson(`meshcity-world-${stamp}.json`, { world: stateCache.world });
    setMapEditorHint("World exported as JSON.");
  });

  const importInput = document.getElementById("import-map-input");
  document.getElementById("import-map-btn").addEventListener("click", () => {
    importInput.value = "";
    importInput.click();
  });
  importInput.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      setMapEditorHint("Import failed: invalid JSON.");
      return;
    }
    const world = payload && payload.world ? payload.world : payload;
    if (!world || !world.map || !Number.isInteger(Number(world.map.width)) || !Number.isInteger(Number(world.map.height))) {
      setMapEditorHint("Import failed: missing world.map.width/height.");
      return;
    }
    await request("/api/world/import", {
      method: "POST",
      body: JSON.stringify({ world })
    });
    setMapEditorHint("World imported successfully.");
    closeCellModal();
    await refresh();
  });

  document.getElementById("map-mode").addEventListener("change", () => {
    updateMapEditorUi();
  });

  initMapPanZoom();
  initCellModal();
  initPlayerModal();
  initHelpModal();
  updateMapEditorUi();
  await refresh();
  window.setInterval(refresh, 3000);
}

main().catch((error) => {
  console.error(error);
  alert(error.message);
});





