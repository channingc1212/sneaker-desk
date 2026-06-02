const STORAGE_KEY = "sneaker-desk-v1";
const SAMPLE_PHOTO = "./assets/sample-sneaker.png";
const PLATFORMS = ["eBay", "Facebook", "StockX", "Local"];
const DEFAULT_FEES = {
  eBay: 8,
  Facebook: 0,
  StockX: 12,
  Local: 0,
};
const DEFAULT_FIXED_FEES = {
  eBay: 0,
  Facebook: 0,
  StockX: 0,
  Local: 0,
};
const DEFAULT_SHIPPING_COSTS = {
  eBay: 0,
  Facebook: 0,
  StockX: 0,
  Local: 0,
};

const statusLabels = {
  draft: "未整理",
  photo: "待拍照",
  listed: "已挂牌",
  offer: "有询价",
  sold: "已售出",
};

const platformStatusLabels = {
  not_listed: "未挂",
  draft: "草稿",
  listed: "已挂",
  offer: "询价",
  sold: "已售",
};

const ACTIVE_PRICE_STATUSES = ["draft", "listed", "offer"];

let shoes = [];
let archivedTaskKeys = new Set();
let activityLogs = [];
let editingId = null;
let currentView = "inventory";
let density = "grid";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const elements = {
  searchInput: $("#searchInput"),
  statusFilter: $("#statusFilter"),
  platformFilter: $("#platformFilter"),
  sortSelect: $("#sortSelect"),
  inventoryGrid: $("#inventoryGrid"),
  inventoryTable: $("#inventoryTable"),
  inventoryTableBody: $("#inventoryTableBody"),
  emptyState: $("#emptyState"),
  drawer: $("#shoeDrawer"),
  drawerBackdrop: $("#drawerBackdrop"),
  shoeForm: $("#shoeForm"),
  drawerTitle: $("#drawerTitle"),
  platformRows: $("#platformRows"),
  photoPreview: $("#photoPreview"),
  photoInput: $("#photoInput"),
  importFile: $("#importFile"),
  ebayStatusText: $("#ebayStatusText"),
  ebayConnectButton: $("#ebayConnectButton"),
  ebaySyncButton: $("#ebaySyncButton"),
};

function money(value) {
  const number = Number(value || 0);
  return number > 0 ? `$${Math.round(number).toLocaleString()}` : "-";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `shoe-${Date.now()}`;
}

function normalizePlatform(platform, existing = {}) {
  const hasNetFields = existing.fixedFee !== undefined || existing.shippingCost !== undefined;
  const legacyFee =
    !hasNetFields &&
    ((platform === "eBay" && Number(existing.fee) === 13.25) ||
      (platform === "StockX" && Number(existing.fee) === 9));
  return {
    name: platform,
    status: existing.status || "not_listed",
    price: Number(existing.price || 0),
    fee: Number(legacyFee ? DEFAULT_FEES[platform] : existing.fee ?? DEFAULT_FEES[platform] ?? 0),
    fixedFee: Number(existing.fixedFee ?? DEFAULT_FIXED_FEES[platform] ?? 0),
    shippingCost: Number(existing.shippingCost ?? DEFAULT_SHIPPING_COSTS[platform] ?? 0),
    link: existing.link || "",
  };
}

function normalizeShoe(shoe) {
  const byName = Object.fromEntries((shoe.platforms || []).map((item) => [item.name, item]));
  return {
    id: shoe.id || uid(),
    name: shoe.name || "",
    brand: shoe.brand || "",
    sku: shoe.sku || "",
    size: shoe.size || "",
    condition: shoe.condition || "Used",
    cost: Number(shoe.cost || 0),
    floor: Number(shoe.floor || 0),
    market: Number(shoe.market || 0),
    checkedAt: shoe.checkedAt || todayISO(),
    nextAction: shoe.nextAction || "",
    notes: shoe.notes || "",
    photo: shoe.photo || SAMPLE_PHOTO,
    updatedAt: shoe.updatedAt || new Date().toISOString(),
    platforms: PLATFORMS.map((platform) => normalizePlatform(platform, byName[platform])),
  };
}

function getListedPlatforms(shoe) {
  return shoe.platforms.filter((item) => ["listed", "offer", "sold"].includes(item.status));
}

