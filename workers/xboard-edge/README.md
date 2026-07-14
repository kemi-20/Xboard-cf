# xboard-edge

Independent Cloudflare Worker root for xboard-edge.

Default admin seed: admin@admin.com / adminadmin.

The admin Web UI is served from `/admin`; inner pages use hash routes such as `/admin#/server/machine`.

Email tasks are published to the `MAIL_EVENTS` binding and delivered by `xboard-jobs` through Resend. Gift card admin and user APIs follow the official XBoard route and response contracts.

The authenticated migration wizard is available at `/<secure_path>/migration`. The original SQLite3 database is required; Redis RDB/JSON is optional. Persistent rows are imported into D1, while a supplied Redis backup contributes useful runtime state to KV. Without Redis, node presence and load state are rebuilt after reconnect. Laravel queues, locks, sessions, verification codes, and rate-limit keys are skipped. The preflight step warns that SMTP/mail-driver credentials and payment provider/plugin configuration cannot be migrated. Resend credentials must be configured manually after migration; mail templates and auditable order history are preserved.
