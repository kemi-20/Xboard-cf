# xboard-edge

Independent Cloudflare Worker root for xboard-edge.

Default admin seed: admin@admin.com / adminadmin.

The admin Web UI is served from `/admin`; inner pages use hash routes such as `/admin#/server/machine`.

Email and Telegram tasks are published to the shared `NOTIFICATION_EVENTS` binding. `xboard-jobs` dispatches them by event type and sends email through Maileroo or Brevo. Gift card admin and user APIs follow the official XBoard route and response contracts.

The authenticated migration wizard is available at `/<secure_path>/migration`. The original SQLite3 database is required; Redis RDB/JSON is optional. Persistent rows are imported into D1, while a supplied Redis backup contributes useful runtime state to KV. Without Redis, node presence and load state are rebuilt after reconnect. Laravel queues, locks, sessions, verification codes, and rate-limit keys are skipped. SMTP/mail-driver credentials and plugin configuration are not migrated. `v2_payment` is imported and exported without redacting provider credentials; unsupported providers and ambiguous duplicate callback UUIDs are preserved but disabled. Resend credentials must be configured manually after migration; mail templates and auditable order history are preserved.
