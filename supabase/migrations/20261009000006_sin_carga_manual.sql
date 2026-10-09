-- =====================================================================
-- Sin carga manual: las facturas solo se agregan importando el PDF.
-- crear_factura() sigue existiendo, pero solo la usa importar_factura().
-- =====================================================================
revoke execute on function public.crear_factura(jsonb) from public, anon, authenticated;
