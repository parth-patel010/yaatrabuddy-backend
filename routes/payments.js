import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { withUser, query } from '../db.js';

const router = Router();

// POST /payments/create-order
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
    const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Payment not configured' });
    }
    const { amount, purpose, ride_request_id } = req.body;
    const userId = req.user.id;
    if (!amount || amount < 21) {
      return res.status(400).json({ error: 'Minimum amount is ₹21' });
    }
    if (!['join_request', 'accept_request', 'subscription'].includes(purpose)) {
      return res.status(400).json({ error: 'Invalid payment purpose' });
    }
    const shortUserId = userId.substring(0, 8);
    const timestamp = Date.now().toString(36);
    const receipt = `${purpose.substring(0, 4)}_${shortUserId}_${timestamp}`.substring(0, 40);
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amount * 100,
        currency: 'INR',
        receipt,
        notes: {
          user_id: userId,
          purpose,
          ride_request_id: ride_request_id || '',
        },
      }),
    });
    if (!orderRes.ok) {
      const text = await orderRes.text();
      console.error('Razorpay order failed:', text);
      return res.status(500).json({ error: 'Failed to create order' });
    }
    const order = await orderRes.json();
    return res.json({
      order_id: order.id,
      amount,
      currency: 'INR',
      key_id: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Create order error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create order' });
  }
});

// POST /payments/verify
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
    if (!RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Payment not configured' });
    }
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      purpose,
      amount,
      ride_id,
      ride_request_id,
      requester_show_profile_photo,
      requester_show_mobile_number,
    } = req.body;
    const userId = req.user.id;

    const crypto = await import('crypto');
    const sig = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (sig !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    if (purpose === 'subscription') {
      const r = await query('SELECT * FROM public.activate_premium_subscription($1, $2, $3)', [
        userId,
        razorpay_payment_id,
        razorpay_order_id,
      ]);
      const row = r.rows?.[0];
      if (!row?.success || !row?.expiry_date) {
        return res.status(500).json({ error: row?.error_message || 'Failed to activate subscription' });
      }
      return res.json({
        success: true,
        message: 'Premium subscription activated!',
        expiry_date: row.expiry_date,
      });
    }
    if (purpose === 'join_request') {
      const r = await withUser(userId, (client) =>
        client.query('SELECT * FROM public.create_and_pay_join_request($1, $2, $3, $4, $5, $6)', [
          userId,
          ride_id,
          'razorpay',
          requester_show_profile_photo ?? true,
          requester_show_mobile_number ?? false,
          razorpay_payment_id,
        ])
      );
      const row = r.rows?.[0];
      if (!row?.success) {
        return res.status(400).json({ error: row?.error_message || 'Failed to process payment' });
      }
      return res.json({
        success: true,
        message: 'Join request payment successful',
        request_id: row.request_id,
      });
    }
    if (purpose === 'accept_request') {
      const r = await withUser(userId, (client) =>
        client.query('SELECT * FROM public.pay_accept_request($1, $2, $3, $4)', [
          userId,
          ride_request_id,
          'razorpay',
          razorpay_payment_id,
        ])
      );
      const row = r.rows?.[0];
      if (!row?.success) {
        return res.status(400).json({ error: row?.error_message || 'Failed to process payment' });
      }
      return res.json({
        success: true,
        message: 'Request accepted successfully! Chat is now open.',
      });
    }
    return res.status(400).json({ error: 'Invalid purpose' });
  } catch (err) {
    console.error('Verify payment error:', err);
    return res.status(500).json({ error: err.message || 'Verification failed' });
  }
});

export default router;
