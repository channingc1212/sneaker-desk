import { getConfig } from "../config.mjs";
import { getAuthToken, getShoe, getShoes, saveAuthToken, saveShoe } from "../db.mjs";

const SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];

function endpoints() {
  const { env } = getConfig().ebay;
  const sandbox = env === "sandbox";
  return {
    auth: sandbox ? "https://auth.sandbox.ebay.com/oauth2/authorize" : "https://auth.ebay.com/oauth2/authorize",
    api: sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com",
  };
}

function basicAuth() {
  const { clientId, clientSecret } = getConfig().ebay;
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function missingConfig() {
  const { clientId, clientSecret, ruName } = getConfig().ebay;
  return [
    ["EBAY_CLIENT_ID", clientId],
    ["EBAY_CLIENT_SECRET", clientSecret],
    ["EBAY_RUNAME", ruName],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function tokenExpiresAt(expiresInSeconds) {
  return new Date(Date.now() + Number(expiresInSeconds || 0) * 1000).toISOString();
}

export function getEbayStatus() {
  const config = getConfig().ebay;
  const token = getAuthToken("eBay");
  const missing = missingConfig();
  return {
    configured: missing.length === 0,
    missing,
    env: config.env,
    marketplaceId: config.marketplaceId,
    hasToken: Boolean(token?.refreshToken || token?.accessToken),
    accessTokenExpiresAt: token?.expiresAt || "",
    policiesConfigured: Boolean(
      config.locationKey &&
        config.fulfillmentPolicyId &&
        config.paymentPolicyId &&
        config.returnPolicyId,
    ),
    scopes: SCOPES,
  };
}

export function getEbayAuthUrl(state = "sneaker-desk") {
  const missing = missingConfig();
  if (missing.length) {
    return { error: `Missing ${missing.join(", ")}` };
  }

  const { ruName } = getConfig().ebay;
  const url = new URL(endpoints().auth);
  url.searchParams.set("client_id", getConfig().ebay.clientId);
  url.searchParams.set("redirect_uri", ruName);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  return { url: url.toString() };
}

export async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getConfig().ebay.ruName,
  });

  const response = await fetch(`${endpoints().api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(),
    },
    body,
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || "eBay token exchange failed");

  return saveAuthToken("eBay", {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: tokenExpiresAt(payload.expires_in),
  });
}

async function refreshAccessTokenIfNeeded() {
  const token = getAuthToken("eBay");
  if (!token?.refreshToken && !token?.accessToken) throw new Error("eBay is not authorized");

  const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
  if (token.accessToken && expiresAt - Date.now() > 5 * 60 * 1000) return token.accessToken;
  if (!token.refreshToken) return token.accessToken;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    scope: SCOPES.join(" "),
  });

  const response = await fetch(`${endpoints().api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(),
    },
    body,
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || "eBay refresh failed");

  saveAuthToken("eBay", {
    accessToken: payload.access_token,
    expiresAt: tokenExpiresAt(payload.expires_in),
  });
  return payload.access_token;
}

