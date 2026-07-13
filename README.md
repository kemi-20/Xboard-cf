# XBoard CF

XBoard CF 是基于 Cloudflare Workers、D1、KV、Queues、Durable Objects 和 Static Assets 重写的 XBoard。项目保留官方后台 WebUI、用户 API、订阅接口和节点协议，不需要部署 Laravel、PHP、MySQL 或 Redis。

> 当前支付、佣金结算、礼品卡兑换等真实资金功能仍处于停用状态，其余接口会尽量保持官方前端和节点程序所需的数据结构。

## 主要功能

- 官方 XBoard 后台 WebUI，入口为 `/admin`
- 用户、套餐、权限组、节点、服务器、路由、公告、知识库和工单管理
- 系统设置、订阅设置、订阅模板和邮件模板管理
- 用户 API 与第三方用户前端兼容接口
- Base64、Clash、Clash Meta、Surge、Shadowrocket、Quantumult X 和 Loon 订阅输出
- UniProxy、ShadowsocksTidalab、TrojanTidalab 和 V2 节点接口
- Xboard-Node 单节点模式、机器模式和 WebSocket 热同步
- 节点在线状态、机器负载、负载历史折线图和网络速率展示
- D1 持久化业务数据，KV 缓存临时状态
- Queue 异步处理流量，Cron Worker 执行周期任务

## 后台入口

站点根路径只返回：

```text
200
```

后台登录页：

```text
https://你的域名/admin
```

后台内部使用 Hash 路由，例如：

```text
/admin#/server/machine
/admin#/server/manage
/admin#/user/manage
```

### 默认超级管理员

```text
邮箱：admin@admin.com
密码：adminadmin
```

首次登录后请立即修改默认密码。

## Worker 架构

每个 Worker 都是独立部署根目录：

| Worker | 根目录 | 职责 |
| --- | --- | --- |
| `xboard-edge` | `workers/xboard-edge` | 后台 WebUI、后台 API、用户 API、节点接口代理 |
| `xboard-subscription` | `workers/xboard-subscription` | 订阅校验、订阅格式生成和短缓存 |
| `xboard-server` | `workers/xboard-server` | 节点 HTTP、机器模式、状态上报和 WebSocket |
| `xboard-jobs` | `workers/xboard-jobs` | Queue 消费、流量和统计写入 |
| `xboard-cron` | `workers/xboard-cron` | 流量重置、过期检查、统计和清理任务 |

Worker 之间没有依赖仓库根目录的共享运行时代码，因此 Cloudflare 可以直接把每个目录设置为独立的构建根目录。

## Cloudflare 资源

默认资源和绑定：

```text
D1 数据库：xboard-db
D1 绑定：XBOARD_DB

KV Namespace：xboard-kv
KV 绑定：XBOARD_KV

Queues：
traffic-events
mail-events
telegram-events
stat-events
node-sync-events

Durable Object：NodeHub
Static Assets 绑定：ASSETS
Service Binding：XBOARD_SERVER -> xboard-server
```

D1 保存用户、套餐、节点、服务器、权限、设置、流量和统计等正式数据。KV 仅用于 Session、缓存、版本号、在线状态和短期负载，不应作为业务数据的唯一来源。

## 使用 Cloudflare Git 自动部署

本项目不使用 GitHub Actions。推荐在 Cloudflare Workers Builds 中直接连接本仓库，并为每个 Worker 分别创建项目：

```text
Git 分支：master
构建命令：npm ci && npm run typecheck && npm test
部署命令：npx wrangler deploy
```

分别设置根目录：

```text
workers/xboard-edge
workers/xboard-subscription
workers/xboard-server
workers/xboard-jobs
workers/xboard-cron
```

连接完成后，推送 `master` 即会触发 Cloudflare 自动构建和部署。首次部署前仍需创建 D1、KV、Queues、Durable Object 和 Service Binding。

## 初始化数据库

创建资源后执行：

```bash
npx wrangler d1 execute xboard-db --remote --config workers/xboard-edge/wrangler.toml --file schema/d1.sql
npx wrangler d1 execute xboard-db --remote --config workers/xboard-edge/wrangler.toml --file schema/seed.sql
```

`schema/seed.sql` 会创建或重置默认管理员。Schema 和 seed 都按幂等方式设计；已有数据库升级时应保留现有用户、节点、服务器和统计数据。

## 节点与服务器状态

节点协议兼容基线固定为：

```text
cedar2025/Xboard      8e4864b4c7f6240e3ef08ecd7b59447e5d9dd363
cedar2025/Xboard-Node 0a29338e1f102a462363ce3527417029f89bab28
```

支持的接口包括：

```text
/api/v1/server/UniProxy/*
/api/v1/server/ShadowsocksTidalab/*
/api/v1/server/TrojanTidalab/*
/api/v2/server/*
/api/v2/server/machine/*
/ws
```

机器模式会持续上报 CPU、内存、磁盘和网络速率。最近 24 小时的数据保存在 `v2_server_machine_load_history`，后台服务器详情页可切换 `1h`、`6h`、`12h` 和 `24h` 查看折线图。

属于机器的节点会继承该机器的有效心跳和负载状态，因此机器在线时，节点管理页会显示绿色状态点和“运行正常”悬浮详情。

## 订阅行为

主要订阅入口：

```text
GET /s/:token
GET /sub/:token
GET /api/v1/client/subscribe
```

订阅 Worker 会读取站点订阅设置、订阅 URL、节点完整配置和订阅模板。默认 URI 订阅以 Base64 文本返回，响应使用 `text/plain`，访问链接时直接显示内容，不强制下载 TXT 文件。

KV 仅作为订阅短缓存。KV 读写失败时会回退到 D1 实时生成，不应导致有效订阅不可用。

## 本地检查

检查所有 Worker：

```bash
npm run typecheck
npm test
```

检查单个 Worker：

```bash
cd workers/xboard-edge
npm install
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir ../../.tmp/xboard-edge-dry-run
```

所有临时脚本、上游仓库和 dry-run 产物应放在 `.tmp/`，不得提交。

## 暂未启用的功能

以下功能暂不进行真实业务处理：

- 在线支付和支付回调
- 佣金结算与提现
- 礼品卡真实兑换
- 依赖外部支付插件的订单流程

相关表和兼容接口仍然保留，用于避免后台页面崩溃。不要把兼容占位响应当作已经完成的支付实现。

## 上游项目与许可

本项目参考以下 cedar2025/XBoard 生态仓库：

- https://github.com/cedar2025/Xboard
- https://github.com/cedar2025/xboard-admin-dist
- https://github.com/cedar2025/xboard-user
- https://github.com/cedar2025/Xboard-Node

后台静态资源来自 `xboard-admin-dist`，节点协议以固定提交版本为兼容基线。原项目使用 MIT License，复制或修改上游代码和资源时请保留原作者归属与许可说明。
