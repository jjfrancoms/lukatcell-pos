-- ============================================================================
-- P3.A — search_path fijado en las 4 funciones de `private` que no lo tenían
-- ============================================================================
-- Hallazgo (linter de Supabase `function_search_path_mutable` + consulta directa
-- sobre pg_proc, sólo lectura, 2026-09-17): de las funciones de `public` y
-- `private`, exactamente 4 tienen proconfig NULL, es decir resuelven los nombres
-- sin cualificar con el search_path que traiga quien las llame:
--
--     private.hash_recepcion(uuid, jsonb)
--     private.incidencia_eventos_append_only()
--     private.reimpresiones_venta_append_only()
--     private.reembolsos_proveedor_append_only()
--
-- Las 4 son SECURITY INVOKER, propiedad de postgres y con ACL `postgres=X/postgres`
-- (ni anon ni authenticated pueden ejecutarlas). El riesgo residual es real pero
-- acotado: un rol que pueda crear objetos en un esquema alcanzable podría, en el
-- futuro, secuestrar un nombre sin cualificar. Se cierra ahora, antes de que
-- alguien añada al cuerpo una referencia sin esquema.
--
-- QUÉ NO HACE ESTA MIGRACIÓN
-- --------------------------
-- No toca el cuerpo. Se usa ALTER FUNCTION ... SET, no CREATE OR REPLACE, por una
-- razón de seguridad, no de estilo: CREATE OR REPLACE SOBRESCRIBIRÍA el cuerpo con
-- la copia que lleve este archivo. Si producción hubiera derivado (un cuerpo
-- editado a mano desde el panel), esa deriva se perdería en silencio y sin error.
-- ALTER FUNCTION ... SET sólo escribe pg_proc.proconfig: es físicamente incapaz de
-- cambiar prosrc, propietario, ACL, tipo de retorno, volatilidad o prosecdef.
--
-- En vez de copiar el cuerpo, el bloque 1 lo VERIFICA: si md5(prosrc) no es el
-- capturado de producción, la migración aborta y no fija nada. Eso es lo contrario
-- de sobrescribir a ciegas.
--
-- POR QUÉ `search_path = ''` EN LAS 4 (y no `public` ni `public, extensions`)
-- --------------------------------------------------------------------------
-- pg_catalog está SIEMPRE en el camino de búsqueda de forma implícita y no se
-- puede quitar con search_path. Por tanto `''` no significa "sin nada": significa
-- "sólo pg_catalog, y todo lo demás hay que cualificarlo". Es el mínimo estricto.
--
--   · incidencia_eventos_append_only, reimpresiones_venta_append_only y
--     reembolsos_proveedor_append_only son triggers cuyo cuerpo entero es
--     `raise exception ... using errcode = 'P0001'`. No leen ninguna tabla, no
--     llaman a ninguna función, no usan ningún tipo propio. El único identificador
--     que aparece, `tg_table_name`, es una variable mágica de PL/pgSQL que el
--     intérprete resuelve internamente, sin catálogo. No hay NADA que buscar:
--     cualquier esquema en la lista sobraría.
--
--   · hash_recepcion es SQL inmutable y tampoco toca ninguna tabla, vista, tipo
--     propio ni función de `public`. Todo lo que invoca vive en pg_catalog:
--     md5, jsonb_build_object, jsonb_agg, jsonb_array_elements, coalesce, nullif,
--     btrim, trim_scale, los operadores -> y ->> y los cast a numeric/boolean/
--     text/jsonb. Añadir `public` no habilitaría nada que use hoy, y en cambio
--     dejaría abierta la puerta que se viene a cerrar.
--
-- Efecto lateral aceptado y medido: con proconfig no nulo el planificador deja de
-- hacer INLINE de hash_recepcion (inline_function() rechaza toda función SQL con
-- SET). hash_recepcion se llama una vez por recepción, con el jsonb ya en memoria
-- y sin acceso a disco; no está en ningún bucle ni en ningún predicado de scan.
-- El coste es irrelevante frente a dejar el search_path abierto.
--
-- Fallo cerrado: cada bloque `do` levanta excepción y aborta la migración entera
-- si algo no cuadra. No hay camino silencioso.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ANTES · el cuerpo es el de producción, y la función es la que creemos
-- ----------------------------------------------------------------------------
-- md5(prosrc) capturados de producción. Si alguno no coincide, alguien cambió el
-- cuerpo por fuera de las migraciones: parar y mirar, no seguir.
do $migracion$
declare
  v_esperado constant jsonb := jsonb_build_object(
    'private.hash_recepcion(uuid,jsonb)',          '16e0a66e09b12894dc8e8b85dea0f1ce',
    'private.incidencia_eventos_append_only()',    '783661bb6b9b135421337abfb9367cd9',
    'private.reimpresiones_venta_append_only()',   '8387ba0622be6cb193781c690e7afc69',
    'private.reembolsos_proveedor_append_only()',  '039d88da4845fd322ca197e79c2a4dfa');
  v_clave   text;
  v_oid     oid;
  v_md5     text;
  v_secdef  boolean;
  v_owner   name;
