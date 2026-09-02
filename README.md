# VOLTCORE Command Center

Live observability dashboard for `public.events`.

**Live:** https://voltcore-org.github.io/voltcore-command-center/

Ingest API: `GET https://core-api.dominic-calandro1991.workers.dev/api/v1/events`

## Stack
See [ADR.md](./ADR.md). Static Pages + Cloudflare Worker BFF. $0. iOS Safari first.

## Behavior
- Orders events `created_at DESC`
- Anomaly rows (`error` / `high` / `critical` / `fatal`) isolated with a danger rail
- Polls every 5 seconds, paused when the tab is hidden
- No Supabase keys in this repo

Push to `main` deploys GitHub Pages.
