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

## Rejected
- Direct `anon` Supabase from the browser — would require opening `events` to the world via RLS, or shipping a key.
- React/Vite Pages build — npm CI already burned hours on sister repos; not worth it for a grid.
- Supabase Realtime — extra client SDK + RLS policy surface for a 5s SLA we do not need.

## Consequences
Anyone who knows the Worker URL can read recent events. Payloads must stay non-secret. Worker must be redeployed after adding GET.
