'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = process.env.BASE_URL || '';     // ör: https://reklampaybot.onrender.com
const PUBLIC_URL = process.env.PUBLIC_URL || BASE_URL;

if (!BOT_TOKEN) console.warn('BOT_TOKEN missing!');
if (!DATABASE_URL) console.warn('DATABASE_URL missing!');

// ---------- DB ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function q(text, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

function parseTgId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Users table columns differ between versions. We try multiple variants.
async function ensureUser(tg) {
  const tgId = parseTgId(tg?.id);
  if (!tgId) return;
  const username = tg?.username || null;
  const firstName = tg?.first_name || null;

  // Try common schemas
  const tries = [
    `insert into users (tg_id, username, first_name, created_at)
     values ($1,$2,$3, now())
     on conflict (tg_id) do nothing`,
    `insert into users (tg_id, username, first_name)
     values ($1,$2,$3)
     on conflict (tg_id) do nothing`,
  ];

  for (const sql of tries) {
    try {
      await q(sql, [tgId, username, firstName]);
      return;
    } catch (e) {
      // 42703 = undefined_column
      if (e && (e.code === '42703' || e.code === '42P01')) continue;
      // if table missing, just bubble
      continue;
    }
  }
}

async function creditUser(tgId, tlAmount, diamondAmount) {
  const tl = Number(tlAmount) || 0;
  const dia = Number(diamondAmount) || 0;

  const updates = [
    // balance_tl + diamonds
    `update users
     set balance_tl = coalesce(balance_tl,0) + $2,
         diamonds   = coalesce(diamonds,0) + $3
     where tg_id = $1`,
    // tl_balance + diamond_balance
    `update users
     set tl_balance = coalesce(tl_balance,0) + $2,
         diamond_balance = coalesce(diamond_balance,0) + $3
     where tg_id = $1`,
    // balance_tl + elmas (some custom)
    `update users
     set balance_tl = coalesce(balance_tl,0) + $2,
         elmas   = coalesce(elmas,0) + $3
     where tg_id = $1`,
  ];

  let lastErr = null;
  for (const sql of updates) {
    try {
      const r = await q(sql, [tgId, tl, dia]);
      if (r.rowCount === 0) {
        // user yoksa oluşturup tekrar dene
        await q(`insert into users (tg_id) values ($1) on conflict (tg_id) do nothing`, [tgId]).catch(()=>{});
        await q(sql, [tgId, tl, dia]).catch(()=>{});
      }
      return true;
    } catch (e) {
      lastErr = e;
      if (e && (e.code === '42703' || e.code === '42P01')) continue;
    }
  }
  console.error('creditUser failed:', lastErr?.message || lastErr);
  return false;
}

async function bumpDailyCounter(tgId) {
  // optional columns; ignore if not present
  const tries = [
    `update users set daily_ads_watched = coalesce(daily_ads_watched,0) + 1 where tg_id=$1`,
    `update users set ads_watched_today = coalesce(ads_watched_today,0) + 1 where tg_id=$1`,
  ];
  for (const sql of tries) {
    try { await q(sql, [tgId]); return; } catch (e) { if (e && (e.code==='42703'||e.code==='42P01')) continue; }
  }
}

async function getDailyLimitInfo(tgId) {
  // returns {seen, limit} best-effort
  const limit = 50;
  try {
    const r = await q(`select coalesce(daily_ads_watched,0) as seen from users where tg_id=$1`, [tgId]);
    const seen = Number(r.rows?.[0]?.seen || 0);
    return { seen, limit };
  } catch (e) {
    return { seen: 0, limit };
  }
}

// ad_sessions schema differs: either has session_id (uuid/text) or just id bigserial.
// We return a string sessionId that frontend will send back.
async function createAdSession(tgId, seconds, rewardTl, rewardDiamonds) {
  const sessionId = crypto.randomUUID();

  const tries = [
    {
      sql: `insert into ad_sessions (session_id, tg_id, started_at, seconds, reward_tl, reward_diamonds, completed)
            values ($1,$2, now(), $3, $4, $5, false)
            returning session_id`,
      params: [sessionId, tgId, seconds, rewardTl, rewardDiamonds],
      pick: (r) => r.rows?.[0]?.session_id,
    },
    {
      sql: `insert into ad_sessions (tg_id, started_at, seconds, reward_tl, reward_diamonds, completed)
            values ($1, now(), $2, $3, $4, false)
            returning id`,
      params: [tgId, seconds, rewardTl, rewardDiamonds],
      pick: (r) => String(r.rows?.[0]?.id),
    },
    {
      sql: `insert into ad_sessions (tg_id, started_at, seconds, reward_tl, completed)
            values ($1, now(), $2, $3, false)
            returning id`,
      params: [tgId, seconds, rewardTl],
      pick: (r) => String(r.rows?.[0]?.id),
    },
  ];

  let lastErr = null;
  for (const t of tries) {
    try {
      const r = await q(t.sql, t.params);
      const id = t.pick(r);
      if (id) return String(id);
    } catch (e) {
      lastErr = e;
      if (e && (e.code === '42703' || e.code === '42P01')) continue;
    }
  }
  console.error('createAdSession failed:', lastErr?.message || lastErr);
  return null;
}

