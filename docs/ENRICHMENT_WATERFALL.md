# Waterfall enrichment, verificación de email y teléfonos latinos

Fecha: 2026-10-17. Ítem P0 n.º 1 y 2 de la hoja de ruta GTM OS (`docs/ROADMAP_GTM_OS.md`, PR #340). Referencia: Oxygen (30+ proveedores en cascada, los baratos primero, cobro solo si encuentra, proveedor guardado por dato).

## Qué hace

Cuando el usuario pulsa **«Enriquecer»** en Listas (modo `full` de la cola), `enrich-list` hace lo de siempre con Apollo. Si Apollo no trajo el email, o el teléfono pedido, la fila sigue **en cascada** con los demás proveedores configurados hasta encontrarlo o agotar la lista.

- **Solo participan los proveedores con su secret en Supabase.** Sin ninguno (ni verificador), `enrich-list` hace exactamente lo de antes.
- **Al guardar desde Buscar (modo `email`) no hay cascada**: ese enriquecimiento corre solo para cada lead guardado, y la cascada cobraría créditos que nadie pidió.
- **Cobro por dato encontrado**: 3 créditos por email y 20 por teléfono (`enrich_email_waterfall` / `enrich_phone_waterfall` en `_shared/credit-costs.ts` ↔ `js/credit-costs.js`). Se cobra también con el Apollo propio del cliente, porque las keys de la cascada son de la plataforma. Un dato que no se encuentra no cuesta nada. El precio es el mismo lo encuentre quien lo encuentre (márgenes en `docs/PRICING.md`).
- **Verificación de email**: un email que el proveedor ya dio por válido o catch-all se acepta. Uno que el proveedor dio por inválido se descarta. El resto (sin veredicto o «riesgoso») pasa por el verificador. Un inválido **no se guarda** en `email` (rebotaría en la campaña), queda en `source_provider.rejected_emails` y la cascada busca otro. El email que Apollo acaba de traer sin «verified» también se verifica: 1 crédito (`email_verify`), solo con veredicto concluyente. Un email que la fila ya tenía no se verifica.
- **Teléfonos en E.164 con su tipo** (móvil / fijo / conmutador), vengan de Apollo, de su webhook o de la cascada (`_shared/phone-latam.ts`).
- **Listas muestra quién encontró cada dato** («vía Prospeo», «vía BetterContact (icypeas)», «verificado con MillionVerifier»), el veredicto («Verificado», «Catch-all», «Riesgoso», «Sin confirmar») y el tipo de teléfono. El modal «Enriquecer contactos» muestra la cascada vigente y sus precios (`enrich-list` `{ action: "providers" }`, que nunca expone keys).

## Arquitectura

```
supabase/functions/_shared/enrichment/
  types.ts          contrato: EnrichProvider, EmailVerifier, LookupResult
  http.ts           fetch JSON con tope de tiempo + utilidades (nombre, dominio, LinkedIn)
  registry.ts       qué proveedores participan y en qué orden (por secrets)
  waterfall.ts      motor: stepWaterfall(state, person, deps) → email/teléfono/esperar
  providers/        un archivo por proveedor de datos
  verifiers/        un archivo por verificador
  enrichment.test.ts
supabase/functions/_shared/phone-latam.ts (+ .test.ts)
```

**Agregar un proveedor = un archivo.** Se escribe `providers/<id>.ts` exportando un `EnrichProvider` (`canLookup`, `start` y, si es asíncrono, `poll`), se agrega a `PROVIDERS` en `registry.ts` y su nombre a `ENRICH_SOURCES` de `js/prospecting.js` (el test falla si falta). El motor no cambia.

### El motor

- Un proveedor se consulta **una vez por lead**, por todos los campos que falten y él sepa buscar (email y teléfono en la misma llamada si faltan los dos).
- **Orden**: por campo, los no-beta con secret, ordenados por `approxUsd`. Con `ENRICH_WATERFALL_ORDER=prospeo,fullenrich,…` manda ese orden para los dos campos, y así se habilitan los beta.
- **Créditos**: el precio de un campo se reserva (`reserveCredits`) la primera vez que se pide y se liquida (`settleReservation`) cuando se resuelve: se cobra si se encontró y se devuelve si se agotó. Sin saldo, no se llama al proveedor.
- **Asíncronos** (FullEnrich, BetterContact): `start` devuelve `pending` y la fila se pospone. `enrich_requested_at` pasa a la hora del próximo sondeo; `claim_enrichment_batch` ahora ignora las filas del futuro (migración `20261017000001`). El estado (proveedores consultados, trabajo, créditos reservados) vive en `prospect_list_members.enrich_waterfall`. Hay un tope de 12 sondeos o 45 minutos por trabajo; después se pasa al siguiente proveedor.
- **Teléfono de Apollo**: llega por `apollo-webhook`. La cascada lo espera hasta 8 minutos y empieza antes si el webhook ya respondió «no disponible».
- **Errores**: nunca detienen la cascada. Una key inválida o sin saldo apaga ese proveedor durante el resto de la invocación. Cada paso queda en `enrich_waterfall.log` mientras la fila corre.
- **Seguridad**: `enrich_waterfall` lleva créditos reservados. Un trigger (`protect_enrich_waterfall`) impide que `authenticated`/`anon` lo escriban; si pudieran, inflarían `reserved` y cobrarían devoluciones de créditos que nunca pagaron. Además, la función acota lo reservado al precio del campo.
- **Re-encolar**: si el usuario vuelve a pedir el enriquecimiento de una fila con una cascada a medias, la cascada anterior se descarta y se devuelve lo reservado (`abandon`). Lo mismo pasa si la fila supera los intentos o si se quitan los secrets.

### Columnas nuevas (`prospect_list_members`, migración `20261017000001`)

| Columna | Qué guarda |
|---|---|
| `source_provider` (JSONB) | `email`, `email_via` (fuente de fondo del agregador), `email_verifier`, `phone`, `phone_via`, `rejected_emails` |
| `email_verification` | `valid` · `invalid` · `catch_all` · `risky` · `unknown` (el `email_status` de Apollo no cambia) |
| `email_verified_at` | cuándo |
| `phone_type` | `mobile` · `landline` · `switchboard` · `unknown` |
| `enrich_waterfall` (JSONB) | estado de la cascada mientras corre (solo service role) |

Mientras la migración no se aplique, `enrich-list` y `apollo-webhook` guardan la fila sin esas columnas (como antes).

## Proveedores (APIs leídas el 2026-10-17)

El proxy de la sesión bloqueaba los sitios de documentación, así que cada adaptador se escribió contra el **código oficial publicado por el proveedor** (SDK, MCP o nodo de n8n) y las páginas de la documentación citadas en su cabecera. Los marcados **beta** tienen partes de la respuesta sin confirmar y solo corren si el dueño los lista en `ENRICH_WATERFALL_ORDER`. **Antes de cargar cada secret en producción, conviene hacer una llamada real** con un lead conocido.

| Id | Proveedor | Campos | Modo | Fuente | Costo aprox. por dato | Secret |
|---|---|---|---|---|---|---|
| `prospeo` | Prospeo `POST /enrich-person` | email, móvil | síncrono | MCP oficial + api-docs | 0.04 / 0.39 USD (1 / 10 créditos; nada si no hay match) | `PROSPEO_API_KEY` |
| `bettercontact` | BetterContact `POST /api/v2/async` → `GET /async/{id}` | email, móvil | asíncrono (5-60 s) | paquete oficial `bettercontact` | 0.05 / 0.49 USD (1 / 10) | `BETTERCONTACT_API_KEY` |
| `fullenrich` | FullEnrich v2 `POST /contact/enrich/bulk` → `GET …/{id}` | email, teléfono | asíncrono (sondeo a 2 min y luego cada 5) | nodo oficial de n8n | 0.055 / 0.55 USD (1 / 10) | `FULLENRICH_API_KEY` |
| `contactout` | ContactOut `GET /v1/people/linkedin` | email, teléfono | síncrono, exige LinkedIn | api.contactout.com | ~0.1 / ~0.6 USD | `CONTACTOUT_API_KEY` (beta) |
| `kaspr` | Kaspr `POST /profile/linkedin` | email, teléfono | síncrono, exige LinkedIn | Stoplight de Kaspr | ~0.08 / ~0.5 USD | `KASPR_API_KEY` (beta) |
| `lusha` | Lusha v3 `POST /v3/contacts/search-and-enrich` | email, teléfono | síncrono | nodo oficial `@lusha-org/n8n-nodes-lusha@1.3.1` | ~0.1 / ~0.5 USD (1 / 5 créditos; sin match no cobra) | `LUSHA_API_KEY` (beta) |

| Id | Verificador | Endpoint | Costo | Secret |
|---|---|---|---|---|
| `millionverifier` | MillionVerifier | `GET /api/v3/?api&email&timeout` (errores con HTTP 200) | ~0.0004–0.004 USD | `MILLIONVERIFIER_API_KEY` |
| `reoon` | Reoon (modo power) | `GET /api/v1/verify?email&key&mode=power` | ~0.001 USD; no cobra `unknown` | `REOON_API_KEY` |
| `zerobounce` | ZeroBounce v2 | `GET /v2/validate?api_key&email` | ~0.004–0.01 USD; no cobra `unknown` | `ZEROBOUNCE_API_KEY` |

Sin `ENRICH_EMAIL_VERIFIER`, se usa el verificador más barato que tenga secret.

**Lusha (v3, beta).** La Person API v2 deja de responder el 2026-11-30, así que el adaptador usa la v3. El request (endpoint, header `api_key`, un identificador por contacto: email, LinkedIn o nombre + dominio) y la envoltura de la respuesta (`results[]` con `clientReferenceId`, `billing.creditsCharged`, 451 por GDPR) salen del nodo oficial de Lusha para n8n y de sus mocks e2e. **Lo que no está verificado es el nombre de los campos revelados dentro de cada resultado**: el nodo oficial devuelve la respuesta sin leerla. El parser acepta `emails`/`emailAddresses` y `phones`/`phoneNumbers`, como texto o como objeto, descarta los teléfonos con `doNotCall`, y si Lusha cobró sin que se pudiera leer nada lo deja en el log de `enrich-list` con las claves que llegaron. Por eso es beta: con la primera llamada real se confirma el parser y se puede sacar de beta.

**Qué fuente de fondo encontró el dato**: BetterContact lo informa (`contact_email_address_provider` / `email_provider`; se leen los dos nombres porque no está confirmado cuál es el vigente). FullEnrich no lo informa.

## Teléfonos latinos (`_shared/phone-latam.ts`)

`normalizePhone(raw, { country, type })` → `{ e164, country, type, extension, valid }`. `pickBestPhone` prefiere móvil > desconocido > fijo > conmutador.

- **México**: 10 dígitos desde 2019. Se quitan el `1` de `+52 1` y los prefijos `044`/`045` (los dos marcan móvil) y `01`. El número no dice si es móvil o fijo: el tipo sale del marcador viejo o del proveedor.
- **Argentina**: un móvil es `+54 9` + área + número. El `15` nacional después del área se quita y se agrega el `9`. Un número nacional sin `15` es fijo. `+54` + 10 dígitos sin `9` es ambiguo (Apollo guarda así muchos móviles): queda «desconocido», salvo que el proveedor diga móvil, en cuyo caso se agrega el `9`.
- **Brasil**: noveno dígito (se agrega a los móviles viejos de 8 dígitos); 0800, 0300 y 400x son conmutador.
- **Colombia**: `3xx` es móvil, `60x` es fijo; el esquema anterior a 2021 se convierte a `60x`; 01 8000 es conmutador.
- **Chile, Perú, Ecuador, Uruguay, Paraguay, Bolivia, Venezuela, Centroamérica, España, NANP**: tabla `COUNTRIES`.
- **Conmutador** también es un número con extensión («ext. 214», «anexo») o uno que el proveedor marca como de la empresa (Apollo `work_hq`).
- Nunca inventa: si el número no calza con el plan del país, `valid=false`.

E.164 es compatible con lo que ya existía: `digits()` y `phoneKey()` de `_shared/wati.ts` quitan el `+` y siguen reconociendo `521…`/`549…` como el mismo contacto.

## Pendiente

- Confirmar con una llamada real los campos de la respuesta de Lusha v3 y sacarlo de beta (también ContactOut y Kaspr).
- Webhook propio para FullEnrich (`webhook_events.contact_finished`) en lugar del sondeo cada 5 minutos, si el volumen lo pide (60 llamadas/min por key).
- Orden de la cascada por cuenta (hoy es de la plataforma, por secret).
- Mirar el teléfono «¿está en WhatsApp?» antes de gastar una plantilla (§4 de la hoja de ruta).
