import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import {
  archiveTask,
  getActivityLogs,
  getShoes,
  getArchivedTasks,
  removeShoe,
  replaceShoes,
  saveShoe,
} from "./server/db.mjs";

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = process.cwd();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/shoes") {
    sendJson(res, 200, getShoes());
    return;
  }

  if (req.method === "GET" && pathname === "/api/tasks/archived") {
    sendJson(res, 200, getArchivedTasks());
    return;
  }

  if (req.method === "GET" && pathname === "/api/activity") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    sendJson(res, 200, getActivityLogs(url.searchParams.get("limit")));
    return;
  }

  if (req.method === "POST" && pathname === "/api/tasks/archive") {
    sendJson(res, 200, archiveTask(await readJson(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/shoes") {
    sendJson(res, 201, saveShoe(await readJson(req)));
    return;
  }

  const shoeMatch = pathname.match(/^\/api\/shoes\/([^/]+)$/);
  if (shoeMatch && req.method === "PUT") {
    sendJson(res, 200, saveShoe({ ...(await readJson(req)), id: decodeURIComponent(shoeMatch[1]) }));
    return;
  }

  if (shoeMatch && req.method === "DELETE") {
    const deleted = removeShoe(decodeURIComponent(shoeMatch[1]));
    sendJson(res, deleted ? 200 : 404, { deleted });
    return;
  }

  if (req.method === "POST" && pathname === "/api/import") {
    const body = await readJson(req);
    const shoes = Array.isArray(body) ? body : body.shoes;
    if (!Array.isArray(shoes)) {
      sendJson(res, 400, { error: "Expected an array of shoes" });
      return;
    }
    sendJson(res, 200, replaceShoes(shoes));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function serveStatic(req, res, pathname) {
  const safePath = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT, safePath);
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Sneaker Desk running at http://${HOST}:${PORT}`);
});
