import prisma from "../lib/prisma";

interface CheckoutInput {
  productId: string;
  userId: string;
  idempotencyKey: string;
}

export async function checkoutNaive({
  productId,
  userId,
  idempotencyKey,
}: CheckoutInput) {
  const product = await prisma.product.findUnique({
    where: {
      id: productId,
    },
  });

  if (!product) {
    throw { status: 404, message: "Product not found" };
  }

  if (product.stockCount <= 0) {
    throw { status: 409, message: "Out of stock" };
  }

  await prisma.product.update({
    where: {
      id: productId,
    },
    data: {
      stockCount: {
        decrement: 1,
      },
    },
  });

  const order = await prisma.order.create({
    data: {
      productId,
      userId,
      idempotencyKey,
      status: "CONFIRMED",
    },
  });

  return order;
}