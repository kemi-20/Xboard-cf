# xboard-edge

Independent Cloudflare Worker root for xboard-edge.

Default admin seed: admin@admin.com / adminadmin.

The admin Web UI is served from `/admin`; inner pages use hash routes such as `/admin#/server/machine`.

Email tasks are published to the `MAIL_EVENTS` binding and delivered by `xboard-jobs` through Resend. Gift card admin and user APIs follow the official XBoard route and response contracts.
