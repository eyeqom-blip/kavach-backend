require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || "").trim();
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
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'photo.jpg');

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

// Login / Signup with Referral Code Support
app.post('/api/auth/login', async (req, res) => {
  const { name, phone, email, deviceId, inviteCode, referralCode } = req.body;
  if (!name || !phone || !deviceId) {
    return res.status(400).json({ success: false, message: 'Name, Phone & Device ID required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let referrerId = null;
    if (referralCode && referralCode.trim().length > 0) {
      const refRes = await client.query('SELECT id, phone FROM users WHERE referral_code = $1', [referralCode.trim().toUpperCase()]);
      if (refRes.rows.length > 0 && refRes.rows[0].phone !== phone) {
        referrerId = refRes.rows[0].id;
      }
    }

    const genRef = 'REF' + Math.random().toString(36).substring(2, 7).toUpperCase();
    const userRes = await client.query(
      `INSERT INTO users (name, phone, email, device_id, referral_code, referred_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (phone) DO UPDATE SET
         name = $1,
         email = COALESCE($3, users.email),
         device_id = $4,
         referral_code = COALESCE(users.referral_code, $5),
         referred_by = COALESCE(users.referred_by, $6)
       RETURNING *`,
      [name, phone, email || null, deviceId, genRef, referrerId]
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
          'INSERT INTO families (owner_id, invite_code, max_members, max_pro_guard) VALUES ($1, $2, 5, 0) RETURNING *',
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

// Referral Dashboard
app.get('/api/referrals/:userId', async (req, res) => {
  try {
    const uRes = await pool.query('SELECT id, referral_code, discount_credits FROM users WHERE id = $1', [req.params.userId]);
    if (uRes.rows.length === 0) return res.status(404).json({ success: false });

    const friendsRes = await pool.query(
      `SELECT u.id, u.name,
              CONCAT(LEFT(u.phone, 2), '******', RIGHT(u.phone, 2)) AS masked_phone,
              COALESCE((SELECT s.status FROM subscriptions s WHERE s.user_id = u.id ORDER BY s.created_at DESC LIMIT 1), 'NOT_PAID') AS plan_status
       FROM users u WHERE u.referred_by = $1 ORDER BY u.created_at DESC`,
      [req.params.userId]
    );

    res.json({
      success: true,
      referral_code: uRes.rows[0].referral_code,
      discount_credits: uRes.rows[0].discount_credits || 0,
      referred_friends: friendsRes.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Family Plan, Pro Guard Slots & Member Toggles
app.get('/api/family/:familyId/status', async (req, res) => {
  try {
    const fam = await pool.query('SELECT * FROM families WHERE id = $1', [req.params.familyId]);
    if (fam.rows.length === 0) return res.status(404).json({ success: false });

    const membersRes = await pool.query(
      `SELECT u.id, u.name, u.phone, fm.role, fm.pro_guard_enabled
       FROM family_members fm JOIN users u ON fm.user_id = u.id WHERE fm.family_id = $1 ORDER BY fm.id ASC`,
      [req.params.familyId]
    );
    const sub = await pool.query(
      `SELECT * FROM subscriptions WHERE family_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.familyId]
    );
    const ownerCredits = await pool.query('SELECT discount_credits, referral_code FROM users WHERE id = $1', [fam.rows[0].owner_id]);

    res.json({
      success: true,
      max_members: fam.rows[0].max_members,
      max_pro_guard: fam.rows[0].max_pro_guard || 0,
      current_members: membersRes.rows.length,
      members: membersRes.rows,
      discount_credits: ownerCredits.rows[0]?.discount_credits || 0,
      referral_code: ownerCredits.rows[0]?.referral_code || '',
      subscription: sub.rows[0] || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Toggle Person-Wise Pro Guard (Call Log / Hidden Apps / Anti-Theft)
app.post('/api/family/:familyId/pro-guard/toggle', async (req, res) => {
  const { targetUserId, enable } = req.body;
  try {
    const fam = await pool.query('SELECT max_pro_guard FROM families WHERE id = $1', [req.params.familyId]);
    const maxPro = fam.rows[0]?.max_pro_guard || 0;

    if (enable) {
      const used = await pool.query(
        'SELECT COUNT(*) FROM family_members WHERE family_id = $1 AND pro_guard_enabled = TRUE',
        [req.params.familyId]
      );
      if (parseInt(used.rows[0].count) >= maxPro) {
        return res.status(400).json({
          success: false,
          message: `Aapke paas ${maxPro} Pro Guard slots hain. Pay / Add me ja kar person add karein!`,
        });
      }
    }

    await pool.query(
      'UPDATE family_members SET pro_guard_enabled = $1 WHERE family_id = $2 AND user_id = $3',
      [Boolean(enable), req.params.familyId, targetUserId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Submit Payment (Base 5=20/80 + Extra 5/20 + Pro Guard Add-On 10/35 per person)
app.post('/api/payment/submit', async (req, res) => {
  const { familyId, userId, planType, requestedMembers, proGuardCount, utrNumber, screenshotBase64 } = req.body;
  const members = Math.max(5, Math.min(20, parseInt(requestedMembers || 5, 10)));
  const extra = members - 5;
  const proCount = Math.max(0, Math.min(members, parseInt(proGuardCount || 0, 10)));

  const baseAmount =
    planType === '6_MONTHS'
      ? 80 + extra * 20 + proCount * 35
      : 20 + extra * 5 + proCount * 10;

  try {
    const userRes = await pool.query('SELECT name, phone, discount_credits FROM users WHERE id = $1', [userId]);
    const u = userRes.rows[0] || { name: 'Unknown', phone: 'N/A', discount_credits: 0 };
    const discountUsed = Math.min(u.discount_credits || 0, baseAmount);
    const finalAmount = baseAmount - discountUsed;

    const subRes = await pool.query(
      `INSERT INTO subscriptions (family_id, user_id, plan_type, amount, payment_source, tx_ref, status, requested_members, pro_guard_count, discount_used)
       VALUES ($1, $2, $3, $4, 'MANUAL_UPI', $5, 'PENDING', $6, $7, $8) RETURNING *`,
      [familyId, userId, planType, finalAmount, utrNumber || 'CREDIT_CLAIM', members, proCount, discountUsed]
    );
    const sub = subRes.rows[0];

    const caption =
      `💰 <b>New Kavach Payment Request!</b>\n\n` +
      `👤 User: ${u.name} (${u.phone})\n` +
      `🏠 Family ID: #${familyId}\n` +
      `👥 Members: <b>${members}</b> | 🛡️ Pro Guard Slots: <b>${proCount}</b>\n` +
      `💵 Base: ₹${baseAmount} | 🎟️ Referral: -₹${discountUsed}\n` +
      `📦 Payable: <b>${planType} (₹${finalAmount})</b>\n` +
      `🧾 UTR/Ref: <code>${utrNumber}</code>\n` +
      `🆔 Sub ID: #${sub.id}`;

    const replyMarkup = {
      inline_keyboard: [[
        { text: '✅ Approve Plan', callback_data: `approve_${sub.id}` },
        { text: '❌ Reject', callback_data: `reject_${sub.id}` },
      ]],
    };

    if (screenshotBase64) {
      await sendTgPhotoBase64(ADMIN_CHAT_ID, screenshotBase64, caption, replyMarkup);
    } else {
      await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: caption, parse_mode: 'HTML', reply_markup: replyMarkup });
    }

    res.json({ success: true, message: 'Payment submitted! Admin approval pending.', subscription: sub });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Location & SOS
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
      `SELECT DISTINCT ON (u.id) u.id, u.name, u.phone, fm.role, fm.pro_guard_enabled, l.latitude, l.longitude, l.battery_level, l.is_charging, l.recorded_at
       FROM family_members fm JOIN users u ON fm.user_id = u.id
       LEFT JOIN locations l ON u.id = l.user_id
       WHERE fm.family_id = $1 ORDER BY u.id, l.recorded_at DESC`,
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

// Phase 4: E2EE Family Chat (Server sirf encrypted ciphertext store karta hai!)
app.post('/api/chat/send', async (req, res) => {
  const { familyId, senderId, ciphertext, iv } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO encrypted_messages (family_id, sender_id, ciphertext, iv) VALUES ($1, $2, $3, $4) RETURNING *',
      [familyId, senderId, ciphertext, iv]
    );
    res.json({ success: true, message: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/chat/:familyId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, u.name as sender_name FROM encrypted_messages m JOIN users u ON m.sender_id = u.id
       WHERE m.family_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
      [req.params.familyId]
    );
    res.json({ success: true, messages: rows.reverse() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Phase 4: Shared Family Tasks & Calendar
app.get('/api/tasks/:familyId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM family_tasks WHERE family_id = $1 ORDER BY is_done ASC, id DESC', [req.params.familyId]);
    res.json({ success: true, tasks: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tasks/add', async (req, res) => {
  const { familyId, title, dueDate, assignedTo } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO family_tasks (family_id, title, due_date, assigned_to) VALUES ($1, $2, $3, $4) RETURNING *',
      [familyId, title, dueDate || '', assignedTo || 'Everyone']
    );
    res.json({ success: true, task: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tasks/toggle', async (req, res) => {
  const { taskId, isDone } = req.body;
  try {
    await pool.query('UPDATE family_tasks SET is_done = $1 WHERE id = $2', [Boolean(isDone), taskId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Phase 4: Kids Activity & Anti-Theft Reports
app.post('/api/reports/submit', async (req, res) => {
  const { familyId, userId, reportType, details, photoBase64 } = req.body;
  try {
    await pool.query(
      'INSERT INTO child_reports (family_id, user_id, report_type, details) VALUES ($1, $2, $3, $4)',
      [familyId, userId, reportType, details]
    );
    if (photoBase64) {
      await sendTgPhotoBase64(ADMIN_CHAT_ID, photoBase64, `🚨 <b>Kavach Anti-Theft Capture</b>\nFamily #${familyId} | ${reportType}\n${details}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reports/:familyId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.name as user_name FROM child_reports r JOIN users u ON r.user_id = u.id
       WHERE r.family_id = $1 ORDER BY r.created_at DESC LIMIT 30`,
      [req.params.familyId]
    );
    res.json({ success: true, reports: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GitHub Actions -> Telegram 3-Option Release Control
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

// Telegram Webhook
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      if (String(cq.from.id) !== String(ADMIN_CHAT_ID)) return;
      const data = cq.data;

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

      const [action, subId] = data.split('_');
      const subRes = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [subId]);
      if (subRes.rows.length === 0) return;
      const sub = subRes.rows[0];

      if (action === 'approve' && sub.status !== 'ACTIVE') {
        const days = sub.plan_type === '6_MONTHS' ? 180 : 30;
        await pool.query(`UPDATE subscriptions SET status = 'ACTIVE', valid_until = NOW() + INTERVAL '${days} days' WHERE id = $1`, [subId]);
        await pool.query(
          `UPDATE families SET max_members = GREATEST(max_members, $1), max_pro_guard = GREATEST(max_pro_guard, $2) WHERE id = $3`,
          [sub.requested_members || 5, sub.pro_guard_count || 0, sub.family_id]
        );

        if ((sub.discount_used || 0) > 0) {
          await pool.query(`UPDATE users SET discount_credits = GREATEST(0, discount_credits - $1) WHERE id = $2`, [sub.discount_used, sub.user_id]);
        }
        const payerRes = await pool.query('SELECT referred_by FROM users WHERE id = $1', [sub.user_id]);
        const refBy = payerRes.rows[0]?.referred_by;
        if (refBy && refBy !== sub.user_id) {
          await pool.query(`UPDATE users SET discount_credits = discount_credits + 1 WHERE id = $1`, [refBy]);
        }

        await tgCall('editMessageReplyMarkup', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: {
            inline_keyboard: [[{ text: `✅ APPROVED (${sub.requested_members}M + ${sub.pro_guard_count || 0}Pro)`, callback_data: 'done' }]],
          },
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
      if (text === '/stats' || text === '/stat') {
        const u = await pool.query('SELECT COUNT(*) FROM users');
        const f = await pool.query('SELECT COUNT(*) FROM families');
        const a = await pool.query(`SELECT COUNT(*) FROM subscriptions WHERE status = 'ACTIVE' AND valid_until > NOW()`);
        await tgCall('sendMessage', {
          chat_id: ADMIN_CHAT_ID,
          text: `📊 <b>Family Kavach Stats</b>\n\n👥 Users: ${u.rows[0].count}\n🏠 Families: ${f.rows[0].count}\n💎 Active Paid: ${a.rows[0].count}`,
          parse_mode: 'HTML',
        });
      } else if (text === '/help' || text === '/start') {
        await tgCall('sendMessage', {
          chat_id: ADMIN_CHAT_ID,
          text:
            `🛡️ <b>Family Kavach Admin Cheatsheet</b>\n\n` +
            `📊 <code>/stats</code> - Live Users, Families & Paid Plans\n` +
            `💳 <code>/setupi id@upi</code> - Owner UPI ID badlein\n` +
            `📢 <code>/broadcast Message</code> - App Open Popup bhejein\n` +
            `🔄 <code>/mode_pg</code> - PhonePe PG Autopay ON karein\n` +
            `🔄 <code>/mode_upi</code> - Owner Manual UPI ON karein\n` +
            `ℹ️ <code>/help</code> - Ye list dobara dekhein`,
          parse_mode: 'HTML',
        });
      } else if (text.startsWith('/setupi ')) {
        const newUpi = text.replace('/setupi ', '').trim();
        await pool.query(`UPDATE app_config SET value = $1 WHERE key = 'upi_id'`, [newUpi]);
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `✅ UPI ID updated: ${newUpi}` });
      } else if (text.startsWith('/broadcast ')) {
        const msg = text.replace('/broadcast ', '').trim();
        await pool.query(`UPDATE app_config SET value = $1 WHERE key = 'announcement'`, [msg]);
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `📢 Announcement Updated:\n"${msg}"` });
      } else if (text === '/mode_pg') {
        await pool.query(`UPDATE app_config SET value = 'PHONEPE_PG' WHERE key = 'payment_mode'`);
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `🔄 Switched to PHONEPE_PG!` });
      } else if (text === '/mode_upi') {
        await pool.query(`UPDATE app_config SET value = 'MANUAL_UPI' WHERE key = 'payment_mode'`);
        await tgCall('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `🔄 Switched to MANUAL_UPI!` });
      }
    }
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
  }
});


app.get('/api/debug-bot', async (req, res) => {
  const info = await tgCall('getWebhookInfo', {});
  res.json({ hasToken: Boolean(BOT_TOKEN), adminChatIdLen: ADMIN_CHAT_ID.length, webhook: info });
});

app.get('/api/cron/daily-report', async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false });
  try {
    const u = await pool.query('SELECT COUNT(*) FROM users');
    const f = await pool.query('SELECT COUNT(*) FROM families');
    const a = await pool.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'ACTIVE' AND valid_until > NOW()");
    const p = await pool.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'PENDING'");
    const rev = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM subscriptions WHERE status = 'ACTIVE' AND created_at >= NOW() - INTERVAL '24 hours'");
    const sos = await pool.query("SELECT COUNT(*) FROM sos_alerts WHERE created_at >= NOW() - INTERVAL '24 hours'");

    await tgCall('sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      text:
        `☀️ <b>Good Morning! Daily Kavach Report (10 AM)</b>\n\n` +
        `👥 Total Users: <b>${u.rows[0].count}</b>\n` +
        `🏠 Total Families: <b>${f.rows[0].count}</b>\n` +
        `💎 Active Paid Plans: <b>${a.rows[0].count}</b>\n` +
        `⏳ Pending Approvals: <b>${p.rows[0].count}</b>\n` +
        `💰 Last 24h Revenue: <b>₹${rev.rows[0].total}</b>\n` +
        `🚨 Last 24h SOS Alerts: <b>${sos.rows[0].count}</b>`,
      parse_mode: 'HTML',
    });
    res.json({ success: true, sent: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/fix-webhook', async (req, res) => {
  const r = await tgCall('setWebhook', { url: 'https://kavach-backend-8hjz.onrender.com/telegram-webhook' });
  res.json(r);
});

app.listen(PORT, () => {
  console.log(`Kavach Backend running on port ${PORT}`);
  tgCall('setWebhook', { url: 'https://kavach-backend-8hjz.onrender.com/telegram-webhook' });
  tgCall('setMyCommands', {
    commands: [
      { command: 'stats', description: 'Live Users, Families & Paid Count' },
      { command: 'help', description: 'Admin Commands Cheatsheet' },
      { command: 'setupi', description: 'Change UPI (/setupi id@upi)' },
      { command: 'broadcast', description: 'Send App Popup (/broadcast msg)' },
      { command: 'mode_pg', description: 'Switch to PhonePe PG Autopay' },
      { command: 'mode_upi', description: 'Switch to Owner Manual UPI' }
    ]
  });
});