import axios from 'axios';
import { v4 as uuid } from 'uuid';

const PRODUCT_ID = 'seed-product-1';
const USER_ID = '076c51a4-c1b3-4f2e-ab0f-75c78a505d9f'; // from Prisma Studio
const CONCURRENT_REQUESTS = 30; // more requests than stock available
const BASE_URL = 'http://localhost:3000';

async function attemptCheckout(index: number) {
  try {
    const res = await axios.post(`${BASE_URL}/checkout`, {
      productId: PRODUCT_ID,
      userId: USER_ID,
      idempotencyKey: uuid(), // unique per request, simulating distinct purchases
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
  console.log(`Firing ${CONCURRENT_REQUESTS} concurrent checkout requests...`);

  const results = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => attemptCheckout(i))
  );

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  console.log(`\nSuccessful checkouts: ${successes.length}`);
  console.log(`Failed/rejected checkouts: ${failures.length}`);
  console.log(`\n--- Now check the DB ---`);
  console.log(`Run: npx prisma studio`);
  console.log(`Expected if broken: stockCount is negative, or successful orders > initial stock`);
}

main();