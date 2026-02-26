import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// POST /admin/set-25-rides-unlock-spin - set a user to 25 completed rides and unlock spin (admin only)
router.post('/set-25-rides-unlock-spin', requireAuth, async (req, res) => {
  try {
    const roleRow = await query(
      "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin'",
      [req.user.id]
    );
    if (roleRow.rows.length === 0) {
      return res.status(403).json({ error: 'Forbidden: admin only' });
    }
    const userId = req.body?.user_id;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'user_id required' });
    }
    const update = await query(
      `UPDATE public.profiles
       SET total_connections = 25, spin_used = false, rewards_enabled = true
       WHERE user_id = $1
       RETURNING user_id`,
      [userId]
    );
    if (update.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found' });
    }
    return res.json({ success: true, user_id: userId, message: '25 rides set; spin unlocked' });
  } catch (err) {
    console.error('set-25-rides-unlock-spin error:', err);
    return res.status(500).json({ error: err.message || 'Failed' });
  }
});

// GET /admin/signed-id-url?path=userId/filename - admin or owner can get URL for university ID file
router.get('/signed-id-url', requireAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'File path is required' });
    }
    const match = filePath.match(/^([a-f0-9-]{36})\/[^/]+$/i);
    if (!match) {
      return res.status(400).json({ error: 'Invalid file path format' });
    }
    const fileOwnerId = match[1];
    const requesterId = req.user.id;
    const roleRow = await query(
      "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin'",
      [requesterId]
    );
    const isAdmin = roleRow.rows.length > 0;
    const isOwner = requesterId === fileOwnerId;
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const baseUrl = process.env.API_PUBLIC_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
    const url = `${baseUrl.replace(/\/$/, '')}/uploads/university-ids/${filePath}`;
    return res.json({ signedUrl: url });
  } catch (err) {
    console.error('Signed ID URL error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate URL' });
  }
});

export default router;
