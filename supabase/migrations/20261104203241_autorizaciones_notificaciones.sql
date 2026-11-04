-- Entradas fuera del límite de tolerancia: el registro queda "pending" hasta que un administrador lo autoriza.
alter table asiste.records drop constraint records_status_check;
alter table asiste.records add constraint records_status_check check (status in ('valid', 'rejected', 'pending'));

create table asiste.late_requests (
  id           integer generated always as identity primary key,
  company_id   integer not null references asiste.companies(id) on delete cascade,
  user_id      uuid    not null references asiste.profiles(id) on delete cascade,
  record_id    integer not null unique references asiste.records(id) on delete cascade,
  local_date   text    not null,
  minutes_late integer not null,
  status       text    not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  notes        text,
  decided_by   uuid references asiste.profiles(id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index late_requests_company_status on asiste.late_requests (company_id, status, created_at desc);
create index late_requests_user on asiste.late_requests (user_id, created_at desc);
alter table asiste.late_requests enable row level security;

-- Notificaciones de la campana (cada usuario solo lee las suyas, también por Realtime).
create table asiste.notifications (
  id         integer generated always as identity primary key,
  user_id    uuid not null references asiste.profiles(id) on delete cascade,
  company_id integer references asiste.companies(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user on asiste.notifications (user_id, created_at desc);
alter table asiste.notifications enable row level security;
grant select on asiste.notifications to authenticated;
create policy notifications_select on asiste.notifications
  for select to authenticated using (user_id = (select auth.uid()));
alter publication supabase_realtime add table asiste.notifications;

-- Suscripciones Web Push de cada dispositivo.
create table asiste.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references asiste.profiles(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user on asiste.push_subscriptions (user_id);
alter table asiste.push_subscriptions enable row level security;
