-- Permite eliminar usuarios: si el usuario eliminado autorizó horas extras de otros, la decisión se conserva
-- y solo se pierde la referencia a quién la tomó (se muestra como "Usuario eliminado").

alter table asiste.overtime_decisions alter column decided_by drop not null;
alter table asiste.overtime_decisions drop constraint overtime_decisions_decided_by_fkey;
alter table asiste.overtime_decisions add constraint overtime_decisions_decided_by_fkey
  foreign key (decided_by) references asiste.profiles (id) on delete set null;
