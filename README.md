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
- 不通过平台 API 发布、同步或管理商品
- eBay、Facebook、StockX、Local 都是手动记录状态和价格
- 照片会被压缩后存在 SQLite，适合个人库存管理，不适合作为长期图片仓库

## 本地架构

```text
浏览器 UI
  -> /api/shoes
Node 本地后端
  -> data/sneaker-desk.sqlite
```

## 本地 API

- `GET /api/shoes`: 读取库存
- `POST /api/shoes`: 新增球鞋
- `PUT /api/shoes/:id`: 更新球鞋
- `DELETE /api/shoes/:id`: 删除球鞋
- `POST /api/import`: 用 JSON 替换当前库存
