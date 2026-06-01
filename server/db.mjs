import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "sneaker-desk.sqlite");
const PLATFORMS = ["eBay", "Facebook", "StockX", "Local"];
const DEFAULT_FEES = { eBay: 8, Facebook: 0, StockX: 12, Local: 0 };

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS shoes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '',
    sku TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    condition TEXT NOT NULL DEFAULT 'Used',
    cost REAL NOT NULL DEFAULT 0,
    floor REAL NOT NULL DEFAULT 0,
    market REAL NOT NULL DEFAULT 0,
    checked_at TEXT NOT NULL DEFAULT '',
    next_action TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS platform_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shoe_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    external_listing_id TEXT NOT NULL DEFAULT '',
    external_product_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'not_listed',
    price REAL NOT NULL DEFAULT 0,
    fee REAL NOT NULL DEFAULT 0,
    fixed_fee REAL NOT NULL DEFAULT 0,
    shipping_cost REAL NOT NULL DEFAULT 0,
    link TEXT NOT NULL DEFAULT '',
    last_synced_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (shoe_id, platform),
    FOREIGN KEY (shoe_id) REFERENCES shoes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shoe_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    lowest_ask REAL NOT NULL DEFAULT 0,
    highest_bid REAL NOT NULL DEFAULT 0,
    last_sale REAL NOT NULL DEFAULT 0,
    sold_average REAL NOT NULL DEFAULT 0,
    captured_at TEXT NOT NULL,
    raw_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (shoe_id) REFERENCES shoes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shoe_id TEXT,
    platform TEXT NOT NULL,
    external_order_id TEXT NOT NULL DEFAULT '',
    sold_price REAL NOT NULL DEFAULT 0,
    payout REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '',
    sold_at TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (platform, external_order_id),
    FOREIGN KEY (shoe_id) REFERENCES shoes(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    platform TEXT PRIMARY KEY,
    access_token TEXT NOT NULL DEFAULT '',
    refresh_token TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS archived_tasks (
    task_key TEXT PRIMARY KEY,
    shoe_id TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    archived_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    entity_label TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
`);

const selectShoes = db.prepare("SELECT * FROM shoes ORDER BY updated_at DESC");
const selectPlatforms = db.prepare("SELECT * FROM platform_listings WHERE shoe_id = ? ORDER BY platform");
const selectShoeById = db.prepare("SELECT * FROM shoes WHERE id = ?");
const insertShoe = db.prepare(`
  INSERT INTO shoes (
    id, name, brand, sku, size, condition, cost, floor, market, checked_at,
    next_action, notes, photo, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    brand = excluded.brand,
    sku = excluded.sku,
    size = excluded.size,
    condition = excluded.condition,
    cost = excluded.cost,
    floor = excluded.floor,
    market = excluded.market,
    checked_at = excluded.checked_at,
    next_action = excluded.next_action,
    notes = excluded.notes,
    photo = excluded.photo,
    updated_at = excluded.updated_at
`);
const upsertPlatform = db.prepare(`
  INSERT INTO platform_listings (
    shoe_id, platform, external_listing_id, external_product_id, status, price,
    fee, fixed_fee, shipping_cost, link, last_synced_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(shoe_id, platform) DO UPDATE SET
    external_listing_id = excluded.external_listing_id,
    external_product_id = excluded.external_product_id,
    status = excluded.status,
    price = excluded.price,
    fee = excluded.fee,
    fixed_fee = excluded.fixed_fee,
    shipping_cost = excluded.shipping_cost,
    link = excluded.link,
    last_synced_at = excluded.last_synced_at,
    updated_at = excluded.updated_at
`);
const deletePlatforms = db.prepare("DELETE FROM platform_listings WHERE shoe_id = ?");
const deleteShoe = db.prepare("DELETE FROM shoes WHERE id = ?");
const deleteAllShoes = db.prepare("DELETE FROM shoes");
const insertSyncLog = db.prepare(`
  INSERT INTO sync_logs (platform, action, result, message, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const selectArchivedTasks = db.prepare("SELECT * FROM archived_tasks ORDER BY archived_at DESC");
const upsertArchivedTask = db.prepare(`
  INSERT INTO archived_tasks (task_key, shoe_id, action, archived_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(task_key) DO UPDATE SET
    action = excluded.action,
    archived_at = excluded.archived_at
`);
const selectActivityLogs = db.prepare("SELECT * FROM activity_logs ORDER BY created_at DESC, id DESC LIMIT ?");
const insertActivityLog = db.prepare(`
  INSERT INTO activity_logs (entity_type, entity_id, entity_label, action, summary, details_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const selectAuthToken = db.prepare("SELECT * FROM auth_tokens WHERE platform = ?");
const upsertAuthToken = db.prepare(`
  INSERT INTO auth_tokens (platform, access_token, refresh_token, expires_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(platform) DO UPDATE SET
    access_token = excluded.access_token,
    refresh_token = excluded.refresh_token,
    expires_at = excluded.expires_at,
    updated_at = excluded.updated_at
`);

function now() {
  return new Date().toISOString();
}

function toCamelShoe(row) {
  const platforms = selectPlatforms.all(row.id).map(toCamelPlatform);
  const byName = Object.fromEntries(platforms.map((platform) => [platform.name, platform]));
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    sku: row.sku,
    size: row.size,
    condition: row.condition,
    cost: row.cost,
    floor: row.floor,
    market: row.market,
    checkedAt: row.checked_at,
    nextAction: row.next_action,
    notes: row.notes,
    photo: row.photo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    platforms: PLATFORMS.map((platform) => byName[platform] ?? defaultPlatform(platform)),
  };
}

function toCamelPlatform(row) {
  return {
    name: row.platform,
    externalListingId: row.external_listing_id,
    externalProductId: row.external_product_id,
    status: row.status,
    price: row.price,
    fee: row.fee,
    fixedFee: row.fixed_fee,
    shippingCost: row.shipping_cost,
    link: row.link,
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

function toCamelActivity(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: row.entity_label,
    action: row.action,
    summary: row.summary,
    details: parseJson(row.details_json),
    createdAt: row.created_at,
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function defaultPlatform(platform) {
  return {
    name: platform,
    externalListingId: "",
    externalProductId: "",
    status: "not_listed",
    price: 0,
    fee: DEFAULT_FEES[platform] ?? 0,
    fixedFee: 0,
    shippingCost: 0,
    link: "",
    lastSyncedAt: "",
    updatedAt: now(),
  };
}

function normalizePlatform(platform) {
  return {
    ...defaultPlatform(platform.name),
    ...platform,
    price: Number(platform.price || 0),
    fee: Number(platform.fee ?? DEFAULT_FEES[platform.name] ?? 0),
    fixedFee: Number(platform.fixedFee || 0),
    shippingCost: Number(platform.shippingCost || 0),
  };
}

function shoeLabel(shoe) {
  return shoe?.name || shoe?.sku || shoe?.id || "未命名球鞋";
}

function formatChangeValue(value, kind = "text") {
  if (kind === "money") return value ? `$${Math.round(Number(value)).toLocaleString()}` : "-";
  if (kind === "percent") return value ? `${Number(value)}%` : "-";
  if (kind === "status") {
    return {
      not_listed: "未挂",
      draft: "草稿",
      listed: "已挂",
      offer: "询价",
      sold: "已售",
    }[value] || value || "-";
  }
  return value === undefined || value === null || value === "" ? "-" : String(value);
}

function valuesEqual(before, after, kind = "text") {
  if (kind === "money" || kind === "percent") return Number(before || 0) === Number(after || 0);
  return String(before ?? "") === String(after ?? "");
}

function compareShoeChanges(before, after) {
  if (!before) return [];

  const changes = [];
  const fields = [
    ["name", "鞋名"],
    ["brand", "品牌"],
    ["sku", "货号"],
    ["size", "尺码"],
    ["condition", "状态"],
    ["cost", "购入成本", "money"],
    ["floor", "心理底价", "money"],
    ["market", "最高买家出价", "money"],
    ["checkedAt", "价格检查日"],
    ["nextAction", "下一步"],
    ["notes", "备注"],
  ];

  for (const [field, label, kind = "text"] of fields) {
    if (valuesEqual(before[field], after[field], kind)) continue;
    changes.push({
      field,
      label,
      before: before[field] ?? "",
      after: after[field] ?? "",
      summary: `${label} ${formatChangeValue(before[field], kind)} -> ${formatChangeValue(after[field], kind)}`,
    });
  }

  if ((before.photo || "") !== (after.photo || "")) {
    changes.push({ field: "photo", label: "照片", before: "old", after: "new", summary: "照片已更新" });
  }

  const beforePlatforms = Object.fromEntries((before.platforms || []).map((platform) => [platform.name, platform]));
  const afterPlatforms = Object.fromEntries((after.platforms || []).map((platform) => [platform.name, platform]));
  const platformFields = [
    ["status", "状态", "status"],
    ["price", "价格", "money"],
    ["fee", "费用 %", "percent"],
    ["fixedFee", "固定费", "money"],
    ["shippingCost", "运费成本", "money"],
    ["link", "链接"],
    ["externalListingId", "Listing ID"],
    ["externalProductId", "Product ID"],
  ];

  for (const platformName of PLATFORMS) {
    const beforePlatform = beforePlatforms[platformName] || defaultPlatform(platformName);
    const afterPlatform = afterPlatforms[platformName] || defaultPlatform(platformName);
    for (const [field, label, kind = "text"] of platformFields) {
      if (valuesEqual(beforePlatform[field], afterPlatform[field], kind)) continue;
      changes.push({
        field: `platforms.${platformName}.${field}`,
        label: `${platformName} ${label}`,
        before: beforePlatform[field] ?? "",
        after: afterPlatform[field] ?? "",
        summary: `${platformName} ${label} ${formatChangeValue(beforePlatform[field], kind)} -> ${formatChangeValue(afterPlatform[field], kind)}`,
      });
    }
  }

  return changes;
}

export function logActivity({ entityType = "system", entityId = "", entityLabel = "", action, summary, details = {} }) {
  insertActivityLog.run(
    entityType,
    entityId,
    entityLabel,
    action || "",
    summary || "",
    JSON.stringify(details || {}),
    now(),
  );
}

export function getShoes() {
  return selectShoes.all().map(toCamelShoe);
}

export function getShoe(id) {
  const row = selectShoeById.get(id);
  return row ? toCamelShoe(row) : null;
}

export function getActivityLogs(limit = 80) {
  return selectActivityLogs.all(Math.max(1, Math.min(Number(limit || 80), 200))).map(toCamelActivity);
}

export function saveShoe(shoe, options = {}) {
  const previous = shoe.id ? getShoe(shoe.id) : null;
  const timestamp = now();
  const id = shoe.id || crypto.randomUUID();
  const createdAt = shoe.createdAt || timestamp;
  const updatedAt = timestamp;
  const platforms = PLATFORMS.map((platform) => {
    const existing = (shoe.platforms || []).find((item) => item.name === platform);
    return normalizePlatform(existing ?? defaultPlatform(platform));
  });

  db.exec("BEGIN");
  try {
    insertShoe.run(
      id,
      shoe.name || "",
      shoe.brand || "",
      shoe.sku || "",
      shoe.size || "",
      shoe.condition || "Used",
      Number(shoe.cost || 0),
      Number(shoe.floor || 0),
      Number(shoe.market || 0),
      shoe.checkedAt || "",
      shoe.nextAction || "",
      shoe.notes || "",
      shoe.photo || "",
      createdAt,
      updatedAt,
    );

    for (const platform of platforms) {
      upsertPlatform.run(
        id,
        platform.name,
        platform.externalListingId || "",
        platform.externalProductId || "",
        platform.status || "not_listed",
        Number(platform.price || 0),
        Number(platform.fee || 0),
        Number(platform.fixedFee || 0),
        Number(platform.shippingCost || 0),
        platform.link || "",
        platform.lastSyncedAt || "",
        updatedAt,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const saved = getShoe(id);
  if (options.log !== false) {
    if (!previous) {
      logActivity({
        entityType: "shoe",
        entityId: id,
        entityLabel: shoeLabel(saved),
        action: "created",
        summary: `新增球鞋: ${shoeLabel(saved)}`,
        details: { shoe: saved },
      });
    } else {
      const changes = compareShoeChanges(previous, saved);
      if (changes.length) {
        const preview = changes.slice(0, 3).map((change) => change.summary).join("; ");
        const suffix = changes.length > 3 ? ` 等 ${changes.length} 项` : "";
        logActivity({
          entityType: "shoe",
          entityId: id,
          entityLabel: shoeLabel(saved),
          action: "updated",
          summary: `更新球鞋: ${shoeLabel(saved)} - ${preview}${suffix}`,
          details: { changes },
        });
      }
    }
  }

  return saved;
}

export function removeShoe(id) {
  const existing = getShoe(id);
  if (!existing) return false;
  deletePlatforms.run(id);
  deleteShoe.run(id);
  logActivity({
    entityType: "shoe",
    entityId: id,
    entityLabel: shoeLabel(existing),
    action: "deleted",
    summary: `删除球鞋: ${shoeLabel(existing)}`,
    details: { shoe: existing },
  });
  return true;
}

export function replaceShoes(shoes) {
  db.exec("BEGIN");
  try {
    deleteAllShoes.run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  for (const shoe of shoes) saveShoe(shoe, { log: false });
  const saved = getShoes();
  logActivity({
    entityType: "system",
    action: "imported",
    summary: `导入/替换库存: ${saved.length} 双球鞋`,
    details: { count: saved.length },
  });
  return saved;
}

export function logSync(platform, action, result, message = "") {
  insertSyncLog.run(platform, action, result, message, now());
  logActivity({
    entityType: "platform",
    entityId: platform,
    entityLabel: platform,
    action: `sync_${result}`,
    summary: `${platform} ${action}: ${message || result}`,
    details: { platform, action, result, message },
  });
}

export function getArchivedTasks() {
  return selectArchivedTasks.all().map((row) => ({
    taskKey: row.task_key,
    shoeId: row.shoe_id,
    action: row.action,
    archivedAt: row.archived_at,
  }));
}

export function archiveTask(task) {
  upsertArchivedTask.run(task.taskKey, task.shoeId || "", task.action || "done", now());
  const shoe = task.shoeId ? getShoe(task.shoeId) : null;
  const actionLabel = task.action === "ignored" ? "忽略" : "完成";
  logActivity({
    entityType: "task",
    entityId: task.taskKey || "",
    entityLabel: shoeLabel(shoe),
    action: task.action || "done",
    summary: `${actionLabel}待办: ${shoeLabel(shoe)} (${task.taskKey || "task"})`,
    details: { taskKey: task.taskKey, shoeId: task.shoeId || "", action: task.action || "done" },
  });
  return { archived: true };
}

export function getAuthToken(platform) {
  const row = selectAuthToken.get(platform);
  if (!row) return null;
  return {
    platform: row.platform,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export function saveAuthToken(platform, token) {
  const existing = getAuthToken(platform);
  upsertAuthToken.run(
    platform,
    token.accessToken || existing?.accessToken || "",
    token.refreshToken || existing?.refreshToken || "",
    token.expiresAt || existing?.expiresAt || "",
    now(),
  );
  logActivity({
    entityType: "platform",
    entityId: platform,
    entityLabel: platform,
    action: "auth_updated",
    summary: `${platform} 授权信息已更新`,
    details: { platform, hasRefreshToken: Boolean(token.refreshToken || existing?.refreshToken) },
  });
  return getAuthToken(platform);
}

export { DB_PATH, PLATFORMS, DEFAULT_FEES };
