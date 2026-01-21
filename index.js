// index.js - Elmastoken / ReklamPay Bot + API + Admin Panel
// Node 18+ / Render friendly
require('dotenv').config();
const express = require('express');
const path = require('path');
const { fileURLToPath } = require('url');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const crypto = require('crypto');
// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;             // e.g. https://reklampaybot.onrender.com
const WEBAPP_URL = `${BASE_URL}/webapp/index.html`; // Telegram WebApp ana sayfa
const DATABASE_URL = process.env.DATABASE_URL;     // postgres connection string

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!BASE_URL) throw new Error('Missing BASE_URL');
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL');

// Admin Telegram ID (from memory / user)
const ADMIN_TG_ID = 7784281785;

// ===== App settings (can be moved to DB later) =====
const SETTINGS = {
  daily_limit: 50,
  reward_tl: 0.25,
  reward_gem: 0.25,
  gem_to_tl_rate: 0.25,
  min_withdraw_tl: 250,
  referral_new_user_tl: 18,
  referral_ad_percent: 0.05, // 5%
  advertiser_price_tier_1: { minSec: 10, maxSec: 30, pricePerClick: 1.75 },
  advertiser_price_tier_2: { minSec: 30, maxSec: 240, pricePerClick: 2.25 },
};

// ===== DB =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function q(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function migrate() {
  // Safe, idempotent migrations (minimal)
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      diamonds NUMERIC(12,2) NOT NULL DEFAULT 0,
      is_vip BOOLEAN NOT NULL DEFAULT FALSE,
      referred_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS daily_views (
      tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      day DATE NOT NULL,
      seen INT NOT NULL DEFAULT 0,
      PRIMARY KEY (tg_id, day)
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('video','image','html')),
      url TEXT NOT NULL,
      seconds INT NOT NULL DEFAULT 15,
      reward_tl NUMERIC(12,2) NOT NULL DEFAULT ${SETTINGS.reward_tl},
      reward_gem NUMERIC(12,2) NOT NULL DEFAULT ${SETTINGS.reward_gem},
      is_vip BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      max_clicks INT,
      clicks INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS ad_sessions (
      session_id UUID PRIMARY KEY,
      tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      ad_id INT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'started' -- started|completed
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      iban TEXT NOT NULL,
      amount_tl NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      decided_by BIGINT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS advertiser_orders (
      id SERIAL PRIMARY KEY,
      tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      contact TEXT,
      ad_url TEXT NOT NULL,
      seconds INT NOT NULL,
      target_clicks INT NOT NULL,
      price_per_click NUMERIC(12,2) NOT NULL,
      total_budget NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      decided_by BIGINT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS forum_topics (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      is_open BOOLEAN NOT NULL DEFAULT TRUE,
      created_by BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS forum_posts (
      id SERIAL PRIMARY KEY,
      topic_id INT NOT NULL REFERENCES forum_topics(id) ON DELETE CASCADE,
      tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed: ensure at least one default ad exists so /ad/start works
  const { rows } = await q(`SELECT COUNT(*)::int AS c FROM ads`);
  if (rows[0].c === 0) {
    await q(
      `INSERT INTO ads (type,url,seconds,reward_tl,reward_gem,is_vip,active,max_clicks)
       VALUES ('video', $1, 15, $2, $3, FALSE, TRUE, NULL)`,
      [`${BASE_URL}/webapp/ads/demo.mp4`, SETTINGS.reward_tl, SETTINGS.reward_gem]
    ).catch(() => {});
  }
}

// ===== Helpers =====
function todayISO() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function ensureUserFromTg(user, startRef) {
  const tg_id = Number(user.id);
  await q(
    `INSERT INTO users (tg_id, username, first_name, referred_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tg_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name`,
    [tg_id, user.username || null, user.first_name || null, startRef || null]
  );

  // if startRef given and user has no referred_by yet, set it
  if (startRef && Number(startRef) !== tg_id) {
    await q(
      `UPDATE users SET referred_by = COALESCE(referred_by, $2) WHERE tg_id=$1`,
      [tg_id, Number(startRef)]
    );

    // new user bonus (one-time): if first time setting referred_by and created very recently
    // We'll give bonus only once by checking if user had referred_by null before and no row in withdrawals etc is needed.
    // Simple: add a marker table? For now: give bonus when referred_by was null and created_at within 5 minutes.
    await q(
      `UPDATE users u SET balance = balance + $2
       WHERE tg_id=$1 AND referred_by = $3
       AND NOT EXISTS (
         SELECT 1 FROM users ux WHERE ux.tg_id=$1 AND ux.created_at < NOW() - INTERVAL '5 minutes'
       )`,
      [tg_id, SETTINGS.referral_new_user_tl, Number(startRef)]
    ).catch(() => {});
  }

  return tg_id;
}

async function getDaily(tg_id) {
  const day = todayISO();
  await q(
    `INSERT INTO daily_views (tg_id, day, seen) VALUES ($1,$2,0)
     ON CONFLICT (tg_id, day) DO NOTHING`,
    [tg_id, day]
  );
  const r = await q(`SELECT seen FROM daily_views WHERE tg_id=$1 AND day=$2`, [tg_id, day]);
  return { day, seen: r.rows[0]?.seen ?? 0, limit: SETTINGS.daily_limit };
}

function isAdminTgId(tg_id) {
  return Number(tg_id) === Number(ADMIN_TG_ID);
}

function requireAdmin(req, res, next) {
  const tg_id = Number(req.body?.tg_id || req.query?.tg_id);
  if (!tg_id || !isAdminTgId(tg_id)) return res.status(403).json({ error: 'admin_only' });
  next();
}

function priceTier(seconds) {
  const s = Number(seconds);
  if (s >= SETTINGS.advertiser_price_tier_1.minSec && s <= SETTINGS.advertiser_price_tier_1.maxSec) return SETTINGS.advertiser_price_tier_1;
  if (s > SETTINGS.advertiser_price_tier_2.minSec && s <= SETTINGS.advertiser_price_tier_2.maxSec) return SETTINGS.advertiser_price_tier_2;
  // treat 30 exactly as tier1
  if (s === 30) return SETTINGS.advertiser_price_tier_1;
  // default to tier2 within range
  return SETTINGS.advertiser_price_tier_2;
}

// ===== Express =====
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// Telegram WebApp URL expects "/webapp/index.html"
app.use('/webapp', express.static(path.join(__dirname, 'webapp')));

// Health + root
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect('/webapp/index.html'));

// Serve admin page (static file)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'webapp', 'admin.html')));

// ===== API: User =====
app.post('/api/me', async (req, res) => {
  try {
    const tg_id = Number(req.body.tg_id);
    if (!tg_id) return res.status(400).json({ error: 'missing_tg_id' });

    const u = await q(`SELECT tg_id, username, first_name, balance, diamonds, is_vip FROM users WHERE tg_id=$1`, [tg_id]);
    const daily = await getDaily(tg_id);

    return res.json({
      user: u.rows[0] || { tg_id, balance: 0, diamonds: 0, is_vip: false },
      daily,
      settings: {
        gem_to_tl_rate: SETTINGS.gem_to_tl_rate,
        min_withdraw_tl: SETTINGS.min_withdraw_tl,
        ref_bonus_rate: SETTINGS.referral_ad_percent,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'server', reason: String(e.message || e) });
  }
});

app.post('/api/ad/start', async (req, res) => {
  try {
    const tg_id = Number(req.body.tg_id);
    const vip = Boolean(req.body.vip);
    if (!tg_id) return res.status(400).json({ error: 'missing_tg_id' });

    // daily limit
    const daily = await getDaily(tg_id);
    if (daily.seen >= daily.limit) return res.status(429).json({ error: 'daily_limit', reason: 'Günlük limit doldu.' });

    // pick active ad (vip or normal)
    const ad = await q(
      `SELECT * FROM ads
       WHERE active=TRUE AND is_vip=$1
       AND (max_clicks IS NULL OR clicks < max_clicks)
       ORDER BY RANDOM() LIMIT 1`,
      [vip]
    );
    if (!ad.rows[0]) return res.status(404).json({ error: 'no_ads', reason: 'Aktif reklam yok.' });

    const session_id = crypto.randomUUID();
    await q(`INSERT INTO ad_sessions (session_id, tg_id, ad_id) VALUES ($1,$2,$3)`, [session_id, tg_id, ad.rows[0].id]);

    // increment daily seen immediately (prevents spam clicking)
    await q(`UPDATE daily_views SET seen = seen + 1 WHERE tg_id=$1 AND day=$2`, [tg_id, daily.day]);

    return res.json({
      session_id,
      seen: daily.seen + 1,
      limit: daily.limit,
      ad: {
        type: ad.rows[0].type,
        url: ad.rows[0].url,
        seconds: ad.rows[0].seconds,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'server', reason: String(e.message || e) });
  }
});

app.post('/api/ad/complete', async (req, res) => {
  try {
    const tg_id = Number(req.body.tg_id);
    const session_id = String(req.body.session_id || '');
    if (!tg_id || !session_id) return res.status(400).json({ error: 'missing' });

    const ses = await q(
      `SELECT s.session_id, s.status, s.ad_id, a.reward_tl, a.reward_gem, a.is_vip
       FROM ad_sessions s
       JOIN ads a ON a.id=s.ad_id
       WHERE s.session_id=$1 AND s.tg_id=$2`,
      [session_id, tg_id]
    );
    if (!ses.rows[0]) return res.status(404).json({ error: 'invalid_session' });
    if (ses.rows[0].status === 'completed') {
      return res.json({ ok: true, reward_tl: 0, reward_gem: 0 });
    }

    const reward_tl = Number(ses.rows[0].reward_tl);
    const reward_gem = Number(ses.rows[0].reward_gem);

    // credit user
    await q(`UPDATE users SET balance = balance + $2, diamonds = diamonds + $3 WHERE tg_id=$1`, [tg_id, reward_tl, reward_gem]);

    // referral percent to referrer
    const ref = await q(`SELECT referred_by FROM users WHERE tg_id=$1`, [tg_id]);
    const ref_id = Number(ref.rows[0]?.referred_by || 0);
    if (ref_id) {
      const bonus = Number((reward_tl * SETTINGS.referral_ad_percent).toFixed(2));
      if (bonus > 0) {
        await q(`UPDATE users SET balance = balance + $2 WHERE tg_id=$1`, [ref_id, bonus]).catch(() => {});
      }
    }

    // mark completed + ad click count
    await q(`UPDATE ad_sessions SET status='completed', completed_at=NOW() WHERE session_id=$1`, [session_id]);
    await q(`UPDATE ads SET clicks = clicks + 1 WHERE id=$1`, [ses.rows[0].ad_id]);

    return res.json({ ok: true, reward_tl, reward_gem });
  } catch (e) {
    return res.status(500).json({ error: 'server', reason: String(e.message || e) });
  }
});

app.post('/api/convert', async (req, res) => {
  try {
    const tg_id = Number(req.body.tg_id);
    const gems = Math.floor(Number(req.body.gems || 0));
    if (!tg_id || gems <= 0) return res.status(400).json({ error: 'bad_request' });

    const u = await q(`SELECT diamonds FROM users WHERE tg_id=$1`, [tg_id]);
    const have = Number(u.rows[0]?.diamonds || 0);
    if (have < gems) return res.status(400).json({ error: 'insufficient_gems' });

    const amount = Number((gems * SETTINGS.gem_to_tl_rate).toFixed(2));
    await q(`UPDATE users SET diamonds = diamonds - $2, balance = balance + $3 WHERE tg_id=$1`, [tg_id, gems, amount]);
    return res.json({ ok: true, credited_tl: amount });
  } catch (e) {
    return res.status(500).json({ error: 'server', reason: String(e.message || e) });
  }
});

app.post('/api/withdraw/request', async (req, res) => {
  try {
    const tg_id = Number(req.body.tg_id);
    const full_name = String(req.body.full_name || '').trim();
    const iban = String(req.body.iban || '').trim();
    const amount_tl = Number(req.body.amount_tl || 0);

    if (!tg_id || !full_name || !iban || !amount_tl) return res.status(400).json({ error: 'bad_request' });
    if (amount_tl < SETTINGS.min_withdraw_tl) return res.status(400).json({ error: 'min_withdraw', reason: `Minimum ${SETTINGS.min_withdraw_tl} ₺` });

    const u = await q(`SELECT balance FROM users WHERE tg_id=$1`, [tg_id]);
    const bal = Number(u.rows[0]?.balance || 0);
    if (bal < amount_tl) return res.status(400).json({ error: 'insufficient_balance' });

    // reserve funds by subtracting immediately (simpler)
    await q(`UPDATE users SET balance = balance - $2 WHERE tg_id=$1`, [tg_id, amount_tl]);
    await q(`INSERT INTO withdrawals (tg_id, full_name, iban, amount_tl) VALUES ($1,$2,$3,$4)`, [tg_id, full_name, iban, amount_tl]);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server', reason: String(e.message || e) });
  }
});

app.post('/api/advertiser/submit', async (req, res) => {
  try {
    const tg_id = Number(req.body.tg_id);
    const contact = String(req.body.contact || '').trim();
    const ad_url = String(req.body.ad_url || '').trim();
    const seconds = Math.floor(Number(req.body.seconds || 0));
    const target_clicks = Math.floor(Number(req.body.target_clicks || 0));

    if (!tg_id || !ad_url || seconds <= 0 || target_clicks <= 0) return res.status(400).json({ error: 'bad_request' });

    const tier = priceTier(seconds);
    const price_per_click = Number(tier.pricePerClick);
    const total_budget = Number((price_per_click * target_clicks).toFixed(2));

    await q(
      `INSERT INTO advertiser_orders (tg_id, contact, ad_url, seconds, target_clicks, price_per_click, total_budget)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tg_id, contact || null, ad_url, seconds, target_clicks, price_per_click, total_budget]
    );

    return res.json({ ok: true, price_per_click, total_budget });
  } catch (e) {
    return res.status(500).json({ error: 'server', reason: String(e.message || e) });
  }
});

// ===== API: Admin =====
app.post('/api/admin/ads/list', requireAdmin, async (req, res) => {
  const r = await q(`SELECT * FROM ads ORDER BY id DESC LIMIT 200`);
  res.json({ ads: r.rows });
});

app.post('/api/admin/ads/create', requireAdmin, async (req, res) => {
  const { type, url, seconds, reward_tl, reward_gem, is_vip, active, max_clicks } = req.body || {};
  if (!type || !url) return res.status(400).json({ error: 'bad_request' });

  const r = await q(
    `INSERT INTO ads (type,url,seconds,reward_tl,reward_gem,is_vip,active,max_clicks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      String(type),
      String(url),
      Math.max(1, Math.floor(Number(seconds || 15))),
      Number(reward_tl ?? SETTINGS.reward_tl),
      Number(reward_gem ?? SETTINGS.reward_gem),
      Boolean(is_vip),
      active !== false,
      max_clicks ? Math.floor(Number(max_clicks)) : null,
    ]
  );
  res.json({ ok: true, ad: r.rows[0] });
});

app.post('/api/admin/ads/toggle', requireAdmin, async (req, res) => {
  const id = Number(req.body.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  await q(`UPDATE ads SET active = NOT active WHERE id=$1`, [id]);
  res.json({ ok: true });
});

app.post('/api/admin/withdrawals/list', requireAdmin, async (req, res) => {
  const status = String(req.body.status || 'pending');
  const r = await q(
    `SELECT w.*, u.username, u.first_name
     FROM withdrawals w
     JOIN users u ON u.tg_id=w.tg_id
     WHERE w.status=$1
     ORDER BY w.id DESC LIMIT 200`,
    [status]
  );
  res.json({ withdrawals: r.rows });
});

app.post('/api/admin/withdrawals/approve', requireAdmin, async (req, res) => {
  const id = Number(req.body.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });

  await q(
    `UPDATE withdrawals SET status='approved', decided_at=NOW(), decided_by=$2
     WHERE id=$1 AND status='pending'`,
    [id, Number(req.body.tg_id)]
  );
  res.json({ ok: true });
});

app.post('/api/admin/withdrawals/reject', requireAdmin, async (req, res) => {
  const id = Number(req.body.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });

  // refund reserved amount
  const w = await q(`SELECT tg_id, amount_tl FROM withdrawals WHERE id=$1 AND status='pending'`, [id]);
  if (!w.rows[0]) return res.status(404).json({ error: 'not_found' });

  await q(`UPDATE users SET balance = balance + $2 WHERE tg_id=$1`, [Number(w.rows[0].tg_id), Number(w.rows[0].amount_tl)]);
  await q(`UPDATE withdrawals SET status='rejected', decided_at=NOW(), decided_by=$2 WHERE id=$1`, [id, Number(req.body.tg_id)]);
  res.json({ ok: true });
});

app.post('/api/admin/advertisers/list', requireAdmin, async (req, res) => {
  const status = String(req.body.status || 'pending');
  const r = await q(
    `SELECT ao.*, u.username, u.first_name
     FROM advertiser_orders ao
     JOIN users u ON u.tg_id=ao.tg_id
     WHERE ao.status=$1
     ORDER BY ao.id DESC LIMIT 200`,
    [status]
  );
  res.json({ orders: r.rows });
});

app.post('/api/admin/advertisers/approve', requireAdmin, async (req, res) => {
  const id = Number(req.body.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });

  const ord = await q(`SELECT * FROM advertiser_orders WHERE id=$1 AND status='pending'`, [id]);
  if (!ord.rows[0]) return res.status(404).json({ error: 'not_found' });

  // Create ad with max_clicks = target_clicks, reward maybe stays default (users earn normal rewards)
  await q(
    `INSERT INTO ads (type,url,seconds,reward_tl,reward_gem,is_vip,active,max_clicks)
     VALUES ('video',$1,$2,$3,$4,FALSE,TRUE,$5)`,
    [ord.rows[0].ad_url, ord.rows[0].seconds, SETTINGS.reward_tl, SETTINGS.reward_gem, ord.rows[0].target_clicks]
  );

  await q(`UPDATE advertiser_orders SET status='approved', decided_at=NOW(), decided_by=$2 WHERE id=$1`, [id, Number(req.body.tg_id)]);
  res.json({ ok: true });
});

app.post('/api/admin/advertisers/reject', requireAdmin, async (req, res) => {
  const id = Number(req.body.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  await q(`UPDATE advertiser_orders SET status='rejected', decided_at=NOW(), decided_by=$2 WHERE id=$1`, [id, Number(req.body.tg_id)]);
  res.json({ ok: true });
});

app.post('/api/admin/forum/topics/create', requireAdmin, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'bad_request' });
  const r = await q(`INSERT INTO forum_topics (title, created_by) VALUES ($1,$2) RETURNING *`, [title, Number(req.body.tg_id)]);
  res.json({ ok: true, topic: r.rows[0] });
});

app.post('/api/forum/topics', async (req, res) => {
  const r = await q(`SELECT id, title, is_open, created_at FROM forum_topics ORDER BY id DESC LIMIT 50`);
  res.json({ topics: r.rows });
});

app.post('/api/forum/posts', async (req, res) => {
  const topic_id = Number(req.body.topic_id);
  if (!topic_id) return res.status(400).json({ error: 'bad_request' });
  const r = await q(
    `SELECT p.id, p.message, p.created_at, u.username, u.first_name
     FROM forum_posts p
     JOIN users u ON u.tg_id=p.tg_id
     WHERE p.topic_id=$1
     ORDER BY p.id DESC LIMIT 100`,
    [topic_id]
  );
  res.json({ posts: r.rows });
});

app.post('/api/forum/post', async (req, res) => {
  const tg_id = Number(req.body.tg_id);
  const topic_id = Number(req.body.topic_id);
  const message = String(req.body.message || '').trim();
  if (!tg_id || !topic_id || !message) return res.status(400).json({ error: 'bad_request' });

  const t = await q(`SELECT is_open FROM forum_topics WHERE id=$1`, [topic_id]);
  if (!t.rows[0]) return res.status(404).json({ error: 'topic_not_found' });
  if (!t.rows[0].is_open) return res.status(403).json({ error: 'topic_closed' });

  await q(`INSERT INTO forum_posts (topic_id, tg_id, message) VALUES ($1,$2,$3)`, [topic_id, tg_id, message]);
  res.json({ ok: true });
});

// ===== Telegram Bot =====
const bot = new Telegraf(BOT_TOKEN);

function buildMainMenu(tg_id) {
  const isAdmin = isAdminTgId(tg_id);

  // Sadece 3 menü Telegram WebApp olarak dışarı açılacak:
  // - Reklam İzle
  // - Reklam Ver
  // - Para Çek
  // Diğerleri Telegram sohbet içinde cevap olarak gösterilecek.
  const rows = [
    [
      Markup.button.webApp('👀 Reklam İzle', `${WEBAPP_URL}?page=watch`),
      Markup.button.webApp('📣 Reklam Ver', `${WEBAPP_URL}?page=advertise`),
    ],
    [
      Markup.button.webApp('💸 Para Çek', `${WEBAPP_URL}?page=withdraw`),
      Markup.button.text('👛 Cüzdan'),
    ],
    [
      Markup.button.text('🎁 Referans'),
      Markup.button.text('👑 VIP'),
    ],
    [
      Markup.button.text('💎 Elmas → TL'),
      Markup.button.text('ℹ️ Bilgi'),
    ],
    [
      Markup.button.text('💬 Forum'),
    ],
  ];

  if (isAdmin) {
    rows.push([Markup.button.webApp('🛠️ Admin Panel', `${WEBAPP_URL}/admin.html`)]);
  }

  return Markup.keyboard(rows).resize();
}


const INFO_TEXT =
`1️⃣ Elmastoken nedir?
Elmastoken, reklam izleyerek para kazanabileceğin bir bottur.

2️⃣ Elmastoken ile nasıl para kazanabilirim?
Reklamları izlersin, biz reklamverenlerden gelir elde ederiz ve bu geliri seninle paylaşırız.

3️⃣ Güncel ödeme oranı nedir?
Güncel ödeme oranı: 1 reklam başına ₺0,25 ve 0.25 elmas token.

4️⃣ Ne kadar kazanabilirim?
Kazancın, izlediğin reklam sayısına ve davet ettiğin kullanıcı sayısına bağlıdır.

5️⃣ Referans programı nasıl çalışır?
Elmastoken’e referans linkinle yeni kullanıcılar davet ettiğinde, her yeni kullanıcı için ₺18 ve onların izlediği her reklamdan %5 kazanırsın.

6️⃣ Paramı nasıl çekebilirim?
Paranı “Para Çek” bölümündeki talimatları izleyerek çekebilirsin. Minimum çekim tutarı: ₺250.

7️⃣ Para çekme yöntemleri nelerdir?
PayFix, Papara, VISA/MasterCard, Skrill, kripto para ve IBAN.

8️⃣ Elmastoken güvenli mi?
Evet, Elmastoken kullanıcı verilerini ve işlemleri korumak için güvenlik standartlarına uygundur.

9️⃣ Elmas token niçin var?
Elmas tokeni istediğin zaman Türk Lirasına çevirebilirsin. Ayrıca elmas token VIP reklam izlemek için elinde olması lazım.

🔟 VIP reklam nedir?
VIP reklam izlerken normal reklamın iki katı kadar ödül kazanırsın.

Ek soruların varsa, lütfen müşteri destek ekibimizle iletişime geç.`;

bot.start(async (ctx) => {
  const startParam = ctx.startPayload; // referral id
  const tg_id = await ensureUserFromTg(ctx.from, startParam ? Number(startParam) : null);

  // show info text (no "menü hazır" mesajı)
  await ctx.reply(INFO_TEXT, { disable_web_page_preview: true });

  // set menu
  await ctx.reply('👇 Menü aşağıda:', buildMainMenu(tg_id));
});

// --------- Telegram içi menüler (webapp açmadan) ----------
async function getBotUsername(ctx) {
  try {
    if (ctx.botInfo?.username) return ctx.botInfo.username;
    const me = await ctx.telegram.getMe();
    return me.username;
  } catch (e) {
    return null;
  }
}

bot.hears('👛 Cüzdan', async (ctx) => {
  try {
    const user = await ensureUserFromTg(ctx.from);
    const tl = Number(user.balance || 0).toFixed(2);
    const diamonds = Number(user.diamonds || 0).toFixed(2);

    await ctx.replyWithHTML(
      `👛 <b>Cüzdan</b>\n\n` +
      `TL: <b>${tl} ₺</b>\n` +
      `Elmas: <b>${diamonds}</b> 💎\n\n` +
      `Dönüşüm: 1 💎 = ${DIAMOND_TO_TL} ₺\n` +
      `Minimum çekim: ${MIN_WITHDRAW_TL} ₺`
    );
  } catch (err) {
    console.error(err);
    await ctx.reply('Cüzdan bilgisi alınamadı.');
  }
});

bot.hears('🎁 Referans', async (ctx) => {
  try {
    const user = await ensureUserFromTg(ctx.from);
    const username = await getBotUsername(ctx);
    const link = username ? `https://t.me/${username}?start=${user.tg_id}` : `Start param: ${user.tg_id}`;

    await ctx.replyWithHTML(
      `🎁 <b>Referans</b>\n\n` +
      `Referans linkin:\n${link}\n\n` +
      `✅ Her yeni kullanıcı için ${REFERRAL_BONUS_TL}₺ kazanırsın.\n` +
      `✅ Ayrıca onların izlediği her reklamdan %${Math.round(REFERRAL_SHARE * 100)} pay alırsın.`
    );
  } catch (err) {
    console.error(err);
    await ctx.reply('Referans bilgisi alınamadı.');
  }
});

bot.hears('👑 VIP', async (ctx) => {
  try {
    const user = await ensureUserFromTg(ctx.from);
    const isVip = !!user.is_vip;

    await ctx.replyWithHTML(
      `👑 <b>VIP</b>\n\n` +
      `Durum: ${isVip ? '✅ <b>VIP</b>' : '❌ <b>VIP Değil</b>'}\n\n` +
      `VIP reklam izlerken normal reklama göre daha fazla kazanırsın.\n` +
      `Bu bölümün işlevi yakında tamamlanacak.`
    );
  } catch (err) {
    console.error(err);
    await ctx.reply('VIP bilgisi alınamadı.');
  }
});

bot.hears('💎 Elmas → TL', async (ctx) => {
  await ctx.replyWithHTML(
    `💎 <b>Elmas → TL</b>\n\n` +
    `Dönüşüm oranı: 1 💎 = ${DIAMOND_TO_TL} ₺\n\n` +
    `Şimdilik dönüşüm işlemini WebApp üzerinden yapacağız (yakında bu menüden de yapılabilir).`
  );
});

bot.hears('ℹ️ Bilgi', async (ctx) => {
  await ctx.replyWithHTML(
    `ℹ️ <b>Bilgi</b>\n\n` +
    `• Reklam izleyerek elmas/TL kazanırsın.\n` +
    `• Para çekiminde minimum: ${MIN_WITHDRAW_TL} ₺\n` +
    `• Referans ile ekstra kazanç sağlayabilirsin.\n\n` +
    `Sorun olursa destek ekibi ile iletişime geç.`
  );
});

bot.hears('💬 Forum', async (ctx) => {
  await ctx.reply('💬 Forum yakında aktif edilecek.');
});

bot.action('INFO', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(INFO_TEXT, { disable_web_page_preview: true });
});

