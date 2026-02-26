import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireAuth, signToken } from '../middleware/auth.js';

const router = Router();
const SALT_ROUNDS = 10;
const FOUNDER_EMAIL = 'founder@yaatrabuddy.com';

// POST /auth/signup - create auth_users + profiles
router.post('/signup', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Email, password, and full_name are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const emailLower = email.toLowerCase().trim();
    const existing = await query(
      'SELECT id FROM public.auth_users WHERE email = $1',
      [emailLower]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This email is already registered' });
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = crypto.randomUUID();
    await query('BEGIN');
    try {
      await query(
        `INSERT INTO public.auth_users (id, email, password_hash, email_confirmed_at)
         VALUES ($1, $2, $3, now())`,
        [id, emailLower, passwordHash]
      );
      await query(
        `INSERT INTO public.profiles (user_id, full_name, email)
         VALUES ($1, $2, $3)`,
        [id, (full_name || '').trim(), emailLower]
      );
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
    const token = signToken({ sub: id, email: emailLower });
    return res.json({ user: { id, email: emailLower }, token });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: err.message || 'Sign up failed' });
  }
});

// POST /auth/signin
router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const emailLower = email.toLowerCase().trim();
    const r = await query(
      'SELECT id, email, password_hash FROM public.auth_users WHERE email = $1',
      [emailLower]
    );
    if (r.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || '');
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = signToken({ sub: user.id, email: user.email });
    return res.json({ user: { id: user.id, email: user.email }, token });
  } catch (err) {
    console.error('Signin error:', err);
    return res.status(500).json({ error: err.message || 'Sign in failed' });
  }
});

// POST /auth/request-password-reset
router.post('/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    const emailLower = email.toLowerCase().trim();
    const exists = await query('SELECT id FROM public.auth_users WHERE email = $1', [emailLower]);
    if (exists.rows.length === 0) {
      return res.json({ success: true, message: 'If an account exists with this email, you will receive a password reset code.' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const tokenHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      'UPDATE public.password_reset_tokens SET used = true WHERE email = $1 AND used = false',
      [emailLower]
    );
    await query(
      `INSERT INTO public.password_reset_tokens (email, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [emailLower, tokenHash, expiresAt]
    );
    if (process.env.RESEND_API_KEY) {
      const Resend = (await import('resend')).default;
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.RESEND_FROM || 'YaatraBuddy <onboarding@resend.dev>',
        to: [email],
        subject: 'Reset your YaatraBuddy password',
        html: `<p>Your reset code is: <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
      });
    } else {
      console.log('Password reset OTP (no RESEND_API_KEY):', otp);
    }
    return res.json({ success: true, message: 'If an account exists with this email, you will receive a password reset code.' });
  } catch (err) {
    console.error('Request password reset error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send reset code' });
  }
});

// POST /auth/verify-reset-token
router.post('/verify-reset-token', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'Email, OTP, and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'Invalid OTP format' });
    }
    const emailLower = email.toLowerCase().trim();
    const tokenHash = crypto.createHash('sha256').update(otp).digest('hex');
    const r = await query(
      `SELECT id, attempts FROM public.password_reset_tokens
       WHERE email = $1 AND used = false AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [emailLower]
    );
    if (r.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset code. Please request a new one.' });
    }
    const row = r.rows[0];
    if (row.attempts >= 5) {
      await query('UPDATE public.password_reset_tokens SET used = true WHERE id = $1', [row.id]);
      return res.status(400).json({ error: 'Too many failed attempts. Please request a new reset code.' });
    }
    const tokenRow = await query('SELECT token_hash FROM public.password_reset_tokens WHERE id = $1', [row.id]);
    if (tokenRow.rows[0].token_hash !== tokenHash) {
      await query('UPDATE public.password_reset_tokens SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      const remaining = 5 - row.attempts - 1;
      return res.status(400).json({
        error: `Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
      });
    }
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await query('UPDATE public.auth_users SET password_hash = $1 WHERE email = $2', [passwordHash, emailLower]);
    await query('UPDATE public.password_reset_tokens SET used = true WHERE id = $1', [row.id]);
    await query('SELECT public.cleanup_expired_reset_tokens()');
    return res.json({ success: true, message: 'Password has been reset successfully. You can now sign in with your new password.' });
  } catch (err) {
    console.error('Verify reset token error:', err);
    return res.status(500).json({ error: err.message || 'Failed to reset password' });
  }
});

// POST /admin/ensure-admin - grant admin to founder email (requires auth). Uses direct query to bypass RLS for initial grant.
router.post('/admin/ensure-admin', requireAuth, async (req, res) => {
  try {
    const email = (req.user?.email || '').toLowerCase();
    if (email !== FOUNDER_EMAIL) {
      return res.json({ ok: true, isAdmin: false });
    }
    await query(
      `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [req.user.id]
    );
    return res.json({ ok: true, isAdmin: true });
  } catch (err) {
    console.error('Ensure admin error:', err);
    return res.status(500).json({ error: err.message || 'Failed to assign role' });
  }
});

export default router;
