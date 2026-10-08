BEGIN;

-- Manual result override. NULL means work it out from the prices (see utils/outcome.js).
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS result text CHECK (result IN ('win', 'loss', 'be'));

-- More than one emotion per trade. The old single `emotion` column is kept and
-- set to the first one, so nothing that still reads it breaks.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS emotions text[] NOT NULL DEFAULT '{}'
    CHECK (emotions <@ ARRAY['Confident', 'Anxious', 'FOMO', 'Revenge', 'Calm', 'Hesitant']::text[]);

UPDATE public.trades
SET emotions = ARRAY[emotion]
WHERE emotion IS NOT NULL AND emotions = '{}';

-- Trade screenshots stored in S3; removed with their trade
CREATE TABLE IF NOT EXISTS public.trade_images (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trade_id integer NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  s3_key text NOT NULL UNIQUE,
  caption text,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_images_trade_idx ON public.trade_images (trade_id);

COMMIT;
