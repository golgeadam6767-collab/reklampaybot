/**
 * ReklamPayBot - minimal, schema-flex, webhook Telegraf + Express
 * - Single inline "Panel" message with WebApp buttons (no reply keyboard clutter)
 * - Watch flow uses ad_sessions with server-side elapsed-time validation
 * - WebApp auth uses Telegram initData hash verification
 */
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const crypto = require("crypto");
const { Pool } = require("pg");

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env var");

// WebApp oturum token'ı (JWT) imzalamak için secret.
// Prod'da Render Environment'e güçlü bir WEBAPP_SECRET eklemen önerilir.
// Tanımlı değilse, BOT_TOKEN'u fallback olarak kullanır (crash olmasın diye).
const WEBAPP_SECRET = process.env.WEBAPP_SECRET || BOT_TOKEN || 'dev-webapp-secret';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL env var");

const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
if (!PUBLIC_URL) {
  console.warn("WARN: PUBLIC_URL is empty. WebApp buttons may be broken.");
}

// Backward-compat alias: some earlier snippets used PUBLIC_BASE_URL.
// Keeping this avoids ReferenceError crashes.
const PUBLIC_BASE_URL = PUBLIC_URL;

const PORT = parseInt(process.env.PORT || "10000", 10);

const ADMIN_TG_ID = process.env.ADMIN_TG_ID ? String(process.env.ADMIN_TG_ID) : "7784281785";

function isAdmin(tgId) {
  return String(tgId) === String(ADMIN_TG_ID);
}

// -----------------------
// Admin helpers
// -----------------------
function requireAdmin(req, res, next) {
  if (!req.tgUser?.id) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!isAdmin(req.tgUser.id)) return res.status(403).json({ ok: false, error: "forbidden" });
  return next();
}

async function getTableColumns(tableName) {
  const q = `select column_name from information_schema.columns where table_schema='public' and table_name=$1`;
  const r = await pg.query(q, [tableName]);
  return new Set((r.rows || []).map((x) => x.column_name));
}

// Rewards
const WATCH_REWARD_TL = 0.25;
const WATCH_REWARD_DIAMONDS = 0.25;

// Ad pricing for "Reklam Ver" (user requested: 1 sn = 0.10 TL)
const PRICE_PER_SECOND_TL = 0.10;

// Ad selection strategy from pool: "random" (default) or "sequence"
const AD_PICK_STRATEGY = (process.env.AD_PICK_STRATEGY || "random").toLowerCase();

// Referral percentages (per your latest rules)
// - One-time bonus: on referred user's FIRST completed ad, referrer earns +18% of that ad reward.
// - Ongoing bonus: for EVERY completed ad by the referred user, referrer earns +5% of that ad reward.
const REFERRAL_SIGNUP_BONUS_RATE = 0.18;
const REFERRAL_AD_EARN_RATE = 0.05;

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

const USERS_COL_CANDIDATES = {
  tg_id: ["tg_id", "telegram_id", "user_id"],
  balance_tl: ["balance_tl", "tl_balance", "wallet_tl", "balance"],
  diamonds: ["diamonds", "elmas", "diamond_balance", "diamond"],
  daily_ads_watched: ["daily_ads_watched", "ads_watched_today", "daily_views", "daily_views_count"],
  referred_by: ["referred_by", "referrer_tg_id", "ref_by"],
  panel_message_id: ["panel_message_id", "menu_message_id"],
};

let usersCols = null; // resolved mapping: {tg_id:'tg_id', balance_tl:'balance_tl', ...}

async function ensureSchema() {
  await pool.query(`
    create table if not exists public.users (
      id bigserial primary key,
      tg_id bigint unique not null,
      balance_tl numeric not null default 0,
      diamonds numeric not null default 0,
      daily_ads_watched int not null default 0,
      referred_by bigint,
      panel_message_id bigint,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists public.ads (
      id bigserial primary key,
      title text,
      seconds int not null default 10,
      page_url text,
      youtube_url text,
      game_url text,
      media_url text,
      adsense_code text,
      created_by bigint,
      price_tl numeric not null default 0,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists public.ad_sessions (
      id bigserial primary key,
      tg_id bigint not null,
      ad_id bigint not null references public.ads(id) on delete cascade,
      seconds int not null,
      started_at timestamptz not null default now(),
      completed boolean not null default false,
      completed_at timestamptz
    );
  `);

  // optional referral earnings ledger (safe to ignore if unused)
  await pool.query(`
    create table if not exists public.referral_earnings (
      id bigserial primary key,
      referrer_tg_id bigint not null,
      referred_tg_id bigint not null,
      amount_tl numeric not null default 0,
      amount_diamonds numeric not null default 0,
      created_at timestamptz not null default now()
    );
  `);
}