async function completeAdSession(sessionId, tgId) {
  // Mark completed only once and return rewards.
  // We'll try both schemas.
  const tries = [
    {
      sql: `update ad_sessions
            set completed=true, completed_at=now()
            where session_id=$1 and tg_id=$2 and completed=false
            returning reward_tl, reward_diamonds`,
      params: [sessionId, tgId],
    },
    {
      sql: `update ad_sessions
            set completed=true, completed_at=now()
            where id=$1 and tg_id=$2 and completed=false
            returning reward_tl, reward_diamonds`,
      params: [sessionId, tgId],
    },
    {
      sql: `update ad_sessions
            set completed=true, completed_at=now()
            where id=$1 and tg_id=$2 and completed=false
            returning reward_tl`,
      params: [sessionId, tgId],
    },
  ];

  let lastErr = null;
  for (const t of tries) {
    try {
      const r = await q(t.sql, t.params);
      if (r.rowCount === 0) continue;
      const tl = Number(r.rows?.[0]?.reward_tl ?? r.rows?.[0]?.reward_tl ?? r.rows?.[0]?.reward_tl ?? r.rows?.[0]?.reward_tl);
      const dia = Number(r.rows?.[0]?.reward_diamonds ?? 0);
      return { tl: Number.isFinite(tl) ? tl : 0, diamonds: Number.isFinite(dia) ? dia : 0 };
    } catch (e) {
      lastErr = e;
      if (e && (e.code === '42703' || e.code === '42P01')) continue;
    }
  }
  console.error('completeAdSession failed:', lastErr?.message || lastErr);
  return null;
}

// ---------- Bot ----------
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
}

function webAppUrl(tgId) {
  const base = (PUBLIC_URL || BASE_URL || '').replace(/\/+$/, '');
  return `${base}/webapp/index.html?tg_id=${encodeURIComponent(String(tgId))}`;
}

function mainKeyboard(tgId) {
  const url = webAppUrl(tgId);
  return Markup.keyboard([
    ['👀 Reklam İzle', '📣 Reklam Ver'],
    ['💰 Para Çek', '👛 Cüzdan'],
    ['🎁 Referans', '💎 Elmas → TL'],
    ['ℹ️ Bilgi', '💬 Forum'],
  ]).resize();

  // NOTE: WebApp açmak için inline button da kullanıyoruz (aşağıda).
}

async function sendMainMenu(ctx) {
  const tgId = ctx.from?.id;
  const url = webAppUrl(tgId);
  await ctx.reply(
    '👇 Menü aşağıda. Reklam izlemek için butona bas.',
    Markup.inlineKeyboard([
      Markup.button.webApp('👀 Reklam İzle (WebApp)', url),
    ])
  );
  await ctx.reply('Alternatif menü:', mainKeyboard(tgId));
}

if (bot) {
  bot.start(async (ctx) => {
    await ensureUser(ctx.from);

    // referral: /start <ref_tg_id>
    try {
      const payload = (ctx.startPayload || '').trim();
      const refId = parseTgId(payload);
      const me = parseTgId(ctx.from?.id);
      if (refId && me && refId !== me) {
        // try to set referrer only once if columns exist
        await q(
          `update users set referrer_tg_id = $2
           where tg_id = $1 and (referrer_tg_id is null or referrer_tg_id=0)`,
          [me, refId]
        ).catch(()=>{});

        // optional referral earnings table
        await q(
          `insert into referral_earnings (tg_id, referrer_tg_id, earned_at, amount_tl)
           values ($1,$2, now(), $3)`,
          [me, refId, 0.0]
        ).catch(()=>{});
      }
    } catch (_) {}

    await sendMainMenu(ctx);
  });

  bot.hears('👀 Reklam İzle', async (ctx) => {
    const tgId = parseTgId(ctx.from?.id);
    const url = webAppUrl(tgId);
    return ctx.reply('Reklam açılıyor…', Markup.inlineKeyboard([
      Markup.button.webApp('▶️ Reklamı Başlat', url),
    ]));
  });

  bot.hears('👛 Cüzdan', async (ctx) => {
    const tgId = parseTgId(ctx.from?.id);
    await ensureUser(ctx.from);

    // Try read balances from possible columns
    let tl = 0, dia = 0;
    const queries = [
      `select coalesce(balance_tl,0) as tl, coalesce(diamonds,0) as dia from users where tg_id=$1`,
      `select coalesce(tl_balance,0) as tl, coalesce(diamond_balance,0) as dia from users where tg_id=$1`,
      `select coalesce(balance_tl,0) as tl, coalesce(elmas,0) as dia from users where tg_id=$1`,
    ];
    for (const sql of queries) {
      try {
        const r = await q(sql, [tgId]);
        tl = Number(r.rows?.[0]?.tl || 0);
        dia = Number(r.rows?.[0]?.dia || 0);
        break;
      } catch (e) {
        if (e && (e.code === '42703' || e.code === '42P01')) continue;
      }
    }

    return ctx.reply(`👛 Cüzdan\n\nTL: ${tl.toFixed(2)} ₺\nElmas: ${dia.toFixed(2)} 💎`);
  });

  bot.hears('🎁 Referans', async (ctx) => {
    const me = parseTgId(ctx.from?.id);
    const link = `https://t.me/${ctx.me}?start=${me}`;
    return ctx.reply(`🎁 Referans linkin:\n${link}\n\nPaylaştıkça kazanma sistemini yarın detaylandırırız.`);
  });

  bot.on('message', async (ctx) => {
    // default
    if (ctx.message?.text === '/start') return;
  });
}

