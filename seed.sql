-- =====================================================================
-- Datos iniciales: factura A 0004-00259740 del 04/03/2026 (19 pólizas)
-- Se puede ejecutar más de una vez: no duplica registros.
--
-- Los CUIT del PDF vienen enmascarados ("30-,714,838-0"), así que se cargan
-- vacíos. Completalos desde la pantalla Entidades o con un UPDATE.
-- =====================================================================

insert into public.entidades (razon_social, domicilio, localidad, codigo_postal, provincia,
                              condicion_iva, ingresos_brutos, codigo_cliente) values
  ('Gestión Compañía Argentina de Seguros S.A.', 'Bartolomé Mitre 480 Piso 11º', 'C.A.B.A.', '1036',
   'Ciudad Autónoma de Buenos Aires', 'Responsable Inscripto', '901-130714-0', null),
  ('FABRICA SRL', 'Av. 9 de Julio 938', 'Resistencia', '3500', 'Chaco',
   'Responsable Inscripto', null, '5256')
on conflict (razon_social) do nothing;

insert into public.entidades (razon_social, provincia) values
  ('MINISTERIO DE EDUCACION CULTURA CIENCIA Y TECNOLOGIA - PROVINCIA DE CHACO', 'Chaco'),
  ('SERVICIO DE AGUA Y MANTENIMIENTO EMPRESA DEL ESTADO PROVINCIAL S A M E E P', 'Chaco'),
  ('GOBIERNO DE LA PROVINCIA DE CÓRDOBA – MINISTERIO DE INFRAESTRUCTURA Y SERVICIOS PÚBLICOS', 'Córdoba'),
  ('MINISTERIO DE PLANIFICACION, ECONOMIA E INFRAESTRUCTURA – PROVINCIA DE CHACO', 'Chaco'),
  ('ENTE NACIONAL DE OBRAS HÍDRICAS DE SANEAMIENTO (ENOHSA)', null),
  ('CONSORCIO AÑA CUA ART', null),
  ('YPF SOCIEDAD ANONIMA', null),
  ('SAN CRISTOBAL SOCIEDAD MUTUAL DE SEGUROS GENERALES', null),
  ('BANCO PATAGONIA SOCIEDAD ANONIMA', null)
on conflict (razon_social) do nothing;

insert into public.productores (nombre) values ('ROHANI, SHESHVAN RAIAN OMMID')
on conflict (nombre) do nothing;

insert into public.riesgos (ramo, subtipo) values
  ('Obra Publica',   'Ejecucion de Contrato'),
  ('Obra Publica',   'Fondo de Reparo'),
  ('Obra Publica',   'Ant. por Acopio'),
  ('Obra Publica',   'Anticipo Financiero'),
  ('Obra Privada',   'Fondo de Reparo'),
  ('Obra Privada',   'Ant. por Acopio'),
  ('Sum/Serv.Priv.', 'Anticipo')
on conflict (ramo, subtipo) do nothing;

