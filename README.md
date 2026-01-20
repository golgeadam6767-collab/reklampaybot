# Elmastoken (Bot + Mini App) - Tek Servis

Bu proje **tek Node.js servisi** olarak calisir:
- Telegram bot (Telegraf)
- Telegram Mini App (WebApp)
- API (Express)
- Postgres veritabani (Supabase / Render Postgres)

## Proje yapisi

- `index.js`
  - Telegraf bot
  - Express API
  - `webapp/` klasorunu static olarak servis eder
- `webapp/index.html`
  - Mini App arayuzu
  - Telegram icinde acilinca `tg_id` alir
  - `?action=watch` gelirse otomatik reklam acilir

## Gereken ENV

Render'da **Environment** kismina sunlari ekle:

- `BOT_TOKEN` = BotFather token
- `BASE_URL` = servisinin public URL'i (ornegin: `https://elmastoken.onrender.com`)
- `DATABASE_URL` = Postgres connection string

> Admin Telegram ID su an kod icinde sabit: `7784281785`.
> Degistirmek istersen `index.js` icinde `const ADMIN_TG_ID = ...` satirini degistir.

## Render ayari

- Build Command: `npm install`
- Start Command: `npm start`

## Telegram tarafinda

1) BotFather > **/setdomain**
- Domain: `BASE_URL` alanindaki domain

2) BotFather > **/setmenubutton** (opsiyonel)
- Menu Button URL: `BASE_URL/?action=watch`

> Asil menu **Telegram sohbetinin altindaki** reply-keyboard uzerinden.

## Notlar

- Referans linki: `https://t.me/<botusername>?start=<tg_id>`
  - Yeni kullanici bu linkle gelirse referrer kaydedilir.
- Odul: 1 reklam = `0.25 TL + 0.25 elmas` (normal)
- Reklam veren fiyatlandirma bilgisi bot icinde metin olarak gosterilir.

