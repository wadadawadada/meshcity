const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(process.cwd(), "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function createDashboardHandler() {
  return async (req, res, url) => {
    let targetPath = url.pathname === "/" ? "/index.html" : url.pathname;
    targetPath = path.normalize(targetPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, targetPath);

    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[extension] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(fs.readFileSync(filePath));
  };
}

module.exports = {
  createDashboardHandler
};
