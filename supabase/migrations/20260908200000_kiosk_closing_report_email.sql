-- Where the end-of-night closing statement is emailed.
--
-- Staff print and sign the paper form at the desk; the same figures are emailed to
-- whoever watches the money so they see the night without waiting for the paper.
-- Per kiosk, because a business may want its own manager on it. NULL means the
-- tablet still prints, it just sends nothing.

alter table public.kiosks
  add column if not exists closing_report_email text;

comment on column public.kiosks.closing_report_email is
  'Who receives the end-of-night closing statement email (kiosk-closing-report). NULL = print only.';

update public.kiosks
   set closing_report_email = 'ljandro98@gmail.com'
 where closing_report_email is null;