function getLivePrices(shoe) {
  return shoe.platforms
    .filter((item) => ACTIVE_PRICE_STATUSES.includes(item.status) && item.price > 0)
    .map((item) => item.price);
}

function getMinAsk(shoe) {
  const prices = getLivePrices(shoe).filter((price) => price > 0);
  return prices.length ? Math.min(...prices) : 0;
}

function getMaxAsk(shoe) {
  const prices = getLivePrices(shoe).filter((price) => price > 0);
  return prices.length ? Math.max(...prices) : 0;
}

function getBestNet(shoe) {
  return shoe.platforms.reduce((best, platform) => {
    if (!ACTIVE_PRICE_STATUSES.includes(platform.status) || !platform.price) return best;
    const net = getPlatformNet(platform);
    return net > best.net ? { platform: platform.name, net, price: platform.price } : best;
  }, { platform: "-", net: 0, price: 0 });
}

function getSoldNet(shoe) {
  return shoe.platforms.reduce((sum, platform) => {
    if (platform.status !== "sold" || !platform.price) return sum;
    return sum + getPlatformNet(platform);
  }, 0);
}

function getPlatformNet(platform) {
  const price = Number(platform.price || 0);
  const percentFee = price * (Number(platform.fee || 0) / 100);
  return Math.max(0, price - percentFee - Number(platform.fixedFee || 0) - Number(platform.shippingCost || 0));
}

function getStatus(shoe) {
  if (shoe.platforms.some((item) => item.status === "sold")) return "sold";
  if (shoe.platforms.some((item) => item.status === "offer")) return "offer";
  if (shoe.platforms.some((item) => item.status === "listed")) return "listed";
  if (!shoe.photo || shoe.photo === SAMPLE_PHOTO) return "photo";
  return "draft";
}

function getGap(shoe) {
  const minAsk = getMinAsk(shoe);
  if (!minAsk || !shoe.market) return 0;
  return Math.round(minAsk - shoe.market);
}

function getFilteredShoes() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const status = elements.statusFilter.value;
  const platform = elements.platformFilter.value;

  return shoes
    .filter((shoe) => {
      const haystack = [
        shoe.name,
        shoe.brand,
        shoe.sku,
        shoe.size,
        shoe.condition,
        shoe.notes,
        ...shoe.platforms.map((item) => `${item.name} ${item.link}`),
      ].join(" ").toLowerCase();

      const matchesQuery = !query || haystack.includes(query);
      const matchesStatus = status === "all" || getStatus(shoe) === status;
      const matchesPlatform =
        platform === "all" ||
        shoe.platforms.some((item) => item.name === platform && item.status !== "not_listed");

      return matchesQuery && matchesStatus && matchesPlatform;
    })
    .sort((a, b) => {
      switch (elements.sortSelect.value) {
        case "askDesc":
          return getMaxAsk(b) - getMaxAsk(a);
        case "gapDesc":
          return Math.abs(getGap(b)) - Math.abs(getGap(a));
        case "nameAsc":
          return a.name.localeCompare(b.name);
        default:
          return new Date(b.updatedAt) - new Date(a.updatedAt);
      }
    });
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  return response.json();
}

async function loadLegacyShoes() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return stored.map(normalizeShoe);
  } catch {
    return [];
  }
}

async function load() {
  shoes = (await apiRequest("/api/shoes")).map(normalizeShoe);
  archivedTaskKeys = new Set((await apiRequest("/api/tasks/archived")).map((task) => task.taskKey));
  activityLogs = await apiRequest("/api/activity?limit=80");
  if (!shoes.length) {
    const legacyShoes = await loadLegacyShoes();
    if (legacyShoes.length) {
      shoes = (await apiRequest("/api/import", {
        method: "POST",
        body: JSON.stringify(legacyShoes),
      })).map(normalizeShoe);
      localStorage.removeItem(STORAGE_KEY);
    }
  }
}

async function refreshActivity() {
  activityLogs = await apiRequest("/api/activity?limit=80");
}

