-- =====================================================================
-- Acceso por enlace, sin usuario ni contraseña.
--
-- El enlace lleva una clave (?acceso=...). La app la envía en el encabezado
-- "x-acceso" de cada consulta y la base la valida contra enlaces_acceso,
-- donde solo se guarda su hash SHA-256. Con un enlace válido se puede
-- consultar y cargar; sin él no se ve nada.
-- Reemplaza el acceso por usuario autorizado de la migración 2.
-- =====================================================================

create table public.enlaces_acceso (
  id           bigint generated always as identity primary key,
  descripcion  text not null,
  token_hash   text not null unique,
  activo       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Hash de la clave recibida en el encabezado x-acceso de la petición
create or replace function public.hash_acceso()
returns text
language sql
stable
set search_path = public
as $$
  select encode(sha256(convert_to(coalesce(
    nullif(current_setting('request.headers', true), '')::json ->> 'x-acceso', ''), 'UTF8')), 'hex');
$$;

alter table public.enlaces_acceso enable row level security;
revoke all on public.enlaces_acceso from anon, authenticated;
grant select on public.enlaces_acceso to anon, authenticated;
-- Cada visitante solo puede ver la fila de su propio enlace
create policy enlaces_acceso_propio on public.enlaces_acceso
  for select to anon, authenticated
  using (activo and token_hash = (select public.hash_acceso()));

create or replace function public.acceso_valido()
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (select 1 from public.enlaces_acceso
                 where activo and token_hash = public.hash_acceso());
$$;

-- Se mantiene el nombre usado por las funciones de alta de facturas
create or replace function public.puede_ver_facturas()
returns boolean
language sql
stable
set search_path = public
as $$
  select public.acceso_valido();
$$;

-- Genera un enlace nuevo y devuelve la clave (se muestra una sola vez).
-- Solo se puede usar desde el SQL Editor.
create or replace function public.crear_enlace(p_descripcion text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  insert into enlaces_acceso (descripcion, token_hash)
  values (p_descripcion, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'));
  return v_token;
end;
$$;
revoke execute on function public.crear_enlace(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- PDF originales dentro de la base (misma protección que el resto)
-- ---------------------------------------------------------------------
create table public.factura_pdfs (
  factura_id        bigint primary key references public.facturas(id) on delete cascade,
  nombre            text not null,
  contenido_base64  text not null,
  bytes             integer not null check (bytes > 0 and bytes <= 5242880),
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Políticas: todo permitido con un enlace válido, nada sin él
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  s text;
begin
  foreach t in array array[
    'entidades','productores','riesgos','polizas',
    'facturas','factura_items','deuda_snapshots','factura_pdfs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_leer', t);
    execute format('drop policy if exists %I on public.%I', t || '_crear', t);
    execute format('drop policy if exists %I on public.%I', t || '_editar', t);
    execute format('drop policy if exists %I on public.%I', t || '_borrar', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using ((select public.acceso_valido()))', t || '_leer', t);
    execute format('create policy %I on public.%I for insert to anon, authenticated with check ((select public.acceso_valido()))', t || '_crear', t);
    execute format('create policy %I on public.%I for update to anon, authenticated using ((select public.acceso_valido())) with check ((select public.acceso_valido()))', t || '_editar', t);
    execute format('create policy %I on public.%I for delete to anon, authenticated using ((select public.acceso_valido()))', t || '_borrar', t);
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = t and column_name = 'id') then
      s := pg_get_serial_sequence('public.' || t, 'id');
      if s is not null then
        execute format('grant usage on sequence %s to anon, authenticated', s);
      end if;
    end if;
  end loop;
end $$;

grant select on public.v_facturas_resumen to anon, authenticated;
grant select on public.v_polizas_vigentes to anon, authenticated;

grant execute on function public.acceso_valido()             to anon, authenticated;
grant execute on function public.puede_ver_facturas()        to anon, authenticated;
grant execute on function public.hash_acceso()               to anon, authenticated;
grant execute on function public.crear_factura(jsonb)        to anon, authenticated;
grant execute on function public.importar_factura(jsonb)     to anon, authenticated;
grant execute on function public.asegurar_entidad(jsonb)     to anon, authenticated;

-- El acceso por usuario ya no se usa
drop table if exists public.usuarios_facturas;

-- Los PDF ya no se guardan en Storage
drop policy if exists facturas_pdf_leer   on storage.objects;
drop policy if exists facturas_pdf_subir  on storage.objects;
drop policy if exists facturas_pdf_borrar on storage.objects;
