require("dotenv").config();

const path = require("path");
const express = require("express");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL; // örn: https://reklampaybot.onrender.com
const DATABASE_URL = process.env.DATABASE_URL;
// Admin (comma-separated) - default: owner's id
const ADMIN_TG_IDS = String(process.env.ADMIN_TG_IDS || "7784281785")
  .split(",")
  .map((s) => Number(String(s).trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// ---------------------
// DB (Supabase Postgres)
// ---------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ---------------------------
// Helpers
// ---------------------------
function todayISO() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getTgIdFromReq(req) {
  const tgId = Number(req.body?.tg_id);
  if (!tgId || Number.isNaN(tgId)) throw new Error("tg_id missing");
  return tgId;
}

function absoluteUrl(req, p) {
  const base =
    (BASE_URL && BASE_URL.replace(/\/$/, "")) ||
    `${req.protocol}://${req.get("host")}`;
  return `${base}${p.startsWith("/") ? "" : "/"}${p}`;
}

async function getSetting(key, fallback) {
  try {
    const r = await pool.query("select value from app_settings where key=$1", [key]);
    if (r.rowCount === 0) return fallback;
    return r.rows[0].value;
  } catch (_) {
    return fallback;
  }
}

async function setSetting(key, value) {
  await pool.query(
    `insert into app_settings (key, value, updated_at)
     values ($1,$2,now())
     on conflict (key) do update set value=excluded.value, updated_at=now()`,
    [key, String(value)]
  );
}

function isAdminTgId(tgId) {
  return ADMIN_TG_IDS.includes(Number(tgId));
}

// ---------------------------
// DB helper (user upsert)
// ---------------------------
async function upsertUserFromCtx(ctx, refByTgId = null) {
  const tg = ctx.from;
  const tgId = tg.id;

  const existing = await pool.query(
    "select tg_id, ref_by from users where tg_id=$1",
    [tgId]
  );

  if (existing.rowCount === 0) {
    await pool.query(
      `insert into users (tg_id, username, first_name, ref_by, balance, diamonds)
       values ($1,$2,$3,$4,0,0)`,
      [tgId, tg.username || null, tg.first_name || null, refByTgId]
    );

    if (refByTgId && refByTgId !== tgId) {
      await pool.query(
        `insert into referrals (referrer_tg_id, referred_tg_id)
         values ($1,$2)
         on conflict (referred_tg_id) do nothing`,
        [refByTgId, tgId]
      );
    }
  } else {
    await pool.query(
      `update users set username=$2, first_name=$3 where tg_id=$1`,
      [tgId, tg.username || null, tg.first_name || null]
    );
  }

  return tgId;
}

// --------------------
// 1) Mini App (static)
// --------------------
const webappDir = path.join(__dirname, "webapp");
// Serve both at root (/) and also under /webapp so /webapp/index.html works
app.use(express.static(webappDir));
app.use('/webapp', express.static(webappDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(webappDir, "index.html"));
});

// ---------------
// 2) API routes
// ---------------

// Health
app.get("/api/health", async (req, res) => {
  try {
    if (!DATABASE_URL) return res.json({ ok: true, db: "no_db_env" });
    const r = await pool.query("select now() as now");
    res.json({ ok: true, db: "ok", now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------
// 2b) Me (Panel verileri)
// -----------------------------
const DAILY_LIMIT = 50;

app.post("/api/me", async (req, res) => {
  try {
    const tgId = getTgIdFromReq(req);
    const day = todayISO();

    // user yoksa oluştur
    await pool.query(
      `insert into users (tg_id, balance, diamonds)
       values ($1, 0, 0)
       on conflict (tg_id) do nothing`,
      [tgId]
    );

    // daily_stats yoksa oluştur
    await pool.query(
      `insert into daily_stats (tg_id, day, ads_seen)
       values ($1, $2, 0)
       on conflict (tg_id, day) do nothing`,
      [tgId, day]
    );

    const u = await pool.query(
      `select tg_id,
              coalesce(balance,0) as balance,
              coalesce(diamonds,0) as diamonds,
              coalesce(is_vip,false) as is_vip,
              coalesce(username,'') as username,
              coalesce(first_name,'') as first_name
       from users where tg_id=$1`,
      [tgId]
    );

    const gemRate = Number(await getSetting("GEM_TO_TL_RATE", "0.25"));
    const refRate = Number(await getSetting("REF_BONUS_RATE", "0.10"));
    const minWithdraw = Number(await getSetting("MIN_WITHDRAW_TL", "250"));

    const s = await pool.query(
      `select coalesce(ads_seen,0) as ads_seen
       from daily_stats where tg_id=$1 and day=$2`,
      [tgId, day]
    );

    res.json({
      ok: true,
      user: u.rows[0],
      daily: { seen: s.rows[0]?.ads_seen ?? 0, limit: DAILY_LIMIT },
      settings: {
        gem_to_tl_rate: gemRate,
        ref_bonus_rate: refRate,
        min_withdraw_tl: minWithdraw,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------
// 2d) Convert (Diamonds -> TL)
// -----------------------------
app.post("/api/convert", async (req, res) => {
  const client = await pool.connect();
  try {
    const tgId = getTgIdFromReq(req);
    const gems = Number(req.body?.gems);
    if (!Number.isFinite(gems) || gems <= 0) throw new Error("gems invalid");
    // gems: allow decimals? keep integer for simplicity
    const gemsInt = Math.floor(gems);
    if (gemsInt <= 0) throw new Error("gems invalid");

    const rate = Number(await getSetting("GEM_TO_TL_RATE", "0.25"));
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("rate invalid");
    const tlAmount = Number((gemsInt * rate).toFixed(2));

    await client.query("begin");
    const u = await client.query(
      `select coalesce(balance,0) as balance, coalesce(diamonds,0) as diamonds
       from users where tg_id=$1 for update`,
      [tgId]
    );
    if (u.rowCount === 0) throw new Error("user not found");
    const curGems = Number(u.rows[0].diamonds);
    if (curGems < gemsInt) throw new Error("insufficient_gems");

    await client.query(
      `update users
       set diamonds = coalesce(diamonds,0) - $1,
           balance  = coalesce(balance,0) + $2
       where tg_id=$3`,
      [gemsInt, tlAmount, tgId]
    );

    await client.query(
      `insert into diamond_conversions (tg_id, gems, rate, tl_amount)
       values ($1,$2,$3,$4)`,
      [tgId, gemsInt, rate, tlAmount]
    );

    await client.query("commit");
    res.json({ ok: true, gems: gemsInt, rate, tl_amount: tlAmount });
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// -----------------------------
// 2e) Withdraw request
// -----------------------------
app.post("/api/withdraw/request", async (req, res) => {
  const client = await pool.connect();
  try {
    const tgId = getTgIdFromReq(req);
    const fullName = String(req.body?.full_name || "").trim();
    const iban = String(req.body?.iban || "").trim().replace(/\s+/g, "");
    const amount = Number(req.body?.amount_tl);

    if (fullName.length < 3) throw new Error("full_name invalid");
    if (!/^TR\d{24}$/i.test(iban)) throw new Error("iban invalid");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount invalid");

    const minWithdraw = Number(await getSetting("MIN_WITHDRAW_TL", "250"));
    if (amount < minWithdraw) throw new Error("min_withdraw");

    await client.query("begin");

    const u = await client.query(
      `select coalesce(balance,0) as balance
       from users where tg_id=$1 for update`,
      [tgId]
    );
    if (u.rowCount === 0) throw new Error("user not found");
    const balance = Number(u.rows[0].balance);

    // prevent creating pending requests exceeding balance
    const pending = await client.query(
      `select coalesce(sum(amount_tl),0) as sum
       from withdraw_requests
       where tg_id=$1 and status in ('pending','approved')`,
      [tgId]
    );
    const pendingSum = Number(pending.rows[0].sum);
    if (pendingSum + amount > balance) throw new Error("insufficient_balance");

    const ins = await client.query(
      `insert into withdraw_requests (tg_id, full_name, iban, amount_tl)
       values ($1,$2,$3,$4)
       returning id, status, created_at`,
      [tgId, fullName, iban.toUpperCase(), Number(amount.toFixed(2))]
    );

    await client.query("commit");
    res.json({ ok: true, request: ins.rows[0], min_withdraw_tl: minWithdraw });
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// -----------------------------
// 2c) Ad Watch API (start/complete)
// -----------------------------
app.post("/api/ad/start", async (req, res) => {
  try {
    const tgId = getTgIdFromReq(req);
    const day = todayISO();

    // user + daily_stats garanti
    await pool.query(
      `insert into users (tg_id, balance, diamonds)
       values ($1, 0, 0)
       on conflict (tg_id) do nothing`,
      [tgId]
    );

    await pool.query(
      `insert into daily_stats (tg_id, day, ads_seen)
       values ($1, $2, 0)
       on conflict (tg_id, day) do nothing`,
      [tgId, day]
    );

    const stat = await pool.query(
      `select ads_seen from daily_stats where tg_id=$1 and day=$2`,
      [tgId, day]
    );

    const seen = stat.rows[0]?.ads_seen ?? 0;
    if (seen >= DAILY_LIMIT) {
      return res
        .status(429)
        .json({ ok: false, reason: "daily_limit", seen, limit: DAILY_LIMIT });
    }

    // demo reklam
    const ad = {
      id: 1,
      type: "video",
      seconds: 15,
      url: absoluteUrl(req, "/ads/demo.mp4"), // ✅ tam URL
      reward_tl: 0.25,
      reward_gem: 0.25,
    };

    // session oluştur
    const s = await pool.query(
      `insert into ad_sessions (tg_id, ad_id, seconds, reward_tl, reward_gem, completed)
       values ($1,$2,$3,$4,$5,false)
       returning id`,
      [tgId, ad.id, ad.seconds, ad.reward_tl, ad.reward_gem]
    );

    res.json({ ok: true, session_id: s.rows[0].id, ad, seen, limit: DAILY_LIMIT });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/ad/complete", async (req, res) => {
  try {
    const tgId = getTgIdFromReq(req);
    const sessionId = Number(req.body?.session_id);
    if (!sessionId || Number.isNaN(sessionId)) throw new Error("session_id missing");

    // session tamamla (tek sefer)
    const r = await pool.query(
      `update ad_sessions
       set completed=true, completed_at=now()
       where id=$1 and tg_id=$2 and completed=false
       returning id, reward_tl, reward_gem`,
      [sessionId, tgId]
    );

    if (r.rowCount === 0) {
      return res.status(400).json({ ok: false, reason: "invalid_or_already_completed" });
    }

    const day = todayISO();

    // ads_seen +1
    await pool.query(
      `update daily_stats
       set ads_seen = ads_seen + 1, updated_at=now()
       where tg_id=$1 and day=$2`,
      [tgId, day]
    );

    // ödül direkt cüzdana
    await pool.query(
      `update users
       set balance = coalesce(balance,0) + $1,
           diamonds = coalesce(diamonds,0) + $2
       where tg_id=$3`,
      [Number(r.rows[0].reward_tl), Number(r.rows[0].reward_gem), tgId]
    );

    // referral bonus: referrer gets % of earned gems
    try {
      const ref = await pool.query(
        `select ref_by from users where tg_id=$1`,
        [tgId]
      );
      const refBy = Number(ref.rows[0]?.ref_by);
      if (refBy && refBy !== tgId) {
        const refRate = Number(await getSetting("REF_BONUS_RATE", "0.10"));
        const bonusGems = Number((Number(r.rows[0].reward_gem) * refRate).toFixed(4));
        if (bonusGems > 0) {
          await pool.query(
            `update users set diamonds = coalesce(diamonds,0) + $1 where tg_id=$2`,
            [bonusGems, refBy]
          );
          await pool.query(
            `insert into referral_earnings (referrer_tg_id, from_tg_id, session_id, gems_amount)
             values ($1,$2,$3,$4)`,
            [refBy, tgId, sessionId, bonusGems]
          );
        }
      }
    } catch (_) {
      // ignore referral errors
    }

    res.json({ ok: true, reward_tl: r.rows[0].reward_tl, reward_gem: r.rows[0].reward_gem });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------
// 3) Telegram bot (WEBHOOK)
// ----------------
if (BOT_TOKEN) {
  const bot = new Telegraf(BOT_TOKEN);

  async function sendMainMenu(ctx) {
    if (!BASE_URL) {
      await ctx.reply("BASE_URL yok. Render adresini BASE_URL olarak ekleyin.");
      return;
    }
    await ctx.reply("ReklamPay Panel 👇", {
      reply_markup: {
        keyboard: [
          // Use explicit /webapp/index.html so query params are always preserved in Telegram WebApp
          [
            { text: "🎬 Reklam İzle", web_app: { url: `${BASE_URL}/webapp/index.html?action=watch` } },
            { text: "📣 Reklam Ver", web_app: { url: `${BASE_URL}/webapp/index.html?action=advertise` } },
          ],
          [
            { text: "💼 Cüzdan", web_app: { url: `${BASE_URL}/webapp/index.html?action=wallet` } },
            { text: "💸 Para Çek", web_app: { url: `${BASE_URL}/webapp/index.html?action=withdraw` } },
          ],
          [
            { text: "🔁 Elmas → TL", web_app: { url: `${BASE_URL}/webapp/index.html?action=convert` } },
            { text: "ℹ️ Bilgi", web_app: { url: `${BASE_URL}/webapp/index.html?action=info` } },
          ],
        ],
        resize_keyboard: true,
        is_persistent: true,
      },
    });
  }

  bot.start(async (ctx) => {
    const payload = String(ctx.startPayload || "").trim();
    let refBy = null;
    const m = payload.match(/^ref_(\d+)$/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) refBy = n;
    }
    await upsertUserFromCtx(ctx, refBy);

    await sendMainMenu(ctx);
  });

  bot.command("menu", async (ctx) => {
    await upsertUserFromCtx(ctx);
    await sendMainMenu(ctx);
  });

  // -------- Admin commands (only admins) --------
  function requireAdmin(ctx) {
    if (!isAdminTgId(ctx.from?.id)) {
      ctx.reply("⛔ Yetkisiz");
      return false;
    }
    return true;
  }

  bot.command("admin_stats", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const day = todayISO();
    const a = await pool.query(
      `select count(*)::int as sessions,
              count(*) filter (where completed=true)::int as completed
       from ad_sessions where started_at::date = $1::date`,
      [day]
    );
    const w = await pool.query(
      `select count(*)::int as pending
       from withdraw_requests where status='pending'`);
    ctx.reply(
      `📊 Bugün (${day})\n` +
        `• Session: ${a.rows[0].sessions}\n` +
        `• Completed: ${a.rows[0].completed}\n` +
        `• Pending withdraw: ${w.rows[0].pending}`
    );
  });

  bot.command("admin_rate_gem", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const v = Number((ctx.message.text.split(/\s+/)[1] || "").trim());
    if (!Number.isFinite(v) || v <= 0) return ctx.reply("Kullanım: /admin_rate_gem 0.25");
    await setSetting("GEM_TO_TL_RATE", v);
    ctx.reply(`✅ GEM_TO_TL_RATE = ${v}`);
  });

  bot.command("admin_ref_rate", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const v = Number((ctx.message.text.split(/\s+/)[1] || "").trim());
    if (!Number.isFinite(v) || v < 0 || v > 1) return ctx.reply("Kullanım: /admin_ref_rate 0.10");
    await setSetting("REF_BONUS_RATE", v);
    ctx.reply(`✅ REF_BONUS_RATE = ${v}`);
  });

  bot.command("admin_min_withdraw", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const v = Number((ctx.message.text.split(/\s+/)[1] || "").trim());
    if (!Number.isFinite(v) || v <= 0) return ctx.reply("Kullanım: /admin_min_withdraw 250");
    await setSetting("MIN_WITHDRAW_TL", v);
    ctx.reply(`✅ MIN_WITHDRAW_TL = ${v}`);
  });

  bot.command("admin_gem_add", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [_, tg, amt] = ctx.message.text.split(/\s+/);
    const tgId = Number(tg);
    const a = Number(amt);
    if (!Number.isFinite(tgId) || !Number.isFinite(a)) return ctx.reply("Kullanım: /admin_gem_add <tg_id> <miktar>");
    await pool.query(`update users set diamonds = coalesce(diamonds,0) + $1 where tg_id=$2`, [a, tgId]);
    ctx.reply(`✅ ${tgId} +${a} 💎`);
  });

  bot.command("admin_gem_sub", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [_, tg, amt] = ctx.message.text.split(/\s+/);
    const tgId = Number(tg);
    const a = Number(amt);
    if (!Number.isFinite(tgId) || !Number.isFinite(a)) return ctx.reply("Kullanım: /admin_gem_sub <tg_id> <miktar>");
    await pool.query(`update users set diamonds = greatest(coalesce(diamonds,0) - $1, 0) where tg_id=$2`, [a, tgId]);
    ctx.reply(`✅ ${tgId} -${a} 💎`);
  });

  bot.command("admin_tl_add", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [_, tg, amt] = ctx.message.text.split(/\s+/);
    const tgId = Number(tg);
    const a = Number(amt);
    if (!Number.isFinite(tgId) || !Number.isFinite(a)) return ctx.reply("Kullanım: /admin_tl_add <tg_id> <miktar>");
    await pool.query(`update users set balance = coalesce(balance,0) + $1 where tg_id=$2`, [a, tgId]);
    ctx.reply(`✅ ${tgId} +${a} ₺`);
  });

  bot.command("admin_tl_sub", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [_, tg, amt] = ctx.message.text.split(/\s+/);
    const tgId = Number(tg);
    const a = Number(amt);
    if (!Number.isFinite(tgId) || !Number.isFinite(a)) return ctx.reply("Kullanım: /admin_tl_sub <tg_id> <miktar>");
    await pool.query(`update users set balance = greatest(coalesce(balance,0) - $1, 0) where tg_id=$2`, [a, tgId]);
    ctx.reply(`✅ ${tgId} -${a} ₺`);
  });

  bot.command("admin_withdraw_list", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const r = await pool.query(
      `select id, tg_id, amount_tl, full_name, iban, created_at
       from withdraw_requests
       where status='pending'
       order by created_at asc
       limit 10`
    );
    if (r.rowCount === 0) return ctx.reply("✅ Pending çekim yok");
    const lines = r.rows.map((x) => `#${x.id} • ${x.amount_tl}₺ • ${x.tg_id} • ${x.full_name}`);
    ctx.reply("💸 Pending çekimler:\n" + lines.join("\n"));
  });

  bot.command("admin_withdraw_approve", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [_, idStr, ...noteParts] = ctx.message.text.split(/\s+/);
    const id = Number(idStr);
    if (!Number.isFinite(id)) return ctx.reply("Kullanım: /admin_withdraw_approve <id> [not]");
    const note = noteParts.join(" ").trim() || null;
    await pool.query(
      `update withdraw_requests set status='approved', admin_note=$2, updated_at=now() where id=$1`,
      [id, note]
    );
    ctx.reply(`✅ Approved #${id}`);
  });

  bot.command("admin_withdraw_reject", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [_, idStr, ...noteParts] = ctx.message.text.split(/\s+/);
    const id = Number(idStr);
    if (!Number.isFinite(id)) return ctx.reply("Kullanım: /admin_withdraw_reject <id> [not]");
    const note = noteParts.join(" ").trim() || null;
    await pool.query(
      `update withdraw_requests set status='rejected', admin_note=$2, updated_at=now() where id=$1`,
      [id, note]
    );
    ctx.reply(`✅ Rejected #${id}`);
  });

  bot.command("admin_withdraw_paid", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [_, idStr] = ctx.message.text.split(/\s+/);
    const id = Number(idStr);
    if (!Number.isFinite(id)) return ctx.reply("Kullanım: /admin_withdraw_paid <id>");

    const client = await pool.connect();
    try {
      await client.query("begin");
      const w = await client.query(
        `select tg_id, amount_tl, status from withdraw_requests where id=$1 for update`,
        [id]
      );
      if (w.rowCount === 0) throw new Error("not_found");
      if (w.rows[0].status === "paid") throw new Error("already_paid");

      const tgId = Number(w.rows[0].tg_id);
      const amount = Number(w.rows[0].amount_tl);

      await client.query(
        `update users set balance = greatest(coalesce(balance,0) - $1, 0) where tg_id=$2`,
        [amount, tgId]
      );
      await client.query(
        `update withdraw_requests set status='paid', updated_at=now() where id=$1`,
        [id]
      );
      await client.query("commit");
      ctx.reply(`✅ Paid #${id} (-${amount}₺ from ${tgId})`);
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      ctx.reply("❌ Hata: " + e.message);
    } finally {
      client.release();
    }
  });

  bot.command("health", async (ctx) => {
    await ctx.reply("Bot ayakta ✅");
  });

  // webhook endpoint
  app.use(bot.webhookCallback("/telegram"));

  // webhook set
  (async () => {
    if (!BASE_URL) {
      console.log("BASE_URL yok! Webhook set edilemedi.");
      return;
    }
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.telegram.setWebhook(`${BASE_URL}/telegram`);
    console.log("Webhook aktif:", `${BASE_URL}/telegram`);
  })().catch((e) => console.error("Webhook error:", e));
} else {
  console.log("BOT_TOKEN yok: Bot başlatılmadı.");
}

// ---------------------
// 4) Start the server
// ---------------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
