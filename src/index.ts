import express from 'express';
import dotenv from 'dotenv';
import prisma from './lib/prisma';
import redis from './lib/redis';
import checkoutRouter from './routes/checkout';

dotenv.config();

const app = express();
app.use(express.json());
app.use('/', checkoutRouter);

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const redisPing = await redis.ping();
    res.json({ status: 'ok', db: 'connected', redis: redisPing });
  } catch (err) {
    res.status(500).json({ status: 'error', message: (err as Error).message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});