async function resolveUsersColumns() {
  const { rows } = await pool.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='users'
  `);
  const cols = new Set(rows.map(r => r.column_name));
  const mapping = {};
  for (const key of Object.keys(USERS_COL_CANDIDATES)) {
    const candidates = USERS_COL_CANDIDATES[key];
    const found = candidates.find(c => cols.has(c));
    mapping[key] = found || null;
  }
  if (!mapping.tg_id) throw new Error("users table is missing tg_id (or equivalent) column");
  if (!mapping.balance_tl) mapping.balance_tl = "balance_tl";
  if (!mapping.diamonds) mapping.diamonds = "diamonds";
  if (!mapping.daily_ads_watched) mapping.daily_ads_watched = "daily_ads_watched";
  if (!mapping.referred_by) mapping.referred_by = "referred_by";
  if (!mapping.panel_message_id) mapping.panel_message_id = "panel_message_id";
  usersCols = mapping;
}

function qIdent(name) {
  // Safe identifier from whitelist only
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Unsafe identifier");
  return `"${name.replace(/"/g, '""')}"`;
}

async function ensureUser(tg_id, referred_by = null) {
  // Upsert user. If referred_by exists and user has none, set it.
  const tgCol = qIdent(usersCols.tg_id);
  const refCol = qIdent(usersCols.referred_by);
  const sql = `
    insert into public.users (${tgCol}, ${refCol})
    values ($1, $2)
    on conflict (${tgCol}) do update
      set ${refCol} = coalesce(public.users.${refCol}, excluded.${refCol})
    returning *
  `;
  const { rows } = await pool.query(sql, [tg_id, referred_by]);
  return rows[0];
}

async function getUser(tg_id) {
  const tgCol = qIdent(usersCols.tg_id);
  const { rows } = await pool.query(`select * from public.users where ${tgCol}=$1 limit 1`, [tg_id]);
  return rows[0] || null;
}

async function setPanelMessageId(tg_id, message_id) {
  const tgCol = qIdent(usersCols.tg_id);
  const pmCol = qIdent(usersCols.panel_message_id);
  await pool.query(`update public.users set ${pmCol}=$2 where ${tgCol}=$1`, [tg_id, message_id]);
}

async function getBalances(tg_id) {
  const tgCol = qIdent(usersCols.tg_id);
  const tlCol = qIdent(usersCols.balance_tl);
  const dCol = qIdent(usersCols.diamonds);
  const { rows } = await pool.query(
    `select ${tlCol} as balance_tl, ${dCol} as diamonds from public.users where ${tgCol}=$1`,
    [tg_id]
  );
  if (!rows[0]) return { balance_tl: 0, diamonds: 0 };
  return {
    balance_tl: Number(rows[0].balance_tl || 0),
    diamonds: Number(rows[0].diamonds || 0),
  };
}

