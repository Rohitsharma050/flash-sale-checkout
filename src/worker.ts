import { Worker, Job } from 'bullmq';
import dotenv from 'dotenv';
import prisma from './lib/prisma';

dotenv.config();

const connection = {
  host: 'localhost',
  port: 6379,
};

const worker = new Worker(
  'order-confirmation',
  async (job: Job) => {
    const { orderId, userId, productId } = job.data;

    // Simulate sending a confirmation email
    console.log(`[Worker] Sending confirmation email for order ${orderId} to user ${userId}`);
    await new Promise((resolve) => setTimeout(resolve, 500)); // simulate network delay

    // Simulate logging an analytics event
    console.log(`[Worker] Logging analytics: purchase event for product ${productId}`);

    // Optional: mark something in the DB to prove this ran, e.g. a `confirmedAt` timestamp
    await prisma.order.update({
      where: { id: orderId },
      data: { updatedAt: new Date() },
    });

    console.log(`[Worker] Done processing order ${orderId}`);
  },
  { connection }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
});

console.log('Worker started, listening for order-confirmation jobs...');