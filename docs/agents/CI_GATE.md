# CI Gate — Equipo Elite

Antes de mergear una ola a `main`, el Pull Request debe pasar:

- `npm ci`
- `npm test`
- `npm run lint`
- `npm run build`

Vercel se reserva para el deployment consolidado de `main`.