async function creditUser(tg_id, addTl, addDiamonds) {
  const tgCol = qIdent(usersCols.tg_id);
  const tlCol = qIdent(usersCols.balance_tl);
  const dCol = qIdent(usersCols.diamonds);

  // avoid NaN in SQL
  const aTl = Number.isFinite(addTl) ? addTl : 0;
  const aD = Number.isFinite(addDiamonds) ? addDiamonds : 0;

  const { rows } = await pool.query(
    `update public.users
     set ${tlCol} = coalesce(${tlCol},0) + $2,
         ${dCol}  = coalesce(${dCol},0)  + $3
     where ${tgCol}=$1
     returning ${tlCol} as balance_tl, ${dCol} as diamonds`,
    [tg_id, aTl, aD]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Telegram WebApp auth (initData verify)
// ---------------------------------------------------------------------------
function verifyInitData(initData) {
  // initData is URL-encoded querystring provided by Telegram WebApp
  if (!initData || typeof initData !== "string") return { ok: false, reason: "missing_initData" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };
  params.delete("hash");

  // Build data-check-string (sorted)
  const pairs = [];
  for (const [k, v] of params.entries()) {
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return { ok: false, reason: "bad_hash" };

  const userStr = params.get("user");
  if (!userStr) return { ok: false, reason: "missing_user" };
  let user;
  try { user = JSON.parse(userStr); } catch { return { ok: false, reason: "bad_user_json" }; }
  if (!user || !user.id) return { ok: false, reason: "missing_user_id" };

  return { ok: true, user, params };
}

function signWebAppToken(tgId) {
  const crypto = require("crypto");
  return crypto.createHmac("sha256", WEBAPP_SECRET).update(String(tgId)).digest("hex").slice(0, 24);
}
function verifyWebAppToken(tgId, token) {
  if (!tgId || !token) return false;
  try {
    const expected = signWebAppToken(tgId);
    return require("crypto").timingSafeEqual(Buffer.from(expected), Buffer.from(String(token)));
  } catch (_) {
    return false;
  }
}


function requireWebAppAuth(req, res, next) {
  const initData = req.headers["x-telegram-initdata"] || req.body?.initData || req.query?.initData;

  const v = verifyInitData(initData);
  if (v.ok) {
    req.tgUser = v.user;
    req.initData = initData;
    return next();
  }

  const tgId = req.body?.tg_id || req.query?.tg_id;
  const token = req.body?.token || req.query?.token || req.headers["x-webapp-token"];
  if (verifyWebAppToken(tgId, token)) {
    req.tgUser = { id: Number(tgId) };
    req.initData = null;
    return next();
  }

  return res.status(401).json({ ok: false, error: v.reason || "unauthorized" });
}


// ---------------------------------------------------------------------------
// Express app + API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  // If someone opens base URL, show watch page
  res.redirect("/webapp/watch.html");
});

app.use("/webapp", express.static(require("path").join(__dirname, "webapp"), { maxAge: "1h" }));

app.post("/api/wallet", requireWebAppAuth, async (req, res) => {
  try {
    const tg_id = Number(req.tgUser.id);
    await ensureUser(tg_id);
    const b = await getBalances(tg_id);
    res.json({ ok: true, ...b });
  } catch (e) {
    console.error("wallet error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Fallback: initData gelmezse tg_id ile sadece bakiye görüntüleme.
// (Telegram WebApp domain BotFather'da ayarlı değilse masaüstünde initData boş gelebiliyor.)
app.get("/api/wallet_public", async (req, res) => {
  try {
    const tg_id = Number(req.query.tg_id || 0);
    if (!tg_id) return res.status(400).json({ ok: false, error: "bad_tg_id" });
    await ensureUser(tg_id);
    const b = await getBalances(tg_id);
    res.json({ ok: true, ...b, note: "unverified" });
  } catch (e) {
    console.error("wallet_public error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/ad/start", requireWebAppAuth, async (req, res) => {
  try {
    const tg_id = Number(req.tgUser.id);
    await ensureUser(tg_id);

    // Pick an active ad from pool:
    // - random (default) or sequence via env AD_PICK_STRATEGY
    // - respect max_clicks if present
    const orderBy = AD_PICK_STRATEGY === "sequence" ? "order by clicks asc nulls first, id asc" : "order by random()";
    const { rows } = await pool.query(
      `select *
         from public.ads
        where active=true
          and (max_clicks is null or clicks < max_clicks)
        ${orderBy}
        limit 1`
    );
    const ad = rows[0];
    if (!ad) return res.status(404).json({ ok: false, error: "no_ad" });

    const seconds = Math.max(3, Math.min(300, parseInt(ad.seconds, 10) || WATCH_SECONDS_DEFAULT));

    // reward alanları farklı şema sürümlerinde değişebilir; varsa session'a yaz.
    const rewardTl = Number(ad.reward_tl ?? WATCH_REWARD_TL);
    const rewardDiamonds = Number(ad.reward_gems ?? ad.reward_diamonds ?? WATCH_REWARD_DIAMONDS);

    let sRows;
    try {
      ({ rows: sRows } = await pool.query(
        `insert into public.ad_sessions (tg_id, ad_id, seconds, reward_tl, reward_diamonds)
         values ($1,$2,$3,$4,$5) returning id, started_at`,
        [tg_id, ad.id, seconds, rewardTl, rewardDiamonds]
      ));
    } catch (e) {
      // eski şema
      ({ rows: sRows } = await pool.query(
        `insert into public.ad_sessions (tg_id, ad_id, seconds) values ($1,$2,$3) returning id, started_at`,
        [tg_id, ad.id, seconds]
      ));
    }
    const session = sRows[0];

    // Eski "type + url" şemasını yeni webapp alanlarına map et
    const rawType = String(ad.type || "").toLowerCase();
    const rawUrl = ad.url || "";
    let page_url = ad.page_url || "";
    let youtube_url = ad.youtube_url || "";
    let game_url = ad.game_url || "";
    let media_url = ad.media_url || "";
    if (!page_url && !youtube_url && !game_url && !media_url && rawUrl) {
      if (rawType === "video" || /\.mp4(\?|#|$)/i.test(rawUrl)) media_url = rawUrl;
      else if (rawType === "youtube" || /youtu\.?be/.test(rawUrl)) youtube_url = rawUrl;
      else if (rawType === "game") game_url = rawUrl;
      else page_url = rawUrl;
    }

    res.json({
      ok: true,
      session_id: session.id,
      seconds,
      reward: { tl: rewardTl, diamonds: rewardDiamonds },
      ad: {
        id: ad.id,
        title: ad.title || "Reklam",
        page_url,
        youtube_url,
        game_url,
        media_url,
        adsense_code: ad.adsense_code || "",
      },
    });
  } catch (e) {
    console.error("ad/start error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/ad/complete", requireWebAppAuth, async (req, res) => {
  const tg_id = Number(req.tgUser.id);
  const session_id = Number(req.body?.session_id);
  if (!session_id) return res.status(400).json({ ok: false, error: "missing_session_id" });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const { rows } = await client.query(
      `select id, tg_id, ad_id, seconds, started_at, completed, reward_tl, reward_diamonds
       from public.ad_sessions
       where id=$1 for update`,
      [session_id]
    );
    const s = rows[0];
    if (!s) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "session_not_found" });
    }
    if (Number(s.tg_id) !== tg_id) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "not_your_session" });
    }
    if (s.completed) {
      await client.query("rollback");
      return res.json({ ok: true, already: true });
    }

    // Enforce watch time: server-side elapsed >= seconds
    const { rows: nowRows } = await client.query(`select now() as now`);
    const now = new Date(nowRows[0].now);
    const started = new Date(s.started_at);
    const elapsed = (now.getTime() - started.getTime()) / 1000;

    if (elapsed + 0.5 < Number(s.seconds)) { // 0.5s tolerance
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "too_early", elapsed, required: Number(s.seconds) });
    }

    await client.query(
      `update public.ad_sessions
       set completed=true, completed_at=now()
       where id=$1`,
      [session_id]
    );

    const rewardTl = Number(s.reward_tl ?? WATCH_REWARD_TL);
    const rewardDiamonds = Number(s.reward_diamonds ?? WATCH_REWARD_DIAMONDS);

    // Increment ad click count (if column exists)
    try {
      await client.query(`update public.ads set clicks = coalesce(clicks,0) + 1, active = case when max_clicks is not null and (coalesce(clicks,0) + 1) >= max_clicks then false else active end where id = $1`, [s.ad_id]);
    } catch (e) {
      // ignore schema differences
    }

    // Credit reward to watcher
    const balances = await creditUser(tg_id, rewardTl, rewardDiamonds);

    // Referral rewards:
    // - +5% on every referred user's completed ad
    // - one-time +18% on referred user's FIRST completed ad
    try {
      const { rows: urows } = await client.query(`select referred_by from public.users where tg_id=$1`, [tg_id]);
      const referredBy = urows?.[0]?.referred_by ? Number(urows[0].referred_by) : null;
      if (referredBy) {
        const ongoingTl = rewardTl * REFERRAL_AD_EARN_RATE;
        const ongoingDia = rewardDiamonds * REFERRAL_AD_EARN_RATE;

        // Count completed sessions for this user (including current)
        const { rows: crows } = await client.query(
          `select count(*)::int as cnt from public.ad_sessions where tg_id=$1 and completed=true`,
          [tg_id]
        );
        const cnt = crows?.[0]?.cnt ?? 0;
        const oneTimeFactor = cnt === 1 ? REFERRAL_SIGNUP_BONUS_RATE : 0;
        const oneTl = rewardTl * oneTimeFactor;
        const oneDia = rewardDiamonds * oneTimeFactor;

        await creditUser(referredBy, ongoingTl + oneTl, ongoingDia + oneDia);
      }
    } catch (e) {
      // referral is best-effort
    }

    await client.query("commit");

    // Notify in chat (no extra panel spam): send a short message
    try {
      await bot.telegram.sendMessage(
        tg_id,
        `✅ Reklam izledin! +${rewardTl.toFixed(2)} TL ve +${rewardDiamonds.toFixed(2)} Elmas cüzdanına eklendi.`
      );
    } catch (e) {
      console.warn("sendMessage failed", e?.message || e);
    }

    res.json({ ok: true, balances: { balance_tl: Number(balances.balance_tl), diamonds: Number(balances.diamonds) } });
  } catch (e) {
    await client.query("rollback");
    console.error("ad/complete error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

app.post("/api/ad/create", requireWebAppAuth, async (req, res) => {
  try {
    const tg_id = Number(req.tgUser.id);
    await ensureUser(tg_id);

    const title = String(req.body?.title || "").slice(0, 120);
    const seconds = Math.max(3, Math.min(300, parseInt(req.body?.seconds, 10) || 10));

    const page_url = String(req.body?.page_url || "").slice(0, 500);
    const youtube_url = String(req.body?.youtube_url || "").slice(0, 500);
    const game_url = String(req.body?.game_url || "").slice(0, 500);
    const media_url = String(req.body?.media_url || "").slice(0, 500);
    const adsense_code = String(req.body?.adsense_code || "").slice(0, 5000);

    const price_tl = Number((seconds * PRICE_PER_SECOND_TL).toFixed(2));

    const { rows } = await pool.query(
      `insert into public.ads (title, seconds, page_url, youtube_url, game_url, media_url, adsense_code, created_by, price_tl, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       returning id`,
      [title, seconds, page_url, youtube_url, game_url, media_url, adsense_code, tg_id, price_tl]
    );
    res.json({ ok: true, ad_id: rows[0].id, price_tl });
  } catch (e) {
    console.error("ad/create error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/convert", requireWebAppAuth, async (req, res) => {
  try {
    const { amount, direction } = req.body || {};
    const tgId = req.tg_id;

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "invalid_amount" });

    const mode = String(direction || "d2tl").toLowerCase(); // d2tl | tl2d

    const user = await getOrCreateUser(tgId);
    const diamonds = Number(user.diamonds || 0);
    const tl = Number(user.tl_balance || 0);

    if (mode === "d2tl") {
      if (diamonds < amt) return res.status(400).json({ error: "insufficient_diamonds" });
      const newDiamonds = diamonds - amt;
      const newTl = tl + amt;

      await pool.query("UPDATE users SET diamonds = $1, tl_balance = $2 WHERE tg_id = $3", [
        newDiamonds,
        newTl,
        tgId,
      ]);
      await pool.query("INSERT INTO ledger (tg_id, type, amount, note) VALUES ($1,$2,$3,$4)", [
        tgId,
        "convert_d2tl",
        amt,
        "Elmas → TL dönüşüm",
      ]);
      return res.json({ ok: true, diamonds: newDiamonds, tl_balance: newTl, direction: "d2tl" });
    }

    if (mode === "tl2d") {
      if (tl < amt) return res.status(400).json({ error: "insufficient_tl" });
      const newTl = tl - amt;
      const newDiamonds = diamonds + amt;

      await pool.query("UPDATE users SET diamonds = $1, tl_balance = $2 WHERE tg_id = $3", [
        newDiamonds,
        newTl,
        tgId,
      ]);
      await pool.query("INSERT INTO ledger (tg_id, type, amount, note) VALUES ($1,$2,$3,$4)", [
        tgId,
        "convert_tl2d",
        amt,
        "TL → Elmas dönüşüm",
      ]);
      return res.json({ ok: true, diamonds: newDiamonds, tl_balance: newTl, direction: "tl2d" });
    }

    return res.status(400).json({ error: "invalid_direction" });
  } catch (e) {
    console.error("convert error", e);
    return res.status(500).json({ error: "server_error" });
  }
});




app.post("/api/withdraw", requireWebAppAuth, async (req, res) => {
  // Minimal: just record request; actual payout manual later
  try {
    const tg_id = Number(req.tgUser.id);
    await ensureUser(tg_id);

    const amount = Number(req.body?.amount_tl || 0);
    const iban = String(req.body?.iban || "").slice(0, 64);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "bad_amount" });
    if (iban.length < 8) return res.status(400).json({ ok: false, error: "bad_iban" });

    await pool.query(`
      create table if not exists public.withdraw_requests (
        id bigserial primary key,
        tg_id bigint not null,
        amount_tl numeric not null,
        iban text not null,
        status text not null default 'pending',
        created_at timestamptz not null default now()
      );
    `);

    const b = await getBalances(tg_id);
    if (b.balance_tl + 1e-9 < amount) return res.status(400).json({ ok: false, error: "insufficient_balance" });

    // Deduct immediately (simple)
    await creditUser(tg_id, -amount, 0);

    await pool.query(
      `insert into public.withdraw_requests (tg_id, amount_tl, iban) values ($1,$2,$3)`,
      [tg_id, amount, iban]
    );

    const nb = await getBalances(tg_id);
    res.json({ ok: true, balance_tl: nb.balance_tl, diamonds: nb.diamonds });
  } catch (e) {
    console.error("withdraw error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------
async function getTableColumns(tableName) {
  const { rows } = await pool.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
    [tableName]
  );
  return new Set(rows.map((r) => r.column_name));
}

app.get("/api/admin/me", requireWebAppAuth, requireAdmin, async (req, res) => {
  res.json({ ok: true, tg_id: Number(req.tgUser.id) });
});

app.get("/api/admin/ads", requireWebAppAuth, requireAdmin, async (req, res) => {
  try {
    const cols = await getTableColumns("ads");
    const wanted = [
      "id",
      "type",
      "url",
      "seconds",
      "reward_tl",
      "reward_diamonds",
      "is_vip",
      "active",
      "max_clicks",
      "clicks",
      "created_at",
    ].filter((c) => cols.has(c));

    // fallback: if schema is unexpected, just select *
    const select = wanted.length ? wanted.map(qIdent).join(", ") : "*";
    const { rows } = await pool.query(`select ${select} from public.ads order by id desc limit 200`);
    res.json({ ok: true, ads: rows });
  } catch (e) {
    console.error("admin ads list error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/ads", requireWebAppAuth, requireAdmin, async (req, res) => {
  try {
    const cols = await getTableColumns("ads");
    // expected fields
    const type = String(req.body?.type || "web").slice(0, 16);
    const url = String(req.body?.url || "").slice(0, 1024);
    const seconds = Number(req.body?.seconds ?? 15);
    const reward_tl = Number(req.body?.reward_tl ?? 0.25);
    const reward_diamonds = Number(req.body?.reward_diamonds ?? reward_tl);
    const is_vip = !!req.body?.is_vip;
    const active = req.body?.active === undefined ? true : !!req.body?.active;
    const max_clicks = req.body?.max_clicks === null || req.body?.max_clicks === "" ? null : Number(req.body?.max_clicks);

    if (!url) return res.status(400).json({ ok: false, error: "missing_url" });
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) return res.status(400).json({ ok: false, error: "bad_seconds" });
    if (!Number.isFinite(reward_tl) || reward_tl < 0) return res.status(400).json({ ok: false, error: "bad_reward" });
    if (!Number.isFinite(reward_diamonds) || reward_diamonds < 0) return res.status(400).json({ ok: false, error: "bad_reward" });
    if (max_clicks !== null && (!Number.isFinite(max_clicks) || max_clicks < 0)) return res.status(400).json({ ok: false, error: "bad_max" });

    // Insert depending on available schema
    const fields = [];
    const values = [];
    const params = [];
    const add = (col, val) => {
      if (!cols.has(col)) return;
      fields.push(qIdent(col));
      values.push(val);
      params.push(`$${values.length}`);
    };

    add("type", type);
    add("url", url);
    add("seconds", seconds);
    add("reward_tl", reward_tl);
    add("reward_diamonds", reward_diamonds);
    add("is_vip", is_vip);
    add("active", active);
    add("max_clicks", max_clicks);

    if (!fields.length) return res.status(500).json({ ok: false, error: "ads_schema_unexpected" });

    const { rows } = await pool.query(
      `insert into public.ads (${fields.join(", ")}) values (${params.join(", ")}) returning *`,
      values
    );
    res.json({ ok: true, ad: rows[0] });
  } catch (e) {
    console.error("admin ads create error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.patch("/api/admin/ads/:id", requireWebAppAuth, requireAdmin, async (req, res) => {
  try {
    const cols = await getTableColumns("ads");
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });

    const updates = [];
    const values = [];
    const set = (col, val) => {
      if (!cols.has(col)) return;
      values.push(val);
      updates.push(`${qIdent(col)}=$${values.length}`);
    };

    if (req.body?.type !== undefined) set("type", String(req.body.type).slice(0, 16));
    if (req.body?.url !== undefined) set("url", String(req.body.url).slice(0, 1024));
    if (req.body?.seconds !== undefined) set("seconds", Number(req.body.seconds));
    if (req.body?.reward_tl !== undefined) set("reward_tl", Number(req.body.reward_tl));
    if (req.body?.reward_diamonds !== undefined) set("reward_diamonds", Number(req.body.reward_diamonds));
    if (req.body?.is_vip !== undefined) set("is_vip", !!req.body.is_vip);
    if (req.body?.active !== undefined) set("active", !!req.body.active);
    if (req.body?.max_clicks !== undefined) {
      const v = req.body.max_clicks;
      set("max_clicks", v === null || v === "" ? null : Number(v));
    }

    if (!updates.length) return res.status(400).json({ ok: false, error: "nothing_to_update" });
    values.push(id);
    const { rows } = await pool.query(
      `update public.ads set ${updates.join(", ")} where id=$${values.length} returning *`,
      values
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, ad: rows[0] });
  } catch (e) {
    console.error("admin ads update error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/withdraw_requests", requireWebAppAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query(`
      create table if not exists public.withdraw_requests (
        id bigserial primary key,
        tg_id bigint not null,
        amount_tl numeric not null,
        iban text not null,
        status text not null default 'pending',
        created_at timestamptz not null default now()
      );
    `);
    const { rows } = await pool.query(
      `select id, tg_id, amount_tl, iban, status, created_at from public.withdraw_requests order by id desc limit 200`
    );
    res.json({ ok: true, requests: rows });
  } catch (e) {
    console.error("admin withdraw list error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/withdraw_requests/:id/set_status", requireWebAppAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body?.status || "").toLowerCase();
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });
    if (![/^approved$/, /^rejected$/, /^pending$/].some((r) => r.test(status))) {
      return res.status(400).json({ ok: false, error: "bad_status" });
    }

    const { rows } = await pool.query(
      `update public.withdraw_requests set status=$1 where id=$2 returning id, tg_id, amount_tl, iban, status, created_at`,
      [status, id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, request: rows[0] });
  } catch (e) {
    console.error("admin withdraw update error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);

function buildMainKeyboard(tgId) {
  const qp = `tg_id=${encodeURIComponent(tgId)}&token=${signWebAppToken(tgId)}`;
  return Markup.keyboard([
    [Markup.button.webApp("💎 Elmas ↔️ TL", `${PUBLIC_BASE_URL}/webapp/convert.html?${qp}`)],
    [
      Markup.button.webApp("📣 Reklam Ver", `${PUBLIC_BASE_URL}/webapp/create_ad.html?${qp}`),
      Markup.button.webApp("👛 Cüzdan", `${PUBLIC_BASE_URL}/webapp/wallet.html?${qp}`),
    ],
    [
      Markup.button.webApp("💸 Para Çek", `${PUBLIC_BASE_URL}/webapp/withdraw.html?${qp}`),
      Markup.button.webApp("🎁 Referans", `${PUBLIC_BASE_URL}/webapp/referral.html?${qp}`),
    ],
    [Markup.button.webApp("🛠️ Admin", `${PUBLIC_BASE_URL}/webapp/admin_panel.html?${qp}`)],
  ]).resize();
}


  return Markup.keyboard(base).resize().persistent();
}

bot.start(async (ctx) => {
  const tg_id = ctx.from.id;
  // referral: /start <ref>
  const payload = (ctx.startPayload || "").trim();
  let referred_by = null;
  if (payload && /^\d{3,20}$/.test(payload) && payload !== String(tg_id)) {
    referred_by = Number(payload);
  }
  await ensureUser(tg_id, referred_by);
  // No extra "panel" message in chat; only show bottom keyboard.
  await ctx.reply(`1️⃣ Elmastoken nedir? Elmastoken, reklam izleyerek para kazanabileceğin bir bottur.

2️⃣ Elmastoken ile nasıl para kazanabilirim? Reklamları izlersin, biz reklamverenlerden gelir elde ederiz ve bu geliri seninle paylaşırız.

3️⃣ Güncel ödeme oranı nedir? Güncel ödeme oranı: 1 reklam başına ₺0.25 – 0.25 elmas token

4️⃣ Ne kadar kazanabilirim? Kazancın, izlediğin reklam sayısına ve davet ettiğin kullanıcı sayısına bağlıdır.

5️⃣ Referans programı nasıl çalışır? Elmastoken’e referans linkinle yeni kullanıcılar davet ettiğinde, her yeni kullanıcı için ₺18 ve onların izlediği her reklamdan %5 kazanırsın.

6️⃣ Paramı nasıl çekebilirim? Paranı “Bakiye” bölümündeki talimatları izleyerek çekebilirsin. Minimum çekim tutarı: ₺195

7️⃣ Para çekme yöntemleri nelerdir? Şuan için sadece Banka IBAN’ı.

8️⃣ Elmastoken güvenli mi? Evet, ReklaPay kullanıcı verilerini ve işlemleri korumak için tüm güvenlik standartlarına uygundur.

9️⃣ Elmastoken ne işe yarıyacak? Elmas tokeni istersen hemen liraya çevirebilir, istersen elmas token ile VIP paket alıp iki katı tutarında ödül kazanabilirsin.

Ek soruların varsa, lütfen müşteri destek ekibimizle iletişime geç.`, buildMainKeyboard(tg_id));
});

bot.command("menu", async (ctx) => {
  await ctx.reply("✅", buildMainKeyboard(ctx.from.id));
});

// Referans: webapp açmadan, sohbet içinde linki göster
bot.hears("🎁 Referans", async (ctx) => {
  const tg_id = ctx.from.id;
  await ensureUser(tg_id);
  const link = `https://t.me/${(await bot.telegram.getMe()).username}?start=${tg_id}`;
  // Şimdilik basit çıktı: link + oranlar
  await ctx.reply(`🎁 Referans linkin:\n${link}\n\n📌 Kurallar:\n• Davet ettiğin her kullanıcı için: ilk reklamında %18 bonus\n• Davet ettiğin kullanıcının izlediği her reklamdan: %5 komisyon`);
});

// ---------------------------------------------------------------------------
// Run: webhook on Render
// ---------------------------------------------------------------------------
async function main() {
  await ensureSchema();
  await resolveUsersColumns();

  app.post("/telegram", (req, res) => bot.handleUpdate(req.body, res));

  app.listen(PORT, async () => {
    console.log("Server listening on :" + PORT);
    const webhookUrl = PUBLIC_URL ? `${PUBLIC_URL}/telegram` : null;
    if (webhookUrl) {
      try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log("Webhook aktif:", webhookUrl);
      } catch (e) {
        console.error("Webhook set failed:", e?.message || e);
      }
    } else {
      console.log("PUBLIC_URL missing; webhook cannot be configured automatically.");
    }
    console.log("Bot started (webhook mode)");
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
