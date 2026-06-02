import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import {
  archiveTask,
  getActivityLogs,
  getShoes,
  getArchivedTasks,
  logSync,
  removeShoe,
  replaceShoes,
  saveShoe,
} from "./server/db.mjs";
import {
  createEbayOffer,
  createOrUpdateEbayInventoryItem,
  exchangeCodeForToken,
  getEbayAuthUrl,
  getEbayPolicies,
  getEbayStatus,
  syncEbay,
} from "./server/adapters/ebay.mjs";
import { syncGoat } from "./server/adapters/goat.mjs";
import { syncStockX } from "./server/adapters/stockx.mjs";
import { handleEbayAccountDeletion } from "./server/ebayAccountDeletion.mjs";

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

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const privacyPolicyHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CC Sneaker Platform Privacy Policy</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; line-height: 1.6; color: #18211f; }
      h1 { line-height: 1.15; }
    </style>
  </head>
  <body>
    <h1>CC Sneaker Platform Privacy Policy</h1>
    <p>CC Sneaker Platform is a personal inventory tool used by its owner to manage sneaker listings and resale workflow.</p>
    <p>The production application stores inventory and listing workflow data locally on the owner's computer. This public endpoint is used for eBay developer compliance and OAuth redirect relay only.</p>
    <p>Marketplace account deletion notifications from eBay are acknowledged by the compliance endpoint. If eBay user data is stored in local records, the owner is responsible for deleting applicable local records when required.</p>
    <p>Contact: chicheng@outlook.com</p>
  </body>
</html>`;

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

  if (req.method === "GET" && pathname === "/api/ebay/status") {
    sendJson(res, 200, getEbayStatus());
    return;
  }

  if (pathname === "/api/ebay/account-deletion") {
    await handleEbayAccountDeletion(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/ebay/auth-url") {
    sendJson(res, 200, getEbayAuthUrl());
    return;
  }

  if (req.method === "GET" && pathname === "/api/ebay/auth/start") {
    const result = getEbayAuthUrl();
    if (result.error) {
      sendJson(res, 400, result);
      return;
    }
    res.writeHead(302, { Location: result.url });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/ebay/oauth/callback") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.searchParams.get("error")) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>eBay authorization declined</h1><p>${url.searchParams.get("error_description") || ""}</p>`);
      return;
    }
    await exchangeCodeForToken(url.searchParams.get("code"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>eBay connected</h1><p>You can close this tab and return to Sneaker Desk.</p><p><a href="/">Back to Sneaker Desk</a></p>`);
    return;
  }

  if (req.method === "GET" && pathname === "/api/ebay/oauth/relay") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const localCallback = new URL("http://127.0.0.1:5173/api/ebay/oauth/callback");
    for (const [key, value] of url.searchParams.entries()) {
      localCallback.searchParams.append(key, value);
    }
    redirect(res, localCallback.toString());
    return;
  }

  if (req.method === "GET" && pathname === "/api/ebay/policies") {
    sendJson(res, 200, await getEbayPolicies());
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

  const ebayInventoryMatch = pathname.match(/^\/api\/ebay\/shoes\/([^/]+)\/inventory-item$/);
  if (ebayInventoryMatch && req.method === "POST") {
    sendJson(res, 200, await createOrUpdateEbayInventoryItem(decodeURIComponent(ebayInventoryMatch[1])));
    return;
  }

  const ebayOfferMatch = pathname.match(/^\/api\/ebay\/shoes\/([^/]+)\/offer$/);
  if (ebayOfferMatch && req.method === "POST") {
    sendJson(res, 200, await createEbayOffer(decodeURIComponent(ebayOfferMatch[1])));
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

  if (req.method === "POST" && pathname.startsWith("/api/sync/")) {
    const platform = pathname.split("/").pop();
    const adapters = { ebay: syncEbay, stockx: syncStockX, goat: syncGoat };
    const adapter = adapters[platform];
    if (!adapter) {
      sendJson(res, 404, { error: "Unknown sync platform" });
      return;
    }
    const result = await adapter();
    logSync(result.platform, "sync", result.status, result.message);
    sendJson(res, 200, result);
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
    if (req.method === "GET" && url.pathname === "/privacy") {
      sendHtml(res, 200, privacyPolicyHtml);
      return;
    }
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
