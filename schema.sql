-- schema.sql (reference)
-- The app also auto-creates tables on startup (see index.js migrate()).

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

CREATE TABLE IF NOT EXISTS daily_views (
  tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  day DATE NOT NULL,
  seen INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tg_id, day)
);

CREATE TABLE IF NOT EXISTS ads (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('video','image','html')),
  url TEXT NOT NULL,
  seconds INT NOT NULL DEFAULT 15,
  reward_tl NUMERIC(12,2) NOT NULL DEFAULT 0.25,
  reward_gem NUMERIC(12,2) NOT NULL DEFAULT 0.25,
  is_vip BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  max_clicks INT,
  clicks INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ad_sessions (
  session_id UUID PRIMARY KEY,
  tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  ad_id INT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'started'
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  iban TEXT NOT NULL,
  amount_tl NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decided_by BIGINT
);

CREATE TABLE IF NOT EXISTS advertiser_orders (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  contact TEXT,
  ad_url TEXT NOT NULL,
  seconds INT NOT NULL,
  target_clicks INT NOT NULL,
  price_per_click NUMERIC(12,2) NOT NULL,
  total_budget NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decided_by BIGINT
);

CREATE TABLE IF NOT EXISTS forum_topics (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forum_posts (
  id SERIAL PRIMARY KEY,
  topic_id INT NOT NULL REFERENCES forum_topics(id) ON DELETE CASCADE,
  tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
