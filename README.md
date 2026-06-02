# Sneaker Desk

一个本地运行的轻量球鞋库存与跨平台挂牌管理工具。

## 使用方式

启动本地后端：

```bash
npm start
```

然后打开：

```text
http://127.0.0.1:5173/
```

数据会存在本机的 `data/sneaker-desk.sqlite`，不会上传到任何服务。

## 适合的流程

- 记录每双鞋的照片、尺码、状态、成本、心理底价和最高买家出价
- 维护 eBay、Facebook Marketplace、StockX、Local 四个渠道的挂牌状态、价格、费用和链接
- 查看待办，例如补照片、补下一步、更新最高出价、复核 Ask-Bid 差距
- 在每个平台估算到手价：挂牌价 - 平台费率 - 固定费 - 运费成本
- 在编辑页一键打开 eBay Sold、StockX、GOAT 和 Google 查市场价
- 导出 JSON 做备份，或导入之前导出的 JSON

## 默认费用假设

- eBay: 球鞋 over $150 先按 8% 估算
- StockX: Level 1 交易费 9% + 付款处理费 3%，先按 12% 估算
- Facebook Marketplace / Local: 默认按本地现金交易 0% 估算

这些只是默认值。每双鞋、每个平台都可以单独改费率、固定费和运费成本。

## 当前边界

- 不自动抓取各平台价格
- 不通过 API 发布商品
- eBay / StockX / GOAT adapter 目前是占位骨架，还没有接入真实 credentials
- 照片会被压缩后存在 SQLite，适合个人库存管理，不适合作为长期图片仓库

## 本地架构

```text
浏览器 UI
  -> /api/shoes
Node 本地后端
  -> data/sneaker-desk.sqlite
  -> server/adapters/* 平台同步模块
```

## 本地 API

- `GET /api/shoes`: 读取库存
- `POST /api/shoes`: 新增球鞋
- `PUT /api/shoes/:id`: 更新球鞋
- `DELETE /api/shoes/:id`: 删除球鞋
- `POST /api/import`: 用 JSON 替换当前库存
- `POST /api/sync/ebay`: eBay 同步入口，占位
- `POST /api/sync/stockx`: StockX 同步入口，占位
- `POST /api/sync/goat`: GOAT/Alias 同步入口，占位

## eBay setup

1. 在 eBay Developer Portal 创建 Application Keys。
2. 如果要同步真实账号，用 Production keyset；Sandbox 只适合测试账号。
3. 在 User Tokens / eBay Sign-In 设置 RuName。
4. Auth Accepted URL 填：

```text
http://127.0.0.1:5173/api/ebay/oauth/callback
```

5. Auth Declined URL 也可以先填同一个 URL。
6. 复制 `.env.example` 为 `.env`，填入：

```text
EBAY_ENV=sandbox
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
EBAY_RUNAME=...
```

7. 重启 `npm start`，点左侧 eBay 面板里的 `授权`。

### Production keyset compliance

eBay Production keyset 启用前，需要完成 Marketplace Account Deletion / Account Closure Notifications。
本项目已经提供 webhook：

```text
/api/ebay/account-deletion
```

部署到 Vercel 后，eBay Developer Portal 里填：

```text
Notification Endpoint URL:
https://<your-vercel-domain>/api/ebay/account-deletion
```

同时在 Vercel Environment Variables 里设置同样的 endpoint 和一个 32-80 字符 verification token：

```text
EBAY_ACCOUNT_DELETION_ENDPOINT=https://<your-vercel-domain>/api/ebay/account-deletion
EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN=<your-32-to-80-char-token>
```

在 eBay Developer Portal 的 Verification token 字段填同一个 token。
eBay 会用 `GET ?challenge_code=...` 验证 endpoint，本项目会按 eBay 要求返回：

```json
{ "challengeResponse": "sha256(challengeCode + verificationToken + endpoint)" }
```

后续 eBay 发送 account deletion POST notification 时，endpoint 会立即返回 `200 OK`，满足 eBay 的 acknowledgement 要求。

当前 eBay adapter 已支持 OAuth、token refresh、seller policy 读取、inventory item upsert、offer draft 创建入口。真正 publish active listing 前，还需要配置：

```text
EBAY_LOCATION_KEY
EBAY_FULFILLMENT_POLICY_ID
EBAY_PAYMENT_POLICY_ID
EBAY_RETURN_POLICY_ID
```
