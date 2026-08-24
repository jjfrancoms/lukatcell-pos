# Decisiones persistentes — LukatCell POS

Estas decisiones no deben volver a discutirse en cada sesión salvo que cambien los requisitos o aparezca evidencia técnica nueva.

## Arquitectura

1. Frontend: React + TypeScript + Vite.
2. Backend/DB/Auth/Storage/Edge: Supabase.
3. Deploy web: Vercel.
4. Repositorio/CI: GitHub.
5. Cambios de esquema deben ir mediante migraciones versionadas.

## Identidad y permisos

6. `staff.rol` representa permisos del sistema.
7. `staff.puesto` representa función laboral.
8. Puestos y permisos no deben mezclarse.
9. Datos sensibles de administración requieren doble protección: UI + backend/RLS/RPC.
10. No confiar en IDs de actor/sucursal enviados por el navegador si pueden derivarse de `auth.uid()`.

## Personal/turnos

11. Una persona puede tener como máximo un turno activo por día.
12. El historial de horarios no se borra; se cierra con vigencia.
13. Un día sin programación representa descanso.
14. Excepciones diarias tienen prioridad sobre el patrón semanal.
15. Turnos que cruzan medianoche deben conservar la fecha lógica de la jornada.
16. Tardanza guarda minutos reales desde el inicio; tolerancia decide el estado.
17. Permiso/vacaciones/licencia no cuenta como ausencia.
18. Una ausencia justificada no crea una entrada falsa.

## Operación

19. Vendedor necesita jornada activa para módulos operativos.
20. Venta necesita jornada + caja abierta.
21. Salida de jornada requiere caja cerrada.
22. Administrador puede gestionar módulos administrativos fuera de jornada.
23. Máximo una caja abierta por cajero.
24. Cálculos monetarios críticos se validan en servidor.
25. Precio de venta se verifica contra catálogo para ventas online sincronizadas.
26. Escrituras de inventario sensibles se hacen por RPC validada, no por acceso libre a tabla.

## Seguridad

27. Todas las tablas públicas mantienen RLS.
28. Ninguna función `SECURITY DEFINER` debe quedar ejecutable por `anon` salvo decisión explícita documentada.
29. Helpers de auth/RLS pertenecen a esquema privado cuando no necesitan ser RPC públicas.
30. Username login no devuelve email interno al navegador.
31. `.env` no debe versionarse.
32. Edge Functions públicas deben justificar `verify_jwt=false` y aplicar autenticación/firma propia cuando corresponda.

## Testing

33. Para cambios de datos sensibles, TESTER debe incluir un test de bypass directo.
34. Pruebas SQL sintéticas deben usar `BEGIN/ROLLBACK` cuando sea posible.
35. Una función no se considera terminada hasta pasar test, lint/build/deploy aplicables.
36. Un bug encontrado por TESTER debe generar regresión automática si es razonable.

## Desarrollo multiagente

37. CREATOR define criterios de aceptación antes del cambio grande.
38. TESTER diseña pruebas en paralelo con DEV.
39. Agentes deben leer STATE/BACKLOG/DECISIONS antes de trabajar.
40. No repetir investigación registrada como decisión estable.
41. Cada bloque terminado actualiza memoria persistente.
