# Cobro local y factura en Latam (investigación, 2026-10-17)

> **Estado: fase 1, solo investigación.** No cambia código de billing. Cierra la parte de investigación del ítem P2 «Cobro local y CFDI» de `docs/ROADMAP_GTM_OS.md`; la implementación espera a que el dueño elija una opción (§6).
>
> **No es asesoría fiscal ni legal.** Lo marcado con **[contador]** lo tiene que confirmar un contador o abogado del país antes de decidir. Las fuentes son oficiales cuando existen (SAT, DIAN, SII, SUNAT, docs de Stripe); cuando solo había análisis de despachos, se dice. Los datos de Stripe se leyeron en sus páginas públicas el 2026-10-17: lo que está en *preview* puede cambiar, y lo que vale es lo que muestre el Dashboard de la cuenta.

## 1. Resumen

- **Hoy:** Stripe a nombre de la LLC de Wyoming, todo en USD, solo tarjeta (`docs/PRICING.md` §1). `billing` crea Checkout sin `payment_method_types` (métodos dinámicos del Dashboard) y con `tax_id_collection` encendido; `stripe-webhook` ya espera los pagos asíncronos (`checkout.session.async_payment_succeeded`, y la recarga solo se acredita con `payment_status = 'paid'`), así que un medio como OXXO no daría créditos antes de tiempo.
- **Lo que Stripe EE. UU. da sin entidad local:** tarjetas en moneda local en los seis países, **OXXO** (solo pagos únicos, MXN) y **Pix** transfronterizo (preview; suscripciones con Pix desde abril de 2026). **No da:** SPEI, meses sin intereses, Boleto, PSE ni Mercado Pago: esos exigen una cuenta de Stripe del país o un proveedor local.
- **CFDI: una LLC de EE. UU. sin establecimiento en México no puede emitir CFDI** (no tiene RFC de persona moral mexicana ni certificado de sello digital). El cliente mexicano **sí puede deducir** con la factura del extranjero si cumple la regla 2.7.1.14 de la RMF (incluido su RFC), pero el área de compras de una empresa mediana suele pedir CFDI igual.
- **Riesgo que hay que revisar ya:** si el SAT considera a Predictable un «servicio digital» del art. 18-B de la LIVA, la LLC **ya** tendría que estar inscrita en el RFC y cobrando 16 % de IVA desde la primera venta a México, también a empresas **[contador]**.
- **Recomendación (§6):** (A) ahora, sin entidad, dejar la factura de Stripe lista para deducir en México y abrir moneda local, Pix y OXXO para recargas; (B) cuando haya demanda mexicana pagada, **entidad mexicana + Stripe México + un PAC por API** para emitir CFDI 4.0 automáticamente; Brasil y el resto, más adelante.

## 2. Medios de pago y monedas

### 2.1 Stripe con la cuenta de EE. UU.

| País | Tarjeta en moneda local | Medios locales que Stripe EE. UU. acepta | Lo que NO (exige cuenta local u otro proveedor) |
|---|---|---|---|
| México | Sí (MXN) | **OXXO**: Stripe lista a EE. UU. entre las cuentas que lo aceptan; cliente en México, MXN, de 10 a 10,000 MXN, vale de 1 a 7 días, **sin reembolsos ni recurrencia** (no sirve en Checkout `subscription`) | **SPEI** (transferencias de México: solo cuentas MX), **meses sin intereses** (solo cuentas de Stripe México, tarjetas de crédito mexicanas, no corporativas), Mercado Pago |
| Brasil | Sí (BRL) | **Pix** transfronterizo para vendedores de EE. UU. (*public preview* desde 2025-04-30; también vía Link y la alianza con EBANX). Pix recurrente (Pix Automático) en suscripciones desde 2026-04-22 | **Boleto** (solo cuentas BR), cuotas brasileñas |
| Colombia | Sí (COP) | — | PSE, Nequi, efectivo |
| Chile | Sí (CLP, sin decimales) | — | Webpay/transferencias |
| Perú | Sí (PEN) | — | Yape, PagoEfectivo |
| Argentina | Sí (ARS, con mucha conversión y percepciones al tarjetahabiente) | — | Mercado Pago, transferencias |

Notas:
- Cobrar en moneda local con liquidación en USD tiene un recargo por conversión además del de tarjeta internacional (ver la página de precios de Stripe). `docs/PRICING.md` §4 ya supone ~5.1 % + 0.30 USD.
- Para mostrar MXN/BRL hay dos caminos: precios con `currency_options` o *Adaptive Pricing* de Checkout. **OXXO y Pix exigen que el cobro sea en MXN y BRL**, no en USD: con los precios actuales en USD no aparecen aunque se enciendan.
- OXXO excluye algunas categorías («Direct Marketing – Subscription», entre otras); hay que confirmar con Stripe que la categoría de la cuenta lo permite.
- **Stripe Managed Payments** (Stripe como *merchant of record*) está en *private preview* y no menciona CFDI; no resuelve México.

