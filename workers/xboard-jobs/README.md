# xboard-jobs

Independent Cloudflare Worker root for Queue consumers, including traffic accounting and Resend email delivery.

Configure `RESEND_API_KEY` as a Worker Secret, or set the key through the admin email settings. The sender address must belong to a domain verified by Resend.

Default admin seed: admin@admin.com / adminadmin.
