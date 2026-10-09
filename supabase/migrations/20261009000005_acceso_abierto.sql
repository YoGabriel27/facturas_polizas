-- =====================================================================
-- Acceso abierto: cualquiera que abra la app puede ver y cargar datos,
-- sin enlace ni clave.
--
-- Las políticas de RLS siguen consultando acceso_valido(); acá esa función
-- pasa a devolver siempre verdadero. Para volver a exigir el enlace,
-- restaurar la versión de la migración 4:
--
--   create or replace function public.acceso_valido() returns boolean
--   language sql stable set search_path = public as $$
--     select exists (select 1 from public.enlaces_acceso
--                    where activo and token_hash = public.hash_acceso());
--   $$;
--
-- y volver a usar la versión de la app que envía la clave.
-- =====================================================================

create or replace function public.acceso_valido()
returns boolean
language sql
stable
set search_path = public
as $$
  select true;
$$;
