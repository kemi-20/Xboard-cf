# xboard-edge

Independent Cloudflare Worker root for xboard-edge.

Default admin seed: admin@admin.com / adminadmin.

The admin Web UI is served from `/admin`; inner pages use hash routes such as `/admin#/server/machine`.

Email tasks are published to the `MAIL_EVENTS` binding and delivered by `xboard-jobs` through Resend. Gift card admin and user APIs follow the official XBoard route and response contracts.

The authenticated migration wizard is available at `/<secure_path>/migration`. It requires the original SQLite3 database and Redis RDB/JSON together, imports persistent rows into D1, translates useful runtime state into KV, and skips Laravel queues, locks, sessions, verification codes, and rate-limit keys. The preflight step warns that SMTP/mail-driver credentials and payment provider/plugin configuration cannot be migrated. Resend credentials must be configured manually after migration; mail templates and auditable order history are preserved.
