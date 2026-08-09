import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  scenarios: {
    flash_sale_spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 100 },
        { duration: '20s', target: 100 },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'], // this is the metric that actually matters here
  },
};
const BASE_URL = 'http://localhost:3000';

export default function () {
const userId = '11111111-1111-1111-1111-111111111111'; // reuse your seeded test user's real ID — paste yours from Prisma Studio
  const idempotencyKey = uuidv4();

  const payload = JSON.stringify({
    productId: 'seed-product-1',
    userId: userId,
    idempotencyKey: idempotencyKey,
  });

  const params = {
    headers: { 'Content-Type': 'application/json' },
  };

  const res = http.post(`${BASE_URL}/checkout`, payload, params);

 check(res, {
  'status is 201, 409, or 429': (r) => r.status === 201 || r.status === 409 || r.status === 429,
  'no 5xx errors': (r) => r.status < 500,
});

  sleep(0.1);
}