begin
  for v_clave in select jsonb_object_keys(v_esperado) loop
    -- to_regprocedure resuelve la firma EXACTA por tipos de argumento y devuelve
    -- null si no existe (a diferencia de ::regprocedure, que levantaría error).
    v_oid := to_regprocedure(v_clave);
    select md5(p.prosrc), p.prosecdef, a.rolname
      into v_md5, v_secdef, v_owner
      from pg_proc p join pg_authid a on a.oid = p.proowner
     where p.oid = v_oid;

    if v_oid is null then
      raise exception 'P3.A: no existe %', v_clave using errcode = 'P0001';
    end if;
    if v_md5 is distinct from (v_esperado ->> v_clave) then
      raise exception 'P3.A: el cuerpo de % no es el de producción (md5 %, esperado %)',
        v_clave, v_md5, (v_esperado ->> v_clave) using errcode = 'P0001';
    end if;
    if v_secdef then
      raise exception 'P3.A: % es SECURITY DEFINER y se esperaba SECURITY INVOKER', v_clave using errcode = 'P0001';
    end if;
    if v_owner <> 'postgres' then
      raise exception 'P3.A: % pertenece a % y se esperaba postgres', v_clave, v_owner using errcode = 'P0001';
    end if;
  end loop;
end
$migracion$;

-- ----------------------------------------------------------------------------
-- 2. FIJAR · sólo proconfig. Idempotente: reaplicarla es un no-op exacto.
-- ----------------------------------------------------------------------------
alter function private.hash_recepcion(uuid, jsonb)          set search_path = '';
alter function private.incidencia_eventos_append_only()     set search_path = '';
alter function private.reimpresiones_venta_append_only()    set search_path = '';
alter function private.reembolsos_proveedor_append_only()   set search_path = '';

-- ----------------------------------------------------------------------------
-- 3. DESPUÉS · el search_path quedó fijo y NADA MÁS cambió
-- ----------------------------------------------------------------------------
-- Se vuelve a comprobar md5(prosrc), propietario, prosecdef, volatilidad, tipo de
-- retorno y ACL. La ACL debe seguir siendo exactamente {postgres=X/postgres}: si
-- anon o authenticated pudieran ejecutarlas, esto aborta.
do $migracion$
declare
  v_clave  text;
  v_fila   record;
  v_claves constant text[] := array[
    'private.hash_recepcion(uuid,jsonb)',
    'private.incidencia_eventos_append_only()',
    'private.reimpresiones_venta_append_only()',
    'private.reembolsos_proveedor_append_only()'];
