import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'stone-secret-change-me';
const JWT_EXPIRES = '8h';

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  // Check against env-based admin credentials
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';

  if (username.toLowerCase() !== adminUser.toLowerCase() || password !== adminPass) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  // Find or fall back to first ADMIN user in DB for display info
  const dbUser = await prisma.user.findFirst({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, name: true, role: true },
  }) ?? { id: 'admin', name: 'Administrator', role: 'ADMIN' };

  const token = jwt.sign(
    { userId: dbUser.id, name: dbUser.name, role: dbUser.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES },
  );

  res.json({
    token,
    user: { id: dbUser.id, name: dbUser.name, role: dbUser.role },
  });
});

// GET /api/auth/me  – validate current token
router.get('/me', (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    res.json({ user: decoded });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// POST /api/auth/logout  – client-side only; just acknowledge
router.post('/logout', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

export default router;
