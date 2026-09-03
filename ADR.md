# ADR-001: VOLTCORE Command Center stack

## Status
Accepted — 2026-09-02

## Context
Need a $0, iOS-first observability surface over `public.events` with near-real-time visibility and no secrets in the browser.

## Decision
| Layer | Choice | Why |
|---|---|---|
| UI | Vanilla HTML/CSS/JS | Zero npm, zero CI install risk, fastest iOS Safari paint |
| Hosting | GitHub Pages | $0, HTTPS, org Pages, already proven on Storm Path |
| Data path | Cloudflare Worker `core-api` GET `/api/v1/events` | Service-role stays on the Worker; Pages never holds Supabase keys |
| Freshness | 5s poll + Page Visibility | No Realtime websocket bill; pauses in background Safari tabs |
| Auth | None | $0 static host cannot keep a secret; ingest POST is already public |
| Order | `created_at DESC` from the Worker | Newest ingest lands at the top of the grid |
| Anomalies | Isolated queue + danger rail | `error` / `high` / `critical` / `fatal` never blend into the stream |

## Rejected
- Direct `anon` Supabase from the browser — would require opening `events` to the world via RLS, or shipping a key.
- React/Vite Pages build — npm CI already burned hours on sister repos; not worth it for a grid.
- Supabase Realtime — extra client SDK + RLS policy surface for a 5s SLA we do not need.

## Consequences
Anyone who knows the Worker URL can read recent events. Payloads must stay non-secret. Worker GET must stay deployed with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.

## Verification
2026-09-02: `GET /api/v1/events` → 200 `{status,events,fetched_at}`; `POST` → 202; Pages → 200.

---

# ADR-002: Global Health grouping and anomaly aging

## Status
Accepted — 2026-09-03

## Context
Global Health listed one card per ingest source, so product families (Storm Path web + mobile, Command Center + remediate) looked like unrelated services. The 2026-09-02 07:06 `grok-orchestration-engine` / `system.recovery` HIGH stayed in the hot queue after a later `status: patched` info event, and each Remediate tap re-queried OpenRouter.

## Decision
- Global Health groups sources by product (`GROUPS` in `app.js`). Pinned groups always render, including idle sources (`awaiting ingest`). Unknown sources land in Other.
- An anomaly is **active** only if it is still `high|critical|fatal|error` AND has not been superseded AND is younger than 6h.
- Supersede: a newer same-source event with the same `payload.incident` (or same `event_type` plus `payload.status` in `patched|recovered|resolved|ok`) clears the HIGH from the hot queue.
- ANOMALIES count, `.hot` rail, and Remediate / Copy Patch apply to **active** only. Aged/resolved events remain in the stream with a warn label and a collapsed “Show N aged / resolved” list.
- Heartbeats older than 3 minutes mark the source **stale** (amber), distinct from an active HIGH (red).
- iPhone: compact sticky header (no wrap), 44px targets, 16px search, bottom sheet, 1-col groups, no `backdrop-filter`.

## Rejected
- DELETE from `public.events` — history belongs in the stream; aging is a view rule.
- Auto-commit of model patches — still Copy Patch only.
- Worker change — this is Pages-only.

## Verification
Client-side: the 07:06 HIGH is resolved by the 20:42 `system.recovery` info (`status: patched`) and/or the 6h TTL. Anomaly queue shows 0 active unless a new HIGH arrives.
