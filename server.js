require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;

async function tgCall(method, body) {
  if (!BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendTgPhotoBase64(chatId, base64Img, caption, replyMarkup) {
  if (!BOT_TOKEN) return;
  const cleanBase64 = base64Img.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'receipt.jpg');

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'OK', app: 'Family Kavach', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'DB_ERROR', error: err.message });
  }
});

app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_config');
    const config = {};
    rows.forEach((r) => (config[r.key] = r.value));
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { name, phone, email, deviceId, inviteCode } = req.body;
  if (!name || !phone || !deviceId) {
    return res.status(400).json({ success: false, message: 'Name, Phone & Device ID required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query(
      `INSERT INTO users (name, phone, email, device_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE SET name = $1, email = COALESCE($3, users.email), device_id = $4
       RETURNING *`,
      [name, phone, email || null, deviceId]
    );
    const user = userRes.rows[0];

    let family;
    if (inviteCode) {
      const famRes = await client.query('SELECT * FROM families WHERE invite_code = $1', [inviteCode.toUpperCase()]);
      if (famRes.rows.length === 0) throw new Error('Invalid Family Invite Code');
      family = famRes.rows[0];

      const countRes = await client.query('SELECT COUNT(*) FROM family_members WHERE family_id = $1', [family.id]);
      const alreadyMember = await client.query(
        'SELECT * FROM family_members WHERE family_id = $1 AND user_id = $2',
        [family.id, user.id]
      );
      if (alreadyMember.rows.length === 0 && parseInt(countRes.rows[0].count) >= family.max_members) {
        throw new Error('Family limit full (Max 5 members allowed per login)');
      }
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'MEMBER') ON CONFLICT DO NOTHING`,
        [family.id, user.id]
      );
    } else {
      const existing = await client.query(
        `SELECT f.* FROM families f JOIN family_members fm ON f.id = fm.family_id WHERE fm.user_id = $1 LIMIT 1`,
        [user.id]
      );
      if (existing.rows.length > 0) {
        family = existing.rows[0];
      } else {
        const code = 'KVC' + Math.random().toString(36).substring(2, 7).toUpperCase();
        const newFam = await client.query(
          'INSERT INTO families (owner_id, invite_code) VALUES ($1, $2) RETURNING *',
          [user.id, code]
        );
        family = newFam.rows[0];
        await client.query(
          `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'ADMIN')`,
          [family.id, user.id]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, user, family });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/payment/submit', async (req, res) => {
  const { familyId, userId, planType, utrNumber, screenshotBase64 } = req.body;
  const amount = planType === '6_MONTHS' ? 80 : 20;

  try {
    const subRes = await pool.query(
      `INSERT INTO subscriptions (family_id, user_id, plan_type, amount, payment_source, tx_ref, status)
       VALUES ($1, $2, $3, $4, 'MANUAL_UPI', $5, 'PENDING') RETURNING *`,
      [familyId, userId, planType, amount, utrNumber]
    );
    const sub = subRes.rows[0];

    const userRes = await pool.query('SELECT name, phone FROM users WHERE id = $1', [userId]);
    const u = userRes.rows[0] || { name: 'Unknown', phone: 'N/A' };

    const caption =
      `💰 <b>New Kavach Payment Request!</b>\n\n` +
      `👤 User: ${u.name} (${u.phone})\n` +
      `🏠 Family ID: #${familyId}\n` +
      `📦 Plan: <b>${planType} (₹${amount})</b>\n` +
      `🧾 UTR/Ref: <code>${utrNumber}</code>\n` +
      `🆔 Sub ID: #${sub.id}`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Approve Plan', callback_data: `approve_${sub.id}` },
          { text: '❌ Reject', callback_data: `reject_${sub.id}` },
        ],
      ],
    };

    if (screenshotBase64) {
      await sendTgPhotoBase64(ADMIN_CHAT_ID, screenshotBase64, caption, replyMarkup);
    } else {
      await tgCall('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text: caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    }

    res.json({ success: true, message: 'Payment submitted! Admin approval pending.', subscription: sub });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/location/update', async (req, res) => {
  const { userId, latitude, longitude, batteryLevel, isCharging } = req.body;
  try {
    await pool.query(
      'INSERT INTO locations (user_id, latitude, longitude, battery_level, is_charging) VALUES ($1, $2, $3, $4, $5)',
      [userId, latitude, longitude, batteryLevel, isCharging || false]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/family/:familyId/locations', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (u.id) u.id, u.name, u.phone, fm.role, l.latitude, l.longitude, l.battery_level, l.is_charging, l.recorded_at
       FROM family_members fm
       JOIN users u ON fm.user_id = u.id
       LEFT JOIN locations l ON u.id = l.user_id
       WHERE fm.family_id = $1
       ORDER BY u.id, l.recorded_at DESC`,
      [req.params.familyId]
    );
    res.json({ success: true, members: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      if (String(cq.from.id) !== String(ADMIN_CHAT_ID)) return;

      const [action, subId] = cq.data.split('_');
      const subRes = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [subId]);
      if (subRes.rows.length === 0) return;
      const sub = subRes.rows[0];

      if (action === 'approve') {
        const days = sub.plan_type === '6_MONTHS' ? 180 : 30;
        await pool.query(
          `UPDATE subscriptions SET status = 'ACTIVE', valid_until = NOW() + INTERVAL '${days} days' WHERE id = $1`,
          [subId]
        );
        await tgCall('editMessageReplyMarkup', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: '✅ APPROVED & ACTIVE', callback_data: 'done' }]] },
        });
      } else if (action === 'reject') {
        await pool.query(`UPDATE subscriptions SET status = 'REJECTED' WHERE id = $1`, [subId]);
        await tgCall('editMessageReplyMarkup', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: '❌ REJECTED', callback_data: 'done' }]] },
        });
      }
      await tgCall('answerCallbackQuery', { callback_query_id: cq.id });
    }

    if (update.message && String(update.message.from.id) === String(ADMIN_CHAT_ID)) {
      const text = update.message.text || '';

      if (text === '/stats') {
        const u = await pool.query('SELECT COUNT(*) FROM users');
        const f = await pool.query('SELECT COUNT(*) FROM families');
        const a = await pool.query(`SELECT COUNT(*) FROM subscriptions WHERE status = 'ACTIVE' AND valid_until > NOW()`);
        await tgCall('sendMessage', {
          chat_id: ADMIN_CHAT_ID,
          text: `📊 <b>Family Kavach Stats</b>\n\n👥 Total Users: ${u.rows[0].count}\n🏠 Total Families: ${f.rows[0].count}\n💎 Active Paid Plans: ${a.rows[0].count}`,
          parse_mode: 'HTML',
        });
      } else if (text.startsWith('/setupi ')) {
        const newUpi = text.replace('/setupi ', '').trim();
        await pool.query(`UPDATE app_config SET value = $1 WHERE key = 'upi_id'`, [newUpi]);
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `✅ UPI ID updated to: ${newUpi}` });
      } else if (text.startsWith('/broadcast ')) {
        const msg = text.replace('/broadcast ', '').trim();
        await pool.query(`UPDATE app_config SET value = $1 WHERE key = 'announcement'`, [msg]);
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `📢 App Announcement Updated:\n"${msg}"` });
      } else if (text === '/mode_pg') {
        await pool.query(`UPDATE app_config SET value = 'PHONEPE_PG' WHERE key = 'payment_mode'`);
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `🔄 Switched to PHONEPE_PG mode!` });
      } else if (text === '/mode_upi') {
        await pool.query(`UPDATE app_config SET value = 'MANUAL_UPI' WHERE key = 'payment_mode'`);
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `🔄 Switched to MANUAL_UPI mode!` });
      }
    }
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
  }
});

app.listen(PORT, () => console.log(`Kavach Backend running on port ${PORT}`));