### 2.2 Complementos

| Proveedor | Qué aporta | Qué no |
|---|---|---|
| **dLocal** | Cobro local sin entidad en el país (Pix y Pix Automático —es iniciador de pagos certificado en Brasil—, SPEI, OXXO, PSE, tarjetas locales con cuotas) con liquidación en USD a la LLC. Pensado para suscripciones digitales | No emite la factura fiscal local; precios por cotización |
| **EBANX** | Igual: adquirencia local en 17 países sin entidad, Pix recurrente, medios alternativos recurrentes en BR, MX, CL, AR y UY (CO en 2026); se integra con Stripe para Pix. Exige el documento fiscal del pagador en CO, BR, CL y AR | Tampoco emite factura local; precios por cotización |
| **Mercado Pago** | El medio que más usa el comprador; suscripciones | **Cuenta por país y atada a una entidad local** (en México es Institución de Pago Electrónico regulada por la CNBV): sirve después de tener entidad, no antes **[confirmar con Mercado Pago]** |

**Conclusión de pagos:** con Stripe EE. UU. se cubre lo que más pesa en B2B (tarjeta corporativa en moneda local + Pix + OXXO para recargas). dLocal o EBANX solo valen la pena si el volumen en Brasil o Colombia lo justifica: agregan un segundo proveedor que da créditos (ver §5) y no resuelven la factura.

## 3. México: CFDI e IVA

### 3.1 ¿La LLC puede emitir CFDI?

**No.** Para timbrar un CFDI 4.0 se necesita RFC, certificado de sello digital (CSD) y un PAC. Un residente en el extranjero **sin** establecimiento permanente no tramita CSD, así que no emite CFDI. Si tuviera establecimiento permanente sí estaría obligado a emitirlo (y tributaría ISR en México).

Hay un régimen especial (Título III, Capítulo III Bis de la LIVA) para extranjeros que dan **servicios digitales**: se inscriben en el RFC con la ficha 1/PLT (gratis), nombran representante legal y domicilio en México, cobran el IVA y emiten **comprobantes en PDF** con el IVA por separado a quien los pida (regla 12.1.4 de la RMF). **Ese comprobante no es un CFDI.**

### 3.2 Lo que el cliente mexicano puede hacer hoy sin CFDI

- **Deducir con la factura extranjera** si cumple la **regla 2.7.1.14 de la RMF**: nombre, domicilio y número fiscal del emisor; lugar y fecha; **RFC del receptor** (obligatorio desde 2022); descripción, cantidad e importe. Si falta un dato, no es deducible aunque haya transferencia.
- **IVA:** si Predictable NO es servicio digital del 18-B, el cliente lo trata como **importación de servicios** (art. 24 LIVA) y acredita el IVA en la misma declaración («IVA virtual», art. 50 del Reglamento). Si SÍ lo es, el IVA lo cobra el extranjero inscrito y el cliente lo acredita con el comprobante del 18-D.
- **ISR:** hay que confirmar que el SAT no vea parte del pago como **regalía** (uso de software o información), porque eso exigiría retener ISR al pagar (con el tratado México–EE. UU., tasa reducida) **[contador]**.

### 3.3 La pregunta del 18-B

El art. 18-B enumera los servicios digitales gravados (fracción I: «descarga o acceso a imágenes, películas, texto, información, video…», entre otras). Un SaaS de inteligencia comercial con datos de empresas y contactos puede leerse como «acceso a información». No encontramos un criterio del SAT que lo cierre para SaaS B2B **[contador]**:

- **Si aplica:** la obligación nace con la **primera venta a un receptor en México, sin umbral**, e incluye B2B. Stripe Tax lo describe igual (inscripción en 30 días). Si ya hay clientes mexicanos, puede haber atraso.
- **Si no aplica:** no hay que inscribirse; el cliente hace la importación de servicios.

### 3.4 Lo que exige un CFDI de verdad

Entidad mexicana (S. de R.L. de C.V. o S.A.P.I. de C.V.) → RFC, e.firma (presencial) y CSD → contador que lleve contabilidad electrónica y declaraciones → **PAC** que timbre por API. Para emitir cada CFDI hay que pedirle al cliente RFC, razón social exacta, régimen fiscal, código postal y uso del CFDI; a quien no lo dé, factura global a «público en general».

