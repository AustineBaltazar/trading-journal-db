BEGIN;

-- Optional planned stop and target. With a stop, every trade gets an R value
-- (see utils/outcome.js); without one it just shows P/L as before.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS stop_price numeric(12,2),
  ADD COLUMN IF NOT EXISTS target_price numeric(12,2);

-- Each user's tag groups (Setup, News, Market...) and the tags in them
CREATE TABLE IF NOT EXISTS public.tag_groups (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tag_groups_user_name_idx ON public.tag_groups (user_id, lower(name));

CREATE TABLE IF NOT EXISTS public.tags (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id integer NOT NULL REFERENCES public.tag_groups(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_group_name_idx ON public.tags (group_id, lower(name));

-- Which tags are on a trade; removed with the trade or the tag
CREATE TABLE IF NOT EXISTS public.trade_tags (
  trade_id integer NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  tag_id integer NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  PRIMARY KEY (trade_id, tag_id)
);
CREATE INDEX IF NOT EXISTS trade_tags_tag_idx ON public.trade_tags (tag_id);

-- Starter groups for every existing user (new users get them at sign-up)
INSERT INTO public.tag_groups (user_id, name, position)
SELECT u.id, g.name, g.position
FROM public.users u
CROSS JOIN (VALUES ('Setup', 0), ('News', 1), ('Market', 2)) AS g(name, position)
ON CONFLICT DO NOTHING;

INSERT INTO public.tags (group_id, name)
SELECT g.id, t.name
FROM public.tag_groups g
JOIN (VALUES
  ('News', 'CPI'), ('News', 'FOMC'), ('News', 'NFP'),
  ('Market', 'Trend day'), ('Market', 'Range day'), ('Market', 'Gap')
) AS t(grp, name) ON t.grp = g.name
ON CONFLICT DO NOTHING;

-- Setup tags from each user's existing Strategy values, and tag those trades,
-- so the by-setup report works straight away
INSERT INTO public.tags (group_id, name)
SELECT DISTINCT ON (g.id, lower(trim(tr.strategy))) g.id, trim(tr.strategy)
FROM public.trades tr
JOIN public.tag_groups g ON g.user_id = tr.user_id AND g.name = 'Setup'
WHERE trim(coalesce(tr.strategy, '')) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO public.trade_tags (trade_id, tag_id)
SELECT tr.id, t.id
FROM public.trades tr
JOIN public.tag_groups g ON g.user_id = tr.user_id AND g.name = 'Setup'
JOIN public.tags t ON t.group_id = g.id AND lower(t.name) = lower(trim(tr.strategy))
ON CONFLICT DO NOTHING;

COMMIT;
