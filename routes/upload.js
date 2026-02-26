import { Router } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { withUser } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
const uploadDir = path.join(__dirname, '../uploads');

function makeStorage(subDir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const userId = req.user?.id || 'anon';
      const dir = path.join(uploadDir, subDir, userId);
      try {
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err, null);
      }
    },
    filename: (req, file, cb) => {
      const ext = (file.originalname && path.extname(file.originalname)) || '.jpg';
      cb(null, `${Date.now()}${ext}`);
    },
  });
}
const uploadAvatar = multer({ storage: makeStorage('avatars') });
const uploadUniversityId = multer({ storage: makeStorage('university-ids') });

// Ensure base upload dirs exist
try {
  fs.mkdirSync(uploadDir, { recursive: true });
  [path.join(uploadDir, 'avatars'), path.join(uploadDir, 'university-ids')].forEach((d) => {
    fs.mkdirSync(d, { recursive: true });
  });
} catch (e) {
  console.error('Upload dir creation failed:', e);
}

// POST /upload/avatar - single file, auth required
router.post('/avatar', requireAuth, uploadAvatar.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const baseUrl = process.env.API_PUBLIC_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
    const relativePath = `uploads/avatars/${req.user.id}/${req.file.filename}`;
    const url = `${baseUrl.replace(/\/$/, '')}/${relativePath}`;
    await withUser(req.user.id, (client) =>
      client.query('UPDATE public.profiles SET avatar_url = $1 WHERE user_id = $2', [url, req.user.id])
    );
    return res.json({ url });
  } catch (err) {
    console.error('Upload avatar error:', err);
    const msg = err?.message || (err && String(err)) || 'Upload failed';
    return res.status(500).json({ error: msg });
  }
});

// POST /upload/university-id - single file, auth required
router.post('/university-id', requireAuth, uploadUniversityId.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const baseUrl = process.env.API_PUBLIC_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
    const relativePath = `uploads/university-ids/${req.user.id}/${req.file.filename}`;
    const url = `${baseUrl.replace(/\/$/, '')}/${relativePath}`;
    await withUser(req.user.id, (client) =>
      client.query(
        'UPDATE public.profiles SET university_id_url = $1, verification_submitted_at = now() WHERE user_id = $2',
        [url, req.user.id]
      )
    );
    return res.json({ url });
  } catch (err) {
    console.error('Upload university-id error:', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

export default router;
