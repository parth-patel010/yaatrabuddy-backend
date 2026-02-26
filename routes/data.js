import { Router } from 'express';
import { withUser, query } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Helper: run with user context and return rows or single row
async function runWithUser(userId, fn) {
  return withUser(userId, fn);
}

// GET /data/profiles/me
router.get('/profiles/me', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.profiles WHERE user_id = $1', [req.user.id])
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/profiles/me
router.patch('/profiles/me', requireAuth, async (req, res) => {
  try {
    const allowed = ['full_name', 'phone_number', 'avatar_url', 'university_id_url', 'verification_submitted_at', 'is_verified', 'is_blocked', 'spin_used', 'rewards_enabled'];
    const body = req.body || {};
    const setKeys = Object.keys(body).filter((k) => allowed.includes(k));
    if (setKeys.length === 0) return res.status(400).json({ error: 'No allowed fields to update' });
    const setClause = setKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [req.user.id, ...setKeys.map((k) => body[k])];
    await runWithUser(req.user.id, (client) =>
      client.query(`UPDATE public.profiles SET ${setClause} WHERE user_id = $1`, values)
    );
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.profiles WHERE user_id = $1', [req.user.id])
    );
    return res.json(r.rows[0] || null);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/profiles/:user_id - single profile by user_id (RLS applies)
router.get('/profiles/:user_id', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.profiles WHERE user_id = $1', [req.params.user_id])
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/profiles/:user_id - update any profile (admin or self; RLS applies)
router.patch('/profiles/:user_id', requireAuth, async (req, res) => {
  try {
    const allowed = ['full_name', 'phone_number', 'avatar_url', 'university_id_url', 'verification_submitted_at', 'is_verified', 'is_blocked', 'spin_used', 'rewards_enabled', 'is_premium', 'subscription_expiry'];
    const body = req.body || {};
    const setKeys = Object.keys(body).filter((k) => allowed.includes(k));
    if (setKeys.length === 0) return res.status(400).json({ error: 'No allowed fields to update' });
    const setClause = setKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [req.params.user_id, ...setKeys.map((k) => body[k])];
    const r = await runWithUser(req.user.id, (client) =>
      client.query(`UPDATE public.profiles SET ${setClause} WHERE user_id = $1 RETURNING *`, values)
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/profiles - list all (admin) or ?ids=uuid1,uuid2 for filter
router.get('/profiles', requireAuth, async (req, res) => {
  try {
    const ids = req.query.ids ? req.query.ids.split(',').filter(Boolean) : null;
    const r = await runWithUser(req.user.id, (client) => {
      if (ids && ids.length > 0) {
        return client.query(
          'SELECT user_id, full_name, email, avatar_url, is_verified, is_premium, subscription_expiry, free_connections_left FROM public.profiles WHERE user_id = ANY($1::uuid[])',
          [ids]
        );
      }
      return client.query('SELECT * FROM public.profiles ORDER BY created_at DESC');
    });
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/rides - list with optional filters (from_ilike, to_ilike for partial match)
router.get('/rides', requireAuth, async (req, res) => {
  try {
    const { user_id, from_location, to_location, from_ilike, to_ilike, ride_date_gte, id } = req.query;
    let sql = 'SELECT * FROM public.rides WHERE 1=1';
    const values = [];
    let i = 1;
    if (user_id) { sql += ` AND user_id = $${i++}`; values.push(user_id); }
    if (from_location) { sql += ` AND from_location = $${i++}`; values.push(from_location); }
    if (to_location) { sql += ` AND to_location = $${i++}`; values.push(to_location); }
    if (from_ilike) { sql += ` AND from_location ILIKE $${i++}`; values.push(`%${from_ilike}%`); }
    if (to_ilike) { sql += ` AND to_location ILIKE $${i++}`; values.push(`%${to_ilike}%`); }
    if (ride_date_gte) { sql += ` AND ride_date >= $${i++}`; values.push(ride_date_gte); }
    if (id) { sql += ` AND id = $${i++}`; values.push(id); }
    sql += ' ORDER BY ride_date ASC, created_at DESC';
    const r = await runWithUser(req.user.id, (client) => client.query(sql, values));
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/rides
router.post('/rides', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const { from_location, to_location, from_location_id, to_location_id, ride_date, ride_time, seats_available, transport_mode } = b;
    if (!from_location || !to_location || !ride_date || !ride_time || seats_available == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `INSERT INTO public.rides (user_id, from_location, to_location, from_location_id, to_location_id, ride_date, ride_time, seats_available, transport_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [req.user.id, from_location, to_location, from_location_id || null, to_location_id || null, ride_date, ride_time, seats_available, transport_mode || 'car']
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/rides/:id
router.patch('/rides/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['from_location', 'to_location', 'ride_date', 'ride_time', 'seats_available', 'transport_mode'];
    const body = req.body || {};
    const setKeys = Object.keys(body).filter((k) => allowed.includes(k));
    if (setKeys.length === 0) return res.status(400).json({ error: 'No allowed fields' });
    const setClause = setKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [req.params.id, ...setKeys.map((k) => body[k])];
    const r = await runWithUser(req.user.id, (client) =>
      client.query(`UPDATE public.rides SET ${setClause} WHERE id = $1 RETURNING *`, values)
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/notifications - current user's notifications
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'SELECT * FROM public.notifications WHERE user_id = $1 ORDER BY created_at DESC',
        [req.user.id]
      )
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/notifications
router.post('/notifications', requireAuth, async (req, res) => {
  try {
    const { user_id, title, message, type, ride_id } = req.body || {};
    const uid = user_id || req.user.id;
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `INSERT INTO public.notifications (user_id, title, message, type, ride_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [uid, title || '', message || '', type || 'info', ride_id || null]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/notifications/:id
router.patch('/notifications/:id', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'UPDATE public.notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING *',
        [req.params.id, req.user.id]
      )
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/notifications/read-all - mark all current user notifications as read
router.patch('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await runWithUser(req.user.id, (client) =>
      client.query('UPDATE public.notifications SET read = true WHERE user_id = $1 AND read = false', [req.user.id])
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/ride_requests
router.get('/ride_requests', requireAuth, async (req, res) => {
  try {
    const { ride_id, requester_id } = req.query;
    let sql = 'SELECT * FROM public.ride_requests WHERE 1=1';
    const values = [];
    let i = 1;
    if (ride_id) { sql += ` AND ride_id = $${i++}`; values.push(ride_id); }
    if (requester_id) { sql += ` AND requester_id = $${i++}`; values.push(requester_id); }
    sql += ' ORDER BY created_at DESC';
    const r = await runWithUser(req.user.id, (client) => client.query(sql, values));
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/ride_requests
router.post('/ride_requests', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `INSERT INTO public.ride_requests (ride_id, requester_id, status, show_profile_photo, show_mobile_number,
         requester_show_profile_photo, requester_show_mobile_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          b.ride_id,
          req.user.id,
          b.status || 'pending',
          b.show_profile_photo ?? false,
          b.show_mobile_number ?? false,
          b.requester_show_profile_photo ?? true,
          b.requester_show_mobile_number ?? false,
        ]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/ride_requests/:id
router.patch('/ride_requests/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['status', 'request_payment_status', 'accept_payment_status'];
    const body = req.body || {};
    const setKeys = Object.keys(body).filter((k) => allowed.includes(k));
    if (setKeys.length === 0) return res.status(400).json({ error: 'No allowed fields' });
    const setClause = setKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [req.params.id, ...setKeys.map((k) => body[k])];
    const r = await runWithUser(req.user.id, (client) =>
      client.query(`UPDATE public.ride_requests SET ${setClause} WHERE id = $1 RETURNING *`, values)
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/connections - current user's connections
router.get('/connections', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.connections WHERE user1_id = $1 OR user2_id = $1 ORDER BY created_at DESC', [
        req.user.id,
        req.user.id,
      ])
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/connections
router.post('/connections', requireAuth, async (req, res) => {
  try {
    const { ride_id, ride_request_id, user1_id, user2_id } = req.body || {};
    if (!ride_id || !ride_request_id || !user1_id || !user2_id) {
      return res.status(400).json({ error: 'ride_id, ride_request_id, user1_id, user2_id required' });
    }
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `INSERT INTO public.connections (ride_id, ride_request_id, user1_id, user2_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [ride_id, ride_request_id, user1_id, user2_id]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/chat_messages?connection_id=
router.get('/chat_messages', requireAuth, async (req, res) => {
  try {
    const { connection_id } = req.query;
    if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'SELECT * FROM public.chat_messages WHERE connection_id = $1 ORDER BY created_at ASC',
        [connection_id]
      )
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/chat_messages
router.post('/chat_messages', requireAuth, async (req, res) => {
  try {
    const { connection_id, message } = req.body || {};
    if (!connection_id || message == null) return res.status(400).json({ error: 'connection_id and message required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'INSERT INTO public.chat_messages (connection_id, sender_id, message) VALUES ($1, $2, $3) RETURNING *',
        [connection_id, req.user.id, message]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/chat_messages/:id (e.g. mark read)
router.patch('/chat_messages/:id', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'UPDATE public.chat_messages SET read = true WHERE id = $1 RETURNING *',
        [req.params.id]
      )
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/user_roles - list (own or all if admin)
router.get('/user_roles', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.user_roles WHERE user_id = $1', [req.user.id])
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/user_reports (admin list - RLS will filter)
router.get('/user_reports', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.user_reports ORDER BY created_at DESC')
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/user_reports
router.post('/user_reports', requireAuth, async (req, res) => {
  try {
    const { reported_user_id, ride_id, reason, description } = req.body || {};
    if (!reported_user_id || !ride_id || !reason) {
      return res.status(400).json({ error: 'reported_user_id, ride_id, reason required' });
    }
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'INSERT INTO public.user_reports (reporter_id, reported_user_id, ride_id, reason, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [req.user.id, reported_user_id, ride_id, reason, description || null]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/user_reports/:id (e.g. status update for admin)
router.patch('/user_reports/:id', requireAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'UPDATE public.user_reports SET status = $1 WHERE id = $2 RETURNING *',
        [status, req.params.id]
      )
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/locations
router.get('/locations', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.locations ORDER BY category, display_order, name')
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/locations/:id
router.patch('/locations/:id', requireAuth, async (req, res) => {
  try {
    const { active, name, category, city, display_order } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (typeof active === 'boolean') { updates.push(`active = $${i++}`); values.push(active); }
    if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
    if (category !== undefined) { updates.push(`category = $${i++}`); values.push(category); }
    if (city !== undefined) { updates.push(`city = $${i++}`); values.push(city); }
    if (display_order !== undefined) { updates.push(`display_order = $${i++}`); values.push(display_order); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    const r = await runWithUser(req.user.id, (client) =>
      client.query(`UPDATE public.locations SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, values)
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/locations
router.post('/locations', requireAuth, async (req, res) => {
  try {
    const { name, category, city, display_order, active } = req.body || {};
    if (!name || !category) return res.status(400).json({ error: 'name and category required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'INSERT INTO public.locations (name, category, city, display_order, active) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [name, category, city || 'Vadodara', display_order != null ? display_order : 0, active !== false]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/ratings - get for a user or ride
router.get('/ratings', requireAuth, async (req, res) => {
  try {
    const { rated_user_id, ride_id } = req.query;
    let sql = 'SELECT * FROM public.ratings WHERE 1=1';
    const values = [];
    let i = 1;
    if (rated_user_id) { sql += ` AND rated_user_id = $${i++}`; values.push(rated_user_id); }
    if (ride_id) { sql += ` AND ride_id = $${i++}`; values.push(ride_id); }
    const r = await runWithUser(req.user.id, (client) => client.query(sql, values));
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/ratings
router.post('/ratings', requireAuth, async (req, res) => {
  try {
    const { rated_user_id, ride_id, rating, comment } = req.body || {};
    if (!rated_user_id || !ride_id || rating == null) {
      return res.status(400).json({ error: 'rated_user_id, ride_id, rating required' });
    }
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'INSERT INTO public.ratings (rater_user_id, rated_user_id, ride_id, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [req.user.id, rated_user_id, ride_id, rating, comment || null]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/reward_history - for current user
router.get('/reward_history', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.reward_history WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id])
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/group_chat_messages?group_chat_id=
router.get('/group_chat_messages', requireAuth, async (req, res) => {
  try {
    const { group_chat_id } = req.query;
    if (!group_chat_id) return res.status(400).json({ error: 'group_chat_id required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'SELECT * FROM public.group_chat_messages WHERE group_chat_id = $1 ORDER BY created_at ASC',
        [group_chat_id]
      )
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/group_chat_messages
router.post('/group_chat_messages', requireAuth, async (req, res) => {
  try {
    const { group_chat_id, message } = req.body || {};
    if (!group_chat_id || message == null) return res.status(400).json({ error: 'group_chat_id and message required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'INSERT INTO public.group_chat_messages (group_chat_id, sender_id, message) VALUES ($1, $2, $3) RETURNING *',
        [group_chat_id, req.user.id, message]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/group_chats - list for user (via RPC get_user_group_chats is used in app)
// GET /data/group_chat_members?group_chat_id=
router.get('/group_chat_members', requireAuth, async (req, res) => {
  try {
    const { group_chat_id } = req.query;
    if (!group_chat_id) return res.status(400).json({ error: 'group_chat_id required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.group_chat_members WHERE group_chat_id = $1', [group_chat_id])
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