bot.action('REF', async (ctx) => {
  await ctx.answerCbQuery();
  const tg_id = Number(ctx.from?.id);
  const botUser = await ctx.telegram.getMe();
  const botUsername = botUser.username;

  const link = `https://t.me/${botUsername}?start=${tg_id}`;
  await ctx.reply(
    `🎁 Referans linkin:\n${link}\n\n✅ Her yeni kullanıcı için ₺${SETTINGS.referral_new_user_tl} ve onların izlediği her reklamdan %${Math.round(SETTINGS.referral_ad_percent*100)} kazanırsın.`,
    { disable_web_page_preview: true }
  );
});

bot.action('ADVERTISER', async (ctx) => {
  await ctx.answerCbQuery();
  const t1 = SETTINGS.advertiser_price_tier_1;
  const t2 = SETTINGS.advertiser_price_tier_2;
  await ctx.reply(
`📣 Reklam Ver

Fiyatlandırma:
• ${t1.minSec}–${t1.maxSec} sn reklam: tıklanma başı ${t1.pricePerClick} ₺
• ${t2.minSec}–${t2.maxSec} sn reklam: tıklanma başı ${t2.pricePerClick} ₺

Reklamını admin onaylar. "Reklam Ver" sayfasından süre ve tıklanma bütçesi girerek talep oluşturabilirsin.`,
    { disable_web_page_preview: true }
  );
});

