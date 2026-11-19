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
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'kavach_secret_2026';
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

// 1. Health Check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'OK', app: 'Family Kavach', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'DB_ERROR', error: err.message });
  }
});

// 2. Dynamic App Config
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

// 3. Register / Login & Family (Flexible Max Members)
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
        throw new Error(`Family limit full (${family.max_members} members). Admin extra members add kar sakte hain!`);
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
          'INSERT INTO families (owner_id, invite_code, max_members) VALUES ($1, $2, 5) RETURNING *',
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

// 4. Family Plan & Member Count Status
app.get('/api/family/:familyId/status', async (req, res) => {
  try {
    const fam = await pool.query('SELECT * FROM families WHERE id = $1', [req.params.familyId]);
    if (fam.rows.length === 0) return res.status(404).json({ success: false });

    const cnt = await pool.query('SELECT COUNT(*) FROM family_members WHERE family_id = $1', [req.params.familyId]);
    const sub = await pool.query(
      `SELECT * FROM subscriptions WHERE family_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.familyId]
    );
    res.json({
      success: true,
      max_members: fam.rows[0].max_members,
      current_members: parseInt(cnt.rows[0].count),
      subscription: sub.rows[0] || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Submit Payment (5 default = 20/80, Extra member = +5/mo or +20/6mo)
app.post('/api/payment/submit', async (req, res) => {
  const { familyId, userId, planType, requestedMembers, utrNumber, screenshotBase64 } = req.body;
  const members = Math.max(5, parseInt(requestedMembers || 5, 10));
  const extra = members - 5;
  const amount = planType === '6_MONTHS' ? (80 + extra * 20) : (20 + extra * 5);

  try {
    const subRes = await pool.query(
      `INSERT INTO subscriptions (family_id, user_id, plan_type, amount, payment_source, tx_ref, status, requested_members)
       VALUES ($1, $2, $3, $4, 'MANUAL_UPI', $5, 'PENDING', $6) RETURNING *`,
      [familyId, userId, planType, amount, utrNumber, members]
    );
    const sub = subRes.rows[0];

    const userRes = await pool.query('SELECT name, phone FROM users WHERE id = $1', [userId]);
    const u = userRes.rows[0] || { name: 'Unknown', phone: 'N/A' };

    const caption =
      `💰 <b>New Kavach Payment Request!</b>\n\n` +
      `👤 User: ${u.name} (${u.phone})\n` +
      `🏠 Family ID: #${familyId}\n` +
      `👥 Members Limit: <b>${members} Persons</b> (5 + ${extra} extra)\n` +
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

    res.json({ success: true, message: 'Payment submitted! Telegram par approval pending.', subscription: sub });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Location & SOS Endpoints
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

app.post('/api/sos/trigger', async (req, res) => {
  const { familyId, userId, latitude, longitude, alertType } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO sos_alerts (family_id, triggered_by, latitude, longitude, alert_type) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [familyId, userId, latitude || 0, longitude || 0, alertType || 'SOS_PANIC']
    );
    res.json({ success: true, alert: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/family/:familyId/alerts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, u.name as triggered_by_name FROM sos_alerts s JOIN users u ON s.triggered_by = u.id
       WHERE s.family_id = $1 ORDER BY s.created_at DESC LIMIT 20`,
      [req.params.familyId]
    );
    res.json({ success: true, alerts: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. GitHub Actions -> Telegram 3-Option Release Control!
app.post('/api/admin/new-build', async (req, res) => {
  const { version, apkUrl, notes, secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ success: false });

  try {
    const r = await pool.query(
      `INSERT INTO app_releases (version, apk_url, notes, status) VALUES ($1, $2, $3, 'PENDING') RETURNING *`,
      [version, apkUrl, notes || 'New Kavach Update']
    );
    const rel = r.rows[0];

    await tgCall('sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      text:
        `🚀 <b>Naya Kavach Build Taiyar Hai!</b>\n\n` +
        `📦 Version: <b>v${version}</b>\n` +
        `📝 Changes: ${rel.notes}\n` +
        `🔗 Direct APK: ${apkUrl}\n\n` +
        `Kya karna hai is update ka?`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Approved & Send to All Users', callback_data: `rel_approve_${rel.id}` }],
          [{ text: '🧪 Accept for Test Only', callback_data: `rel_test_${rel.id}` }],
          [{ text: '❌ Reject Build', callback_data: `rel_reject_${rel.id}` }],
        ],
      },
    });
    res.json({ success: true, release: rel });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Telegram Webhook (Payments + 3-Button Releases + Admin Commands)
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      if (String(cq.from.id) !== String(ADMIN_CHAT_ID)) return;
      const data = cq.data;

      // Release 3-Option Handlers
      if (data.startsWith('rel_')) {
        const [, action, relId] = data.split('_');
        const relRes = await pool.query('SELECT * FROM app_releases WHERE id = $1', [relId]);
        if (relRes.rows.length === 0) return;
        const rel = relRes.rows[0];

        if (action === 'approve') {
          await pool.query(`UPDATE app_releases SET status = 'APPROVED' WHERE id = $1`, [relId]);
          await pool.query(`UPDATE app_config SET value = $1 WHERE key = 'latest_version'`, [rel.version]);
          await pool.query(`UPDATE app_config SET value = $1 WHERE key = 'update_url'`, [rel.apk_url]);
          await tgCall('editMessageReplyMarkup', {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [[{ text: '🚀 LIVE FOR ALL USERS', callback_data: 'done' }]] },
          });
        } else if (action === 'test') {
          await pool.query(`UPDATE app_releases SET status = 'TEST_ONLY' WHERE id = $1`, [relId]);
          await pool.query(`UPDATE app_config SET value = $1 WHERE key = 'test_version'`, [rel.version]);
          await pool.query(`UPDATE app_config SET value = $1 WHERE key = 'test_url'`, [rel.apk_url]);
          await tgCall('editMessageReplyMarkup', {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: '🧪 ACCEPTED FOR TEST ONLY', callback_data: 'done' }],
                [{ text: '🚀 Promote Test -> All Users', callback_data: `rel_approve_${relId}` }],
              ],
            },
          });
        } else if (action === 'reject') {
          await pool.query(`UPDATE app_releases SET status = 'REJECTED' WHERE id = $1`, [relId]);
          await tgCall('editMessageReplyMarkup', {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [[{ text: '❌ BUILD REJECTED', callback_data: 'done' }]] },
          });
        }
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id });
        return;
      }

      // Payment Handlers
      const [action, subId] = data.split('_');
      const subRes = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [subId]);
      if (subRes.rows.length === 0) return;
      const sub = subRes.rows[0];

      if (action === 'approve') {
        const days = sub.plan_type === '6_MONTHS' ? 180 : 30;
        await pool.query(
          `UPDATE subscriptions SET status = 'ACTIVE', valid_until = NOW() + INTERVAL '${days} days' WHERE id = $1`,
          [subId]
        );
        await pool.query(
          `UPDATE families SET max_members = GREATEST(max_members, $1) WHERE id = $2`,
          [sub.requested_members || 5, sub.family_id]
        );
        await tgCall('editMessageReplyMarkup', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: `✅ APPROVED (${sub.requested_members || 5} Members)`, callback_data: 'done' }]] },
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
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `📢 Announcement Updated:\n"${msg}"` });
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
