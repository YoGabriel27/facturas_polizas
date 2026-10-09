-- =====================================================================
-- Importación de facturas desde PDF
--  * importar_factura(): recibe los datos leídos del PDF con nombres (no ids),
--    crea las entidades, riesgos y productores que falten y da de alta la
--    factura en una sola transacción.
--  * Bucket privado "facturas-pdf" para guardar el PDF original.
-- =====================================================================

alter table public.facturas add column if not exists pdf_path text;

-- Ante dos refacturaciones con igual fin de vigencia, mostrar el endoso más reciente
create or replace view public.v_polizas_vigentes with (security_invoker = true) as
select distinct on (p.id)
       p.id as poliza_id, p.numero, a.razon_social as asegurado,
       r.ramo, r.subtipo, p.objeto,
       i.endoso, i.vigencia_desde, i.vigencia_hasta, i.suma_asegurada, i.premio,
       (i.vigencia_hasta - current_date) as dias_restantes,
       i.factura_id
from public.polizas p
join public.entidades a      on a.id = p.asegurado_id
join public.riesgos r        on r.id = p.riesgo_id
join public.factura_items i  on i.poliza_id = p.id
order by p.id, i.vigencia_hasta desc, i.endoso desc;

-- Devuelve el id de la entidad; si no existe la crea. Si existe, solo completa
-- los datos vacíos (nunca pisa lo que ya se cargó a mano).
create or replace function public.asegurar_entidad(e jsonb)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id bigint;
  v_nombre text := nullif(trim(e->>'razon_social'), '');
begin
  if v_nombre is null then
    raise exception 'Falta la razón social de una entidad';
  end if;

  insert into entidades (razon_social, cuit, domicilio, localidad, codigo_postal, provincia,
                         condicion_iva, ingresos_brutos, codigo_cliente)
  values (v_nombre, nullif(e->>'cuit', ''), nullif(e->>'domicilio', ''), nullif(e->>'localidad', ''),
          nullif(e->>'codigo_postal', ''), nullif(e->>'provincia', ''), nullif(e->>'condicion_iva', ''),
          nullif(e->>'ingresos_brutos', ''), nullif(e->>'codigo_cliente', ''))
  on conflict (razon_social) do update set
    cuit            = coalesce(entidades.cuit, excluded.cuit),
    domicilio       = coalesce(entidades.domicilio, excluded.domicilio),
    localidad       = coalesce(entidades.localidad, excluded.localidad),
    codigo_postal   = coalesce(entidades.codigo_postal, excluded.codigo_postal),
    provincia       = coalesce(entidades.provincia, excluded.provincia),
    condicion_iva   = coalesce(entidades.condicion_iva, excluded.condicion_iva),
    ingresos_brutos = coalesce(entidades.ingresos_brutos, excluded.ingresos_brutos),
    codigo_cliente  = coalesce(entidades.codigo_cliente, excluded.codigo_cliente)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.importar_factura(p jsonb)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_emisor    bigint;
  v_cliente   bigint;
  v_productor bigint;
  v_riesgo    bigint;
  v_item      jsonb;
  v_items     jsonb := '[]'::jsonb;
  v_id        bigint;
begin
  if auth.uid() is not null and not public.puede_ver_facturas() then
    raise exception 'Tu usuario no está autorizado para cargar facturas';
  end if;

  v_emisor  := public.asegurar_entidad(p->'emisor');
  v_cliente := public.asegurar_entidad(p->'cliente');

  if nullif(trim(p->>'productor'), '') is not null then
    insert into productores (nombre) values (trim(p->>'productor'))
    on conflict (nombre) do update set nombre = excluded.nombre
    returning id into v_productor;
  end if;

  for v_item in select value from jsonb_array_elements(p->'items') loop
    insert into riesgos (ramo, subtipo) values (v_item->>'ramo', v_item->>'subtipo')
    on conflict (ramo, subtipo) do update set ramo = excluded.ramo
    returning id into v_riesgo;

    v_items := v_items || jsonb_build_array(v_item || jsonb_build_object(
      'asegurado_id', public.asegurar_entidad(jsonb_build_object('razon_social', v_item->>'asegurado')),
      'riesgo_id',    v_riesgo));
  end loop;

  v_id := public.crear_factura(p || jsonb_build_object(
    'emisor_id',    v_emisor,
    'cliente_id',   v_cliente,
    'productor_id', v_productor,
    'items',        v_items));

  update facturas set pdf_path = nullif(p->>'pdf_path', '') where id = v_id;
  return v_id;
end;
$$;

revoke execute on function public.asegurar_entidad(jsonb) from public, anon;
revoke execute on function public.importar_factura(jsonb) from public, anon;
grant  execute on function public.asegurar_entidad(jsonb) to authenticated;
grant  execute on function public.importar_factura(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Almacenamiento del PDF original (bucket privado, máx. 10 MB, solo PDF)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('facturas-pdf', 'facturas-pdf', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

create policy facturas_pdf_leer on storage.objects
  for select to authenticated
  using (bucket_id = 'facturas-pdf' and (select public.puede_ver_facturas()));

create policy facturas_pdf_subir on storage.objects
  for insert to authenticated
  with check (bucket_id = 'facturas-pdf' and (select public.puede_ver_facturas()));

create policy facturas_pdf_borrar on storage.objects
  for delete to authenticated
  using (bucket_id = 'facturas-pdf' and (select public.puede_ver_facturas()));
