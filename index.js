const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const BASE_URL = (process.env.BASE_URL || process.env.PUBLIC_URL || "").replace(/\/+$/,"");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

const PORT = process.env.PORT || 10000;

// Watch reward (full watch only)
const WATCH_REWARD_TL = 0.25;
const WATCH_REWARD_DIAMONDS = 0.25;

// Safety constants (avoid ReferenceError crashes)
const REFERRAL_BONUS_TL = 0.0;
const REFERRAL_BONUS_DIAMONDS = 0.0;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const schemaCache = {};

async function getTableColumns(table){
  if (schemaCache[table]) return schemaCache[table];
  const { rows } = await pool.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
    [table]
  );
  const cols = rows.map(r=>r.column_name);
  schemaCache[table] = cols;
  return cols;
}
function pickFirst(cols, names){ for (const n of names) if (cols.includes(n)) return n; return null; }

async function ensureUser(tg_id){
  const cols = await getTableColumns("users");
  const tgCol = pickFirst(cols, ["tg_id","telegram_id","user_id"]);
  if (!tgCol) throw new Error("users table must have tg_id (or telegram_id/user_id)");
  const sel = await pool.query(`select * from public.users where ${tgCol}=$1 limit 1`, [tg_id]);
  if (sel.rows.length) return { tgCol, cols, user: sel.rows[0] };

  const diamondsCol = pickFirst(cols, ["diamonds","elmas","diamond"]);
  const tlCol = pickFirst(cols, ["balance_tl","tl_balance","balance","wallet_tl"]);
  const dailyCol = pickFirst(cols, ["daily_ads_watched","ads_watched_today","daily_watch_count"]);

  const insertCols=[tgCol];
  const insertVals=["$1"];
  const params=[tg_id];
  let p=2;
  if (diamondsCol){ insertCols.push(diamondsCol); insertVals.push(`$${p++}`); params.push(0); }
  if (tlCol){ insertCols.push(tlCol); insertVals.push(`$${p++}`); params.push(0); }
  if (dailyCol){ insertCols.push(dailyCol); insertVals.push(`$${p++}`); params.push(0); }

  await pool.query(`insert into public.users (${insertCols.join(",")}) values (${insertVals.join(",")})`, params);
  const after = await pool.query(`select * from public.users where ${tgCol}=$1 limit 1`, [tg_id]);
  return { tgCol, cols, user: after.rows[0] };
}

async function getUserBalances(tg_id){
  const { cols, user } = await ensureUser(tg_id);
  const diamondsCol = pickFirst(cols, ["diamonds","elmas","diamond"]);
  const tlCol = pickFirst(cols, ["balance_tl","tl_balance","balance","wallet_tl"]);
  return { tl: tlCol ? Number(user[tlCol]||0) : 0, diamonds: diamondsCol ? Number(user[diamondsCol]||0) : 0 };
}

async function creditUser(tg_id, addTl, addDiamonds){
  const { tgCol, cols } = await ensureUser(tg_id);
  const diamondsCol = pickFirst(cols, ["diamonds","elmas","diamond"]);
  const tlCol = pickFirst(cols, ["balance_tl","tl_balance","balance","wallet_tl"]);

  const sets=[], params=[];
  let p=1;
  if (tlCol && addTl){ sets.push(`${tlCol}=COALESCE(${tlCol},0)+$${p++}`); params.push(addTl); }
  if (diamondsCol && addDiamonds){ sets.push(`${diamondsCol}=COALESCE(${diamondsCol},0)+$${p++}`); params.push(addDiamonds); }
  if (!sets.length) return;
  params.push(tg_id);
  await pool.query(`update public.users set ${sets.join(", ")} where ${tgCol}=$${p}`, params);
}

