-- Run this in Supabase SQL Editor (or psql) to upgrade an existing DB.
-- Expands ads.type allowed values and adds columns used by the WebApp.

-- 1) Add optional columns (safe to run multiple times)
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS page_url TEXT;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS youtube_url TEXT;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS adsense_code TEXT;

-- 2) Expand the CHECK constraint for ads.type
DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname
    INTO conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'ads'
    AND c.contype = 'c'
    AND c.conname = 'ads_type_check';

  IF conname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.ads DROP CONSTRAINT ads_type_check';
  END IF;

  EXECUTE $$ALTER TABLE public.ads
    ADD CONSTRAINT ads_type_check
    CHECK (type IN ('video','image','html','url','youtube','adsense'))$$;
END $$;

-- 3) Backfill new columns from legacy `url` where possible
UPDATE public.ads
SET
  media_url = COALESCE(media_url, CASE WHEN type = 'video' THEN url END),
  youtube_url = COALESCE(youtube_url, CASE WHEN type = 'youtube' THEN url END),
  page_url = COALESCE(page_url, CASE WHEN type = 'url' THEN url END),
  adsense_code = COALESCE(adsense_code, CASE WHEN type = 'adsense' THEN url END)
WHERE TRUE;
