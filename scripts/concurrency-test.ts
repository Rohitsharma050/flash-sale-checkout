import axios from 'axios';
import { v4 as uuid } from 'uuid';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PRODUCT_ID = 'seed-product-1';
const CONCURRENT_REQUESTS = 30;
const BASE_URL = 'http://localhost:3000';

async function getOrCreateTestUsers(count: number): Promise<string[]> {
  const userIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const email = `loadtest-user-${i}@example.com`;
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email },
    });
    userIds.push(user.id);
  }

  return userIds;
}

async function attemptCheckout(index: number, userId: string) {
  try {
    const res = await axios.post(`${BASE_URL}/checkout`, {
      productId: PRODUCT_ID,
      userId,
      idempotencyKey: uuid(),
    });
    return { index, status: res.status, success: true };
  } catch (err: any) {
    return {
      index,
      status: err.response?.status || 0,
      success: false,
      message: err.response?.data?.error || err.message,
    };
  }
}

async function main() {
  console.log(`Preparing ${CONCURRENT_REQUESTS} distinct test users...`);
  const userIds = await getOrCreateTestUsers(CONCURRENT_REQUESTS);

  console.log(`Firing ${CONCURRENT_REQUESTS} concurrent checkout requests (one per user)...`);
  const results = await Promise.all(
    userIds.map((userId, i) => attemptCheckout(i, userId))
  );

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  console.log(`\nSuccessful checkouts: ${successes.length}`);
  console.log(`Failed/rejected checkouts: ${failures.length}`);
  console.log(`\n--- Now check the DB ---`);
  console.log(`Run: npx prisma studio`);

  await prisma.$disconnect();
}

main();