// ---------- Web + API ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_, res) => res.json({ ok: true }));

app.use('/webapp', express.static(path.join(__dirname, 'webapp'), { extensions: ['html'] }));

// Telegram webhook endpoint
app.post('/telegram', async (req, res) => {
  try {
    if (!bot) return res.status(500).send('bot_not_ready');
    await bot.handleUpdate(req.body);
    return res.sendStatus(200);
  } catch (e) {
    console.error('webhook error', e);
    return res.sendStatus(200);
  }
});

// Start ad session
app.post('/api/ad/start', async (req, res) => {
  try {
    const tgId = parseTgId(req.body?.tg_id);
    if (!tgId) return res.status(400).json({ ok: false, error: 'bad_tg_id' });

    await ensureUser({ id: tgId });

    const { seen, limit } = await getDailyLimitInfo(tgId);
    if (seen >= limit) {
      return res.status(429).json({ ok: false, error: 'daily_limit', seen, limit });
    }

    const seconds = 15;
    const rewardTl = 0.25;
    const rewardDiamonds = 0.25;

    const session_id = await createAdSession(tgId, seconds, rewardTl, rewardDiamonds);
    if (!session_id) return res.status(500).json({ ok: false, error: 'session_create_failed' });

    return res.json({
      ok: true,
      session_id,
      seconds,
      reward_tl: rewardTl,
      reward_diamonds: rewardDiamonds,
      seen,
      limit,
    });
  } catch (e) {
    console.error('/api/ad/start error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Complete ad session + credit reward
app.post('/api/ad/complete', async (req, res) => {
  try {
    const tgId = parseTgId(req.body?.tg_id);
    const sessionId = String(req.body?.session_id || '').trim();
    if (!tgId) return res.status(400).json({ ok: false, error: 'bad_tg_id' });
    if (!sessionId) return res.status(400).json({ ok: false, error: 'bad_session' });

    const rewards = await completeAdSession(sessionId, tgId);
    if (!rewards) return res.status(409).json({ ok: false, error: 'already_completed_or_not_found' });

    const tlReward = Number(rewards.tl) || 0.25;
    const diaReward = Number(rewards.diamonds) || 0.25;

    await creditUser(tgId, tlReward, diaReward);
    await bumpDailyCounter(tgId);

    // Telegram'a otomatik mesaj
    try {
      if (bot) {
        await bot.telegram.sendMessage(
          tgId,
          `✅ Reklam izledin! +${tlReward.toFixed(2)} TL ve +${diaReward.toFixed(2)} Elmas cüzdanına eklendi.`
        );
      }
    } catch (e) {
      console.error('telegram notify failed', e?.message || e);
    }

    return res.json({ ok: true, tl_reward: tlReward, diamond_reward: diaReward });
  } catch (e) {
    console.error('/api/ad/complete error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Start server + set webhook
app.listen(PORT, async () => {
  console.log(`Server listening on :${PORT}`);
  if (!bot) return;

  try {
    const base = (BASE_URL || PUBLIC_URL || '').replace(/\/+$/, '');
    const webhookUrl = `${base}/telegram`;

    console.log('Webhook aktif:', webhookUrl);
    await bot.telegram.setWebhook(webhookUrl);

    console.log('Bot started (webhook mode)');
  } catch (e) {
    console.error('Webhook set error:', e);
  }
});