async function saveShoeToApi(shoe) {
  const method = shoes.some((item) => item.id === shoe.id) ? "PUT" : "POST";
  const path = method === "PUT" ? `/api/shoes/${encodeURIComponent(shoe.id)}` : "/api/shoes";
  return normalizeShoe(await apiRequest(path, { method, body: JSON.stringify(shoe) }));
}

async function deleteShoeFromApi(id) {
  await apiRequest(`/api/shoes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function replaceShoesViaApi(nextShoes) {
  return (await apiRequest("/api/import", {
    method: "POST",
    body: JSON.stringify(nextShoes),
  })).map(normalizeShoe);
}

async function loadEbayStatus() {
  try {
    const status = await apiRequest("/api/ebay/status");
    if (!status.configured) {
      elements.ebayStatusText.textContent = "API 待配置，可先手动录入 eBay 状态";
      elements.ebayStatusText.title = `缺配置: ${status.missing.join(", ")}`;
      elements.ebayConnectButton.disabled = true;
      elements.ebaySyncButton.disabled = true;
      return;
    }
    elements.ebayConnectButton.disabled = false;
    elements.ebaySyncButton.disabled = !status.hasToken;
    const tokenText = status.hasToken ? "已授权" : "未授权";
    const policyText = status.policiesConfigured ? "可创建 offer" : "缺 policies";
    elements.ebayStatusText.textContent = `${status.env} / ${tokenText} / ${policyText}`;
    elements.ebayStatusText.title = "";
  } catch {
    elements.ebayStatusText.textContent = "eBay 状态读取失败";
    elements.ebayConnectButton.disabled = true;
    elements.ebaySyncButton.disabled = true;
  }
}

async function syncEbay() {
  elements.ebaySyncButton.disabled = true;
  elements.ebayStatusText.textContent = "同步中...";
  try {
    const result = await apiRequest("/api/sync/ebay", { method: "POST" });
    elements.ebayStatusText.textContent = result.message || result.status;
    await refreshActivity();
    render();
  } catch (error) {
    elements.ebayStatusText.textContent = `同步失败: ${error.message}`;
  } finally {
    await loadEbayStatus();
  }
}

async function archiveTask(taskKey, shoeId, action) {
  await apiRequest("/api/tasks/archive", {
    method: "POST",
    body: JSON.stringify({ taskKey, shoeId, action }),
  });
  archivedTaskKeys.add(taskKey);
  await refreshActivity();
  render();
}

async function seedData() {
  const now = new Date().toISOString();
  const seeded = [
    normalizeShoe({
      name: "Kobe 6 Protro Reverse Grinch",
      brand: "Nike",
      sku: "FV4921-600",
      size: "US 10.5",
      condition: "VNDS",
      cost: 210,
      floor: 285,
      market: 330,
      checkedAt: todayISO(),
      nextAction: "补外底和鞋盒标照片，Facebook 可先试 $340",
      notes: "鞋盒完整，鞋面状态好。eBay sold comps 大概在 310-350 区间。",
      photo: SAMPLE_PHOTO,
      updatedAt: now,
      platforms: [
        { name: "eBay", status: "listed", price: 349, fee: 8, fixedFee: 0, shippingCost: 0, link: "draft / listing URL" },
        { name: "Facebook", status: "draft", price: 340, fee: 0, fixedFee: 0, shippingCost: 0, link: "Marketplace draft" },
        { name: "StockX", status: "not_listed", price: 0, fee: 12, fixedFee: 0, shippingCost: 0, link: "" },
        { name: "Local", status: "not_listed", price: 0, fee: 0, fixedFee: 0, shippingCost: 0, link: "" },
      ],
    }),
    normalizeShoe({
      name: "Jordan 11 Space Jam Low",
      brand: "Jordan",
      sku: "Sample-002",
      size: "US 9",
      condition: "Used",
      cost: 145,
      floor: 185,
      market: 230,
      checkedAt: todayISO(),
      nextAction: "清洁中底，再给 local 店发照片问 cash offer",
      notes: "轻微折痕，适合 local 或 Facebook。",
      photo: SAMPLE_PHOTO,
      updatedAt: now,
      platforms: [
        { name: "eBay", status: "not_listed", price: 0, fee: 8, fixedFee: 0, shippingCost: 0, link: "" },
        { name: "Facebook", status: "listed", price: 245, fee: 0, fixedFee: 0, shippingCost: 0, link: "Marketplace URL" },
        { name: "StockX", status: "not_listed", price: 0, fee: 12, fixedFee: 0, shippingCost: 0, link: "" },
        { name: "Local", status: "offer", price: 190, fee: 0, fixedFee: 0, shippingCost: 0, link: "Store A" },
      ],
    }),
  ];
  shoes = await replaceShoesViaApi(seeded);
  await refreshActivity();
  render();
}

function renderMetrics() {
  const listed = shoes.filter((shoe) => getListedPlatforms(shoe).length > 0 && getStatus(shoe) !== "sold");
  const unsold = shoes.filter((shoe) => getStatus(shoe) !== "sold");
  const askTotal = unsold.reduce((sum, shoe) => sum + getMaxAsk(shoe), 0);
  const projectedNet = unsold.reduce((sum, shoe) => sum + getBestNet(shoe).net, 0);
  const soldNet = shoes.reduce((sum, shoe) => sum + getSoldNet(shoe), 0);
  const todos = getActions();

  $("#metricInventory").textContent = shoes.length;
  $("#metricListed").textContent = listed.length;
  $("#metricAsk").textContent = money(askTotal);
  $("#metricProjectedNet").textContent = money(projectedNet);
  $("#metricSoldNet").textContent = money(soldNet);
  $("#metricTodo").textContent = todos.length;
  $("#navInventoryCount").textContent = shoes.length;
  $("#navActionCount").textContent = todos.length;
  $("#navPricingCount").textContent = shoes.filter((shoe) => getMinAsk(shoe) && shoe.market).length;
  $("#navActivityCount").textContent = activityLogs.length;
}

function renderInventory() {
  const filtered = getFilteredShoes();
  elements.inventoryGrid.innerHTML = filtered.map(renderShoeCard).join("");
  elements.inventoryTableBody.innerHTML = filtered.map(renderTableRow).join("");

  elements.emptyState.hidden = filtered.length > 0;
  elements.inventoryGrid.hidden = density !== "grid" || filtered.length === 0;
  elements.inventoryTable.hidden = density !== "table" || filtered.length === 0;

  $$("[data-edit-id]").forEach((button) => {
    button.addEventListener("click", () => openDrawer(button.dataset.editId));
  });
}

function renderShoeCard(shoe) {
  const status = getStatus(shoe);
  const gap = getGap(shoe);
  const bestNet = getBestNet(shoe);
  const platforms = shoe.platforms
    .map((item) => {
      const live = item.status !== "not_listed" ? "live" : "";
      const price = item.price ? ` ${money(item.price)}` : "";
      return `<span class="platform-pill ${live}">${item.name}${price}</span>`;
    })
    .join("");

  return `
    <article class="shoe-card">
      <button type="button" data-edit-id="${shoe.id}" title="Edit ${escapeHtml(shoe.name)}">
        <img class="shoe-photo" src="${shoe.photo || SAMPLE_PHOTO}" alt="${escapeHtml(shoe.name)}" />
        <div class="shoe-card-body">
          <div class="shoe-title-row">
            <h3>${escapeHtml(shoe.name || "未命名球鞋")}</h3>
            <span class="status-pill ${status}">${statusLabels[status]}</span>
          </div>
          <div class="shoe-meta">
            <span>${escapeHtml(shoe.size || "-")}</span>
            <span>${escapeHtml(shoe.condition || "-")}</span>
            <span>${escapeHtml(shoe.sku || "无货号")}</span>
          </div>
          <div class="platform-strip">${platforms}</div>
          <div class="price-row">
            <div class="price-cell"><span>最低挂牌</span><strong>${money(getMinAsk(shoe))}</strong></div>
            <div class="price-cell"><span>最高出价</span><strong>${money(shoe.market)}</strong></div>
            <div class="price-cell"><span>最好净收</span><strong>${bestNet.net ? money(bestNet.net) : "-"}</strong></div>
          </div>
          <div class="next-action">${escapeHtml(shoe.nextAction || `价差 ${gap >= 0 ? "+" : ""}${money(Math.abs(gap))}`)}</div>
        </div>
      </button>
    </article>
  `;
}

function renderTableRow(shoe) {
  const status = getStatus(shoe);
  const gap = getGap(shoe);
  const gapText = gap ? `${gap > 0 ? "+" : "-"}${money(Math.abs(gap))}` : "-";
  return `
    <tr>
      <td>
        <button class="table-shoe ghost-row" type="button" data-edit-id="${shoe.id}">
          <img src="${shoe.photo || SAMPLE_PHOTO}" alt="" />
          <span><strong>${escapeHtml(shoe.name || "未命名球鞋")}</strong><br />${escapeHtml(shoe.sku || "")}</span>
        </button>
      </td>
      <td><span class="status-pill ${status}">${statusLabels[status]}</span></td>
      <td>${escapeHtml(shoe.size || "-")}</td>
      <td>${money(getMinAsk(shoe))}</td>
      <td>${money(shoe.market)}</td>
      <td>${gapText}</td>
      <td>${escapeHtml(shoe.nextAction || "-")}</td>
    </tr>
  `;
}

function getActions() {
  const tasks = [];
  shoes.forEach((shoe) => {
    const status = getStatus(shoe);
    const live = getListedPlatforms(shoe).length;
    const staleDays = shoe.checkedAt ? daysSince(shoe.checkedAt) : 999;

    if (status === "photo") {
      tasks.push({ key: `photo:${shoe.id}`, shoe, priority: 1, title: "补照片", detail: "没有真实照片会拖慢所有平台上架。" });
    }
    if (!shoe.nextAction && status !== "sold") {
      tasks.push({ key: `next:${shoe.id}`, shoe, priority: 2, title: "写下一步", detail: "给这双鞋一个明确动作，避免反复打开又关掉。" });
    }
    if (!live && status !== "sold") {
      tasks.push({ key: `platform:${shoe.id}`, shoe, priority: 3, title: "至少挂一个平台", detail: "先挂 Facebook 或 eBay，建立价格锚点。" });
    }
    if (staleDays >= 10 && status !== "sold") {
      tasks.push({ key: `bid-stale:${shoe.id}:${shoe.checkedAt || "none"}`, shoe, priority: 4, title: "更新最高出价", detail: `上次检查是 ${shoe.checkedAt || "未知日期"}。` });
    }
    if (Math.abs(getGap(shoe)) >= 50 && getMinAsk(shoe) && shoe.market) {
      tasks.push({ key: `bid-gap:${shoe.id}:${getMinAsk(shoe)}:${shoe.market}`, shoe, priority: 5, title: "复核 Ask-Bid 差", detail: "你的挂牌价和最高买家出价差距超过 $50。" });
    }
  });

  return tasks
    .filter((task) => !archivedTaskKeys.has(task.key))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 20);
}

function renderActions() {
  const actions = getActions();
  $("#actionsList").innerHTML = actions.length
    ? actions
        .map(
          (item) => `
            <article class="action-item">
              <div>
                <h4>${item.title}: ${escapeHtml(item.shoe.name || "未命名球鞋")}</h4>
                <p>${escapeHtml(item.detail)}</p>
              </div>
              <p>${escapeHtml(item.shoe.nextAction || item.shoe.notes || "暂无备注")}</p>
              <div class="task-actions">
                <button class="ghost-button" type="button" data-edit-id="${item.shoe.id}">处理</button>
                <button class="ghost-button" type="button" data-archive-task="${item.key}" data-shoe-id="${item.shoe.id}" data-task-action="done">完成</button>
                <button class="ghost-button" type="button" data-archive-task="${item.key}" data-shoe-id="${item.shoe.id}" data-task-action="ignored">忽略</button>
              </div>
            </article>
          `,
        )
        .join("")
    : `<div class="empty-state"><h3>没有明显待办</h3><p>现在主要可以继续录入下一批球鞋。</p></div>`;

  $$("[data-edit-id]").forEach((button) => {
    button.addEventListener("click", () => openDrawer(button.dataset.editId));
  });
  $$("[data-archive-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await archiveTask(button.dataset.archiveTask, button.dataset.shoeId, button.dataset.taskAction);
      } catch {
        alert("归档失败：本地后端没有响应。");
      }
    });
  });
}

function renderPricing() {
  const rows = shoes
    .filter((shoe) => getMinAsk(shoe) || shoe.market)
    .sort((a, b) => Math.abs(getGap(b)) - Math.abs(getGap(a)));

  $("#pricingBoard").innerHTML = rows.length
    ? rows
        .map((shoe) => {
          const gap = getGap(shoe);
          const min = getMinAsk(shoe);
          const signalClass = Math.abs(gap) >= 50 ? "signal hot" : "signal";
          const signalText = !min
            ? "未挂牌"
            : !shoe.market
              ? "缺 bid"
              : gap >= 100
                ? "差距大"
                : gap >= 50
                  ? "有价差"
                  : "接近";
          return `
            <article class="pricing-item">
              <div>
                <h4>${escapeHtml(shoe.name || "未命名球鞋")}</h4>
                <p>${escapeHtml(shoe.size || "-")} / ${escapeHtml(shoe.condition || "-")} / checked ${escapeHtml(shoe.checkedAt || "-")}</p>
              </div>
              <p>你的 Ask ${money(min)}，最高买家出价 ${money(shoe.market)}，Ask-Bid 差 ${gap ? money(gap) : "-"}</p>
              <span class="${signalClass}">${signalText}</span>
            </article>
          `;
        })
        .join("")
    : `<div class="empty-state"><h3>还没有价格数据</h3><p>填你的 Ask 和最高买家出价，这里就会显示差距。</p></div>`;
}

function renderActivity() {
  $("#activityList").innerHTML = activityLogs.length
    ? activityLogs.map(renderActivityItem).join("")
    : `<div class="empty-state"><h3>还没有活动记录</h3><p>新增或修改球鞋后，这里会自动留下记录。</p></div>`;
}

function renderActivityItem(item) {
  const details = Array.isArray(item.details?.changes) ? item.details.changes : [];
  const detailRows = details
    .slice(0, 4)
    .map(
      (change) => `
        <li>
          <span>${escapeHtml(change.label || change.field)}</span>
          <strong>${escapeHtml(formatActivityValue(change.before))} -> ${escapeHtml(formatActivityValue(change.after))}</strong>
        </li>
      `,
    )
    .join("");

  return `
    <article class="activity-item">
      <div class="activity-main">
        <span class="activity-type">${escapeHtml(activityActionLabel(item.action))}</span>
        <h4>${escapeHtml(item.summary || item.entityLabel || "活动记录")}</h4>
        <p>${escapeHtml(formatDateTime(item.createdAt))}</p>
      </div>
      ${
        detailRows
          ? `<ul class="activity-details">${detailRows}</ul>`
          : `<p class="activity-context">${escapeHtml(item.entityLabel || item.entityType || "系统")}</p>`
      }
    </article>
  `;
}

function activityActionLabel(action) {
  return {
    created: "新增",
    updated: "修改",
    deleted: "删除",
    imported: "导入",
    done: "完成待办",
    ignored: "忽略待办",
    auth_updated: "授权",
    sync_ok: "同步",
    sync_error: "同步失败",
  }[action] || action || "记录";
}

function formatActivityValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  if (value === "old") return "旧照片";
  if (value === "new") return "新照片";
  const labels = {
    not_listed: "未挂",
    draft: "草稿",
    listed: "已挂",
    offer: "询价",
    sold: "已售",
  };
  return labels[value] || String(value);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function render() {
  renderMetrics();
  renderInventory();
  renderActions();
  renderPricing();
  renderActivity();
}

function daysSince(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 999;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getMarketQuery() {
  const name = $("#nameInput").value.trim();
  const sku = $("#skuInput").value.trim();
  const size = $("#sizeInput").value.trim();
  return [name, sku, size].filter(Boolean).join(" ") || "basketball sneakers";
}

function updateMarketLinks() {
  const query = getMarketQuery();
  const encoded = encodeURIComponent(query);
  const links = {
    ebay: `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Sold=1&LH_Complete=1`,
    stockx: `https://stockx.com/search?s=${encoded}`,
    goat: `https://www.goat.com/search?query=${encoded}`,
    google: `https://www.google.com/search?q=${encoded}+market+price+sneakers`,
  };

  $$("[data-market-link]").forEach((link) => {
    link.href = links[link.dataset.marketLink];
  });
}

