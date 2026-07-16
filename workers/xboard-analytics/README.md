# xboard-analytics

Internal Analytics Engine query Worker. It accepts only fixed query shapes through the `XBOARD_ANALYTICS` Service Binding. The Cloudflare API token must be stored as the `ANALYTICS_API_TOKEN` Worker secret and is never exposed to browsers.
