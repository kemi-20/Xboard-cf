# XBoard CF

XBoard CF 是基于 Cloudflare Workers、D1、KV、Queues、Durable Objects 和 Static Assets 重写的 XBoard。项目保留官方后台 WebUI、用户 API、订阅接口和节点协议，不需要部署 Laravel、PHP、MySQL 或 Redis。

> 当前仅暂缓需要真实收款、支付回调或资金提现的功能。礼品卡兑换、余额奖励、套餐奖励、流量奖励和邮件发送均为真实业务实现。

## 主要功能

- 官方 XBoard 后台 WebUI，入口为 `/admin`
- 用户、套餐、权限组、节点、服务器、路由、公告、知识库和工单管理
- 系统设置、订阅设置、订阅模板和邮件模板管理
- Resend 邮件发送、测试邮件、模板测试、批量用户邮件和提醒邮件队列
- 原版礼品卡模板、批量兑换码、条件与次数限制、盲盒奖励、兑换记录和统计
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
| `xboard-jobs` | `workers/xboard-jobs` | Queue 消费、流量和统计写入、Resend 邮件发送 |
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
Service Binding：XBOARD_SUBSCRIPTION -> xboard-subscription
Queue Producer：MAIL_EVENTS -> mail-events
```

D1 保存用户、套餐、节点、服务器、权限、设置、流量和统计等正式数据。KV 仅用于 Session、缓存、版本号、在线状态和短期负载，不应作为业务数据的唯一来源。

## Resend 邮件

邮件不再使用 SMTP，`xboard-edge` 将邮件任务写入 `mail-events`，`xboard-jobs` 通过 Resend HTTPS API 发送。后台“邮件设置”中的字段含义为：

```text
Resend API 地址：默认 https://api.resend.com
发件人名称：Resend 邮件显示名称
Resend API Key：以 re_ 开头的 API Key
发件人地址：已在 Resend 验证的域名邮箱
```

生产环境推荐把 API Key 配置为 `xboard-jobs` 的 Worker Secret：

```bash
cd workers/xboard-jobs
npx wrangler secret put RESEND_API_KEY
```

后台保存的 API Key 作为兼容回退。邮件 Queue 使用稳定事件 ID 和 Resend `Idempotency-Key`，队列重试不会重复发送同一封邮件。

## 礼品卡

礼品卡接口与官方 XBoard 保持一致，包含：

```text
后台：模板创建/编辑/删除、兑换码批量生成、启停、导出、记录和统计
用户：兑换码检查、奖励预览、兑换、历史记录和详情
奖励：余额、流量、设备数、有效期、流量重置、套餐、邀请人奖励、盲盒和节日倍率
限制：新用户、付费用户、指定套餐、邀请人、每用户次数和冷却时间
```

兑换会同步更新 D1 中的用户、兑换码、兑换记录和流量重置日志。

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

`xboard-edge` 通过 `XBOARD_SUBSCRIPTION` Service Binding 原样转发 `/s/*`、`/sub/*` 和 `/api/v1/client/subscribe`，因此官方客户端可以继续使用面板主域名。

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
- 需要真实出金的佣金提现
- 依赖外部支付插件的订单流程

Cloudflare Workers 无法在运行时解压并执行 Laravel Blade 主题或任意 PHP 插件。后台内置 Xboard 主题、主题配置持久化以及 Cloudflare-native 插件的安装状态、启停和配置可正常使用；上传 PHP/Blade ZIP 包会明确返回不支持，不会伪装成安装成功。

礼品卡不在暂缓范围内，已经执行真实奖励发放。支付相关表和兼容接口仍然保留，用于避免后台页面崩溃。

## 上游项目与许可

本项目参考以下 cedar2025/XBoard 生态仓库：

- https://github.com/cedar2025/Xboard
- https://github.com/cedar2025/xboard-admin-dist
- https://github.com/cedar2025/xboard-user
- https://github.com/cedar2025/Xboard-Node

后台静态资源来自 `xboard-admin-dist`，节点协议以固定提交版本为兼容基线。原项目使用 MIT License，复制或修改上游代码和资源时请保留原作者归属与许可说明。
