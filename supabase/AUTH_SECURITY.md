# Seguridad de Supabase Auth

## Pendiente de configuración

El Security Advisor de Supabase indica que **Leaked Password Protection** está desactivado.

Esta protección debe activarse desde la configuración de Auth del proyecto para impedir el uso de contraseñas conocidas como comprometidas.

## Acción requerida en el panel

En Supabase Dashboard, abrir la configuración de Authentication / Password Security y habilitar la protección contra contraseñas filtradas/comprometidas.

Referencia del asesor:
https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## Validación posterior

Después de habilitarla:

1. Ejecutar nuevamente Security Advisor.
2. Confirmar que desaparece `auth_leaked_password_protection`.
3. Mantener las contraseñas temporales de personal con mínimo 6 caracteres; idealmente elevar el mínimo conforme a la política operativa de la tienda.
