# xboard-server

Independent Cloudflare Worker implementing the XBoard node protocol on D1, KV, Queues, and Durable Objects.

`NodeHub` owns hibernating WebSocket connections and ordered configuration/user synchronization. The global `StatusHub` owns live node, machine, and device state plus the rolling 24-hour machine-load series. Traffic reports are split into bounded events and published to `traffic-events`; this Worker does not perform final traffic accounting itself.

Successful node, machine, and machine-node authentication lookups use a bounded 20-second isolate cache with concurrent-load coalescing. Admin changes invalidate it through internal sync; misses and authorization failures are not cached. Config/user responses may use Cache API, but authentication, traffic reports, device reports, and WebSocket health decisions remain uncached. D1 or Cache API failure must not turn an invalid credential into an accepted one.

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
