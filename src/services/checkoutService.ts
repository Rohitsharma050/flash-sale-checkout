// import prisma from "../lib/prisma";

// interface CheckoutInput {
//   productId: string;
//   userId: string;
//   idempotencyKey: string;
// }

// export async function checkoutNaive({
//   productId,
//   userId,
//   idempotencyKey,
// }: CheckoutInput) {
//   const product = await prisma.product.findUnique({
//     where: {
//       id: productId,
//     },
//   });

//   if (!product) {
//     throw { status: 404, message: "Product not found" };
//   }

//   if (product.stockCount <= 0) {
//     throw { status: 409, message: "Out of stock" };
//   }

//   await prisma.product.update({
//     where: {
//       id: productId,
//     },
//     data: {
//       stockCount: {
//         decrement: 1,
//       },
//     },
//   });

//   const order = await prisma.order.create({
//     data: {
//       productId,
//       userId,
//       idempotencyKey,
//       status: "CONFIRMED",
//     },
//   });

//   return order;
// }



// <------------  Safe checkout system with redis lua script preventing overselling in a concurrent system    ------------->


// import prisma from '../lib/prisma';
// import { tryDecrementStock, restoreStock, initStockInRedis } from './stockService';

// interface CheckoutInput {
//   productId: string;
//   userId: string;
//   idempotencyKey: string;
// }

// export async function checkoutSafe({ productId, userId, idempotencyKey }: CheckoutInput) {
//   await initStockInRedis(productId); // ensures Redis has a value to work with

//   const stockAvailable = await tryDecrementStock(productId);

//   if (!stockAvailable) {
//     throw { status: 409, message: 'Out of stock' };
//   }

//   try {
//     const order = await prisma.order.create({
//       data: {
//         productId,
//         userId,
//         idempotencyKey,
//         status: 'CONFIRMED',
//       },
//     });

//     // Keep Postgres in sync as the durable system of record
//     await prisma.product.update({
//       where: { id: productId },
//       data: { stockCount: { decrement: 1 } },
//     });

//     return order;
//   } catch (err) {
//     // If the DB write fails after we already reserved stock in Redis, give it back
//     await restoreStock(productId);
//     throw err;
//   }
// }



// <------------  with returning the same order when multiple requests are made from a single idemporency key   ------------->

import prisma from '../lib/prisma';
import { tryDecrementStock, restoreStock, initStockInRedis } from './stockService';
import { Prisma } from '@prisma/client';
import { orderConfirmationQueue } from '../lib/queue';
interface CheckoutInput {
  productId: string;
  userId: string;
  idempotencyKey: string;
}

export async function checkoutSafe({ productId, userId, idempotencyKey }: CheckoutInput) {
  // 1. Fast path: if this exact request already succeeded before, just return it.
  //    Handles the common case (client retry after a slow/lost response).
  const existingOrder = await prisma.order.findUnique({
    where: { idempotencyKey },
  });
  if (existingOrder) {
    return existingOrder;
  }

  await initStockInRedis(productId);

  const stockAvailable = await tryDecrementStock(productId);
  if (!stockAvailable) {
    throw { status: 409, message: 'Out of stock' };
  }

  try {
    const order = await prisma.order.create({
      data: {
        productId,
        userId,
        idempotencyKey,
        status: 'CONFIRMED',
      },
    });

    await prisma.product.update({
      where: { id: productId },
      data: { stockCount: { decrement: 1 } },
    });

    // Fire-and-forget: checkout response doesn't wait for this
  await orderConfirmationQueue.add('confirm-order', {
  orderId: order.id,
  userId,
  productId,
  
},
 {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000
    }
  }
);
    return order;
  } catch (err) {
    // 2. Slow path: two requests with the SAME idempotency key raced past the
    //    check above at the same time. The DB's unique constraint catches it
    //    here — this is our real safety net, not just the check above.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await restoreStock(productId); // we decremented for nothing, give it back
      const raceWinnerOrder = await prisma.order.findUnique({ where: { idempotencyKey } });
      if (raceWinnerOrder) return raceWinnerOrder;
    }

    await restoreStock(productId);
    throw err;
  }
}