-- La factura se da de alta con la misma función que usa la app
with
asegurados (clave, razon_social) as (values
  ('MEDU', 'MINISTERIO DE EDUCACION CULTURA CIENCIA Y TECNOLOGIA - PROVINCIA DE CHACO'),
  ('SAMEEP', 'SERVICIO DE AGUA Y MANTENIMIENTO EMPRESA DEL ESTADO PROVINCIAL S A M E E P'),
  ('CBA', 'GOBIERNO DE LA PROVINCIA DE CÓRDOBA – MINISTERIO DE INFRAESTRUCTURA Y SERVICIOS PÚBLICOS'),
  ('MPLAN', 'MINISTERIO DE PLANIFICACION, ECONOMIA E INFRAESTRUCTURA – PROVINCIA DE CHACO'),
  ('ENOHSA', 'ENTE NACIONAL DE OBRAS HÍDRICAS DE SANEAMIENTO (ENOHSA)'),
  ('ANACUA', 'CONSORCIO AÑA CUA ART'),
  ('YPF', 'YPF SOCIEDAD ANONIMA'),
  ('SANCRIS', 'SAN CRISTOBAL SOCIEDAD MUTUAL DE SEGUROS GENERALES'),
  ('PATAGONIA', 'BANCO PATAGONIA SOCIEDAD ANONIMA')
),
items (orden, poliza, endoso, desde, hasta, clave, ramo, subtipo, objeto,
       suma, prima, impuestos, iva, premio) as (values
  ( 1, 31596, 17, '2026-03-14', '2026-06-14', 'MEDU',      'Obra Publica',   'Ejecucion de Contrato', 'CONTRATACIÓN DIRECTA Nº02/21',  15723783.00,  15723.78,  1996.92,  3301.99,  21022.69),
  ( 2, 53198, 10, '2026-03-29', '2026-06-29', 'MEDU',      'Obra Publica',   'Ejecucion de Contrato', 'CONCURSO DE PRECIOS Nº02/21',    1673062.55,   8000.00,  1016.00,  1680.00,  10696.00),
  ( 3, 56061,  9, '2026-03-05', '2026-06-05', 'SAMEEP',    'Obra Publica',   'Ejecucion de Contrato', 'LICITACION PÚBLICA Nº 02/2020 EXPEDIENTE Nº 238-03-12-2020-024-E-SAMEEP - REDETERMINACION CERT 1 AL 13', 674727.89, 12400.00, 1574.80, 2604.00, 16578.80),
  ( 4, 67415,  5, '2026-03-20', '2026-06-20', 'MEDU',      'Obra Publica',   'Ejecucion de Contrato', 'CONTRATACIÓN DIRECTA Nº02/21', 101487933.69, 101487.93, 12888.97, 21312.47, 135689.37),
  ( 5, 75847,  3, '2026-03-16', '2026-06-16', 'CBA',       'Obra Publica',   'Fondo de Reparo',       'EXPEDIENTE N° 0045-027314/2025',  4436307.00,  22000.00,  2794.00,  4620.00,  29414.00),
  ( 6, 53197, 10, '2026-03-29', '2026-06-29', 'MEDU',      'Obra Publica',   'Fondo de Reparo',       'CONCURSO DE PRECIOS Nº02/21',    1673062.55,   8000.00,  1016.00,  1680.00,  10696.00),
  ( 7, 67414,  5, '2026-03-19', '2026-06-19', 'MEDU',      'Obra Publica',   'Fondo de Reparo',       'CONTRATACIÓN DIRECTA Nº02/21', 101487933.69, 101487.93, 12888.97, 21312.47, 135689.37),
  ( 8, 56060,  9, '2026-03-05', '2026-06-05', 'SAMEEP',    'Obra Publica',   'Fondo de Reparo',       'LICITACION PÚBLICA Nº 02/2020 - EXPEDIENTE Nº 238-03-12-2020-024-E-SAMEEP - REDETERMINACION CERT 1 AL 13', 674727.89, 12400.00, 1574.80, 2604.00, 16578.80),
  ( 9, 31597, 17, '2026-03-14', '2026-06-14', 'MEDU',      'Obra Publica',   'Fondo de Reparo',       'CONTRATACIÓN DIRECTA Nº02/21',  15723783.00,  15723.78,  1996.92,  3301.99,  21022.69),
  (10, 44231, 13, '2026-03-20', '2026-06-20', 'MPLAN',     'Obra Publica',   'Fondo de Reparo',       'LICITACIÓN PÚBLICA Nº 05/23 - ACTUACIÓN ELECTRONICA: E23-2023-76-Ae', 9179128.99, 9179.13, 1165.75, 1927.62, 12272.50),
  (11, 31528, 16, '2026-03-11', '2026-06-11', 'ENOHSA',    'Obra Publica',   'Ant. por Acopio',       'LICITACIÓN PÚBLICA N°02/21',     6335071.71,   8000.00,  1016.00,  1680.00,  10696.00),
  (12, 31529, 16, '2026-03-11', '2026-06-11', 'ENOHSA',    'Obra Publica',   'Ant. por Acopio',       'LICITACIÓN PÚBLICA N°01/21',     1632723.79,   8000.00,  1016.00,  1680.00,  10696.00),
  (13, 31595, 17, '2026-03-14', '2026-06-14', 'MEDU',      'Obra Publica',   'Anticipo Financiero',   'CONTRATACIÓN DIRECTA Nº02/21',  62895130.00,  62895.13,  7987.69, 13207.98,  84090.80),
  (14, 44692, 15, '2026-03-29', '2026-06-29', 'ANACUA',    'Obra Privada',   'Fondo de Reparo',       'LICITACION PUBLICA INTERNACIONAL N° 670 - CONTRATO Y-C-AMPLYA', 38889878.92, 38889.88, 4939.02, 8166.87, 51995.77),
  (15, 78909,  2, '2026-03-26', '2026-06-26', 'YPF',       'Obra Privada',   'Ant. por Acopio',       'SERVICIO DE OBRAS CIVILES MENORES PARA LA ZONA DE LITORAL NORTE', 150000000.00, 150000.00, 19050.00, 31500.00, 200550.00),
  (16, 62099,  7, '2026-03-28', '2026-06-28', 'SANCRIS',   'Sum/Serv.Priv.', 'Anticipo',              'PRESUPUESTO 153-23 DE FECHA 05/04/2024 - NOTA DE PEDIDO N° 4500174898', 1095828.84, 13000.00, 1651.00, 2730.00, 17381.00),
  (17, 76072,  2, '2026-03-23', '2026-06-23', 'SANCRIS',   'Sum/Serv.Priv.', 'Anticipo',              'NOTA DE PEDIDO N° 4500184502',     980100.00,  22000.00,  2794.00,  4620.00,  29414.00),
  (18, 72712,  3, '2026-03-09', '2026-06-09', 'PATAGONIA', 'Sum/Serv.Priv.', 'Anticipo',              'ORDEN DE COMPRA 029995 DE FECHA 30/05/2025', 5009101.00, 22000.00, 2794.00, 4620.00, 29414.00),
  (19, 72743,  3, '2026-03-09', '2026-06-09', 'SANCRIS',   'Sum/Serv.Priv.', 'Anticipo',              'NOTA DE PEDIDO N° 4500182169',    2628725.00,  22000.00,  2794.00,  4620.00,  29414.00)
)
select public.crear_factura(jsonb_build_object(
  'emisor_id',       (select id from public.entidades where razon_social = 'Gestión Compañía Argentina de Seguros S.A.'),
  'cliente_id',      (select id from public.entidades where razon_social = 'FABRICA SRL'),
  'productor_id',    (select id from public.productores where nombre = 'ROHANI, SHESHVAN RAIAN OMMID'),
  'tipo',            'A',
  'punto_venta',     4,
  'numero',          259740,
  'fecha',           '2026-03-04',
  'cae',             '86096265854384',
  'cae_vencimiento', '2026-03-14',
  'premio_total',    873311.79,
  'deuda',           jsonb_build_object('vencido', 16477101, 'a_vencer', 1386611, 'total', 17863711.74),
  'items', (
    select jsonb_agg(jsonb_build_object(
             'poliza_numero',  i.poliza,
             'endoso',         i.endoso,
             'vigencia_desde', i.desde,
             'vigencia_hasta', i.hasta,
             'asegurado_id',   e.id,
             'riesgo_id',      r.id,
             'objeto',         i.objeto,
             'suma_asegurada', i.suma,
             'prima',          i.prima,
             'impuestos',      i.impuestos,
             'iva',            i.iva,
             'premio',         i.premio
           ) order by i.orden)
    from items i
    join asegurados a        on a.clave = i.clave
    join public.entidades e  on e.razon_social = a.razon_social
    join public.riesgos r    on r.ramo = i.ramo and r.subtipo = i.subtipo
  )
))
where not exists (
  select 1 from public.facturas where tipo = 'A' and punto_venta = 4 and numero = 259740
);
