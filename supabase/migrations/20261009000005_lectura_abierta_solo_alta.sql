-- =====================================================================
-- Acceso abierto: cualquiera puede ver y cargar facturas nuevas.
-- Nadie puede modificar ni eliminar lo que ya está cargado.
--
--  * Las tablas quedan en solo lectura para la app (sin INSERT/UPDATE/DELETE).
--  * La carga pasa por funciones que solo AGREGAN registros nuevos:
--      importar_factura()  factura leída desde el PDF (con el PDF incluido)
--      crear_factura()     carga manual
--      archivar_pdf()      agrega el PDF a una factura que todavía no lo tiene
--    Si una entidad, póliza, riesgo o productor ya existe, se reutiliza tal
--    cual está, sin cambiar sus datos.
--  * Las correcciones se hacen desde el panel de Supabase.
-- Reemplaza el acceso por enlace de la migración 4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Lectura para todos, escritura directa para nadie
-- ---------------------------------------------------------------------
do $$
declare
  t text;
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
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_leer', t);
  end loop;
end $$;

grant select on public.v_facturas_resumen to anon, authenticated;
grant select on public.v_polizas_vigentes to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Sin acceso por enlace
-- ---------------------------------------------------------------------
drop function if exists public.crear_enlace(text);
drop function if exists public.acceso_valido();
drop table if exists public.enlaces_acceso;
drop function if exists public.hash_acceso();
drop function if exists public.puede_ver_facturas();

-- ---------------------------------------------------------------------
-- 3. Funciones de alta (solo agregan; nunca modifican lo existente)
--    SECURITY DEFINER: escriben con permisos propios, porque la app no
--    tiene permiso de escritura directa sobre las tablas.
-- ---------------------------------------------------------------------

