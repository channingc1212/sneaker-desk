import { createHash, randomUUID } from "node:crypto";
import { getConfig } from "./config.mjs";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function endpointFromRequest(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = req.headers["x-forwarded-proto"] || (host.startsWith("127.0.0.1") ? "http" : "https");
  const path = new URL(req.url, `${proto}://${host}`).pathname;
  return `${proto}://${host}${path}`;
}

export function getAccountDeletionConfig(req) {
  const config = getConfig().ebay;
  return {
    endpoint: config.accountDeletionEndpoint || endpointFromRequest(req),
    verificationToken: config.accountDeletionVerificationToken,
  };
}

export function createVerificationToken() {
  return `cc_sneaker_${randomUUID().replaceAll("-", "")}_${randomUUID().slice(0, 8)}`;
}

export function challengeResponse({ challengeCode, verificationToken, endpoint }) {
  return createHash("sha256").update(`${challengeCode}${verificationToken}${endpoint}`, "utf8").digest("hex");
}

export async function handleEbayAccountDeletion(req, res) {
  const config = getAccountDeletionConfig(req);

  if (!config.verificationToken) {
    json(res, 500, { error: "Missing EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN" });
    return;
  }

  if (req.method === "GET") {
    const url = new URL(req.url, config.endpoint);
    const challengeCode = url.searchParams.get("challenge_code");
    if (!challengeCode) {
      json(res, 400, { error: "Missing challenge_code" });
      return;
    }

    json(res, 200, {
      challengeResponse: challengeResponse({
        challengeCode,
        verificationToken: config.verificationToken,
        endpoint: config.endpoint,
      }),
    });
    return;
  }

  if (req.method === "POST") {
    // eBay requires immediate acknowledgement. The local app does not store
    // third-party buyer profile data outside user-entered listing/order records.
    json(res, 200, { received: true });
    return;
  }

  json(res, 405, { error: "Method not allowed" });
}