// Keep bot alive
bot.catch((err) => console.error('BOT_ERR', err));

// ===== Start =====
// Webhook endpoint (prevents 409 getUpdates conflict)
app.post('/telegram', async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
  } catch (e) {
    console.error('WEBHOOK_HANDLE_ERR', e);
    // Always respond so Telegram doesn't retry forever
    res.status(200).end();
  }
});

const PORT = process.env.PORT || 10000;

// Render port binding: start HTTP server immediately so Render can detect the open port.
app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on :${PORT}`));

(async () => {
  try {
    await migrate();
  } catch (e) {
    console.error('MIGRATE_ERR', e);
  }
  try {
    // Set webhook (do NOT use polling on Render)
    const publicUrl = (process.env.PUBLIC_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '') || BASE_URL).replace(/\/+$/,'');
    if (!publicUrl) {
      console.warn('PUBLIC_URL/RENDER_EXTERNAL_HOSTNAME not set. Webhook cannot be configured automatically.');
    } else {
      const hookUrl = `${publicUrl}/telegram`;
      await bot.telegram.setWebhook(hookUrl);
      console.log(`Webhook aktif: ${hookUrl}`);
    }
  } catch (e) {
    console.error('WEBHOOK_SETUP_ERR', e);
  }
})();

process.on('SIGINT', () => bot.stop('SIGINT'));
process.on('SIGTERM', () => bot.stop('SIGTERM'));