function setActiveView(view) {
  currentView = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.remove("active-view"));
  $(`#view${view[0].toUpperCase()}${view.slice(1)}`).classList.add("active-view");
}

function setDensity(nextDensity) {
  density = nextDensity;
  $$(".segment").forEach((button) => button.classList.toggle("active", button.dataset.density === density));
  renderInventory();
}

function openDrawer(id = null) {
  editingId = id;
  const shoe = id ? shoes.find((item) => item.id === id) : normalizeShoe({ checkedAt: todayISO() });
  if (!shoe) return;

  elements.drawerTitle.textContent = id ? "编辑球鞋" : "新增球鞋";
  $("#nameInput").value = shoe.name;
  $("#brandInput").value = shoe.brand;
  $("#skuInput").value = shoe.sku;
  $("#sizeInput").value = shoe.size;
  $("#conditionInput").value = shoe.condition;
  $("#costInput").value = shoe.cost || "";
  $("#floorInput").value = shoe.floor || "";
  $("#marketInput").value = shoe.market || "";
  $("#checkedInput").value = shoe.checkedAt || todayISO();
  $("#nextActionInput").value = shoe.nextAction;
  $("#notesInput").value = shoe.notes;
  elements.photoPreview.src = shoe.photo || SAMPLE_PHOTO;
  elements.photoPreview.dataset.photo = shoe.photo || SAMPLE_PHOTO;

  renderPlatformEditor(shoe.platforms);
  updateMarketLinks();
  $("#deleteButton").hidden = !id;
  elements.drawerBackdrop.hidden = false;
  elements.drawer.hidden = false;
  requestAnimationFrame(() => {
    elements.drawer.classList.add("open");
    elements.drawer.setAttribute("aria-hidden", "false");
  });
}

