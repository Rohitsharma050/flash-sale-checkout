import redis from '../lib/redis';
import prisma from '../lib/prisma';

const STOCK_KEY_PREFIX = 'stock:';

export function stockKey(productId: string) {
  return `${STOCK_KEY_PREFIX}${productId}`;
}

// Call this once at startup (or lazily) to sync Redis with the DB's source of truth
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

// The atomic operation: decrement, but never below zero
export async function tryDecrementStock(productId: string): Promise<boolean> {
  const key = stockKey(productId);

  // Lua script = single atomic operation in Redis, no gap for another
  // request to sneak in between the check and the decrement
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

  const result = await redis.eval(luaScript, 1, key);
  return result === 1;
}

export async function restoreStock(productId: string) {
  await redis.incr(stockKey(productId));
}

export async function resetStock(productId: string, newStockCount: number) {
  await prisma.product.update({
    where: { id: productId },
    data: { stockCount: newStockCount },
  });
  await redis.set(stockKey(productId), newStockCount);
}