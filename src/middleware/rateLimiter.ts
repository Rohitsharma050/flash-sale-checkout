
// // <------------ Fixed window rate limitting technique -------->
// import { Request, Response, NextFunction } from 'express';
// import redis from '../lib/redis';

// const WINDOW_SECONDS = 15;   // time window
// const MAX_REQUESTS = 5;      // max requests per user per window

// export async function rateLimiter(req: Request, res: Response, next: NextFunction) {
//   const userId = req.body?.userId;

//   if (!userId) {
//     return res.status(400).json({ error: 'userId is required' });
//   }

//   const key = `ratelimit:${userId}`;

//   // INCR is atomic in Redis — safe under concurrency, same principle as stock decrement
//   const currentCount = await redis.incr(key);

//   if (currentCount === 1) {
//     // first request in this window — start the expiry clock
//     await redis.expire(key, WINDOW_SECONDS);
//   }

//   if (currentCount > MAX_REQUESTS) {
//     const ttl = await redis.ttl(key);
//     return res.status(429).json({
//       error: 'Too many requests, slow down',
//       retryAfterSeconds: ttl,
//     });
//   }

//   next();
// }



// // <------------ Token bukket rate  limitting technique -------->
import { Request, Response, NextFunction } from 'express';
import redis from '../lib/redis';

const BUCKET_CAPACITY = 5;       // max tokens (burst allowance)
const REFILL_RATE = 0.5;         // tokens added per second (1 token every 2s)

// Atomic: read current tokens, refill based on elapsed time, try to consume one
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

  -- Refill based on time elapsed since last request
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

export async function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const userId = req.body?.userId;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const key = `ratelimit:token:${userId}`;
  const now = Date.now() / 1000; // seconds, for readable math

  const result = (await redis.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    key,
    BUCKET_CAPACITY,
    REFILL_RATE,
    now
  )) as [number, number];

  const [allowed, remainingTokens] = result;

  if (!allowed) {
    return res.status(429).json({
      error: 'Too many requests, slow down',
      tokensRemaining: 0,
    });
  }

  next();
}