function closeDrawer() {
  elements.drawer.classList.remove("open");
  elements.drawer.setAttribute("aria-hidden", "true");
  setTimeout(() => {
    elements.drawerBackdrop.hidden = true;
    elements.drawer.hidden = true;
    elements.shoeForm.reset();
    editingId = null;
  }, 180);
}

function renderPlatformEditor(platforms) {
  const template = $("#platformRowTemplate");
  elements.platformRows.innerHTML = "";
  platforms.forEach((platform) => {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.platform = platform.name;
    row.querySelector(".platform-name").textContent = platform.name;
    row.querySelector(".platform-status").value = platform.status;
    row.querySelector(".platform-price").value = platform.price || "";
    row.querySelector(".platform-fee").value = platform.fee ?? DEFAULT_FEES[platform.name] ?? 0;
    row.querySelector(".platform-fixed").value = platform.fixedFee ?? DEFAULT_FIXED_FEES[platform.name] ?? 0;
    row.querySelector(".platform-ship").value = platform.shippingCost ?? DEFAULT_SHIPPING_COSTS[platform.name] ?? 0;
    row.querySelector(".platform-link").value = platform.link || "";
    row.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("input", () => updatePlatformNet(row));
      input.addEventListener("change", () => updatePlatformNet(row));
    });
    updatePlatformNet(row);
    elements.platformRows.appendChild(row);
  });
}

