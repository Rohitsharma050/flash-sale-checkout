import { Queue } from 'bullmq';

const connection = {
  host: 'localhost',
  port: 6379,
};

export const orderConfirmationQueue = new Queue('order-confirmation', { connection });