Costos y plazos orientativos (despachos y notarías, no oficiales; pedir cotización):

| Concepto | Rango |
|---|---|
| Constitución con notario + Registro Público | 20,000–40,000 MXN en un paquete básico; 70,000–160,000 MXN con asesoría legal y traducciones |
| Capital social | desde 3,000 MXN (en la práctica ~10,000) |
| RFC y e.firma | gratis; e.firma con cita presencial del representante legal |
| Plazo | de semanas a 3–5 meses, según notaría, socios extranjeros (FM/visa) y apertura de la cuenta bancaria |
| Contador mensual | **[cotizar]** (depende del volumen de CFDI y nómina) |
| PAC por API (Facturapi, Facturama, etc.) | **[cotizar]**: plan por volumen de timbres |

Implicaciones que decide el dueño con su contador: precios de transferencia entre la entidad mexicana y la LLC (quién vende a quién y con qué margen), ISR mexicano sobre la utilidad de la entidad, PTU si tiene empleados, y si los clientes mexicanos se migran a la entidad nueva.

### 3.5 Atajo: un revendedor que ya tiene RFC

Una empresa mexicana (socio, agencia o una entidad de Vanarsi si ya existe en México **[dueño]**) compra a la LLC y revende, emitiendo el CFDI. Sirve sobre todo para **Growth**, que ya se da de alta a mano (`subscriptions.provider = 'manual'`): no toca Stripe ni el código. Contra: el margen y el contrato pasan por un tercero, y la importación de servicios queda en el revendedor.

Un *merchant of record* mexicano para SaaS que emita CFDI no apareció en la investigación (los que lo hacen son de bienes físicos, p. ej. Cubbo; Paddle no publica que emita CFDI) **[confirmar con proveedores]**.

## 4. Otros países (corto)

| País | Factura electrónica | ¿La LLC puede emitirla? | Qué pasa con el cliente empresa |
|---|---|---|---|
| **Colombia** (DIAN) | Factura electrónica de venta | No, y **no está obligada**: el art. 437 par. 2 del Estatuto Tributario exime al prestador extranjero de servicios digitales | IVA 19 %: el cliente responsable de IVA practica **retención asumida del 100 %** (art. 437-2 num. 3). Ojo: la DIAN (Concepto 001932 de 2025) dice que la factura extranjera o el extracto **no bastan como soporte** de costos; el soporte es el **documento soporte electrónico** que emite el propio cliente. **Presencia económica significativa** (art. 20-3 ET, desde 2024): ingresos de servicios digitales a Colombia pueden tributar renta (3 % sobre ingresos brutos declarando, o retención del 10 %) por encima del umbral **[contador]** |
| **Chile** (SII) | DTE (factura electrónica) | No. El régimen simplificado (Ley 21.210, art. 8 n DL 825, 19 %) es para ventas a **consumidores**; a empresa no obliga al extranjero | La empresa contribuyente declara el IVA de la operación en el F29 y evalúa si es crédito fiscal **[contador]** |
| **Perú** (SUNAT) | Comprobante electrónico | No. Desde el D. Leg. 1623 (registro: RS 000173-2024/SUNAT) el no domiciliado cobra IGV 18 % solo a **personas naturales sin negocio** | La empresa domiciliada es la contribuyente del IGV por **utilización de servicios** y retiene renta de no domiciliado según el caso **[contador]** |
| **Brasil** | NF-e / NFS-e (y la reforma CBS/IBS desde 2026) | No: sin CNPJ no hay nota fiscal | Importar el servicio le cuesta al cliente IRRF, CIDE (10 %), PIS/COFINS-Importação (9.25 %), ISS e IOF; en 2026 se suman CBS 0.9 % e IBS 0.1 % de prueba y desde 2027 CBS reemplaza a PIS/COFINS. La reforma prevé un registro simplificado para extranjeros. **Es la mayor fricción de la región**: el cliente empresa paga mucho encima del precio. Solución real: entidad brasileña o revendedor local |
| **Argentina** (ARCA) | Factura electrónica | No | Para un responsable inscripto es **importación de servicios** (el IVA 21 % lo ingresa el cliente sobre la factura extranjera); la percepción en tarjeta (RG 4240/2018) apunta al consumidor final **[contador]** |

**Lectura:** fuera de México, la factura del extranjero + el mecanismo de cada país (retención asumida, utilización de servicios, importación) es la norma para B2B, y ningún país obliga a la LLC a emitir su factura electrónica a una empresa. Lo que sí piden siempre es que la factura de Stripe traiga **el número fiscal del cliente** (NIT, RUT, RUC, CNPJ, CUIT).

