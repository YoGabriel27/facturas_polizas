-- =====================================================================
-- Esquema para facturas de seguros de caución
-- Modelo: factura (cabecera + totales) -> ítems -> póliza -> asegurado/riesgo
-- =====================================================================

-- Entidades: emisor (aseguradora), cliente (tomador) y asegurados (comitentes)
create table public.entidades (
  id               bigint generated always as identity primary key,
  razon_social     text not null unique,
  cuit             text unique check (cuit is null or cuit ~ '^\d{2}-\d{8}-\d$'),
  domicilio        text,
  localidad        text,
  codigo_postal    text,
  provincia        text,
  condicion_iva    text,
  ingresos_brutos  text,
  codigo_cliente   text,            -- código interno que asigna la aseguradora (ej. 5256)
  created_at       timestamptz not null default now()
);

create table public.productores (
  id          bigint generated always as identity primary key,
  nombre      text not null unique,
  created_at  timestamptz not null default now()
);

-- Catálogo de riesgos: ramo + subtipo (ej. Obra Publica / Fondo de Reparo)
create table public.riesgos (
  id       bigint generated always as identity primary key,
  ramo     text not null,
  subtipo  text not null,
  unique (ramo, subtipo)
);

-- Pólizas: se refacturan trimestralmente, cada refacturación es un endoso
create table public.polizas (
  id              bigint generated always as identity primary key,
  aseguradora_id  bigint not null references public.entidades(id),
  numero          bigint not null,
  tomador_id      bigint not null references public.entidades(id),
  asegurado_id    bigint not null references public.entidades(id),
  riesgo_id       bigint not null references public.riesgos(id),
  objeto          text,              -- licitación, expediente, nota de pedido, etc.
  created_at      timestamptz not null default now(),
  unique (aseguradora_id, numero)
);

create table public.facturas (
  id                 bigint generated always as identity primary key,
  emisor_id          bigint not null references public.entidades(id),
  cliente_id         bigint not null references public.entidades(id),
  productor_id       bigint references public.productores(id),
  tipo               char(1) not null check (tipo in ('A','B','C','M')),
  punto_venta        integer not null check (punto_venta > 0),
  numero             bigint  not null check (numero > 0),
  fecha              date not null,
  moneda             text not null default 'ARS',
  cae                text,
  cae_vencimiento    date,
  -- Totales del desglose (calculados desde los ítems al dar de alta)
  prima              numeric(15,2) not null default 0,
  gastos_notariales  numeric(15,2) not null default 0,
  subtotal           numeric(15,2) not null default 0,
  impuestos          numeric(15,2) not null default 0,
  perc_iibb          numeric(15,2) not null default 0,
  iva                numeric(15,2) not null default 0,
  iva_rg             numeric(15,2) not null default 0,
  otros_gastos       numeric(15,2) not null default 0,
  -- Premio total tal como figura impreso: se compara contra la suma de ítems
  premio_total       numeric(15,2) not null default 0,
  estado             text not null default 'pendiente'
                     check (estado in ('pendiente','pagada','anulada')),
  fecha_pago         date,
  created_at         timestamptz not null default now(),
  unique (emisor_id, tipo, punto_venta, numero)
);

create table public.factura_items (
  id                 bigint generated always as identity primary key,
  factura_id         bigint not null references public.facturas(id) on delete cascade,
  poliza_id          bigint not null references public.polizas(id),
  orden              integer not null default 1,
  endoso             integer not null check (endoso >= 0),
  vigencia_desde     date not null,
  vigencia_hasta     date not null,
  movimiento         text not null default 'Lote de Refacturación',
  suma_asegurada     numeric(15,2) not null check (suma_asegurada >= 0),
  prima              numeric(15,2) not null default 0,
  gastos_notariales  numeric(15,2) not null default 0,
  subtotal           numeric(15,2) not null default 0,
  impuestos          numeric(15,2) not null default 0,
  perc_iibb          numeric(15,2) not null default 0,
  iva                numeric(15,2) not null default 0,
  iva_rg             numeric(15,2) not null default 0,
  premio             numeric(15,2) not null default 0,
  constraint vigencia_valida check (vigencia_hasta >= vigencia_desde),
  -- Tolerancia de 5 centavos por redondeos de la aseguradora
  constraint premio_cuadra check (abs(premio - (subtotal + impuestos + perc_iibb + iva + iva_rg)) <= 0.05),
  unique (factura_id, poliza_id, endoso)
);

-- Foto de la cuenta corriente informada al pie de cada factura
create table public.deuda_snapshots (
  id          bigint generated always as identity primary key,
  factura_id  bigint not null unique references public.facturas(id) on delete cascade,
  vencido     numeric(15,2) not null default 0,
  a_vencer    numeric(15,2) not null default 0,
  total       numeric(15,2) not null default 0
);

create index on public.polizas (asegurado_id);
create index on public.polizas (tomador_id);
create index on public.polizas (riesgo_id);
create index on public.facturas (cliente_id);
create index on public.facturas (fecha desc);
create index on public.factura_items (factura_id);
create index on public.factura_items (poliza_id);
create index on public.factura_items (vigencia_hasta);

-- ---------------------------------------------------------------------
-- Vistas (security_invoker: respetan el RLS del usuario que consulta)
-- ---------------------------------------------------------------------
create view public.v_facturas_resumen with (security_invoker = true) as
select f.id, f.tipo, f.punto_venta, f.numero, f.fecha, f.estado,
       f.premio_total,
       c.razon_social                              as cliente,
       count(i.id)                                 as cantidad_items,
       coalesce(sum(i.premio), 0)                  as premio_items,
       f.premio_total - coalesce(sum(i.premio), 0) - f.otros_gastos as diferencia
from public.facturas f
join public.entidades c on c.id = f.cliente_id
left join public.factura_items i on i.factura_id = f.id
group by f.id, c.razon_social;

-- Último endoso facturado de cada póliza, con días hasta el fin de vigencia
create view public.v_polizas_vigentes with (security_invoker = true) as
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

-- ---------------------------------------------------------------------
-- Alta atómica de una factura completa (cabecera + pólizas + ítems + deuda)
-- ---------------------------------------------------------------------
create or replace function public.crear_factura(p jsonb)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_factura_id bigint;
  v_poliza_id  bigint;
  v_item       jsonb;
  v_orden      integer := 0;
  v_emisor     bigint := (p->>'emisor_id')::bigint;
  v_cliente    bigint := (p->>'cliente_id')::bigint;
begin
  -- Desde la app (usuario autenticado) se exige estar autorizado.
  -- Desde el SQL Editor (sin auth.uid()) se permite, para la carga inicial.
  if auth.uid() is not null and not public.puede_ver_facturas() then
    raise exception 'Tu usuario no está autorizado para cargar facturas';
  end if;

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

    insert into polizas (aseguradora_id, numero, tomador_id, asegurado_id, riesgo_id, objeto)
    values (v_emisor, (v_item->>'poliza_numero')::bigint, v_cliente,
            (v_item->>'asegurado_id')::bigint, (v_item->>'riesgo_id')::bigint,
            nullif(v_item->>'objeto', ''))
    on conflict (aseguradora_id, numero) do update
      set asegurado_id = excluded.asegurado_id,
          riesgo_id    = excluded.riesgo_id,
          objeto       = coalesce(excluded.objeto, polizas.objeto)
    returning id into v_poliza_id;

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
