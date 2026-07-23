# Galería de contexto de empresa — diseño

## Objetivo

Reducir la sensación de formulario interminable en “Contexto de tu empresa” sin eliminar información ni romper el guardado existente. Los siete pasos deben verse juntos como una galería, poder completarse mediante IA y comunicar claramente el avance.

## Dirección elegida

Se implementará una galería expandible. En escritorio mostrará tres columnas; en tablet, dos; y en móvil, una. Cada tarjeta tendrá proporción visual cercana a un cuadrado cuando esté cerrada. Solo una tarjeta podrá estar expandida a la vez dentro de la misma cuadrícula.

Se descartaron:

- Galería con panel separado: facilita textos largos, pero vuelve a introducir desplazamiento y distancia entre índice y contenido.
- Wizard de un paso: reduce carga mental, pero oculta el panorama completo que el usuario pidió.

## Estructura de la página

El encabezado conservará las acciones para investigar desde LinkedIn o desde una web manual. Debajo aparecerá un bloque de progreso con:

- “X de 7 pasos completados”.
- Porcentaje real, calculado en incrementos de 1/7.
- Barra de progreso accesible con `role="progressbar"` y valores ARIA.
- Botón principal “Completar todo con IA”.

La galería tendrá estos siete pasos:

1. Contexto de la empresa: descripción, frase breve y mecanismo.
2. Industria, tamaño y país.
3. Pain points del ICP.
4. Soluciones para esos pain points.
5. Frase posicional o eslogan.
6. Resultados cualitativos.
7. Resumen estratégico generado a partir de los seis pasos anteriores.

La carga de PDFs se conservará como un bloque de “Fuentes adicionales” fuera de los siete pasos. Subir un documento es opcional y no puede ser completado legítimamente por la IA, por lo que no debe bloquear el progreso.

## Tarjetas y estados

Una tarjeta cerrada mostrará:

- Número y título.
- Un resumen corto, truncado a pocas líneas.
- Estado visual.
- Acción secundaria de IA.

Estados:

- `pending`: no tiene contenido suficiente.
- `generating`: una acción de IA está trabajando.
- `generated`: contiene información generada por IA.
- `reviewed`: el usuario guardó cambios manuales después de abrirla.
- `error`: la última generación falló y puede reintentarse.

`generated` y `reviewed` cuentan como completos. El porcentaje no exige confirmación manual, pero el estado permite distinguir claramente qué revisó el usuario.

Al pulsar una tarjeta, esta se expande a todo el ancho de la cuadrícula, mantiene los campos editables actuales y ofrece “Guardar cambios” y “Generar/Mejorar con IA”. Abrir otra tarjeta cierra la anterior. La interacción debe funcionar con teclado y exponer `aria-expanded`.

## Comportamiento de IA

Habrá dos niveles de acción:

### Completar todo con IA

Reutilizará la investigación existente desde LinkedIn o web para obtener contexto, industria y soluciones, y luego regenerará el `client_brief` para derivar pain points, posicionamiento, resultados y resumen. La UI mostrará el paso activo y actualizará la barra conforme cada grupo de datos quede persistido.

Si no existe LinkedIn ni web válida, el botón se deshabilitará y explicará qué fuente falta. No se inventarán datos demo.

### Generar o mejorar una tarjeta

Cada tarjeta enviará una clave de sección permitida al backend. El backend generará solo los campos de esa sección usando como contexto los datos existentes, la web/LinkedIn y documentos ya analizados. La lista de claves será cerrada para evitar prompts arbitrarios.

La respuesta se persistirá en `intel_hub_intake` o `client_brief`, según corresponda, y la suscripción realtime existente actualizará la tarjeta. Durante una generación se bloquearán las acciones de esa tarjeta, no toda la galería. El paso 7 solo se habilitará cuando exista contenido suficiente en pasos anteriores.

## Datos y compatibilidad

Se reutilizarán las tablas y campos actuales. El paso 7 usará el resumen ya representado por `client_brief` o, si se necesita separar su contenido, una migración mínima y explícita. No se borrarán datos existentes.

Los estados visuales se derivarán de:

- Presencia de campos requeridos para cada tarjeta.
- Estado de enriquecimiento existente.
- Fuente `client_brief.source`.
- Estado local de generación.

No se añadirá una tabla de seguimiento salvo que la implementación demuestre que los datos existentes no permiten distinguir generación y revisión de forma fiable.

## Errores y recuperación

- Cada tarjeta mostrará un mensaje breve y un botón “Reintentar”.
- Una falla individual no reducirá el progreso de tarjetas ya completadas.
- La generación global continuará solo cuando hacerlo no produzca datos incoherentes; si falla una dependencia, detendrá los pasos dependientes y mantendrá los anteriores.
- Se conservarán las reglas actuales para detectar ejecuciones estancadas.
- Los cambios manuales no se sobrescribirán sin una acción explícita del usuario.

## Responsive y accesibilidad

- Tres, dos y una columna según ancho disponible.
- Sin alturas fijas en tarjetas expandidas.
- Foco visible, activación con teclado y etiquetas accesibles.
- Movimiento reducido bajo `prefers-reduced-motion`.
- Tokens actuales para light/dark; no se hará un retema.
- Texto en español neutro latinoamericano.

## Verificación

- Smoke check existente: sintaxis, balance HTML y secretos.
- Pruebas unitarias o funciones puras para el cálculo de completitud y estado.
- Prueba manual de expansión, guardado, generación individual y generación global.
- Prueba responsive en escritorio, tablet y móvil.
- Comprobación de light/dark y navegación por teclado.
- Confirmación de que los datos existentes aparecen sin migración destructiva.

## Fuera de alcance

- Cambiar el onboarding.
- Rediseñar otras pantallas del Intelligence Hub.
- Inventar contenido demo.
- Desplegar Edge Functions o migraciones de Supabase automáticamente sin confirmar el mecanismo de despliegue disponible.
