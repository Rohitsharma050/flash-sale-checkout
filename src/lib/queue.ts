import { Queue } from 'bullmq';
import { URL } from 'url';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');

const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port) || 6379,
};


export const orderConfirmationQueue = new Queue('order-confirmation', { connection });