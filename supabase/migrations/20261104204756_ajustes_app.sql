-- Ajustes internos del servidor (p. ej. las llaves VAPID de las notificaciones push, generadas por la Edge Function).
-- Sin políticas ni permisos: solo la conexión del servidor puede leerlos.
create table asiste.app_settings (
  key        text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);
alter table asiste.app_settings enable row level security;
revoke all on asiste.app_settings from anon, authenticated;
