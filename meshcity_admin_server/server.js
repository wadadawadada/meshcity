const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createApiHandler } = require("./src/api");
const { createDashboardHandler } = require("./src/dashboard");
const { createMeshtasticService } = require("./src/meshtasticService");
const { createStore } = require("./src/store");
const { createPublicSync } = require("./src/publicSync");

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

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_SYNC_HEARTBEAT_MS = Math.max(3000, Number(process.env.PUBLIC_SYNC_HEARTBEAT_MS || 5000));
const publicSync = createPublicSync({
  backendUrl: process.env.PUBLIC_BROADCAST_BACKEND_URL,
  syncToken: process.env.ADMIN_SYNC_TOKEN
});

const store = createStore({
  onPublicStateChanged: (payload) => {
    publicSync.enqueueSync(payload);
  }
});
const meshtasticService = createMeshtasticService({ store });
const apiHandler = createApiHandler({ store, meshtasticService });
const dashboardHandler = createDashboardHandler();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await apiHandler(req, res, url);
      return;
    }

    await dashboardHandler(req, res, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }
});

function openBrowser(url) {
  if (process.env.NO_OPEN_BROWSER === "1") {
    return;
  }

  const platform = process.platform;
  if (platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return;
  }

  if (platform === "darwin") {
    const child = spawn("open", [url], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [url], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  store.appendLog("system", `MESHCITY dashboard started on ${url}`);
  meshtasticService.restoreConnectionFromSavedState();
  publicSync.enqueueSync({
    world: store.getWorld(),
    players: store.getPlayers(),
    logs: store.getLogs()
  });
  setInterval(() => {
    publicSync.enqueueSync({});
  }, PUBLIC_SYNC_HEARTBEAT_MS);
  openBrowser(url);
});
