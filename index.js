import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/upload.js';
import rpcRoutes from './routes/rpc.js';
import paymentsRoutes from './routes/payments.js';
import adminRoutes from './routes/admin.js';
import dataRoutes from './routes/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Static files for uploads (avatars, university-ids)
const uploadsPath = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(uploadsPath));

app.use('/auth', authRoutes);
app.use('/upload', uploadRoutes);
app.use('/rpc', rpcRoutes);
app.use('/payments', paymentsRoutes);
app.use('/admin', adminRoutes);
app.use('/data', dataRoutes);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
