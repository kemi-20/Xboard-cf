# Migration

The old Laravel/PHP runtime is not used by this Cloudflare-native rewrite. Preserve table names where practical and migrate data into D1 with `scripts/migrate-from-origin.ts`.

JSON columns are stored as TEXT. Money values should be integer cents. Timestamps are Unix seconds.
