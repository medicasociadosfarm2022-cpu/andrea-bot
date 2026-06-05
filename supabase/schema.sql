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

-- Conversaciones en pausa: cuando el paciente pide tratamiento/receta, Andrea
-- deja de responder hasta `paused_until` para que un humano lo atienda.
create table if not exists paused_chats (
  remote_jid   text        primary key,                -- ej: 5199xxxxxxx@s.whatsapp.net
  paused_until timestamptz not null,                   -- hasta cuándo Andrea no responde
  reason       text,                                   -- motivo de la pausa
  created_at   timestamptz not null default now()
);
