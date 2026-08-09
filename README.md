# Flash-sale-checkout-system

**High-Concurrency Flash Sale Checkout System**

A backend system that survives the "10,000 people, 200 units" problem — built to prove, not just claim, that it prevents overselling, rejects duplicate orders, and holds up under real concurrent load.

---

## Table of Contents

- [The Problem](#the-problem)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Key Features](#key-features)
- [Design Decisions](#design-decisions)
- [The Race Condition Story](#the-race-condition-story)
- [Load Test Results](#load-test-results)
- [API Endpoints](#api-endpoints)
- [Getting Started](#getting-started)
- [Running Tests](#running-tests)
- [Project Structure](#project-structure)
- [Known Limitations & Assumptions](#known-limitations--assumptions)
- [Future Improvements](#future-improvements)

---

## The Problem

Flash sales — a limited-stock product drop, a concert ticket release, a Big Billion Day deal — create a specific, well-known failure mode: **many concurrent requests racing against a small, finite pool of stock.** Naive implementations (read stock, check it, then write) have a gap between the check and the write where multiple requests can slip through, causing **overselling** — confirming more orders than actual stock allows.

Flash-sale-checkout-system is a backend built specifically to solve this correctly, along with the two problems that come with it in any real payment/checkout system: **duplicate orders from retried requests**, and **abuse from bot/scalper-style traffic**.

---

## Architecture

```mermaid
flowchart TD
    Client[Client] -->|Checkout request| Gateway[API Gateway<br/>Rate limit + idempotency check]
    Gateway --> Queue[Order Queue<br/>Async confirmation]
    Queue --> Worker[Confirmation Worker<br/>Email + analytics]
    Gateway --> Data[Data Layer<br/>PostgreSQL orders · Redis stock lock]
    Worker --> Data
```

**Two-store model:**
- **Redis** — fast, atomic layer for anything requiring check-then-act safety under concurrency (stock counts via Lua script, rate-limit token buckets)
- **PostgreSQL** — durable source of truth (orders, users, products), accessed via Prisma

---

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict mode) |
| Web framework | Express |
| ORM | Prisma (v5.x) |
| Database | PostgreSQL 16 |
| Cache / atomic ops | Redis 7 (`ioredis`) |
| Queue | BullMQ (Redis-backed) |
| Testing | Jest + Supertest |
| Containerization | Docker / Docker Compose |
| CI | GitHub Actions |
| Load testing | k6 |

---

## Key Features

- **Atomic stock control** — Redis Lua script guarantees stock can never be decremented below zero, even under heavy concurrent load
- **Idempotency keys** — retried or duplicated requests return the original order instead of creating a second one, enforced at the database level via a unique constraint
- **Token bucket rate limiting** — smooths bursty traffic per user without the boundary-burst exploit of naive fixed-window limiting
- **Async order confirmation** — email/analytics work happens in a separate worker process via a queue, keeping the checkout response fast regardless of downstream work
- **Fully automated test suite** — including an automated version of the concurrency proof, not just a one-off manual script

---

## Design Decisions

A few choices are worth explaining, since they were deliberate tradeoffs rather than defaults:

- **Redis Lua scripts for all check-then-act operations** (stock decrement, token bucket refill/consume) — ensures true atomicity. An earlier app-level "read then write" approach was proven unsafe (see [The Race Condition Story](#the-race-condition-story) below) and deliberately not trusted again anywhere else in the system.
- **BullMQ over RabbitMQ** — avoids introducing a second piece of queue infrastructure, since Redis was already required for locking and rate limiting.
- **Token bucket over fixed-window rate limiting** — fixed window allows up to 2x the intended request rate right at a window boundary; token bucket smooths this out and better matches how real flash-sale traffic actually behaves (occasional bursts, steady average).
- **Two-layer idempotency check** — a fast application-level lookup handles the common case cheaply, but the actual correctness guarantee is the database's unique constraint on `idempotencyKey`, caught via Prisma's `P2002` error. The fast path alone is not race-safe on its own — this was confirmed by testing concurrent identical requests directly.
- **PostgreSQL as source of truth, Redis as a fast/atomic layer kept in sync separately** — this split is powerful but has a real cost: the two stores can drift if not updated together (see limitations below).
- **Debian-slim over Alpine for the Docker base image** — Prisma's compiled query engine has known OpenSSL compatibility issues on musl-based Alpine images; Debian-slim avoided this without needing version-specific workarounds.
- **Self-contained test suite** — tests seed their own required data in `beforeAll` rather than depending on an external seed script having run first, so `npm test` is fully reproducible with zero setup assumptions, in CI or anywhere else.

---

## The Race Condition Story

This project was deliberately built "broken first, then fixed," to have a real, provable bug-fix story rather than a system that was only ever demonstrated working.

**Before (naive implementation — read stock, then write, with a gap between):**
> 30 concurrent checkout requests fired against a product with only **10 units** of stock in Postgres.
> Result: **28 orders confirmed**, stock count driven to **-18**.

**After (atomic Redis Lua script fix):**
> Same 30-concurrent-request test, same 10 units of stock.
> Result: exactly the correct number of orders confirmed matching available stock, stock count never goes below zero.

**Root cause:** the naive version read `stockCount`, then wrote `stockCount - 1` as two separate operations — leaving a window where many concurrent requests could all read the same "stock available" value before any of them finished writing. The fix moves the check-and-decrement into a single atomic Redis Lua script, closing that window entirely.

---

## Load Test Results

Tested with k6, simulating a flash-sale traffic spike: ramping from 0 to 100 concurrent virtual users over 10s, holding at 100 VUs for 20s, ramping down over 5s.

| Metric | Result |
|---|---|
| Total requests | 21,144 |
| Sustained throughput | ~603 requests/sec |
| p95 latency | **64.56ms** |
| Average latency | 29.28ms |
| Max latency | 228.09ms |
| Checks passed | 100.00% (42,288/42,288) |
| Unexpected errors (5xx) | 0 |

Full raw output: [`load-tests/results.txt`](./load-tests/results.txt)

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Reports server, database, and Redis connectivity |
| `POST` | `/checkout` | Attempts to purchase one unit of a product; rate-limited and idempotency-protected |
| `POST` | `/admin/reset-stock` | Resets a product's stock in both PostgreSQL and Redis together (dev/testing tool — **intentionally unauthenticated**, not for production use as-is) |

**Example checkout request:**
```json
POST /checkout
{
  "productId": "seed-product-1",
  "userId": "<uuid>",
  "idempotencyKey": "<unique-per-attempt>"
}
```

---

## Getting Started

### Prerequisites
- Docker Desktop
- Node.js 20+ (for local, non-Docker development)

### Run with Docker Compose (recommended)
```bash
docker compose up --build
docker compose exec app npx prisma migrate deploy
```
API available at `http://localhost:3000`.

### Run locally (without full Docker)
```bash
npm install
docker compose up -d postgres redis   # just the data layer
npx prisma migrate dev
npm run seed
npm run dev       # in one terminal
npm run worker    # in a second terminal
```

### Environment variables (`.env`)
```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/flashsale"
REDIS_URL="redis://localhost:6379"
PORT=3000
```

---

## Running Tests

```bash
npm test
```
Runs the full Jest + Supertest suite, including an automated concurrency test that proves stock never goes negative under simultaneous requests. Tests are self-contained and seed their own required data — no manual setup needed beyond having Postgres/Redis reachable.

**Manual test scripts** (in `scripts/`, not part of the automated suite):
```bash
npm run test:concurrency   # fires concurrent checkout requests across distinct users
npm run test:idempotency   # fires repeated requests with the same idempotency key
```

**Load test:**
```bash
k6 run load-tests/flash-sale.js
```

CI runs the automated Jest suite on every push via GitHub Actions.

---

## Project Structure

```
flash-sale-checkout/
├── src/
│   ├── index.ts              # Entry point
│   ├── app.ts                 # Express app definition (separated for testability)
│   ├── worker.ts              # BullMQ worker process (order confirmation)
│   ├── lib/                   # Shared singleton clients (Prisma, Redis, Queue)
│   ├── routes/                # Route handlers
│   ├── services/               # Business logic (checkout, stock)
│   └── middleware/             # Rate limiter
├── scripts/                   # Manual dev-tool scripts (not part of Jest suite)
├── tests/                     # Jest + Supertest automated suite
├── load-tests/                 # k6 load test scripts and results
├── prisma/                     # Schema, migrations, seed script
├── docker-compose.yml
├── Dockerfile
└── .github/workflows/ci.yml    # CI pipeline
```

---

## Known Limitations & Assumptions

- **No authentication/authorization implemented** anywhere, including `/admin/reset-stock`, which is intentionally open for local development/testing convenience — not suitable for a real deployment as-is.
- **Postgres/Redis sync is manual, not automatic** — directly editing `Product.stockCount` in the database bypasses Redis's cached value; use `/admin/reset-stock` to update both together. This was discovered as a real bug during development and is a deliberate tradeoff of the two-store design, not an oversight.
- **Single-product focus during development** — the schema supports multiple products, but extensive multi-product testing wasn't performed.
- **No production observability** (structured logging, metrics/monitoring dashboards) implemented yet — see Future Improvements.
- **Load test used a single repeated test user in one run**, meaning a portion of "failed" responses were rate-limit rejections (`429`) rather than out-of-stock (`409`) — still a valid proof of both systems working correctly under load, but worth rerunning with distinct simulated users for a cleaner "realistic shopper" narrative.

---

## Future Improvements

- Structured request logging and basic metrics (response time, status code distribution) for real production observability
- Swagger/OpenAPI documentation at `/docs`
- Multi-product load testing with distinct simulated users per request
- Authentication on admin endpoints
- Deploy to a live environment (Render/Railway) for a public demo link