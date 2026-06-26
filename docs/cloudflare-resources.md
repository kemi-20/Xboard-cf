# Cloudflare Resources

Bindings used by all Workers:

```toml
[[d1_databases]]
binding = "XBOARD_DB"
database_name = "xboard-db"

[[kv_namespaces]]
binding = "XBOARD_KV"
```

`xboard-server` also binds `TRAFFIC_EVENTS` and Durable Object `NODE_HUB`.
`xboard-jobs` consumes the queue set.
`xboard-cron` defines scheduled triggers.
