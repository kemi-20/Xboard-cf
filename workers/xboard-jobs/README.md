# xboard-jobs

Independent Cloudflare Worker root for Queue consumers, traffic accounting, notification delivery, TrafficStatsHub, and scheduled maintenance.

It owns the single `* * * * *` Cron Trigger and directly runs order, ticket, commission, traffic reset, reminder, statistics, and cleanup tasks. Mail and Telegram events share `notification-events`; mail is delivered through Maileroo or Brevo.

Configure `MAILEROO_API_KEY` or `BREVO_API_KEY` as a Worker Secret, or set the selected provider through the admin email settings.

Default admin seed: admin@admin.com / adminadmin.
