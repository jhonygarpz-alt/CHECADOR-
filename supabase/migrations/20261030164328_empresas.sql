-- Varias empresas (multiempresa): cada empresa tiene sus propias ubicaciones, personal y registros.
-- Roles: 'superadmin' (dueño de la plataforma: da de alta empresas y puede entrar a cualquiera),
-- 'admin' (administra solo su empresa) y 'employee'.
-- Los datos existentes quedan en la empresa "Empresa principal".

create table asiste.companies (
  id          integer generated always as identity primary key,
  name        text    not null check (length(trim(name)) >= 2),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create unique index companies_name_key on asiste.companies (lower(name));
alter table asiste.companies enable row level security;

insert into asiste.companies (name) values ('Empresa principal');

alter table asiste.locations add column company_id integer references asiste.companies (id) on delete restrict;
alter table asiste.profiles  add column company_id integer references asiste.companies (id) on delete restrict;
alter table asiste.records   add column company_id integer references asiste.companies (id) on delete restrict;

update asiste.locations set company_id = (select min(id) from asiste.companies);
update asiste.profiles  set company_id = (select min(id) from asiste.companies);
update asiste.records r set company_id = p.company_id from asiste.profiles p where p.id = r.user_id;

alter table asiste.locations alter column company_id set not null;
alter table asiste.profiles  alter column company_id set not null;
alter table asiste.records   alter column company_id set not null;

create index locations_company on asiste.locations (company_id);
create index profiles_company on asiste.profiles (company_id);
create index records_company_date on asiste.records (company_id, local_date);

alter table asiste.profiles drop constraint profiles_role_check;
alter table asiste.profiles add constraint profiles_role_check check (role in ('superadmin', 'admin', 'employee'));

-- ---------- Seguridad (Realtime): cada administrador solo recibe los registros de su empresa ----------

create or replace function asiste.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from asiste.profiles
    where id = (select auth.uid()) and role in ('admin', 'superadmin') and active
  );
$$;

create function asiste.is_superadmin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from asiste.profiles where id = (select auth.uid()) and role = 'superadmin' and active);
$$;

create function asiste.my_company()
returns integer language sql stable security definer set search_path = ''
as $$
  select company_id from asiste.profiles where id = (select auth.uid());
$$;

grant execute on function asiste.is_superadmin() to authenticated;
grant execute on function asiste.my_company() to authenticated;

drop policy records_select on asiste.records;
create policy records_select on asiste.records
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select asiste.is_superadmin())
    or ((select asiste.is_admin()) and company_id = (select asiste.my_company()))
  );