## 5. Cómo encajaría en el código (para la fase 2)

Nada de esto está construido. Reglas para cuando se haga:

- **`stripe-webhook` sigue siendo lo único que da créditos pagados por Stripe.** Un segundo proveedor (dLocal/EBANX/Mercado Pago) necesitaría su propio webhook firmado, idempotente con la misma tabla `billing_events` (o una equivalente) y las mismas RPC `billing_*` de service role; hay que registrarlo en `docs/DECISIONS.md` porque amplía esa regla. Nada de pasarelas simuladas (`mock_purchase_credits` se eliminó a propósito).
- **Medios asíncronos** (OXXO, Pix, SPEI): ya se acreditan solo al confirmarse el pago; falta mostrar en la UI «Pago pendiente» mientras el vale está abierto.
- **CFDI = efecto posterior al cobro, nunca condición para dar créditos:** una tabla de salida (`cfdi_outbox`, una fila por `invoice.id` o `checkout.session.id`, única) que llena `stripe-webhook` y vacía una función `cfdi-issue` que llama al PAC con reintentos; el XML/PDF se guarda en un bucket privado y se ofrece en el portal. Si el PAC falla, el cliente ya tiene sus créditos y la factura sale en el reintento.
- **Datos fiscales del cliente** (RFC, razón social, régimen, CP, uso del CFDI): formulario en Ajustes → Facturación; el PAC valida contra la lista del SAT. Sin datos completos → factura global, nunca datos inventados.
- **Precios en moneda local:** `currency_options` en los precios de Stripe (mismo `price_id`, así `billing-plans.ts` no cambia) o Adaptive Pricing; hay que revisar que `billing_grant_plan_credits` no dependa del monto en USD.

## 6. Recomendación y qué decide el dueño

### Fase A — ahora, sin entidad (1–2 semanas de trabajo, sin costo fijo)

1. **Factura de Stripe deducible en Latam:** mostrar el número fiscal del cliente (Stripe ya recoge `tax_id`; tipos como `mx_rfc`, `co_nit`, `cl_tin`, `pe_ruc`, `br_cnpj`, `ar_cuit`), con el domicilio de la LLC y el desglose que pide la regla 2.7.1.14. Es el cambio más barato y resuelve la deducción en México y el soporte en el resto.
2. **Moneda local** (MXN, BRL, COP, CLP, PEN) en Checkout para subir la aprobación de tarjetas corporativas.
3. **OXXO para recargas** (pago único, ≤ 10,000 MXN: el paquete de 5,000 créditos ronda 6,500 MXN) y **Pix** si el Dashboard lo ofrece en la cuenta (también en suscripciones).
4. **Respuesta del contador sobre el 18-B** antes de vender más en México. Si aplica, inscribir la LLC (ficha 1/PLT), cobrar 16 % con Stripe Tax y emitir el comprobante del 18-D. Eso **no** es CFDI, pero el cliente acredita el IVA.

### Fase B — cuando haya demanda mexicana pagada (2–4 meses, costo fijo mensual)

**Entidad mexicana + cuenta de Stripe México + PAC por API.** Da CFDI 4.0 automático en cada `invoice.paid`, liquidación en MXN, SPEI, OXXO y meses sin intereses en la misma integración de Stripe (otra cuenta, mismo código con la llave de la cuenta MX). Mercado Pago, después, sobre esa entidad. Mientras tanto, los clientes Growth que exijan CFDI pueden pasar por un **revendedor con RFC** (§3.5).

### Después

Brasil (entidad o revendedor; por la carga de la importación de servicios, no vale con Pix solo) cuando el portugués esté listo (`docs/ROADMAP_GTM_OS.md` §4). dLocal o EBANX solo si Colombia o Brasil muestran volumen que la tarjeta no aprueba.

### Decisiones del dueño

| Decisión | Opciones | Con quién |
|---|---|---|
| ¿Predictable es «servicio digital» del 18-B? ¿Hay que inscribir la LLC en el RFC ya? | Sí (inscribir y cobrar IVA) / No (importación de servicios del cliente) | Contador mexicano |
| ¿Se hace la Fase A? | Sí / No | Dueño |
| Vehículo para CFDI | Entidad mexicana propia / revendedor con RFC / ¿Vanarsi ya tiene entidad en México? | Dueño + abogado + contador |
| Precios de transferencia LLC ↔ entidad MX | Modelo de revendedor, de comisionista o de licencia | Contador |
| PAC | Facturapi, Facturama u otro (precio por timbre, API, complemento de pagos) | Dueño (cotizar) |
| Segundo proveedor de pagos | Ninguno por ahora / dLocal / EBANX | Dueño (cotizar) |
| Colombia: presencia económica significativa | Revisar el umbral contra los ingresos colombianos | Contador colombiano |

