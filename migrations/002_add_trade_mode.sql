BEGIN;

-- Separates real-account trades from backtest trades. Existing rows become 'live'.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'live';

ALTER TABLE public.trades
  ADD CONSTRAINT trades_mode_check CHECK (mode IN ('live', 'backtest'));

CREATE INDEX IF NOT EXISTS trades_user_mode_idx ON public.trades (user_id, mode);

COMMIT;
