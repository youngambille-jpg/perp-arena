# Roadmap — deferred improvements

Recorded 2026-10-13. Implemented already: DRY_RUN mode, unrealized
equity, full order lifecycle (submitted → open → partial → filled).

## P1 — before live copying with real funds

- [ ] **Run the first copy cycle dry.** Set `DRY_RUN=true` on the
  worker, configure one copy setting with a tiny allocation, follow
  one leader for 24h, and review the `dry_run` rows in
  `copy_orders`. Disable only after the translation sizes look sane.
- [ ] **Enforce single-leader-per-market.** Position attribution
  (`attributeLeader`) silently picks the first matching leader when
  a follower copies two leaders on the same market. Either reject
  overlapping markets in `PUT /copy/:leaderId` or track per-order
  position slices.

## P2 — correctness gaps

- [ ] **Funding PnL.** Funding payments accrue outside fills; ingest
  `account-history` funding events into the realized ledger or
  long-running copy PnL drifts from reality.
- [ ] **Tune hot loops.** Account sync polls every 1s
  (`SESSION_POLL_MS`); equity snapshots write on every wallet
  frame. Back off to 5–10s / timer-based snapshots.
- [ ] **Leader-down detection.** If a leader's key dies (revoked,
  expired, forwarding disabled), followers silently stop receiving
  updates. Alert followers and pause affected copy settings.
- [ ] **Divergence metric.** Track follower-vs-leader performance
  gap (copy delay + slippage + minimum-size skips); surface it on
  the leader profile so followers see the cost of copying.

## P3 — product / scale

- [ ] **User provisioning + admin endpoints.** `public.users` rows
  are manual; tournaments are raw SQL. Add `POST /users/provision`
  and admin tournament create/cancel.
- [ ] **Push notifications.** Only in-app `notifications` rows
  exist; add FCM/APNs fan-out for fills, risk pauses, tournaments.
- [ ] **Distributed rate limiting.** The limiter is in-memory per
  API instance; move to Upstash Redis when a second instance
  appears (also the documented answer for multi-worker locks).
- [ ] **Key-encryption rotation.** `KEY_ENCRYPTION_KEY` has no
  rotation story; add key versioning + re-encryption migration.
- [ ] **Metrics.** Request latency, WS uptime/reconnects, copy
  slippage, engine loop durations — currently logs only.
- [ ] **Builder-code registration.** `PERPL_BUILDER_ID` is 0 until
  Perpl issues a code; re-enroll keys bound to it for fee revenue.
