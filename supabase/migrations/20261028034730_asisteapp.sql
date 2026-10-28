-- AsisteApp: control de asistencia.
-- Todo vive en el esquema `asiste` para no interferir con otras tablas del proyecto.
-- La lógica de negocio corre en la Edge Function `api` (conexión directa a la base);
-- los clientes solo leen `records` vía Realtime, limitado por RLS.

create schema if not exists asiste;

create table asiste.locations (
  id          integer generated always as identity primary key,
  name        text    not null,
  address     text    not null default '',
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  radius_m    integer not null default 150 check (radius_m between 20 and 5000),
  timezone    text    not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table asiste.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  name             text    not null,
  email            text    not null,
  role             text    not null default 'employee' check (role in ('admin', 'employee')),
  position         text    not null default 'Personal Administrativo',
  department       text    not null default 'General',
  location_id      integer references asiste.locations (id) on delete set null,
  schedule_start   text    not null default '09:00' check (schedule_start ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  schedule_end     text    not null default '18:00' check (schedule_end ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  tolerance_min    integer not null default 10 check (tolerance_min between 0 and 240),
  work_days        text    not null default '1,2,3,4,5' check (work_days ~ '^[0-6](,[0-6])*$'),
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create unique index profiles_email_key on asiste.profiles (lower(email));

-- Plantilla biométrica separada: nunca se expone a los clientes.
create table asiste.face_templates (
  user_id      uuid primary key references asiste.profiles (id) on delete cascade,
  descriptor   double precision[] not null check (array_length(descriptor, 1) = 128),
  enrolled_at  timestamptz not null default now()
);

create table asiste.records (
  id             integer generated always as identity primary key,
  user_id        uuid    not null references asiste.profiles (id) on delete cascade,
  type           text    not null check (type in ('in', 'out')),
  ts             timestamptz not null,            -- instante tomado del reloj del servidor
  local_date     text    not null check (local_date ~ '^\d{4}-\d{2}-\d{2}$'), -- fecha en la zona de la ubicación
  local_time     text    not null,                -- HH:MM:SS local
  timezone       text    not null,
  location_id    integer references asiste.locations (id) on delete set null,
  lat            double precision,
  lng            double precision,
  accuracy_m     double precision,
  distance_m     double precision,
  face_distance  double precision,
  status         text    not null check (status in ('valid', 'rejected')),
  reason         text,
  late           boolean not null default false,
  snapshot_path  text,
  user_agent     text
);

create index records_user_ts on asiste.records (user_id, ts);
create index records_local_date on asiste.records (local_date);

-- ---------- Seguridad ----------

alter table asiste.locations      enable row level security;
alter table asiste.profiles       enable row level security;
alter table asiste.face_templates enable row level security;
alter table asiste.records        enable row level security;

create function asiste.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from asiste.profiles
    where id = (select auth.uid()) and role = 'admin' and active
  );
$$;

revoke all on schema asiste from public;
grant usage on schema asiste to authenticated;
grant execute on function asiste.is_admin() to authenticated;
grant select on asiste.records to authenticated;

-- Cada empleado ve sus registros; los administradores, todos (necesario para Realtime).
create policy records_select on asiste.records
  for select to authenticated
  using (user_id = (select auth.uid()) or (select asiste.is_admin()));

alter publication supabase_realtime add table asiste.records;

-- Fotos de cada registro (privadas; se consultan con URL firmada desde la función).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('asiste-snapshots', 'asiste-snapshots', false, 262144, array['image/jpeg', 'image/webp'])
on conflict (id) do nothing;
