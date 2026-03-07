const http = require("http");
const { spawn } = require("child_process");
const { URL } = require("url");
const { createApiHandler } = require("./src/api");
const { createDashboardHandler } = require("./src/dashboard");
const { createMeshtasticService } = require("./src/meshtasticService");
const { createStore } = require("./src/store");

const PORT = Number(process.env.PORT || 3000);

const store = createStore();
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
  openBrowser(url);
});