begin
  foreach v_clave in array v_claves loop
    select md5(p.prosrc) as md5, p.prosecdef, p.provolatile, p.prorettype::regtype::text as rettype,
           -- PostgreSQL guarda `set search_path = ''` como la entrada
           -- search_path="" (cadena vacía entrecomillada), no como search_path=.
           (select c from unnest(coalesce(p.proconfig, '{}'::text[])) c
             where c like 'search\_path=%' limit 1) as sp,
           coalesce(p.proacl::text, '<nulo>') as acl, a.rolname as owner,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      into v_fila
      from pg_proc p join pg_authid a on a.oid = p.proowner
     where p.oid = to_regprocedure(v_clave);

    if not found then
      raise exception 'P3.A: desapareció % tras el ALTER', v_clave using errcode = 'P0001';
    end if;
    if v_fila.sp is distinct from 'search_path=""' then
      raise exception 'P3.A: % no quedó con el search_path vacío (entrada %)',
        v_clave, coalesce(v_fila.sp, '<sin search_path>') using errcode = 'P0001';
    end if;
    if v_fila.prosecdef or v_fila.owner <> 'postgres' then
      raise exception 'P3.A: cambió el modo de seguridad o el propietario de %', v_clave using errcode = 'P0001';
    end if;
    if v_fila.anon or v_fila.auth then
      raise exception 'P3.A: la ACL de % se abrió (anon=%, authenticated=%, acl=%)',
        v_clave, v_fila.anon, v_fila.auth, v_fila.acl using errcode = 'P0001';
    end if;
    if v_fila.acl <> '{postgres=X/postgres}' then
      raise exception 'P3.A: la ACL de % ya no es {postgres=X/postgres}, es %', v_clave, v_fila.acl using errcode = 'P0001';
    end if;
  end loop;

  -- Volatilidad y tipo de retorno, uno a uno con su valor esperado.
  if (select p.provolatile::text || '/' || p.prorettype::regtype::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'hash_recepcion') <> 'i/text' then
    raise exception 'P3.A: hash_recepcion ya no es immutable returns text' using errcode = 'P0001';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ('incidencia_eventos_append_only', 'reimpresiones_venta_append_only',
        'reembolsos_proveedor_append_only') and p.provolatile = 'v' and p.prorettype = 'trigger'::regtype) <> 3 then
    raise exception 'P3.A: alguna función de trigger cambió de volatilidad o de tipo de retorno' using errcode = 'P0001';
  end if;
end
$migracion$;

-- ----------------------------------------------------------------------------
-- 4. DESPUÉS · los triggers que las usan siguen en pie y apuntando a lo mismo
-- ----------------------------------------------------------------------------
-- ALTER FUNCTION ... SET no puede tirar un trigger (no hay DROP ni recreación de
-- la función), pero se comprueba igual: es la garantía que de verdad le importa al
-- negocio, y cuesta una consulta.
do $migracion$
declare
  v_n integer;
begin
  select count(*) into v_n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
   where not t.tgisinternal
     and (n.nspname, c.relname, t.tgname, pn.nspname, p.proname) in (
       ('public', 'incidencia_eventos',          'incidencia_eventos_append_only',          'private', 'incidencia_eventos_append_only'),
       ('public', 'reimpresiones_venta',         'reimpresiones_venta_append_only',         'private', 'reimpresiones_venta_append_only'),
       ('public', 'reembolsos_proveedor',        'reembolsos_proveedor_append_only',        'private', 'reembolsos_proveedor_append_only'),
       ('public', 'reembolso_proveedor_eventos', 'reembolso_proveedor_eventos_append_only', 'private', 'reembolsos_proveedor_append_only'));
  if v_n <> 4 then
    raise exception 'P3.A: se esperaban los 4 triggers append-only apuntando a su función y hay %', v_n using errcode = 'P0001';
  end if;

  -- trg_conciliacion_pago_deriva_venta no usa ninguna de las 4, pero se vigila
  -- porque comparte tabla con el trabajo de conciliación: si desapareciera aquí,
  -- sería señal de que esta migración hizo algo que no debía.
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  join pg_namespace n on n.oid = c.relnamespace
                 where not t.tgisinternal and n.nspname = 'public'
                   and c.relname = 'conciliaciones_pago' and t.tgname = 'trg_conciliacion_pago_deriva_venta') then
    raise exception 'P3.A: falta el trigger trg_conciliacion_pago_deriva_venta' using errcode = 'P0001';
  end if;
end
$migracion$;
