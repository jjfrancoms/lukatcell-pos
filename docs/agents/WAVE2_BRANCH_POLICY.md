# Equipo Elite — Wave 2 branch policy

Rama de trabajo: `elite/wave-2`.

## Objetivo

Evitar deployments de Vercel por cambios parciales y usar GitHub Actions como puerta de calidad.

## Flujo

1. Los cambios de ELITE-04, ELITE-06, ELITE-08 y ELITE-09 se escriben en `elite/wave-2`.
2. El PR hacia `main` ejecuta CI: `npm ci`, `npm test`, `npm run lint`, `npm run build`.
3. Si CI falla, el cambio se corrige en la rama y se repite CI.
4. Solo cuando el bloque esté verde se hace merge consolidado a `main`.
5. Vercel queda reservado para el deployment de `main`.

## Regla de cierre

No considerar una ola lista para producción hasta que GitHub Actions esté verde y el merge consolidado haya sido validado.
