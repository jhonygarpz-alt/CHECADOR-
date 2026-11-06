-- Rotación semanal de turnos: { "anchor": "AAAA-MM-DD" (lunes de una semana del turno 1), "shifts": [{ "start", "end" }, ...] }.
-- Null = horario fijo (schedule_start / schedule_end).
alter table asiste.profiles
  add column if not exists rotation jsonb
    check (rotation is null or (jsonb_typeof(rotation -> 'shifts') = 'array' and jsonb_array_length(rotation -> 'shifts') between 2 and 4));