## 7. Fuentes

Oficiales:
- LIVA (texto vigente), Cámara de Diputados: https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf
- SAT, art. 18-B LIVA: https://www.sat.gob.mx/minisitio/EstimulosFiscalesFronteraNorteSur/region_fronteriza_sur_iva/documentos/Articulo_18BLIVA.pdf
- SAT, reglas de la RMF y Anexo 1-A para servicios digitales (ficha 1/PLT, regla 12.1.4): http://omawww.sat.gob.mx/plataformastecnologicas/Paginas/PlataformasTecnologicas_ServiciosDigitales/documentos/23Reglas_de_RMF_yAnexo1A_sobre_plataformas_tecnologicas.pdf
- SAT, disposiciones fiscales para plataformas (inscripción en 30 días): http://omawww.sat.gob.mx/plataformastecnologicas/Paginas/PlataformasTecnologicas_Intermediacion/documentos/DisposicionesFiscales_intermediacion.pdf
- DIAN, Oficio 913886 de 2021: https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_913886_2021.htm
- SII, preguntas frecuentes de IVA a servicios digitales: https://www.sii.cl/preguntas_frecuentes/iva_serv_digitales/001_200_7767.htm y presentación de 2026: https://www.sii.cl/noticias/2026/PPTIVASD08062026_2.pdf
- SUNAT, Ley del IGV: https://www.sunat.gob.pe/legislacion/igv/ley/capitul12.pdf
- Stripe — OXXO: https://docs.stripe.com/payments/oxxo · Boleto: https://docs.stripe.com/payments/boleto · Transferencias de México: https://docs.stripe.com/payments/bank-transfers · Meses sin intereses: https://docs.stripe.com/payments/mx-installments · Pix transfronterizo (preview): https://docs.stripe.com/changelog/basil/2025-04-30/pix_cross_border_in_public_preview · Pix recurrente: https://docs.stripe.com/changelog/dahlia/2026-04-22/pix-recurring-payments-support · Monedas: https://docs.stripe.com/currencies · Stripe Tax México: https://docs.stripe.com/tax/supported-countries/latin-america/mexico · Colombia: https://docs.stripe.com/tax/supported-countries/latin-america/colombia · Managed Payments: https://docs.stripe.com/payments/managed-payments
- dLocal, guía de suscripciones en Latam: https://www.dlocal.com/es/blog/guias/subscription-approval-latin-america-local-payment-methods/
- EBANX + Stripe (Pix): https://business.ebanx.com/en/press-room/press-releases/stripe-users-can-now-accept-pix-in-brazil-via-ebanx

Análisis de despachos y prensa especializada (no son norma; se usaron para orientarse):
- Regla 2.7.1.14 (Russell Bedford): https://russellbedford.mx/fiscal/conoce-los-requisitos-para-deducir-comprobantes-emitidos-por-residentes-el-extranjero-regla-2-7-1-14-de-la-rmf/
- IVA virtual en importación de servicios (AMCP): https://amcpdf.org.mx/tratamiento-fiscal-del-iva-virtual-en-la-importacion-de-bienes-y-servicios-intangibles-y-lo-declarado-al-sat-nuevo-aplicativo-de-iva/
- Colombia, IVA y factura de servicios del exterior (Asuntos Legales): https://www.asuntoslegales.com.co/analisis/sebastian-rodriguez-bravo-510921/servicios-prestados-desde-el-exterior-iva-y-facturacion-3600806 · Presencia económica significativa (Holland & Knight, 2026): https://www.hklaw.com/en/insights/publications/2026/01/revision-del-regimen-presencia-economica-significativa-en-colombia
- Perú, D. Leg. 1623 y registro (Orbitax): https://wpqa.orbitax.com/taxhub/news/country/article/Peru-Establishes-Registration--56591
- Brasil, importación de servicios y reforma (IBDT): https://congresso.ibdt.org.br/wp-content/uploads/2025/06/Ricardo-Maito.pdf · (Planning): https://planning.com.br/importacao-reforma-tributaria-ibs-cbs/
- Argentina, servicios digitales (Marval): https://www.marval.com/Publicacion/tratamiento-impositivo-de-los-servicios-digitales-13177
- Constitución de sociedades en México, costos (orientativo): https://abogadosencdmx.com/blog/constituir-empresa-mexico-2026/