-- Devuelve el id de la entidad; si no existe la crea. Si existe, no la toca.
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

  select id into v_id from entidades where razon_social = v_nombre;
  if v_id is not null then
    return v_id;
  end if;

  insert into entidades (razon_social, cuit, domicilio, localidad, codigo_postal, provincia,
                         condicion_iva, ingresos_brutos, codigo_cliente)
  values (v_nombre, nullif(e->>'cuit', ''), nullif(e->>'domicilio', ''), nullif(e->>'localidad', ''),
          nullif(e->>'codigo_postal', ''), nullif(e->>'provincia', ''), nullif(e->>'condicion_iva', ''),
          nullif(e->>'ingresos_brutos', ''), nullif(e->>'codigo_cliente', ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.crear_factura(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_factura_id bigint;
  v_poliza_id  bigint;
  v_item       jsonb;
  v_orden      integer := 0;
  v_emisor     bigint := (p->>'emisor_id')::bigint;
  v_cliente    bigint := (p->>'cliente_id')::bigint;
  v_numero     bigint;
begin
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'La factura necesita al menos una póliza';
  end if;

  insert into facturas (emisor_id, cliente_id, productor_id, tipo, punto_venta, numero,
                        fecha, moneda, cae, cae_vencimiento, otros_gastos)
  values (v_emisor, v_cliente,
          nullif(p->>'productor_id', '')::bigint,
          p->>'tipo', (p->>'punto_venta')::int, (p->>'numero')::bigint,
          (p->>'fecha')::date, coalesce(nullif(p->>'moneda', ''), 'ARS'),
          nullif(p->>'cae', ''), nullif(p->>'cae_vencimiento', '')::date,
          coalesce((p->>'otros_gastos')::numeric, 0))
  returning id into v_factura_id;

  for v_item in select value from jsonb_array_elements(p->'items') loop
    v_orden := v_orden + 1;
    v_numero := (v_item->>'poliza_numero')::bigint;

    -- La póliza se reutiliza tal como está si ya existe
    select id into v_poliza_id from polizas where aseguradora_id = v_emisor and numero = v_numero;
    if v_poliza_id is null then
      insert into polizas (aseguradora_id, numero, tomador_id, asegurado_id, riesgo_id, objeto)
      values (v_emisor, v_numero, v_cliente,
              (v_item->>'asegurado_id')::bigint, (v_item->>'riesgo_id')::bigint,
              nullif(v_item->>'objeto', ''))
      returning id into v_poliza_id;
    end if;

    insert into factura_items (factura_id, poliza_id, orden, endoso, vigencia_desde, vigencia_hasta,
                               movimiento, suma_asegurada, prima, gastos_notariales, subtotal,
                               impuestos, perc_iibb, iva, iva_rg, premio)
    values (v_factura_id, v_poliza_id, v_orden,
            (v_item->>'endoso')::int,
            (v_item->>'vigencia_desde')::date, (v_item->>'vigencia_hasta')::date,
            coalesce(nullif(v_item->>'movimiento', ''), 'Lote de Refacturación'),
            (v_item->>'suma_asegurada')::numeric,
            (v_item->>'prima')::numeric,
            coalesce((v_item->>'gastos_notariales')::numeric, 0),
            (v_item->>'prima')::numeric + coalesce((v_item->>'gastos_notariales')::numeric, 0),
            coalesce((v_item->>'impuestos')::numeric, 0),
            coalesce((v_item->>'perc_iibb')::numeric, 0),
            coalesce((v_item->>'iva')::numeric, 0),
            coalesce((v_item->>'iva_rg')::numeric, 0),
            (v_item->>'premio')::numeric);
  end loop;

  -- Totales de la factura recién creada (parte del alta, dentro de la misma transacción)
  update facturas f set
    prima             = s.prima,
    gastos_notariales = s.gastos_notariales,
    subtotal          = s.subtotal,
    impuestos         = s.impuestos,
    perc_iibb         = s.perc_iibb,
    iva               = s.iva,
    iva_rg            = s.iva_rg,
    premio_total      = coalesce((p->>'premio_total')::numeric, s.premio + f.otros_gastos)
  from (
    select sum(prima) prima, sum(gastos_notariales) gastos_notariales, sum(subtotal) subtotal,
           sum(impuestos) impuestos, sum(perc_iibb) perc_iibb, sum(iva) iva,
           sum(iva_rg) iva_rg, sum(premio) premio
    from factura_items where factura_id = v_factura_id
  ) s
  where f.id = v_factura_id;

  if jsonb_typeof(p->'deuda') = 'object' then
    insert into deuda_snapshots (factura_id, vencido, a_vencer, total)
    values (v_factura_id,
            coalesce((p->'deuda'->>'vencido')::numeric, 0),
            coalesce((p->'deuda'->>'a_vencer')::numeric, 0),
            coalesce((p->'deuda'->>'total')::numeric,
                     coalesce((p->'deuda'->>'vencido')::numeric, 0)
                   + coalesce((p->'deuda'->>'a_vencer')::numeric, 0)));
  end if;

  return v_factura_id;
end;
$$;

-- Agrega el PDF original a una factura que todavía no lo tiene. No reemplaza.
create or replace function public.archivar_pdf(p_factura_id bigint, p_nombre text, p_base64 text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bytes integer;
begin
  if not exists (select 1 from facturas where id = p_factura_id) then
    raise exception 'La factura no existe';
  end if;
  if exists (select 1 from factura_pdfs where factura_id = p_factura_id) then
    raise exception 'Esta factura ya tiene su PDF archivado';
  end if;

  v_bytes := length(decode(p_base64, 'base64'));
  if v_bytes > 5242880 then
    raise exception 'El PDF supera los 5 MB permitidos';
  end if;
  if substring(decode(p_base64, 'base64') from 1 for 4) <> '\x25504446'::bytea then
    raise exception 'El archivo no es un PDF';
  end if;

  insert into factura_pdfs (factura_id, nombre, contenido_base64, bytes)
  values (p_factura_id, coalesce(nullif(trim(p_nombre), ''), 'factura.pdf'), p_base64, v_bytes);

  update facturas set pdf_path = coalesce(nullif(trim(p_nombre), ''), 'factura.pdf')
  where id = p_factura_id and pdf_path is null;
end;
$$;

create or replace function public.importar_factura(p jsonb)
returns bigint
language plpgsql
security definer
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
  v_nombre    text;
begin
  v_emisor  := public.asegurar_entidad(p->'emisor');
  v_cliente := public.asegurar_entidad(p->'cliente');

  v_nombre := nullif(trim(p->>'productor'), '');
  if v_nombre is not null then
    select id into v_productor from productores where nombre = v_nombre;
    if v_productor is null then
      insert into productores (nombre) values (v_nombre) returning id into v_productor;
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p->'items') loop
    v_riesgo := null;
    select id into v_riesgo from riesgos where ramo = v_item->>'ramo' and subtipo = v_item->>'subtipo';
    if v_riesgo is null then
      insert into riesgos (ramo, subtipo) values (v_item->>'ramo', v_item->>'subtipo')
      returning id into v_riesgo;
    end if;

    v_items := v_items || jsonb_build_array(v_item || jsonb_build_object(
      'asegurado_id', public.asegurar_entidad(jsonb_build_object('razon_social', v_item->>'asegurado')),
      'riesgo_id',    v_riesgo));
  end loop;

  v_id := public.crear_factura(p || jsonb_build_object(
    'emisor_id',    v_emisor,
    'cliente_id',   v_cliente,
    'productor_id', v_productor,
    'items',        v_items));

  -- El PDF original se guarda en la misma operación: o queda todo o no queda nada
  if jsonb_typeof(p->'pdf') = 'object' then
    perform public.archivar_pdf(v_id, p->'pdf'->>'nombre', p->'pdf'->>'base64');
  end if;

  return v_id;
end;
$$;

-- Solo estas tres funciones se pueden llamar desde la app
revoke execute on function public.asegurar_entidad(jsonb) from public, anon, authenticated;
revoke execute on function public.crear_factura(jsonb) from public;
revoke execute on function public.importar_factura(jsonb) from public;
revoke execute on function public.archivar_pdf(bigint, text, text) from public;
grant  execute on function public.crear_factura(jsonb) to anon, authenticated;
grant  execute on function public.importar_factura(jsonb) to anon, authenticated;
grant  execute on function public.archivar_pdf(bigint, text, text) to anon, authenticated;
