-- Horario especial para los sábados (opcional). Si está vacío, el sábado usa el mismo horario de lunes a viernes.
alter table asiste.profiles
  add column if not exists sat_start text check (sat_start ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  add column if not exists sat_end   text check (sat_end ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  add constraint profiles_sat_schedule_pair check ((sat_start is null) = (sat_end is null));
