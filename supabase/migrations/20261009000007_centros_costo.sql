-- =====================================================================
-- Centros de costo (CC)
--
--  * centros_costo: listado que llega en el "Reporte CC" (Excel con las
--    columnas CC, Descripción y Habilitado). Habilitado = obra vigente;
--    deshabilitado = obra dada de baja.
--  * reportes_cc: registro de cada reporte cargado.
--  * polizas.cc_codigo: CC asignado a cada póliza.
--  * polizas_cc_cambios: historial de asignaciones (quién no queda
--    registrado porque la app no tiene usuarios; sí cuándo y qué cambió).
--
-- Lo único editable desde la app es el CC de cada póliza y el listado de
-- CC (al cargar un reporte nuevo). Las facturas siguen sin poder
-- modificarse ni eliminarse.
-- =====================================================================

create table public.reportes_cc (
  id              bigint generated always as identity primary key,
  nombre_archivo  text not null,
  fecha_reporte   date,
  cantidad        integer not null default 0,
  habilitados     integer not null default 0,
  nuevos          integer not null default 0,
  cambios_estado  integer not null default 0,
  cargado_en      timestamptz not null default now()
);

create table public.centros_costo (
  codigo          text primary key check (codigo ~ '^\d{2}-\d{1,5}$'),
  descripcion     text not null,
  habilitado      boolean not null,
  reporte_id      bigint references public.reportes_cc(id),
  actualizado_en  timestamptz not null default now()
);
create index on public.centros_costo (habilitado);

alter table public.polizas
  add column if not exists cc_codigo text references public.centros_costo(codigo);
create index if not exists polizas_cc_codigo_idx on public.polizas (cc_codigo);

create table public.polizas_cc_cambios (
  id           bigint generated always as identity primary key,
  poliza_id    bigint not null references public.polizas(id) on delete cascade,
  cc_anterior  text,
  cc_nuevo     text not null,
  cambiado_en  timestamptz not null default now()
);
create index on public.polizas_cc_cambios (poliza_id);

-- Lectura para todos, escritura solo por las funciones de abajo
do $$
declare
  t text;
begin
  foreach t in array array['reportes_cc', 'centros_costo', 'polizas_cc_cambios'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_leer', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Carga del Reporte CC: agrega los CC nuevos y actualiza descripción y
-- estado de los existentes (el reporte es la fuente oficial). Los CC que
-- no vienen en el reporte se conservan, para no perder asignaciones.
-- p_filas: [{ "codigo": "01-618", "descripcion": "...", "habilitado": true }, ...]
-- ---------------------------------------------------------------------
create or replace function public.importar_reporte_cc(p_nombre text, p_fecha date, p_filas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reporte   bigint;
  v_cantidad  integer;
  v_habil     integer;
  v_nuevos    integer;
  v_cambios   integer;
  v_invalido  text;
begin
  if jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) = 0 then
    raise exception 'El reporte no tiene centros de costo';
  end if;
  if jsonb_array_length(p_filas) > 20000 then
    raise exception 'El reporte tiene demasiadas filas';
  end if;

  create temporary table tmp_cc on commit drop as
  select distinct on (codigo) codigo, descripcion, habilitado
  from (
    select trim(x->>'codigo') as codigo,
           coalesce(nullif(trim(x->>'descripcion'), ''), 'Sin descripción') as descripcion,
           (x->>'habilitado')::boolean as habilitado
    from jsonb_array_elements(p_filas) x
  ) f
  order by codigo;

  select codigo into v_invalido from tmp_cc
  where codigo is null or codigo !~ '^\d{2}-\d{1,5}$' or habilitado is null
  limit 1;
  if found then
    raise exception 'Código de CC inválido en el reporte: %', coalesce(v_invalido, '(vacío)');
  end if;

  select count(*), count(*) filter (where habilitado) into v_cantidad, v_habil from tmp_cc;
  select count(*) into v_nuevos from tmp_cc t where not exists (select 1 from centros_costo c where c.codigo = t.codigo);
  select count(*) into v_cambios from tmp_cc t join centros_costo c on c.codigo = t.codigo where c.habilitado <> t.habilitado;

  insert into reportes_cc (nombre_archivo, fecha_reporte, cantidad, habilitados, nuevos, cambios_estado)
  values (coalesce(nullif(trim(p_nombre), ''), 'Reporte CC'), p_fecha, v_cantidad, v_habil, v_nuevos, v_cambios)
  returning id into v_reporte;

  insert into centros_costo (codigo, descripcion, habilitado, reporte_id)
  select codigo, descripcion, habilitado, v_reporte from tmp_cc
  on conflict (codigo) do update set
    descripcion    = excluded.descripcion,
    habilitado     = excluded.habilitado,
    reporte_id     = excluded.reporte_id,
    actualizado_en = now();

  return jsonb_build_object('reporte_id', v_reporte, 'cantidad', v_cantidad, 'habilitados', v_habil,
                            'nuevos', v_nuevos, 'cambios_estado', v_cambios);
end;
$$;

-- ---------------------------------------------------------------------
-- Asigna (o cambia) el CC de una o varias pólizas. Devuelve cuántas cambiaron.
-- ---------------------------------------------------------------------
create or replace function public.asignar_cc(p_polizas bigint[], p_cc text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cc       text := trim(p_cc);
  v_cambios  integer;
begin
  if v_cc is null or not exists (select 1 from centros_costo where codigo = v_cc) then
    raise exception 'El CC % no está en el listado de centros de costo', coalesce(v_cc, '(vacío)');
  end if;
  if p_polizas is null or cardinality(p_polizas) = 0 then
    raise exception 'No se indicó ninguna póliza';
  end if;
  if cardinality(p_polizas) > 200 then
    raise exception 'Demasiadas pólizas en una sola asignación';
  end if;

  insert into polizas_cc_cambios (poliza_id, cc_anterior, cc_nuevo)
  select id, cc_codigo, v_cc from polizas
  where id = any(p_polizas) and cc_codigo is distinct from v_cc;
  get diagnostics v_cambios = row_count;

  update polizas set cc_codigo = v_cc
  where id = any(p_polizas) and cc_codigo is distinct from v_cc;

  return v_cambios;
end;
$$;

revoke execute on function public.importar_reporte_cc(text, date, jsonb) from public;
revoke execute on function public.asignar_cc(bigint[], text) from public;
grant  execute on function public.importar_reporte_cc(text, date, jsonb) to anon, authenticated;
grant  execute on function public.asignar_cc(bigint[], text) to anon, authenticated;
