-- Registros capturados por un administrador (entrada o salida manual): quién lo hizo.
alter table asiste.records
  add column if not exists created_by uuid references asiste.profiles (id) on delete set null;