async function getNextAd(){
  // If no ads table, return null (webapp shows "Şu an reklam yok")
  let cols;
  try { cols = await getTableColumns("ads"); } catch { return null; }
  const idCol = pickFirst(cols, ["id","ad_id"]);
  const activeCol = pickFirst(cols, ["active","is_active","enabled"]);
  const secondsCol = pickFirst(cols, ["seconds","duration_seconds","duration","sec"]);
  const urlCol = pickFirst(cols, ["url","link","target_url","page_url"]);
  const youtubeCol = pickFirst(cols, ["youtube_url","youtube","yt_url"]);
  const htmlCol = pickFirst(cols, ["html","iframe_html","embed_html"]);
  const titleCol = pickFirst(cols, ["title","name"]);

  const selCols = [idCol, secondsCol, urlCol, youtubeCol, htmlCol, titleCol].filter(Boolean);
  if (!selCols.length) return null;

  const where = activeCol ? `${activeCol}=true` : "1=1";
  const { rows } = await pool.query(`select ${selCols.join(",")} from public.ads where ${where} order by random() limit 1`);
  if (!rows.length) return null;

  const r = rows[0];
  let seconds = secondsCol ? Number(r[secondsCol]||10) : 10;
  if (!Number.isFinite(seconds) || seconds<=0) seconds=10;
  if (seconds>120) seconds=120;

  return {
    id: idCol ? r[idCol] : null,
    title: titleCol ? (r[titleCol] || "Reklam") : "Reklam",
    seconds,
    url: urlCol ? r[urlCol] : null,
    youtube: youtubeCol ? r[youtubeCol] : null,
    html: htmlCol ? r[htmlCol] : null
  };
}

const activeSessions = new Map(); // nonce -> {tg_id, ad_id, seconds, createdAt}

const app = express();
app.use(express.json({ limit:"1mb" }));
app.use(express.urlencoded({ extended:true }));

const webappDir = path.join(__dirname, "webapp");
app.use("/webapp", express.static(webappDir, { extensions:["html"] }));
app.get("/", (req,res)=>res.redirect("/webapp/index.html"));
app.get("/health", (req,res)=>res.json({ ok:true }));

app.get("/api/wallet", async (req,res)=>{
  try{
    const tg_id = Number(req.query.tg_id);
    if (!Number.isFinite(tg_id)) return res.status(400).json({ error:"tg_id required" });
    const bal = await getUserBalances(tg_id);
    res.json({ ok:true, ...bal });
  }catch(e){
    console.error("wallet error", e);
    res.status(500).json({ error:String(e.message||e) });
  }
});

app.get("/api/ad/next", async (req,res)=>{
  try{
    const tg_id = Number(req.query.tg_id);
    if (!Number.isFinite(tg_id)) return res.status(400).json({ error:"tg_id required" });
    await ensureUser(tg_id);

    const ad = await getNextAd();
    if (!ad) return res.json({ ok:true, none:true, seconds:5, message:"Şu an reklam yok." });

    const nonce = crypto.randomBytes(16).toString("hex");
    activeSessions.set(nonce, { tg_id, ad_id: ad.id, seconds: ad.seconds, createdAt: Date.now() });

    res.json({ ok:true, none:false, ad, nonce, reward:{ tl:WATCH_REWARD_TL, diamonds:WATCH_REWARD_DIAMONDS } });
  }catch(e){
    console.error("ad next error", e);
    res.status(500).json({ error:String(e.message||e) });
  }
});

app.post("/api/ad/complete", async (req,res)=>{
  try{
    const tg_id = Number(req.body?.tg_id);
    const nonce = req.body?.nonce;
    if (!Number.isFinite(tg_id)) return res.status(400).json({ error:"tg_id required" });
    if (!nonce || typeof nonce!=="string") return res.status(400).json({ error:"nonce required" });

    const sess = activeSessions.get(nonce);
    if (!sess) return res.status(400).json({ error:"invalid session" });
    if (sess.tg_id !== tg_id) return res.status(400).json({ error:"session mismatch" });

    const elapsed = (Date.now() - sess.createdAt)/1000;
    if (elapsed + 0.25 < sess.seconds){
      return res.status(400).json({ error:"not finished", elapsed, required:sess.seconds });
    }

    activeSessions.delete(nonce);
    await creditUser(tg_id, WATCH_REWARD_TL, WATCH_REWARD_DIAMONDS);

    try{
      await bot.telegram.sendMessage(
        tg_id,
        `✅ Reklam izledin! +${WATCH_REWARD_TL.toFixed(2)} TL ve +${WATCH_REWARD_DIAMONDS.toFixed(2)} Elmas cüzdanına eklendi.`
      );
    }catch(err){
      console.warn("notify failed", err?.message || err);
    }

    const bal = await getUserBalances(tg_id);
    res.json({ ok:true, ...bal });
  }catch(e){
    console.error("ad complete error", e);
    res.status(500).json({ error:String(e.message||e) });
  }
});

