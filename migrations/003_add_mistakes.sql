BEGIN;

-- Each user's own list of execution mistakes (managed in the Playbook)
CREATE TABLE IF NOT EXISTS public.mistakes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mistakes_user_name_idx ON public.mistakes (user_id, lower(name));

-- Which mistakes were made on a trade; removed with the trade or the mistake
CREATE TABLE IF NOT EXISTS public.trade_mistakes (
  trade_id integer NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  mistake_id integer NOT NULL REFERENCES public.mistakes(id) ON DELETE CASCADE,
  PRIMARY KEY (trade_id, mistake_id)
);
CREATE INDEX IF NOT EXISTS trade_mistakes_mistake_idx ON public.trade_mistakes (mistake_id);

-- Starting list for every existing user (new users get it at sign-up)
INSERT INTO public.mistakes (user_id, name)
SELECT u.id, m.name
FROM public.users u
CROSS JOIN (VALUES
  ('Entered too early'),
  ('Moved my stop'),
  ('Oversized the position'),
  ('Chased the move'),
  ('Exited too early'),
  ('Traded during news'),
  ('Revenge trade'),
  ('Outside my session')
) AS m(name)
ON CONFLICT DO NOTHING;

COMMIT;
