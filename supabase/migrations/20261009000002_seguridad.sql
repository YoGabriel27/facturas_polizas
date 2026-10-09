-- =====================================================================
-- Row Level Security con lista de usuarios autorizados.
-- El proyecto de Supabase puede ser compartido con otras apps: estar
-- autenticado no alcanza, el usuario tiene que figurar en usuarios_facturas.
-- =====================================================================

create table public.usuarios_facturas (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  created_at  timestamptz not null default now()
);

alter table public.usuarios_facturas enable row level security;
revoke all on public.usuarios_facturas from anon;
-- Cada usuario solo puede ver su propia fila (la app la usa para saber si tiene acceso).
-- Altas y bajas se hacen desde el SQL Editor (ver README).
create policy usuarios_facturas_propio on public.usuarios_facturas
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.puede_ver_facturas()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (select 1 from public.usuarios_facturas where user_id = auth.uid());
$$;
revoke execute on function public.puede_ver_facturas() from public, anon;
grant  execute on function public.puede_ver_facturas() to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'entidades','productores','riesgos','polizas',
    'facturas','factura_items','deuda_snapshots'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.puede_ver_facturas()))', t || '_leer', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.puede_ver_facturas()))', t || '_crear', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.puede_ver_facturas())) with check ((select public.puede_ver_facturas()))', t || '_editar', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.puede_ver_facturas()))', t || '_borrar', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

revoke all on public.v_facturas_resumen from anon;
revoke all on public.v_polizas_vigentes from anon;

revoke execute on function public.crear_factura(jsonb) from public, anon;
grant  execute on function public.crear_factura(jsonb) to authenticated;