async function ebayRequest(path, options = {}) {
  const accessToken = await refreshAccessTokenIfNeeded();
  const response = await fetch(`${endpoints().api}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Language": getConfig().ebay.locale,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = payload?.errors?.[0]?.message || payload?.error_description || payload?.error || response.statusText;
    throw new Error(message);
  }
  return payload;
}

export async function getEbayPolicies() {
  const { marketplaceId } = getConfig().ebay;
  const query = `marketplace_id=${encodeURIComponent(marketplaceId)}`;
  const [fulfillment, payment, returns, locations] = await Promise.all([
    ebayRequest(`/sell/account/v1/fulfillment_policy?${query}`),
    ebayRequest(`/sell/account/v1/payment_policy?${query}`),
    ebayRequest(`/sell/account/v1/return_policy?${query}`),
    ebayRequest("/sell/inventory/v1/location"),
  ]);

  return {
    fulfillmentPolicies: fulfillment.fulfillmentPolicies || [],
    paymentPolicies: payment.paymentPolicies || [],
    returnPolicies: returns.returnPolicies || [],
    locations: locations.locations || [],
  };
}

export async function syncEbay() {
  const policies = await getEbayPolicies();
  const shoes = getShoes();
  return {
    platform: "eBay",
    status: "ok",
    message: `Authorized. Found ${policies.locations.length} locations, ${policies.fulfillmentPolicies.length} fulfillment policies, ${policies.paymentPolicies.length} payment policies, ${policies.returnPolicies.length} return policies. ${shoes.length} local shoes ready for matching.`,
    policies,
  };
}

function sellerSkuFor(shoe) {
  const existing = shoe.platforms.find((platform) => platform.name === "eBay")?.externalProductId;
  if (existing) return existing;
  const base = [shoe.sku, shoe.name, shoe.size].filter(Boolean).join("-") || shoe.id;
  return base
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function ebayCondition(condition) {
  if (condition === "New") return "NEW_WITH_BOX";
  if (condition === "VNDS") return "USED_EXCELLENT";
  if (condition === "Beat") return "USED_ACCEPTABLE";
  return getConfig().ebay.conditionDefault;
}

function ebayPlatform(shoe) {
  return shoe.platforms.find((platform) => platform.name === "eBay");
}

export async function createOrUpdateEbayInventoryItem(shoeId) {
  const shoe = getShoe(shoeId);
  if (!shoe) throw new Error("Shoe not found");

  const eBay = ebayPlatform(shoe);
  const sku = sellerSkuFor(shoe);
  const title = [shoe.name, shoe.size].filter(Boolean).join(" ").slice(0, 80);
  const imageUrls = eBay?.link?.startsWith("http") ? [eBay.link] : [];

  const payload = {
    availability: {
      shipToLocationAvailability: {
        quantity: 1,
      },
    },
    condition: ebayCondition(shoe.condition),
    product: {
      title,
      description: shoe.notes || title,
      aspects: {
        Brand: [shoe.brand || "Unbranded"],
        "US Shoe Size": [shoe.size || "Unknown"],
        Style: [shoe.name || "Basketball Shoe"],
      },
      imageUrls,
    },
  };

  await ebayRequest(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  const updated = {
    ...eBay,
    name: "eBay",
    externalProductId: sku,
    status: eBay?.status === "not_listed" ? "draft" : eBay?.status || "draft",
  };
  saveShoe({ ...shoe, platforms: shoe.platforms.map((platform) => (platform.name === "eBay" ? updated : platform)) });

  return { sku, payload };
}

export async function createEbayOffer(shoeId) {
  const config = getConfig().ebay;
  const missing = [
    ["EBAY_LOCATION_KEY", config.locationKey],
    ["EBAY_FULFILLMENT_POLICY_ID", config.fulfillmentPolicyId],
    ["EBAY_PAYMENT_POLICY_ID", config.paymentPolicyId],
    ["EBAY_RETURN_POLICY_ID", config.returnPolicyId],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}`);

  const shoe = getShoe(shoeId);
  if (!shoe) throw new Error("Shoe not found");
  const eBay = ebayPlatform(shoe);
  const sku = eBay?.externalProductId || sellerSkuFor(shoe);
  const price = Number(eBay?.price || shoe.market || shoe.floor || 0);
  if (!price) throw new Error("eBay price is required before creating an offer");

  await createOrUpdateEbayInventoryItem(shoeId);
  const payload = {
    sku,
    marketplaceId: config.marketplaceId,
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId: config.categoryId,
    listingDescription: shoe.notes || shoe.name,
    listingPolicies: {
      fulfillmentPolicyId: config.fulfillmentPolicyId,
      paymentPolicyId: config.paymentPolicyId,
      returnPolicyId: config.returnPolicyId,
    },
    pricingSummary: {
      price: {
        currency: config.currency,
        value: String(price),
      },
    },
    merchantLocationKey: config.locationKey,
  };

  const offer = await ebayRequest("/sell/inventory/v1/offer", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const updated = {
    ...eBay,
    name: "eBay",
    externalProductId: sku,
    externalListingId: offer.offerId || eBay?.externalListingId || "",
    status: "draft",
  };
  saveShoe({ ...shoe, platforms: shoe.platforms.map((platform) => (platform.name === "eBay" ? updated : platform)) });

  return { offer, payload };
}
