BEGIN;

-- One journal entry per user, per mode, per trading day
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'backtest')),
  entry_date date NOT NULL,

  -- before the session
  bias text CHECK (bias IN ('bullish', 'neutral', 'bearish')),
  bias_reason text,
  key_levels jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ "price": 21466, "label": "IFVG from London" }]
  plan text,
  news text,
  focus text,

  -- after the session
  followed_plan text CHECK (followed_plan IN ('yes', 'partly', 'no')),
  mood text CHECK (mood IN ('Focused', 'Calm', 'Bored', 'Tired', 'Frustrated')),
  day_grade text CHECK (day_grade IN ('A', 'B', 'C', 'D', 'F')),
  went_well text,
  to_fix text,
  lesson text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, mode, entry_date)
);

-- Chart screenshots stored in S3; removed with their entry
CREATE TABLE IF NOT EXISTS public.journal_images (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id integer NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  section text NOT NULL CHECK (section IN ('pre', 'post')),
  s3_key text NOT NULL UNIQUE,
  caption text,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_images_entry_idx ON public.journal_images (entry_id);

COMMIT;
