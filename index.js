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


// ---- USERS TABLE COLUMN DETECTION (to avoid "column does not exist" crashes) ----
let _usersColsCache = null;

async function getUsersColumns() {
  if (_usersColsCache) return _usersColsCache;
  const res = await q(
    `select column_name
       from information_schema.columns
      where table_schema='public' and table_name='users'`
  );
  const cols = new Set(res.rows.map(r => r.column_name));
  _usersColsCache = cols;
  return cols;
}

function pickFirstExisting(cols, candidates) {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

async function getUsersColMap() {
  const cols = await getUsersColumns();
  const tlCol = pickFirstExisting(cols, ['balance_tl','tl_balance','tl','balance','try_balance','lira_balance']);
  const diaCol = pickFirstExisting(cols, ['diamonds','diamond_balance','elmas','elmas_token','token_balance','diamond']);
  const dailyCol = pickFirstExisting(cols, ['daily_ads_watched','daily_views','daily_watch','daily_count']);
  return { tlCol, diaCol, dailyCol, cols };
}
function parseTgId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function safeBigInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
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

async function creditUser(tgId, tlAmount, diamondAmount, reason = 'reward') {
  tgId = safeBigInt(tgId);
  if (!tgId) return false;

  const tl = Number(tlAmount || 0);
  const dia = Number(diamondAmount || 0);

  const { tlCol, diaCol } = await getUsersColMap();

  if (!tlCol && tl !== 0) {
    console.error(`creditUser failed: users table has no TL column (expected one of balance_tl/tl_balance/tl/...)`);
    return false;
  }
  if (!diaCol && dia !== 0) {
    console.error(`creditUser failed: users table has no DIAMOND column (expected one of diamonds/elmas/...)`);
    return false;
  }

  const sets = [];
  const params = [tgId];
  let p = 2;

  if (tlCol && tl !== 0) { sets.push(`${tlCol} = coalesce(${tlCol},0) + $${p++}`); params.push(tl); }
  if (diaCol && dia !== 0) { sets.push(`${diaCol} = coalesce(${diaCol},0) + $${p++}`); params.push(dia); }

  if (sets.length === 0) return true;

  try {
    await q(`update users set ${sets.join(', ')} where tg_id=$1`, params);
    return true;
  } catch (e) {
    console.error('creditUser failed:', e.message);
    return false;
  }
}



async function bumpDailyCounter(tgId) {
  try {
    const { dailyCol } = await getUsersColMap();
    if (!dailyCol) return;
    await q(`update users set ${dailyCol} = coalesce(${dailyCol},0) + 1 where tg_id=$1`, [tgId]);
  } catch (e) {
    // ignore
  }
}


async function getDailyLimitInfo(tgId) {
  // returns {seen, limit} best-effort
  const limit = 50;
  try {
    const { dailyCol } = await getUsersColMap();
    if (!dailyCol) return { seen: 0, limit };
    const r = await q(`select coalesce(${dailyCol},0) as seen from users where tg_id=$1`, [tgId]);
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
  // Complete only if enough time has passed since started_at.
  // This prevents "reward even if user closes early".
  const selectTries = [
    {
      sql: `select session_id as sid, seconds, started_at, completed, reward_tl, reward_diamonds
            from ad_sessions where session_id=$1 and tg_id=$2 limit 1`,
      params: [sessionId, tgId],
    },
    {
      sql: `select id as sid, seconds, started_at, completed, reward_tl, reward_diamonds
            from ad_sessions where id=$1 and tg_id=$2 limit 1`,
      params: [sessionId, tgId],
    },
  ];

  let row = null;
  for (const t of selectTries) {
    try {
      const r = await q(t.sql, t.params);
      if (r.rowCount > 0) { row = r.rows[0]; break; }
    } catch (e) {
      if (e && (e.code === '42703' || e.code === '42P01')) continue;
      throw e;
    }
  }
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.completed) return { ok: false, reason: 'already_completed' };

  const seconds = Number(row.seconds);
  const startedAt = row.started_at ? new Date(row.started_at) : null;
  if (!Number.isFinite(seconds) || !startedAt) return { ok: false, reason: 'bad_session' };

  const elapsed = (Date.now() - startedAt.getTime()) / 1000;
  // small tolerance so legit users don't miss by milliseconds
  if (elapsed + 0.4 < seconds) {
    return { ok: false, reason: 'too_early', remaining: Math.ceil(seconds - elapsed) };
  }

  const updateTries = [
    {
      sql: `update ad_sessions set completed=true, completed_at=now()
            where session_id=$1 and tg_id=$2 and completed=false
            returning reward_tl, reward_diamonds`,
      params: [sessionId, tgId],
    },
    {
      sql: `update ad_sessions set completed=true, completed_at=now()
            where id=$1 and tg_id=$2 and completed=false
            returning reward_tl, reward_diamonds`,
      params: [sessionId, tgId],
    },
    {
      sql: `update ad_sessions set completed=true, completed_at=now()
            where id=$1 and tg_id=$2 and completed=false
            returning reward_tl`,
      params: [sessionId, tgId],
    },
  ];

  let lastErr = null;
  for (const t of updateTries) {
    try {
      const r = await q(t.sql, t.params);
      if (r.rowCount === 0) continue;
      const tl = Number(r.rows?.[0]?.reward_tl ?? 0);
      const dia = Number(r.rows?.[0]?.reward_diamonds ?? 0);
      return { ok: true, tl: Number.isFinite(tl) ? tl : 0, diamonds: Number.isFinite(dia) ? dia : 0 };
    } catch (e) {
      lastErr = e;
      if (e && (e.code === '42703' || e.code === '42P01')) continue;
    }
  }
  console.error('completeAdSession failed:', lastErr?.message || lastErr);
  return { ok: false, reason: 'update_failed' };
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

function webAppPageUrl(tgId, pageFile) {
  const base = (process.env.PUBLIC_URL || process.env.BASE_URL || '').replace(/\/$/, '');
  return `${base}/webapp/${pageFile}?tg_id=${tgId}`;
}

function mainKeyboard(tgId) {
  const btn = (text, file) => ({ text, web_app: { url: webAppPageUrl(tgId, file) } });

  return Markup.keyboard([
    [btn('📣 Reklam Ver', 'create_ad.html'), btn('👛 Cüzdan', 'wallet.html')],
    ['💰 Para Çek', btn('💎 Elmas → TL', 'convert.html')],
    ['🎁 Referans', 'ℹ️ Bilgi'],
    ['💬 Forum'],
  ])
    .resize(true)
    .persistent(true);
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

    const { tlCol, diaCol } = await getUsersColMap();
    let tl = 0, dia = 0;

    try {
      if (tlCol || diaCol) {
        const parts = [];
        if (tlCol) parts.push(`coalesce(${tlCol},0) as tl`);
        else parts.push(`0 as tl`);
        if (diaCol) parts.push(`coalesce(${diaCol},0) as dia`);
        else parts.push(`0 as dia`);
        const r = await q(`select ${parts.join(', ')} from users where tg_id=$1`, [tgId]);
        tl = Number(r.rows?.[0]?.tl || 0);
        dia = Number(r.rows?.[0]?.dia || 0);
      }
    } catch (e) {
      // ignore
    }

    return ctx.reply(`👛 Cüzdan

TL: ${tl.toFixed(2)} ₺
Elmas: ${dia.toFixed(2)} 💎`);
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
});// Wallet API for webapp pages
app.post('/api/wallet', async (req, res) => {
  try {
    const tgId = parseTgId(req.body?.tg_id);
    if (!tgId) return res.status(400).json({ ok: false, error: 'bad_tg_id' });
    await ensureUser({ id: tgId });
    const b = await getUserBalances(tgId);
    return res.json({ ok: true, ...b });
  } catch (e) {
    console.error('/api/wallet error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Create Ad API (simple). Pricing: 1 second = 0.10 TL
const PRICE_PER_SECOND_TL = 0.10;

app.post('/api/ad/create', async (req, res) => {
  try {
    const tgId = parseTgId(req.body?.tg_id);
    if (!tgId) return res.status(400).json({ ok: false, error: 'bad_tg_id' });

    const seconds = Number(req.body?.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
      return res.status(400).json({ ok: false, error: 'bad_seconds' });
    }

    const costTl = Math.round(seconds * PRICE_PER_SECOND_TL * 100) / 100;

    const payload = {
      seconds,
      cost_tl: costTl,
      youtube_url: req.body?.youtube_url || null,
      page_url: req.body?.page_url || null,
      video_url: req.body?.video_url || null,
      target_url: req.body?.target_url || null,
      adsense_code: req.body?.adsense_code || null,
    };

    // Try inserting with richer columns, fallback to minimal (schema-flex)
    let inserted = null;
    const tries = [
      {
        sql: `insert into ads (created_by, seconds, cost_tl, youtube_url, page_url, video_url, target_url, adsense_code, active, status, created_at)
              values ($1,$2,$3,$4,$5,$6,$7,$8,true,'pending',now())
              returning id`,
        params: [tgId, seconds, costTl, payload.youtube_url, payload.page_url, payload.video_url, payload.target_url, payload.adsense_code],
      },
      {
        sql: `insert into ads (tg_id, seconds, cost_tl, url, active, created_at)
              values ($1,$2,$3,$4,true,now())
              returning id`,
        params: [tgId, seconds, costTl, payload.target_url || payload.page_url || payload.video_url || payload.youtube_url || null],
      },
    ];

    for (const t of tries) {
      try {
        const r = await q(t.sql, t.params);
        if (r.rowCount > 0) { inserted = r.rows[0]; break; }
      } catch (e) {
        if (e && (e.code === '42P01' || e.code === '42703')) continue;
        console.warn('ad insert failed:', e?.message || e);
      }
    }

    if (!inserted) {
      return res.status(500).json({ ok: false, error: 'insert_failed', cost_tl: costTl });
    }

    return res.json({ ok: true, id: inserted.id, cost_tl: costTl, status: 'pending' });
  } catch (e) {
    console.error('/api/ad/create error', e);
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
