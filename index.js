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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL env var");

const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
if (!PUBLIC_URL) {
  console.warn("WARN: PUBLIC_URL is empty. WebApp buttons may be broken.");
}

const PORT = parseInt(process.env.PORT || "10000", 10);

const ADMIN_TG_ID = process.env.ADMIN_TG_ID ? String(process.env.ADMIN_TG_ID) : "7784281785";

// Rewards
const WATCH_REWARD_TL = 0.25;
const WATCH_REWARD_DIAMONDS = 0.25;

// Ad pricing for "Reklam Ver" (user requested: 1 sn = 0.10 TL)
const PRICE_PER_SECOND_TL = 0.10;

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

function requireWebAppAuth(req, res, next) {
  const initData = req.headers["x-telegram-initdata"] || req.body?.initData || req.query?.initData;
  const v = verifyInitData(initData);
  if (!v.ok) return res.status(401).json({ ok: false, error: v.reason });
  req.tgUser = v.user;
  req.initData = initData;
  next();
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

app.post("/api/ad/start", requireWebAppAuth, async (req, res) => {
  try {
    const tg_id = Number(req.tgUser.id);
    await ensureUser(tg_id);

    // pick an active ad, simplest: latest active
    const { rows } = await pool.query(
      `select * from public.ads where active=true order by id desc limit 1`
    );
    const ad = rows[0];
    if (!ad) return res.status(404).json({ ok: false, error: "no_ad" });

    const seconds = Math.max(3, Math.min(300, parseInt(ad.seconds, 10) || 10));
    const { rows: sRows } = await pool.query(
      `insert into public.ad_sessions (tg_id, ad_id, seconds) values ($1,$2,$3) returning id, started_at`,
      [tg_id, ad.id, seconds]
    );
    const session = sRows[0];

    res.json({
      ok: true,
      session_id: session.id,
      seconds,
      reward: { tl: WATCH_REWARD_TL, diamonds: WATCH_REWARD_DIAMONDS },
      ad: {
        id: ad.id,
        title: ad.title || "Reklam",
        page_url: ad.page_url || "",
        youtube_url: ad.youtube_url || "",
        game_url: ad.game_url || "",
        media_url: ad.media_url || "",
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
      `select id, tg_id, seconds, started_at, completed
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

    // Credit reward
    const balances = await creditUser(tg_id, WATCH_REWARD_TL, WATCH_REWARD_DIAMONDS);

    await client.query("commit");

    // Notify in chat (no extra panel spam): send a short message
    try {
      await bot.telegram.sendMessage(
        tg_id,
        `✅ Reklam izledin! +${WATCH_REWARD_TL.toFixed(2)} TL ve +${WATCH_REWARD_DIAMONDS.toFixed(2)} Elmas cüzdanına eklendi.`
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
  // Convert diamonds -> TL at fixed rate 1 diamond = 1 TL (adjust later)
  try {
    const tg_id = Number(req.tgUser.id);
    await ensureUser(tg_id);

    const amount = Number(req.body?.diamonds || 0);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "bad_amount" });

    const rate = 1.0; // DIAMOND_TO_TL
    const tlAdd = Number((amount * rate).toFixed(2));

    const client = await pool.connect();
    try {
      await client.query("begin");
      const b = await getBalances(tg_id);
      if (b.diamonds + 1e-9 < amount) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "insufficient_diamonds" });
      }

      // subtract diamonds, add TL
      const tgCol = qIdent(usersCols.tg_id);
      const tlCol = qIdent(usersCols.balance_tl);
      const dCol = qIdent(usersCols.diamonds);

      const { rows } = await client.query(
        `update public.users
         set ${dCol} = coalesce(${dCol},0) - $2,
             ${tlCol} = coalesce(${tlCol},0) + $3
         where ${tgCol}=$1
         returning ${tlCol} as balance_tl, ${dCol} as diamonds`,
        [tg_id, amount, tlAdd]
      );
      await client.query("commit");
      res.json({ ok: true, balance_tl: Number(rows[0].balance_tl), diamonds: Number(rows[0].diamonds), rate });
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("convert error", e);
    res.status(500).json({ ok: false, error: "server_error" });
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
// Bot
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);

function panelKeyboard(tg_id) {
  const base = PUBLIC_URL ? PUBLIC_URL : "";
  const watchUrl = `${base}/webapp/watch.html`;
  const walletUrl = `${base}/webapp/wallet.html`;
  const createAdUrl = `${base}/webapp/create_ad.html`;
  const convertUrl = `${base}/webapp/convert.html`;
  const withdrawUrl = `${base}/webapp/withdraw.html`;
  const adminUrl = `${base}/webapp/admin.html`;

  const rows = [
    [Markup.button.webApp("🎬 Reklam İzle", watchUrl), Markup.button.webApp("👜 Cüzdan", walletUrl)],
    [Markup.button.webApp("📢 Reklam Ver", createAdUrl), Markup.button.webApp("💎 Elmas → TL", convertUrl)],
    [Markup.button.webApp("💸 Para Çek", withdrawUrl), Markup.button.callback("🎁 Referans", "REF")],
  ];

  if (String(tg_id) === String(ADMIN_TG_ID)) {
    rows.push([Markup.button.webApp("🛠 Admin", adminUrl)]);
  }

  return Markup.inlineKeyboard(rows);
}

async function sendOrUpdatePanel(ctx) {
  const tg_id = ctx.from.id;
  const user = await getUser(tg_id);
  const kb = panelKeyboard(tg_id);

  const text = "⚡ Panel";
  const existingId = user?.[usersCols.panel_message_id];

  if (existingId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, existingId, undefined, text, kb);
      return;
    } catch (e) {
      // fallthrough to send new
    }
  }
  const msg = await ctx.reply(text, kb);
  await setPanelMessageId(tg_id, msg.message_id);
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
  await sendOrUpdatePanel(ctx);
});

bot.action("REF", async (ctx) => {
  try {
    const me = await ctx.telegram.getMe();
    const link = `https://t.me/${me.username}?start=${ctx.from.id}`;
    await ctx.answerCbQuery();
    await ctx.reply(`🎁 Referans linkin:\n${link}`);
  } catch (e) {
    console.error("REF error", e);
    try { await ctx.answerCbQuery("Hata oluştu"); } catch {}
  }
});

bot.on("message", async (ctx) => {
  // Keep chat clean: ignore random text; user uses Panel buttons.
  if (ctx.message?.text === "/start") return;
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
