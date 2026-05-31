-- Memoria de conversaciones del bot Andrea.
-- Ejecuta esto en Supabase: Dashboard > SQL Editor > New query > Run.

create table if not exists messages (
  id          bigint generated always as identity primary key,
  remote_jid  text        not null,                 -- ej: 5199xxxxxxx@s.whatsapp.net
  role        text        not null check (role in ('user', 'assistant')),
  content     text        not null,
  push_name   text,                                 -- nombre que muestra WhatsApp
  created_at  timestamptz not null default now()
);

-- Índice para traer rápido el historial de cada contacto.
create index if not exists messages_remote_jid_created_idx
  on messages (remote_jid, created_at desc);
