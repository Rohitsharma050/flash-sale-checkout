import { Router, Request, Response } from 'express';
import { checkoutNaive } from '../services/checkoutService';

const router = Router();

router.post('/checkout', async (req: Request, res: Response) => {
  const { productId, userId, idempotencyKey } = req.body;

  if (!productId || !userId || !idempotencyKey) {
    return res.status(400).json({ error: 'productId, userId, and idempotencyKey are required' });
  }

  try {
    const order = await checkoutNaive({ productId, userId, idempotencyKey });
    res.status(201).json(order);
  } catch (err: any) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
  }
});

export default router;