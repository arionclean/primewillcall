-- Realtime for the money tables.
--
-- /admin/payments and /caja were the only operational screens with no live
-- updates: a sale rung up on another desk, or a refund issued by someone else,
-- stayed invisible until the page was reloaded. The client code could not fix
-- that on its own, because these tables were never added to the realtime
-- publication, so Postgres was not emitting their changes at all.
--
-- Scoping is unchanged. postgres_changes evaluates each table's existing SELECT
-- policy per subscriber, so an owner streams every business, a manager only
-- their own, and a check-in account only its own business (and, on /caja, only
-- its own kiosk slug via a client-side filter). No policy changes here.

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['stripe_transactions', 'stripe_refunds', 'cash_sales'] LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- REPLICA IDENTITY FULL puts the whole old row in the WAL. Without it an UPDATE
-- or DELETE only carries the primary key, which is not enough for Realtime to
-- run the RLS policy against the old record (the policies read business_id) or
-- to match a client-side filter. Every UPDATE here matters: a refund lands as an
-- UPDATE to amount_refunded/status on stripe_transactions, not as an INSERT.
ALTER TABLE public.stripe_transactions REPLICA IDENTITY FULL;
ALTER TABLE public.stripe_refunds REPLICA IDENTITY FULL;
ALTER TABLE public.cash_sales REPLICA IDENTITY FULL;
