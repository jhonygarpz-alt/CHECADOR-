-- Horas extras: cada jornada (identificada por su registro de entrada) cuyo tiempo trabajado supera la
-- jornada programada genera horas extras. Solo un administrador puede autorizarlas o rechazarlas,
-- dejando por escrito el motivo en `notes`. Sin fila = pendiente de revisión.

create table asiste.overtime_decisions (
  in_record_id   integer primary key references asiste.records (id) on delete cascade,
  user_id        uuid    not null references asiste.profiles (id) on delete cascade,
  work_date      text    not null check (work_date ~ '^\d{4}-\d{2}-\d{2}$'),
  overtime_min   integer not null check (overtime_min > 0),          -- calculadas al momento de decidir
  approved_min   integer not null check (approved_min >= 0 and approved_min <= overtime_min),
  status         text    not null check (status in ('approved', 'rejected')),
  notes          text    not null check (length(trim(notes)) >= 5), -- motivo de la autorización o rechazo
  decided_by     uuid    not null references asiste.profiles (id),
  decided_at     timestamptz not null default now(),
  check (status = 'approved' or approved_min = 0)
);

create index overtime_decisions_user_date on asiste.overtime_decisions (user_id, work_date);

-- Solo la Edge Function (conexión directa) accede a esta tabla.
alter table asiste.overtime_decisions enable row level security;
