import request from 'supertest';
import app from '../src/app';
import prisma from '../src/lib/prisma';
import redis from '../src/lib/redis';
import { resetStock } from '../src/services/stockService';
import { resetRateLimit } from '../src/middleware/rateLimiter';
import { orderConfirmationQueue } from '../src/lib/queue';
import { v4 as uuid } from 'uuid';

const PRODUCT_ID = 'seed-product-1';
let testUserId: string;

beforeAll(async () => {
  const user = await prisma.user.upsert({
    where: { email: 'jest-test-user@example.com' },
    update: {},
    create: { email: 'jest-test-user@example.com' },
  });
  testUserId = user.id;

  // Self-contained: ensure the product exists regardless of external seeding
  await prisma.product.upsert({
    where: { id: PRODUCT_ID },
    update: {},
    create: {
      id: PRODUCT_ID,
      name: 'Test Product',
      price: 99.99,
      stockCount: 10,
    },
  });
});

beforeEach(async () => {
  await resetStock(PRODUCT_ID, 10);
  await resetRateLimit(testUserId);
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
  await orderConfirmationQueue.close();
});


describe('POST /checkout', () => {
  it('successfully checks out when stock is available', async () => {
    const res = await request(app).post('/checkout').send({
      productId: PRODUCT_ID,
      userId: testUserId,
      idempotencyKey: uuid(),
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CONFIRMED');
  });

  it('rejects checkout when out of stock', async () => {
    await resetStock(PRODUCT_ID, 0);

    const res = await request(app).post('/checkout').send({
      productId: PRODUCT_ID,
      userId: testUserId,
      idempotencyKey: uuid(),
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Out of stock');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/checkout').send({
      productId: PRODUCT_ID,
    });

    expect(res.status).toBe(400);
  });

  it('returns the same order for a repeated idempotency key', async () => {
    const key = uuid();

    const first = await request(app).post('/checkout').send({
      productId: PRODUCT_ID,
      userId: testUserId,
      idempotencyKey: key,
    });

    const second = await request(app).post('/checkout').send({
      productId: PRODUCT_ID,
      userId: testUserId,
      idempotencyKey: key,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).toBe(second.body.id); // same order, not a duplicate
  });

  it('never oversells under concurrent requests', async () => {
    await resetStock(PRODUCT_ID, 5);
      await resetRateLimit(testUserId);
    const requests = Array.from({ length: 10 }, () =>
      request(app).post('/checkout').send({
        productId: PRODUCT_ID,
        userId: testUserId,
        idempotencyKey: uuid(),
      })
    );

    const results = await Promise.all(requests);
    const successful = results.filter((r) => r.status === 201);

    expect(successful.length).toBe(5); // exactly matches stock, never more
  });
});