// Telegram bot
const bot = new Telegraf(BOT_TOKEN);

function mainKeyboard(){
  return Markup.keyboard([
    [Markup.button.text("👀 Reklam İzle")],
    [Markup.button.text("🎁 Referans"), Markup.button.text("👛 Cüzdan")]
  ]).resize();
}

bot.start(async (ctx)=>{
  const tg_id = ctx.from.id;
  await ensureUser(tg_id);

  // referral payload support (optional)
  const payload = (ctx.startPayload || "").trim();
  if (payload && /^\d+$/.test(payload)){
    const ref = Number(payload);
    if (Number.isFinite(ref) && ref !== tg_id){
      const cols = await getTableColumns("users");
      const tgCol = pickFirst(cols, ["tg_id","telegram_id","user_id"]);
      const refByCol = pickFirst(cols, ["referred_by","referrer_id","ref_by"]);
      if (refByCol){
        await pool.query(`update public.users set ${refByCol}=COALESCE(${refByCol}, $1) where ${tgCol}=$2`, [ref, tg_id]);
      }
      if (REFERRAL_BONUS_TL || REFERRAL_BONUS_DIAMONDS){
        await creditUser(ref, REFERRAL_BONUS_TL, REFERRAL_BONUS_DIAMONDS);
      }
    }
  }

  await ctx.reply("👇 Menü aşağıda. Reklam izlemek için **👀 Reklam İzle** butonuna bas.", { parse_mode:"Markdown", ...mainKeyboard() });
});

bot.hears("👀 Reklam İzle", async (ctx)=>{
  const tg_id = ctx.from.id;
  await ensureUser(tg_id);

  const url = `${BASE_URL}/webapp/index.html?tg_id=${encodeURIComponent(String(tg_id))}`;
  await ctx.reply(
    "👀 Reklam izlemek için aşağıdaki butona tıkla:",
    Markup.inlineKeyboard([ Markup.button.webApp("👀 Reklam İzle (WebApp)", url) ])
  );
});

bot.hears("👛 Cüzdan", async (ctx)=>{
  const tg_id = ctx.from.id;
  const bal = await getUserBalances(tg_id);
  await ctx.reply(`👛 Cüzdan\nTL: ${bal.tl.toFixed(2)} ₺\nElmas: ${bal.diamonds.toFixed(2)} 💎`);
});

bot.hears("🎁 Referans", async (ctx)=>{
  const tg_id = ctx.from.id;
  const botUser = ctx.me || "YOUR_BOT_USERNAME";
  const link = `https://t.me/${botUser}?start=${tg_id}`;
  await ctx.reply(`🎁 Referans linkin:\n${link}`);
});

app.post("/telegram", (req,res)=>bot.handleUpdate(req.body,res));

app.listen(PORT, async ()=>{
  console.log("Server listening on :" + PORT);
  if (BASE_URL){
    try{
      const webhook = `${BASE_URL}/telegram`;
      await bot.telegram.setWebhook(webhook);
      console.log("Webhook aktif:", webhook);
      console.log("Bot started (webhook mode)");
    }catch(e){
      console.warn("Webhook set failed:", e?.message || e);
    }
  } else {
    console.log("BASE_URL not set; webhook not configured automatically.");
  }
});
