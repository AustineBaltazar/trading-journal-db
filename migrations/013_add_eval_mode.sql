BEGIN;

-- A third journal next to live and backtest: prop-firm evaluation trades
ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_mode_check;
ALTER TABLE public.trades ADD CONSTRAINT trades_mode_check CHECK (mode IN ('live', 'backtest', 'eval'));
ALTER TABLE public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_mode_check;
ALTER TABLE public.journal_entries ADD CONSTRAINT journal_entries_mode_check CHECK (mode IN ('live', 'backtest', 'eval'));

-- Each try at an evaluation: the firm's rules, and how it ended.
-- Empty rule = the firm doesn't have it. One open attempt per user.
CREATE TABLE IF NOT EXISTS public.eval_attempts (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  account_size numeric(12, 2) NOT NULL CHECK (account_size > 0),
  profit_target numeric(12, 2) CHECK (profit_target > 0),
  max_drawdown numeric(12, 2) CHECK (max_drawdown > 0),
  drawdown_type text NOT NULL DEFAULT 'eod_trailing' CHECK (drawdown_type IN ('eod_trailing', 'trailing', 'static')),
  daily_loss_limit numeric(12, 2) CHECK (daily_loss_limit > 0),
  min_days integer CHECK (min_days BETWEEN 1 AND 60),
  consistency_pct integer CHECK (consistency_pct BETWEEN 10 AND 100),
  started_on date NOT NULL,
  ended_on date,
  result text CHECK (result IN ('passed', 'failed')),
  fail_reason text CHECK (length(fail_reason) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CHECK ((ended_on IS NULL) = (result IS NULL)),
  CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS eval_attempts_one_open_idx ON public.eval_attempts (user_id) WHERE ended_on IS NULL;
CREATE INDEX IF NOT EXISTS eval_attempts_user_idx ON public.eval_attempts (user_id, started_on DESC);

COMMIT;
