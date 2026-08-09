# StockGuard — Flash Sale Checkout System

A high-concurrency, backend-only checkout system built to solve the "10,000 people, 200 units" problem: preventing overselling, duplicate orders, and bot abuse when many people try to buy limited stock at the same instant. Built to learn and demonstrate atomic Redis operations, idempotency, token-bucket rate limiting, and async queue processing under real concurrent load.

**Load test results (k6, 100 VUs, 21,144 requests):**
- `p(95) HTTP checkout latency: 64.56ms`
- `Throughput: ~603 requests/sec sustained`
- `Error rate: 0.00% unexpected errors (100% of 42,288 checks passed)`

**The bug this project proves it fixed:** a naive implementation, tested with 30 concurrent requests against 10 units of stock, confirmed 28 orders and drove stock to -18. The atomic-Redis fix, tested identically, never oversold.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Architecture Overview](#2-architecture-overview)
3. [Tech Stack and Why Each Was Chosen](#3-tech-stack-and-why-each-was-chosen)
4. [Database Design](#4-database-design)
5. [Redis — What Lives There and Why](#5-redis--what-lives-there-and-why)
6. [The Concurrency-Safe Checkout Algorithm](#6-the-concurrency-safe-checkout-algorithm)
7. [Idempotency](#7-idempotency)
8. [Rate Limiting — Token Bucket](#8-rate-limiting--token-bucket)
9. [BullMQ Integration](#9-bullmq-integration)
10. [API Reference](#10-api-reference)
11. [Load Testing with k6](#11-load-testing-with-k6)
12. [Project Setup](#12-project-setup)
13. [Interview Q&A — Everything That Could Be Asked](#13-interview-qa--everything-that-could-be-asked)

---

## 1. What This System Does

A limited-stock product goes on sale. Many people try to buy it at the exact same moment — a flash sale, a sneaker drop, a concert ticket release. The system must guarantee three things simultaneously:

1. **Never sell more units than actually exist**, even under massive concurrent load
2. **Never charge/order someone twice** if their request is retried (bad network, client-side retry logic)
3. **Stay fast and available**, even when the checkout endpoint is hammered by traffic — including bad actors trying to flood it

**Core flow:**
1. Client sends a checkout request with `productId`, `userId`, and a client-generated `idempotencyKey`
2. Request passes through rate limiting (per-user token bucket) and an idempotency check
3. Stock is atomically checked and decremented in Redis — a single, uninterruptible operation
4. If successful, the order is persisted in PostgreSQL and stock is synced there too
5. A confirmation job (email, analytics) is pushed onto a queue — the client does **not** wait for this
6. Client gets an immediate response; a separate worker process handles the confirmation job independently

**What "atomic" means concretely:** if stock = 1 and two requests arrive at the same instant, only one can succeed. The check ("is stock > 0?") and the action ("decrement it") happen as one Redis Lua script — there is no gap between them for a second request to slip through.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT                               │
│              (Postman / k6 / Frontend)                      │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              EXPRESS SERVER (port 3000)                     │
│                                                             │
│  POST /checkout                                              │
│    1. rateLimiter middleware  ──────────────────► Redis      │
│    2. idempotency fast-check  ──────────────────► PostgreSQL │
│    3. tryDecrementStock() (Lua script) ─────────► Redis      │
│    4. prisma.order.create() ────────────────────► PostgreSQL │
│    5. orderConfirmationQueue.add() ─────────────► Redis (BullMQ)│
│    6. res.status(201)  ◄── responds IMMEDIATELY               │
│                                                             │
│  GET /health  ───────────────────────► PostgreSQL + Redis    │
└─────────────────────────────────────────────────────────────┘
                                │
                          BullMQ Queue
                     (order-confirmation)
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    WORKER PROCESS                            │
│                                                             │
│  new Worker('order-confirmation', ...)                       │
│    1. Simulate sending confirmation email                     │
│    2. Simulate logging analytics event                        │
│    3. prisma.order.update()  ─────────────────────► PostgreSQL│
└─────────────────────────────────────────────────────────────┘

Infrastructure (Docker):
  ├── PostgreSQL:5432   — persistent data store (orders, users, products)
  └── Redis:6379        — stock locks, rate-limit buckets, BullMQ backend
```

**Why two separate processes (server + worker)?**

If sending the confirmation email ran inside the checkout request itself, the client would wait for that extra work before getting a response. Separating them means the checkout response returns almost immediately (measured p95: 64.56ms), while confirmation work happens independently. If the worker process crashes mid-job, BullMQ (backed by Redis) retains the job and it can be retried — no confirmations are silently lost.

---

## 3. Tech Stack and Why Each Was Chosen

| Technology | Role | Why |
|---|---|---|
| Node.js + TypeScript | Runtime + type safety | Async I/O fits an event-driven checkout flow; TypeScript catches bugs at compile time, especially around request/response shapes |
| Express | HTTP server | Minimal, unopinionated, industry standard |
| PostgreSQL | Primary database | Relational guarantees matter here — specifically, a unique constraint that makes duplicate idempotency keys impossible at the database level |
| Prisma | ORM | Type-safe queries generated from schema, readable migrations, less room for hand-written SQL mistakes |
| Redis (ioredis) | Atomic layer + cache | Sub-millisecond in-memory operations; native support for atomic Lua scripts, which is the actual mechanism that prevents overselling |
| BullMQ | Async job queue | Redis-backed queue — avoids introducing a second piece of infrastructure (like RabbitMQ) since Redis was already required for stock locking |
| Jest + Supertest | Testing | Integration-style tests against a real Express app, real Postgres, real Redis — proving actual concurrency behavior, not just mocked logic |
| k6 | Load testing | Scriptable, metrics-rich, industry standard for performance/concurrency validation |
| Docker Compose | Infrastructure | Reproducible local environment; also matches how this would realistically be deployed |
| GitHub Actions | CI | Runs the full test suite automatically on every push, in a clean environment |

---

## 4. Database Design

### Models and Relationships

```
User ──< Order >── Product
```

**Product** — an item with limited stock. Has many Orders.

**User** — a customer. Has many Orders.

**Order** — one purchase attempt. Belongs to one User and one Product. Has a unique `idempotencyKey` and a `status` (PENDING/CONFIRMED/FAILED).

### Full Schema

```prisma
model Product {
  id         String   @id @default(uuid())
  name       String
  price      Decimal  @db.Decimal(10, 2)
  stockCount Int
  createdAt  DateTime @default(now())

  orders     Order[]

  @@index([name])
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  createdAt DateTime @default(now())

  orders    Order[]
}

model Order {
  id             String      @id @default(uuid())
  productId      String
  userId         String
  idempotencyKey String      @unique
  status         OrderStatus @default(PENDING)
  quantity       Int         @default(1)
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt

  product        Product     @relation(fields: [productId], references: [id])
  user           User        @relation(fields: [userId], references: [id])

  @@index([productId])
  @@index([userId])
}

enum OrderStatus {
  PENDING
  CONFIRMED
  FAILED
}
```

### Key Fields Explained

**`Order.idempotencyKey`** — a client-generated unique string per checkout attempt. Marked `@unique`, which both indexes the column and makes the database reject a second row with the same value. This is the *real* safety net against duplicate orders (see Section 7).

**`Product.stockCount`** — the durable, source-of-truth stock number in PostgreSQL. Redis holds a fast-access copy used for the actual concurrency-safe decrement (see Section 5); this field is updated afterward to keep Postgres in sync.

**`Order.status`** — currently set to `CONFIRMED` immediately on successful checkout. The `PENDING`/`FAILED` states exist in the schema for future use (e.g., if payment processing were added as a separate async step).

### Why `stockCount` Lives Directly on `Product`, Not a Separate Inventory Table

A separate `Inventory` table would make sense for tracking stock across multiple warehouses/locations. That's out of scope here — this project assumes a single, global stock count per product, so keeping it directly on `Product` avoids an unnecessary join for the highest-frequency read in the system.

### Database Indexes

```prisma
@@index([name])        // Product — lookup by name
@@index([productId])   // Order — "all orders for this product"
@@index([userId])      // Order — "all orders for this user"
```

Plus the implicit unique index from `@unique` on `Order.idempotencyKey`, which is the most important index in the schema — it's what makes the database itself refuse duplicate order attempts.

---

## 5. Redis — What Lives There and Why

Redis holds two categories of fast-access data: stock counters and rate-limit buckets.

### Stock Counter

**`stock:<productId>` (Redis String, numeric)**
```
GET stock:seed-product-1
→ "10"
```
A simple integer value, initialized from PostgreSQL the first time it's needed:
```typescript
export async function initStockInRedis(productId: string) {
  const key = stockKey(productId);
  const exists = await redis.exists(key);
  if (!exists) {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (product) {
      await redis.set(key, product.stockCount);
    }
  }
}
```

**Why not query PostgreSQL directly for every stock check?** Under flash-sale load, every single checkout request needs to check stock. Hitting Postgres directly for that, at high frequency, would be slower and would still need extra work (like `SELECT FOR UPDATE`) to be concurrency-safe. Redis gives both speed and, combined with a Lua script, true atomicity.

**The known tradeoff:** Redis and Postgres are two separate stores. If `Product.stockCount` is edited directly in Postgres without going through the app, Redis's cached value goes stale — this was a real bug hit during development (see Section 13), fixed by adding an endpoint that updates both stores together.

### Rate Limit Buckets

**`ratelimit:token:<userId>` (Redis Hash)**
```
HGETALL ratelimit:token:uuid1
→ { tokens: "3.5", lastRefill: "1732000000.123" }
```
Stores each user's current token count and the timestamp of their last refill — enough state to calculate how many tokens have accumulated since the last request, without needing a background job to "tick" the bucket.

**Why a Hash instead of two separate keys?** Both fields (`tokens`, `lastRefill`) need to be read and written together atomically inside the same Lua script — a Hash keeps them as one unit, read via a single `HMGET`.

---

## 6. The Concurrency-Safe Checkout Algorithm

**File:** `src/services/checkoutService.ts` and `src/services/stockService.ts`

### The Naive Version (built first, deliberately)

```typescript
export async function checkoutNaive({ productId, userId, idempotencyKey }: CheckoutInput) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (product.stockCount <= 0) throw { status: 409, message: 'Out of stock' };

  // Gap here: another request can read the same stockCount before this write happens
  await prisma.product.update({
    where: { id: productId },
    data: { stockCount: product.stockCount - 1 },
  });

  return prisma.order.create({ data: { productId, userId, idempotencyKey, status: 'CONFIRMED' } });
}
```

**Proven broken:** 30 concurrent requests against 10 units of stock → 28 orders confirmed, `stockCount` driven to **-18**. The gap between reading `product.stockCount` and writing the update is where every race condition happened — many requests read the same "stock available" value before any of them finished writing.

### The Fix — Atomic Redis Lua Script

```typescript
const luaScript = `
  local stock = tonumber(redis.call('GET', KEYS[1]))
  if stock == nil then
    return -1
  end
  if stock > 0 then
    redis.call('DECR', KEYS[1])
    return 1
  else
    return 0
  end
`;

export async function tryDecrementStock(productId: string): Promise<boolean> {
  const key = stockKey(productId);
  const result = await redis.eval(luaScript, 1, key);
  return result === 1;
}
```

**Why a Lua script specifically:** Redis executes an entire Lua script as one atomic unit — no other command (from any other request) can run in the middle of it. The check (`stock > 0`) and the action (`DECR`) happen as a single, uninterruptible step. This is what actually closes the race condition window — not just moving the same "read then write" pattern from Postgres into application code, which would still be unsafe.

**Result after the fix:** the exact same 30-concurrent-request test against 10 units of stock confirms exactly the right number of orders, and stock never goes negative.

### Full Checkout Flow (Safe Version)

```typescript
export async function checkoutSafe({ productId, userId, idempotencyKey }: CheckoutInput) {
  const existingOrder = await prisma.order.findUnique({ where: { idempotencyKey } });
  if (existingOrder) return existingOrder; // idempotency fast path — see Section 7

  await initStockInRedis(productId);
  const stockAvailable = await tryDecrementStock(productId);
  if (!stockAvailable) throw { status: 409, message: 'Out of stock' };

  try {
    const order = await prisma.order.create({
      data: { productId, userId, idempotencyKey, status: 'CONFIRMED' },
    });
    await prisma.product.update({
      where: { id: productId },
      data: { stockCount: { decrement: 1 } },
    });
    await orderConfirmationQueue.add('confirm-order', { orderId: order.id, userId, productId });
    return order;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await restoreStock(productId); // give back the Redis decrement — see Section 7
      const raceWinnerOrder = await prisma.order.findUnique({ where: { idempotencyKey } });
      if (raceWinnerOrder) return raceWinnerOrder;
    }
    await restoreStock(productId);
    throw err;
  }
}
```

---

## 7. Idempotency

**The problem:** a client's network is slow, or their app retries automatically after a timeout, even though the server actually processed the first request successfully. Without protection, that retry creates a second, duplicate order.

**Two layers of protection, only one of which is a real guarantee:**

**Layer 1 — Fast path (optimization, not a guarantee on its own):**
```typescript
const existingOrder = await prisma.order.findUnique({ where: { idempotencyKey } });
if (existingOrder) return existingOrder;
```
Handles the common case cheaply — a retry that arrives after the first request already finished just gets the same order back immediately, without wasting a Redis stock decrement.

**Layer 2 — Database unique constraint (the actual guarantee):**
```prisma
idempotencyKey String @unique
```
Two identical requests could both pass Layer 1's check at nearly the same instant, before either has finished writing. When both then try to `prisma.order.create()` with the same `idempotencyKey`, PostgreSQL's unique constraint rejects the second one with a `P2002` error code — caught explicitly in `checkoutSafe`, which then restores the wrongly-decremented stock and returns the winning order instead.

**Why both layers, if Layer 2 is the real guarantee?** Layer 1 avoids doing unnecessary work (a Redis stock decrement, a full order-create attempt) in the common, non-racing case. Layer 2 is what makes the system actually correct under true concurrency — this distinction ("application-level checks are for the common case, database constraints are for correctness") is a good one to be able to explain clearly.

**Verified:** 5 concurrent requests with the identical `idempotencyKey` → exactly 1 order created, stock decremented by exactly 1, not 5.

---

## 8. Rate Limiting — Token Bucket

**Why rate limiting at all:** without it, a single bad actor (bot, scalper script) can flood the checkout endpoint and unfairly consume all available stock before real users get a chance.

**Why token bucket over a simpler fixed-window counter:** a fixed window (e.g., "max 5 requests per 10 seconds") has a boundary-burst flaw — a user can send 5 requests at the 9.9-second mark, then another 5 immediately after the window resets at 10.1 seconds — 10 requests in 200ms, technically compliant with the rule but not the intent. Token bucket refills gradually and continuously, closing that loophole while still allowing small natural bursts.

### Implementation

```typescript
const TOKEN_BUCKET_SCRIPT = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])

  local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')
  local tokens = tonumber(bucket[1])
  local lastRefill = tonumber(bucket[2])

  if tokens == nil then
    tokens = capacity
    lastRefill = now
  end

  local elapsed = math.max(0, now - lastRefill)
  local refillAmount = elapsed * refillRate
  tokens = math.min(capacity, tokens + refillAmount)

  local allowed = 0
  if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
  end

  redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
  redis.call('EXPIRE', key, 3600)

  return { allowed, tokens }
`;
```

**Why this is also a Lua script, same as the stock decrement:** the read-refill-consume sequence needs to happen as one atomic step for the same reason stock decrementing does — without atomicity, two concurrent requests from the same user could both read "1 token available" and both be allowed through, when only one token actually existed. This reuses the exact same atomicity principle established for stock control, which keeps the codebase's approach to concurrency consistent throughout.

**Capacity and refill rate:** `BUCKET_CAPACITY = 5` (max burst), `REFILL_RATE = 0.5` tokens/sec (1 token every 2 seconds) — tunable constants depending on desired strictness.

---

## 9. BullMQ Integration

### Why BullMQ

Sending a confirmation email or logging an analytics event doesn't need to block the checkout response. Moving this work off the request path keeps checkout latency low regardless of how slow that downstream work is.

**Why BullMQ specifically, not RabbitMQ:** Redis was already a required dependency for stock locking and rate limiting. BullMQ is a Redis-backed queue library, so using it avoided introducing an entirely separate message broker just to prove the same "decouple slow work" concept. This was a deliberate infrastructure-minimization tradeoff, not a default choice.

### Publisher (inside the checkout flow)

```typescript
await orderConfirmationQueue.add('confirm-order', {
  orderId: order.id,
  userId,
  productId,
});
```
This call is awaited, but only for the fast operation of *adding* the job to Redis — not for the job actually running.

### Worker (separate process)

```typescript
const worker = new Worker('order-confirmation', async (job: Job) => {
  const { orderId, userId, productId } = job.data;

  console.log(`[Worker] Sending confirmation email for order ${orderId} to user ${userId}`);
  await new Promise((resolve) => setTimeout(resolve, 500)); // simulated

  console.log(`[Worker] Logging analytics: purchase event for product ${productId}`);

  await prisma.order.update({ where: { id: orderId }, data: { updatedAt: new Date() } });
}, { connection });
```

Runs as a completely separate Node process (`npm run worker`), independent of the API server (`npm run dev`). Verified: the checkout API response returns before the worker's simulated 500ms delay even completes — proving the decoupling actually works, not just that the code compiles.

---

## 10. API Reference

### `POST /checkout`
Attempts to buy one unit of a product.

**Body:**
```json
{
  "productId": "seed-product-1",
  "userId": "uuid",
  "idempotencyKey": "unique-per-attempt"
}
```

**Response 201 (success):**
```json
{ "id": "order-uuid", "status": "CONFIRMED", "productId": "...", "userId": "...", ... }
```

**Response 409 (out of stock):**
```json
{ "error": "Out of stock" }
```

**Response 429 (rate limited):**
```json
{ "error": "Too many requests, slow down", "tokensRemaining": 0 }
```

**Note:** `idempotencyKey` must be unique per distinct purchase attempt, generated client-side (typically a UUID). Reusing the same key intentionally returns the original order, not an error.

### `GET /health`
Reports server, database, and Redis connectivity.
```json
{ "status": "ok", "db": "connected", "redis": "PONG" }
```

### `POST /admin/reset-stock`
Resets a product's stock in both PostgreSQL and Redis together — a dev/testing tool, intentionally unauthenticated for local use only.
```json
{ "productId": "seed-product-1", "stockCount": 10 }
```

---

## 11. Load Testing with k6

### Test Type: Ramping VU Test

```
VUs
100 |          ___________
    |         /           \
    |        /             \
  0 |_______/               \____
    0s     10s              30s  35s
```
- 0→10s: ramp up to 100 virtual users
- 10→30s: hold at 100 VUs
- 30→35s: ramp down

### What One VU Does Per Iteration

```
1. Generate a fresh idempotencyKey (UUID)
2. POST /checkout with productId, userId, idempotencyKey
3. Assert status is 201, 409, or 429 (all are "correct" outcomes)
4. Assert status is never 5xx
5. Sleep 0.1s
6. Repeat
```

### Metrics Explained

**`http_req_duration` p(95) = 64.56ms** — 95% of all checkout requests completed within 64.56ms, even under 100 concurrent virtual users.

**`checks` = 100.00% (42,288/42,288)** — every request returned a status the app intentionally handles (`201`/`409`/`429`), never an unexpected error.

**`http_reqs` = 21,144 at ~603/sec** — total throughput sustained during the test.

### A Real Gotcha Worth Knowing

k6's built-in `http_req_failed` metric treats **any non-2xx/3xx response as "failed" by default** — including intentional `409`/`429` responses. In an early run, this showed `http_req_failed: 100%` even though the app was behaving correctly, because almost every response was a deliberate `409`/`429`. The fix: replace the `http_req_failed` threshold with a `checks` threshold, since `checks` reflects the app's actual custom-defined correctness (`status is 201, 409, or 429`), not k6's generic HTTP-status assumption.

```javascript
thresholds: {
  http_req_duration: ['p(95)<500'],
  checks: ['rate>0.99'],  // not http_req_failed
}
```

### Running the Test

```bash
# Reset stock before each run
curl -X POST http://localhost:3000/admin/reset-stock \
  -H "Content-Type: application/json" \
  -d '{"productId":"seed-product-1","stockCount":100}'

k6 run load-tests/flash-sale.js
```

---

## 12. Project Setup

### Prerequisites
- Node.js 20+
- Docker Desktop
- k6 (`winget install k6` on Windows, `brew install k6` on Mac)

### Environment Variables

Create `.env`:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/flashsale"
REDIS_URL="redis://localhost:6379"
PORT=3000
```

### First-Time Setup

```bash
npm install
docker compose up -d
npx prisma migrate dev --name init
npx prisma generate
npm run seed
```

### Running

```bash
npm run dev       # Express API server
npm run worker    # BullMQ worker (separate terminal)
```

### Testing

```bash
npm test                    # full Jest + Supertest suite
npm run test:concurrency    # manual script proving no overselling
npm run test:idempotency    # manual script proving no duplicate orders
```

### npm Scripts

```
npm run dev              start API server
npm run worker           start BullMQ worker
npm run build             compile TypeScript
npm run seed              seed test product + user
npm test                  run Jest suite
npm run test:concurrency  manual concurrency proof script
npm run test:idempotency  manual idempotency proof script
```

---

## 13. Interview Q&A — Everything That Could Be Asked

### Architecture

**Q: Why did you separate the API server and worker into two processes?**
A: Sending confirmation emails / logging analytics doesn't need to block the checkout response. If it ran synchronously, every checkout would wait for that extra work. Separating them keeps checkout latency low (measured p95: 64.56ms) regardless of how long confirmation processing takes. If the worker crashes, BullMQ retains the job in Redis for retry — no confirmations are silently lost.

**Q: Why BullMQ instead of RabbitMQ?**
A: Redis was already a required dependency for stock locking and rate limiting. BullMQ is Redis-backed, so I avoided adding an entirely separate message broker just to prove the same "decouple slow work" concept. A real tradeoff, not a default — RabbitMQ has stronger delivery guarantees in some scenarios, but wasn't necessary for this project's scope.

**Q: What happens if PostgreSQL and Redis disagree on stock?**
A: This is a real, known limitation. Redis is the fast, atomic layer used for the actual concurrency-safe decrement; Postgres is the durable record, updated right after. If Postgres is edited directly (bypassing the app), Redis's cached value goes stale. I hit this exact bug during development and fixed it with an endpoint that updates both stores together — but a fully robust solution would need a reconciliation process.

### Redis / Concurrency

**Q: Explain exactly how your Redis Lua script prevents overselling.**
A: The script combines "check if stock > 0" and "decrement stock" into one atomic operation. Redis executes the entire script as a single, uninterruptible unit — no other command can run in the middle of it. Two concurrent requests calling this: Redis processes them one after another internally (single-threaded command execution), so the second request always sees the already-decremented value, never the stale one.

**Q: Why not just use a PostgreSQL transaction with `SELECT FOR UPDATE`?**
A: That's a valid alternative and would also work. I chose Redis because it's faster under very high-frequency concurrent access — Redis operations are in-memory and generally quicker than acquiring row locks in Postgres under heavy load. Postgres row locks would also cause requests to queue and wait on each other more than an in-memory atomic operation does.

**Q: What's the actual proof this works, not just a claim?**
A: I built the naive version first, deliberately. Tested it with 30 concurrent requests against 10 units of stock — it oversold, confirming 28 orders and driving stock to -18. I then implemented the Redis Lua script fix and reran the exact same test — it correctly stopped at the right count every time, stock never went negative. This before/after comparison is documented and reproducible.

**Q: What if Redis goes down?**
A: Currently, checkout would fail entirely, since Redis is a required dependency for the stock check. This is a real limitation — a production system would need Redis replication/failover (e.g., Redis Sentinel or Cluster) to avoid a single point of failure.

### Idempotency

**Q: Why two layers of idempotency checking?**
A: The first (application-level `findUnique` lookup) is cheap and handles the common case — a retry that arrives after the original request already completed. But it's not race-safe alone: two identical requests could both pass that check before either finishes writing. The database's unique constraint on `idempotencyKey` is the real guarantee — Postgres enforces uniqueness atomically regardless of timing, and I catch that specific error (`P2002`) to handle the race gracefully.

**Q: What did you actually test to prove idempotency works?**
A: Fired 5 concurrent requests with the identical `idempotencyKey`. Result: exactly 1 order created, all 5 requests returned the same order ID, and stock decremented by exactly 1 — not 5.

### Rate Limiting

**Q: Why token bucket instead of a fixed window counter?**
A: Fixed window has a boundary-burst flaw — a user could send the max allowed requests right at the end of one window, then immediately send the max again at the start of the next, getting up to 2x the intended rate in a short burst. Token bucket refills gradually and continuously, so there's no exploitable boundary, while still allowing small natural bursts.

**Q: Is your rate limiter safe under concurrency too?**
A: Yes — same principle as the stock decrement. The entire read-refill-consume sequence runs as one atomic Redis Lua script, so two concurrent requests from the same user can't both be incorrectly allowed through when only one token was actually available.

### Testing

**Q: Why do your tests hit a real database and Redis instead of mocks?**
A: The core value of this project is proving real concurrency safety. A mocked database would only prove my code *calls* the right functions — it wouldn't actually exercise the atomic Lua script or the database's unique constraint under real parallel execution. My most important test fires 10 real concurrent requests against 5 units of real stock and asserts exactly 5 succeed.

**Q: What real bug did you hit while writing tests?**
A: My rate limiter (scoped per user) was interfering with my concurrency test, because earlier tests in the same file had already consumed that user's rate-limit tokens by the time the concurrency test ran. Fixed by resetting the rate limiter's Redis key between tests. It's a good example of how two independent safety systems can accidentally mask each other's test results without careful test isolation.

**Q: Why did your tests fail in CI but pass locally?**
A: CI spins up a completely fresh, empty database every run — my tests originally assumed a product already existed from a local manual seed I'd run once. I fixed it by making the test suite self-contained: it creates its own required test data inside `beforeAll`, so `npm test` works identically anywhere with zero external setup assumptions.

### Docker / Infrastructure

**Q: What real Docker issues did you hit?**
A: Two. First, Prisma's compiled query engine crashed on the default `node:alpine` base image with a missing OpenSSL library error — fixed by switching to `node:slim` (Debian-based), which doesn't have Alpine's musl/OpenSSL compatibility problems. Second, I had a hardcoded `localhost` in my BullMQ Redis connection config that worked locally (Redis was reachable at localhost via Docker's port mapping) but failed inside Docker Compose's internal network, where containers must reach each other by service name. Fixed by parsing the connection details from `REDIS_URL` instead of hardcoding them.

**Q: How do your containers talk to each other?**
A: Through Docker Compose's internal network, using service names as hostnames — e.g., the app connects to `redis://redis:6379` and `postgresql://...@postgres:5432/...`, not `localhost`. This is a common early mistake and a good thing to be able to explain clearly.

### Load Testing

**Q: What does p(95) mean and why report it instead of average?**
A: 95th percentile — sort all latency measurements fastest to slowest, p(95) is the value at the 95% mark, meaning 95% of requests were faster than this. It's more meaningful than an average because a few slow outliers can skew an average significantly, while p(95) still reflects what most real users actually experience.

**Q: Why did `http_req_failed` show 100% even though your app worked correctly?**
A: k6's default `http_req_failed` metric treats any non-2xx/3xx status as a failure — but my app intentionally returns `409` (out of stock) and `429` (rate limited) as correct, expected responses under heavy load. I fixed this by switching my threshold to k6's `checks` metric instead, which reflects my own custom-defined correctness logic rather than a generic HTTP-status assumption.

---

## Appendix: File Structure

```
├── prisma/
│   ├── schema.prisma           database models and enums
│   └── seed.ts                 seeds one test product + one test user
├── scripts/
│   ├── concurrency-test.ts     manual script proving no overselling under load
│   └── idempotency-test.ts     manual script proving no duplicate orders
├── load-tests/
│   ├── flash-sale.js           k6 load test script
│   └── results.txt              raw k6 output from the documented run
├── src/
│   ├── index.ts                 entry point (calls app.listen)
│   ├── app.ts                   Express app definition (separated for testability)
│   ├── worker.ts                 BullMQ worker process entry point
│   ├── lib/
│   │   ├── prisma.ts             Prisma client singleton
│   │   ├── redis.ts              ioredis client singleton
│   │   └── queue.ts               BullMQ Queue instance
│   ├── routes/
│   │   └── checkout.ts            POST /checkout route handler
│   ├── services/
│   │   ├── checkoutService.ts     checkoutNaive (Step 4 reference) and checkoutSafe (real logic)
│   │   └── stockService.ts        Redis Lua scripts: tryDecrementStock, restoreStock, resetStock
│   └── middleware/
│       └── rateLimiter.ts          token bucket rate limiter (Lua script)
├── tests/
│   └── checkout.test.ts            Jest + Supertest automated suite
├── .github/workflows/
│   └── ci.yml                      GitHub Actions CI pipeline
├── docker-compose.yml                Postgres + Redis + app containers
└── Dockerfile                        multi-stage build (Debian-slim base)
```
