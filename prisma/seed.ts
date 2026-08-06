import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const product = await prisma.product.upsert({
    where: { id: 'seed-product-1' },
    update: { stockCount: 100 },
    create: {
      id: 'seed-product-1',
      name: 'Limited Edition Sneaker',
      price: 199.99,
      stockCount: 100,
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'testuser@example.com' },
    update: {},
    create: {
      email: 'testuser@example.com',
    },
  });

  console.log('Seeded:', { product, user });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());