function getPlatformFromRow(row) {
  return {
    name: row.dataset.platform,
    status: row.querySelector(".platform-status").value,
    price: Number(row.querySelector(".platform-price").value || 0),
    fee: Number(row.querySelector(".platform-fee").value || 0),
    fixedFee: Number(row.querySelector(".platform-fixed").value || 0),
    shippingCost: Number(row.querySelector(".platform-ship").value || 0),
    link: row.querySelector(".platform-link").value.trim(),
  };
}

function updatePlatformNet(row) {
  const platform = getPlatformFromRow(row);
  const net = platform.price ? getPlatformNet(platform) : 0;
  row.querySelector(".platform-net strong").textContent = money(net);
}

function collectFormData() {
  const existing = editingId ? shoes.find((item) => item.id === editingId) : {};
  const platforms = $$(".platform-row").map(getPlatformFromRow);

  return normalizeShoe({
    ...existing,
    id: editingId || uid(),
    name: $("#nameInput").value.trim(),
    brand: $("#brandInput").value.trim(),
    sku: $("#skuInput").value.trim(),
    size: $("#sizeInput").value.trim(),
    condition: $("#conditionInput").value,
    cost: Number($("#costInput").value || 0),
    floor: Number($("#floorInput").value || 0),
    market: Number($("#marketInput").value || 0),
    checkedAt: $("#checkedInput").value || todayISO(),
    nextAction: $("#nextActionInput").value.trim(),
    notes: $("#notesInput").value.trim(),
    photo: elements.photoPreview.dataset.photo || SAMPLE_PHOTO,
    updatedAt: new Date().toISOString(),
    platforms,
  });
}

