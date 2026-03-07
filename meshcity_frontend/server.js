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

const PORT = Number(process.env.PORT || 4200);
const HOST = String(process.env.HOST || "0.0.0.0");
const BACKEND_URL = String(process.env.BACKEND_URL || "http://localhost:4100").replace(/\/+$/, "");
const PUBLIC_DIR = path.join(process.cwd(), "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

function serveFile(res, filePath) {
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  res.end(fs.readFileSync(filePath));
}

function resolveBackendUrl(req) {
  const configured = BACKEND_URL;
  const requestHost = String(req.headers.host || "").split(":")[0];
  if (!requestHost || requestHost === "localhost" || requestHost === "127.0.0.1") {
    return configured;
  }

  try {
    const parsed = new URL(configured);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      parsed.hostname = requestHost;
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch (error) {
    return configured;
  }

  return configured;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/config.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache"
    });
    const runtimeBackendUrl = resolveBackendUrl(req);
    res.end(`window.MESHCITY_CONFIG = { BACKEND_URL: ${JSON.stringify(runtimeBackendUrl)} };`);
    return;
  }

  const targetPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(targetPath).replace(/^([.][.][/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);
  serveFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`[meshcity_frontend] listening on http://${HOST}:${PORT}`);
  console.log(`[meshcity_frontend] backend: ${BACKEND_URL}`);
});
