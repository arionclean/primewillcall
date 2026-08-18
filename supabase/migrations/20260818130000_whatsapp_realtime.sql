-- Publish whatsapp_messages to Realtime.
--
-- sms_messages has been in the supabase_realtime publication since the Messages
-- screen was built, but whatsapp_messages was added later and never joined it.
-- The unified thread view subscribes to both tables, so without this a WhatsApp
-- message reaches the database and simply never pushes to an open page: staff
-- see it only if they reload. Same guarantee for both channels now.

alter publication supabase_realtime add table public.whatsapp_messages;
