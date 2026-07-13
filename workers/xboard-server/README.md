# xboard-server

Independent Cloudflare Worker implementing the XBoard node protocol on D1, KV, Queues, and Durable Objects.

Compatibility baseline:

```text
cedar2025/Xboard      8e4864b4c7f6240e3ef08ecd7b59447e5d9dd363
cedar2025/Xboard-Node 0a29338e1f102a462363ce3527417029f89bab28
```

Implemented interfaces:

```text
/api/v1/server/UniProxy/*
/api/v1/server/ShadowsocksTidalab/*
/api/v1/server/TrojanTidalab/*
/api/v2/server/*
/api/v2/server/machine/*
/ws
```

Local verification:

```bash
npm install
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir ../../.tmp/xboard-server-dry-run
```

The default administrator is managed by `xboard-edge`, not this Worker:

```text
admin@admin.com / adminadmin
```
