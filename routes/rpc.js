import { Router } from 'express';
import { withUser } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// RPC name -> ordered parameter names (as in Postgres function signature)
const RPC_PARAMS = {
  get_public_profile: ['_user_id'],
  get_approved_contact_details: ['_target_user_id', '_requesting_user_id'],
  owner_delete_ride: ['_user_id', '_ride_id'],
  get_user_connections: ['_user_id'],
  admin_force_cancel_ride: ['_ride_id'],
  admin_get_all_rewards: [],
  admin_mark_reward_delivered: ['_reward_id'],
  admin_toggle_user_rewards: ['_user_id', '_enabled'],
  admin_gift_premium: ['_target_user_id'],
  admin_remove_premium: ['_target_user_id'],
  get_user_group_chats: ['_user_id'],
  pay_accept_request: ['_user_id', '_ride_request_id', '_payment_source', '_razorpay_payment_id'],
  get_connection_for_request: ['_ride_request_id'],
  get_group_chat_members: ['_group_chat_id'],
  get_spin_progress: ['_user_id'],
  get_user_reward_history: ['_user_id'],
  perform_spin: ['_user_id'],
  get_user_rating: ['_user_id'],
  has_rated_user: ['_rater_id', '_rated_id', '_ride_id'],
  create_and_pay_join_request: [
    '_requester_id',
    '_ride_id',
    '_payment_source',
    '_requester_show_profile_photo',
    '_requester_show_mobile_number',
    '_razorpay_payment_id',
  ],
  activate_premium_subscription: ['_user_id', '_razorpay_payment_id', '_razorpay_order_id'],
};

// RPC name -> PostgreSQL types per param (so Postgres doesn't treat as "unknown")
const RPC_TYPES = {
  get_public_profile: ['uuid'],
  get_approved_contact_details: ['uuid', 'uuid'],
  owner_delete_ride: ['uuid', 'uuid'],
  get_user_connections: ['uuid'],
  admin_force_cancel_ride: ['uuid'],
  admin_mark_reward_delivered: ['uuid'],
  admin_toggle_user_rewards: ['uuid', 'boolean'],
  admin_gift_premium: ['uuid'],
  admin_remove_premium: ['uuid'],
  get_user_group_chats: ['uuid'],
  pay_accept_request: ['uuid', 'uuid', 'text', 'text'],
  get_connection_for_request: ['uuid'],
  get_group_chat_members: ['uuid'],
  get_spin_progress: ['uuid'],
  get_user_reward_history: ['uuid'],
  perform_spin: ['uuid'],
  get_user_rating: ['uuid'],
  has_rated_user: ['uuid', 'uuid', 'uuid'],
  create_and_pay_join_request: ['uuid', 'uuid', 'text', 'boolean', 'boolean', 'text'],
  activate_premium_subscription: ['uuid', 'text', 'text'],
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RPCs where first param is _user_id and we allow using req.user.id when body value is missing/invalid (avoids 400 on hydration)
const CURRENT_USER_RPC_FIRST_PARAM = new Set([
  'get_user_connections',
  'get_spin_progress',
  'get_user_reward_history',
  'perform_spin',
  'get_user_group_chats',
  'get_user_rating',
]);

// POST /rpc/:name - body = { _param1: value1, ... }
router.post('/:name', requireAuth, async (req, res) => {
  try {
    const name = req.params.name;
    const paramOrder = RPC_PARAMS[name];
    if (!paramOrder) {
      return res.status(404).json({ error: `Unknown RPC: ${name}` });
    }
    const body = req.body || {};
    let values = paramOrder.map((key) => body[key]);
    // For "current user" RPCs, use JWT user id when first param (_user_id) is missing or invalid
    if (CURRENT_USER_RPC_FIRST_PARAM.has(name) && paramOrder[0] === '_user_id' && req.user?.id) {
      const v = values[0];
      if (v == null || (typeof v === 'string' && (v.trim() === '' || !UUID_REGEX.test(v)))) {
        values = [req.user.id, ...values.slice(1)];
      }
    }
    const types = RPC_TYPES[name];
    // Reject invalid UUIDs before hitting the DB (avoids "invalid input syntax for type uuid")
    if (types) {
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'uuid') {
          const v = values[i];
          if (v == null || (typeof v === 'string' && (v.trim() === '' || !UUID_REGEX.test(v)))) {
            return res.status(400).json({ error: `Invalid or missing UUID for parameter ${paramOrder[i]}` });
          }
        }
      }
    }
    const placeholders = values
      .map((_, i) => (types && types[i] ? `$${i + 1}::${types[i]}` : `$${i + 1}`))
      .join(', ');
    const sql = `SELECT * FROM public.${name}(${placeholders})`;
    const result = await withUser(req.user.id, async (client) => {
      return client.query(sql, values);
    });
    const data = result.rows;
    return res.json(data);
  } catch (err) {
    console.error('RPC error:', err);
    return res.status(500).json({ error: err.message || 'RPC failed' });
  }
});

export default router;
