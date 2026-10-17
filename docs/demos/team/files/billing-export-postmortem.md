# Postmortem: billing export canary, 5xx at 4.2%

**Severity:** SEV-3 · **Duration:** 4 min · **Impact:** 37 failed requests, all retried

## What happened
- 14:14 `api 4.2.0-rc.1` goes to the 10% canary with `POST /v2/billing/export`
- 14:16 5xx on the canary climbs from 0.02% to **4.2%**; on-call's watch fires
- 14:17 on-call rolls the canary back to 4.1.3; 5xx is at 0.02% by 14:20
- 14:19 backend opens #485; load test passes; reviewer approves

## Why
The export held a DB connection per row batch: 3 large accounts took 96 of 100.

## Fix
#485 streams it through **one connection with a cursor**: 50 × 1M rows, pool peak 12/100.

## Follow-ups
- [x] Pool usage alert at 70% (on-call) · [x] large-export test in CI (qa)
- [ ] Per-tenant export concurrency limit (backend, Friday)