async function handlePhotoUpload(file) {
  if (!file) return;
  const dataUrl = await resizeImage(file, 1200, 0.82);
  elements.photoPreview.src = dataUrl;
  elements.photoPreview.dataset.photo = dataUrl;
}

function resizeImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function exportData() {
  const blob = new Blob([JSON.stringify(shoes, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `sneaker-desk-${todayISO()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  if (!file) return;
  const text = await file.text();
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("Invalid import file");
  shoes = await replaceShoesViaApi(data.map(normalizeShoe));
  await refreshActivity();
  render();
}

function bindEvents() {
  $("#addShoeButton").addEventListener("click", () => openDrawer());
  $("#emptyAddButton").addEventListener("click", () => openDrawer());
  $("#closeDrawerButton").addEventListener("click", closeDrawer);
  $("#cancelButton").addEventListener("click", closeDrawer);
  elements.drawerBackdrop.addEventListener("click", closeDrawer);
  elements.photoInput.addEventListener("change", (event) => handlePhotoUpload(event.target.files[0]));

  $("#deleteButton").addEventListener("click", async () => {
    if (!editingId || !confirm("删除这双鞋？")) return;
    try {
      await deleteShoeFromApi(editingId);
      shoes = shoes.filter((item) => item.id !== editingId);
      await refreshActivity();
      closeDrawer();
      render();
    } catch {
      alert("删除失败：本地后端没有响应。");
    }
  });

  elements.shoeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const shoe = collectFormData();
    try {
      const saved = await saveShoeToApi(shoe);
      shoes = editingId ? shoes.map((item) => (item.id === editingId ? saved : item)) : [saved, ...shoes];
      await refreshActivity();
      closeDrawer();
      render();
    } catch {
      alert("保存失败：请确认本地后端正在运行。");
    }
  });

  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setActiveView(button.dataset.view));
  });

  $$(".segment").forEach((button) => {
    button.addEventListener("click", () => setDensity(button.dataset.density));
  });

  [elements.searchInput, elements.statusFilter, elements.platformFilter, elements.sortSelect].forEach((input) => {
    input.addEventListener("input", render);
    input.addEventListener("change", render);
  });

  ["#nameInput", "#skuInput", "#sizeInput"].forEach((selector) => {
    $(selector).addEventListener("input", updateMarketLinks);
  });

  $("#seedButton").addEventListener("click", async () => {
    if (shoes.length && !confirm("用示例数据替换当前数据？请先导出备份。")) return;
    try {
      await seedData();
    } catch {
      alert("加载示例失败：本地后端没有响应。");
    }
  });

  $("#exportButton").addEventListener("click", exportData);
  elements.ebayConnectButton.addEventListener("click", () => {
    window.open("/api/ebay/auth/start", "_blank", "noreferrer");
  });
  elements.ebaySyncButton.addEventListener("click", syncEbay);
  $("#importButton").addEventListener("click", () => elements.importFile.click());
  elements.importFile.addEventListener("change", async (event) => {
    try {
      await importData(event.target.files[0]);
      event.target.value = "";
    } catch {
      alert("导入失败：请选择 Sneaker Desk 导出的 JSON 文件。");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.drawer.classList.contains("open")) closeDrawer();
  });
}

async function init() {
  bindEvents();
  try {
    await load();
    if (!shoes.length) await seedData();
    await loadEbayStatus();
  } catch {
    alert("无法连接本地后端。请用 npm start 启动 Sneaker Desk。");
  }
  render();
}

init();
