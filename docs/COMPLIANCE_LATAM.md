# Cumplimiento en Latam: registros "no llamar" y protección de datos

> **Referencia factual para el equipo de producto e ingeniería, no asesoría legal.** Resume lo que dicen las fuentes oficiales al 2026-10-17 sobre prospección B2B por email (Apollo), WhatsApp (plantillas de WATI), LinkedIn (Dripify) y teléfono (dialer, próximamente). Antes de prometerle algo a un cliente, valídalo con abogados del país.
>
> **Cómo se armó:** búsquedas web acotadas a dominios oficiales (gob.mx, crcom.gov.co, argentina.gob.ar, sernac.cl, bcn.cl, gov.br, gob.pe, sic.gov.co, etc.). Desde este entorno no se pudo abrir cada PDF entero, así que algunos datos salen del extracto de la página oficial indexada. Lo que no quedó confirmado en una fuente oficial dice **«no confirmado en fuente oficial»**. Nada de lo marcado así debe convertirse en regla del producto sin verificarlo antes.

---

## Parte 1. Registros "no llamar"

### Resumen

| País | Registro (operador) | Cómo lo consulta una empresa | Costo | Cada cuánto | Canales | ¿B2B / número corporativo? |
|---|---|---|---|---|---|---|
| México | **REPEP** (PROFECO) | Cuenta de proveedor en repep.profeco.gob.mx, compra de listas por zona y **descarga** del archivo | De pago: suscripción semestral o anual por región | PROFECO actualiza las listas cada **15 días**; un número inscrito queda protegido a los **30 días** | Llamadas y SMS publicitarios | Pensado para consumidores; no confirmado en fuente oficial si una línea de empresa puede inscribirse |
| México (financiero) | **REUS** (CONDUSEF) | Consulta obligatoria **solo para instituciones financieras** | — | Inscripción vigente 2 años; efecto a los ~45 días | Teléfono y **correo electrónico** | Usuarios de servicios financieros |
| Colombia | **RNE**, Registro de Números Excluidos (CRC) | Registro de empresa en el Portal de Trámites CRC; consulta 1 a 1, **masiva (hasta 10.000 registros)** o **web service** (token de 6 meses) | Gratis | La exclusión rige desde el **día hábil siguiente**; no confirmado en fuente oficial cuánto vale un resultado | **SMS, mensajería por apps (WhatsApp), email y llamadas**, por canal | La CRC dice que consulta *toda* persona natural o jurídica que contacte con fines comerciales; no hay exclusión B2B expresa |
| Argentina | **Registro Nacional "No Llame"** (AAIP) | **API de consultas automatizadas** (con credenciales de la AAIP) o consulta uno a uno en nollame.aaip.gob.ar; antes, descarga .txt con constancia y hash | Sin costo confirmado | **Al menos cada 30 días corridos** y antes de contactar | Telefonía "en cualquiera de sus modalidades" (fija y móvil); SMS y apps no confirmados en fuente oficial | Pueden inscribirse titulares de líneas; no confirmado en fuente oficial si incluye personas jurídicas |
| Chile | **"No Molestar"** (SERNAC) | Inscripción **voluntaria** en el Portal del Proveedor; el SERNAC avisa por email al día hábil siguiente | Gratis | Revisar **antes de cada campaña**; la solicitud rige **desde que se hace** | Toda comunicación promocional: email, llamadas, mensajería, correo postal | Ley del consumidor; aplica a consumidores |
| Brasil | **"Não Me Perturbe"** (autorregulación de telecom y bancos, por mandato de Anatel) | **Solo empresas adheridas** (operadoras de telecom e instituciones financieras de crédito consignado) | — | Bloqueo efectivo en **hasta 30 días** | Ofertas de telecom y de consignado | No aplica a un SaaS B2B; ver listas estatales de Procon |
| Brasil (SP) | **Cadastro de bloqueio de telemarketing** (Procon-SP, Ley estadual 13.226/2008) | Registro de la empresa en Procon-SP para **acceder a la lista** (solo números) | No confirmado | Prohibido llamar **desde el día 30** de la inscripción | Llamadas; material de 2021 del Procon-SP incluye SMS y apps | Consumidores con línea registrada en SP |
| Perú | **"Gracias… no insista"** (INDECOPI): **ya no existe** | No hay lista: desde 2018 rige **consentimiento previo** para llamadas y mensajes promocionales | — | — | Llamadas, SMS, mensajes electrónicos, call centers | Código del Consumidor: consumidores |

**Para el producto:** la conclusión de fondo es que **ningún registro se "scrapea"**. En México, Colombia y Argentina la empresa obligada se registra ella misma y descarga o consulta. Predictable solo puede recibir el archivo que el cliente bajó (o, a futuro, usar las credenciales de API del propio cliente, como en Argentina o Colombia).

---

### 1.1 México: REPEP (PROFECO) y REUS (CONDUSEF)

**Base legal.** La [Ley Federal de Protección al Consumidor](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf) (LFPC) dice:
- **art. 17**: la publicidad que se envía debe identificar al proveedor (nombre, domicilio, teléfono o email) y ofrecer cómo dejar de recibirla.
- **art. 18**: crea el registro de consumidores que no quieren publicidad.
- **art. 18 BIS**: prohíbe enviar publicidad a quien la rechazó expresamente o está inscrito en el registro.
- **art. 127**: sanciona las infracciones a los arts. 17 y 18 BIS.

**Qué cubre.** Llamadas y **mensajes de texto** publicitarios a números fijos y celulares ([PROFECO, REPEP](https://repep.profeco.gob.mx/); [Líbrate de las llamadas y mensajes molestos](https://www.gob.mx/profeco/documentos/librate-de-las-llamadas-y-mensajes-molestos-de-publicidad?state=published)).
- Sectores: telecomunicaciones, turismo y comercio.
- No cubre cobranza, partidos políticos, beneficencia ni encuestas ([¿Qué es el REPEP?](https://www.profeco.gob.mx/servicios/repeb.asp)).
- WhatsApp y email: **no confirmado en fuente oficial**. El texto de PROFECO habla de "llamadas y mensajes de texto".

**Quién se inscribe.** El usuario de la línea. La inscripción es gratuita y "surte efectos a los 30 días naturales siguientes" ([FAQ REPEP](https://repep.profeco.gob.mx/preguntasfrecuentes.jsp)). En la [página de denuncias](https://repep.profeco.gob.mx/Denunciar.jsp), la denuncia no procede antes de 30 días hábiles desde la inscripción. Si una persona moral puede inscribir una línea corporativa: **no confirmado en fuente oficial**. Todo el registro está planteado como protección al consumidor.

**Cómo accede una empresa** ([FAQ REPEP](https://repep.profeco.gob.mx/preguntasfrecuentes.jsp), [ficha CONAMER PROFECO-00-019](https://catalogonacional.gob.mx/FichaTramite?traHomoclave=PROFECO-00-019), [Descargas](https://repep.profeco.gob.mx/Descargas.jsp)):
1. Crea una cuenta en la pestaña *Proveedores* de repep.profeco.gob.mx.
2. Elige las listas por región o estado y la vigencia: **semestral o anual**.
3. Genera la orden de compra, paga y espera a que PROFECO valide el pago.
4. Descarga las listas con usuario y clave. PROFECO las **actualiza cada 15 días**, así que conviene descargarlas cada quincena.

Otros datos del acceso:
- **Costo:** la tabla de la FAQ trae montos en MXN por región, por ejemplo la CDMX y su área metropolitana o toda la República. Las cifras varían entre páginas del mismo sitio, así que hay que verificar la tarifa vigente en el portal.
- **Uso:** las listas solo pueden usarse para no contactar a esos números.
- **Cambio de 2024:** desde el 1-feb-2024 PROFECO cambió la forma de consultar las listas y pidió volver a descargarlas.
- **Formato del archivo** (TXT o CSV): **no confirmado en fuente oficial**.
- **Consulta de un número suelto por API:** no se encontró en fuente oficial.

**Excepción.** Se puede llamar a un número inscrito si ese consumidor dio **consentimiento expreso a ese proveedor** ([FAQ](https://repep.profeco.gob.mx/preguntasfrecuentes.jsp)).

**Sanciones.**
- [PROFECO, Sanciones](https://repep.profeco.gob.mx/Sanciones.jsp) cita multas de "$411.61 a $1'317,141.34" MXN por llamada a un número inscrito, y responden tanto el proveedor como la empresa por la que se oferta (por ejemplo, un call center).
- Los montos del art. 127 LFPC se actualizan cada año por acuerdo en el DOF. El último acuerdo encontrado (dic-2021) daba de $623.48 a $1'995,137.95. Hay que verificar el monto de 2026.

**REUS (CONDUSEF).** Es el registro equivalente para **publicidad de instituciones financieras**. Permite inscribir **teléfono y correo electrónico** ([CONDUSEF, ¿Sabes qué es el REUS?](https://www.condusef.gob.mx/?p=contenido&idc=2158&idcat=3); [Reglas del REUS](https://www.condusef.gob.mx/documentos/marco_legal/Reglas_del_Registro_Publico_de_Usuarios.pdf); [trámite CONDUSEF-00-014-E](https://www.gob.mx/public/tramites/detalleTramite.xhtml?homoclave=CONDUSEF-00-014-E)).
- La inscripción dura **2 años** y empieza a contar 45 días después de registrarse.
- La consulta solo es obligatoria para entidades financieras. Solo importa si un cliente de Predictable es una institución financiera mexicana.

**Notas B2B.** Cuando el contacto es un empleado de otra empresa en su número laboral, el REPEP no lo excluye de forma expresa. Tampoco lo incluye de forma expresa: **no confirmado**. Lo prudente es aplicar la lista a todo número mexicano antes de llamar o enviar SMS.

### 1.2 Colombia: RNE (CRC) y Ley 2300 de 2023 «Dejen de fregar»

**Base legal.** La [Ley 2300 de 2023](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=213990) ([texto en el Senado](http://www.secretariasenado.gov.co/senado/basedoc/ley_2300_2023.html)) es la ley que protege el derecho a la intimidad de los consumidores.
- Restringe canales, horarios y periodicidad de la cobranza.
- Su **art. 5** extiende esas reglas a los contactos **comerciales y publicitarios** y ordenó a la CRC adaptar el RNE.
- La CRC lo hizo con la [Resolución CRC 7356 de 2024](https://www.crcom.gov.co/sites/default/files/normatividad/00007356.pdf), que modificó la Res. 5050 de 2016. El nuevo RNE funciona desde el **10-abr-2024** ([comunicado CRC](https://www.crcom.gov.co/es/noticias/comunicado-prensa/partir-10-abril-colombianos-podran-inscribirse-para-evitar-recepcion)).

**Qué cubre.** El consumidor se excluye **por canal**: **SMS, mensajería por aplicaciones o web (WhatsApp), correo electrónico y llamadas** ([ABC del RNE](https://www.crcom.gov.co/sites/default/files/webcrc/documents/2024-05/ABC-ACTUALIZACION-REGISTRO-NUMEROS-EXCLUIDOS-220524.pdf)). El resultado de una consulta solo dice si la persona se excluyó o no de cada canal.

**Excepciones.** Mensajes necesarios para el servicio, confirmación de operaciones monetarias y alertas de fraude.

**Horarios para cualquier contacto comercial** (Ley 2300; [cartilla citada por la CRC](https://www.crcom.gov.co/sites/default/files/normatividad/2024515327.pdf)):
- Lunes a viernes de **7:00 a 19:00** y sábados de **8:00 a 15:00**. Nunca domingos ni festivos.
- Después de un contacto directo, **no más de una vez al día** ni por varios canales en la misma semana.
- Solo por los canales que el consumidor autorizó.

Esto le pega directo al motor de cadencias: limita el horario de envío y cuántos canales se usan por semana.

**Quién consulta y cómo** ([consulta CRC 2024531261](https://www.crcom.gov.co/sites/default/files/normatividad/2024531261.pdf), [2024537298](https://www.crcom.gov.co/sites/default/files/normatividad/2024537298.pdf)):
- Deben consultar los productores y proveedores de bienes y servicios (PBS), los proveedores de contenidos (PCA) y los integradores tecnológicos (IT). Según la CRC, también "todas las personas naturales y jurídicas" que contacten con fines comerciales.
- Primero se hace el *Registro de Empresa* en el Portal de Trámites CRC.
- Hay tres modalidades:
  - **Consulta Básica**, uno a uno.
  - **Consulta Masiva**, de hasta **10.000 registros** de teléfono y email.
  - **Web service**, con un token de conexión que vale **6 meses**. Acepta unos 500.000 teléfonos o 200.000 emails por petición.
- **Gratis** para usuarios y empresas.

Puntos abiertos:
- Archivo plano por SFTP: lo pidió la industria y **no está confirmado que exista** ([respuesta a comentarios](https://www.crcom.gov.co/system/files/Biblioteca%20Virtual/Documento%20de%20respuesta%20a%20comentarios%20-%20Actualizaci%C3%B3n%20del%20RNE/Documento-respuesta-comentarios-RNE-120424.pdf)).
- La CRC **no publica una descarga de la base completa**: se consulta lo que uno ya tiene.

**Vigencia y refresco.**
- La inscripción o la baja rige desde el **día hábil siguiente**.
- Los 5 días hábiles que a veces se citan aplican solo al bloqueo de SMS por código corto que hacen operadores e integradores.
- Cada cuánto debe re-consultar una empresa, o cuánto vale un resultado: **no confirmado en fuente oficial**. Lo prudente es consultar justo antes de cada envío o lote.

**B2B.** No hay exclusión B2B expresa. El registro habla de "consumidores y usuarios" ([concepto 513485 de 2024](https://normograma.crcom.gov.co/crc/compilacion/docs/concepto_crc_0513485_2024.htm)). Quién se considera consumidor en una venta B2B es materia de la Ley 1480 y **no queda resuelto en fuente oficial**.

**Sanciones.** El art. 9 de la Ley 2300 remite a la SIC y a la Superintendencia Financiera con las facultades de la Ley 1266 de 2008. La SIC tiene la vigilancia ([concepto CRC 506667 de 2025](https://normograma.crcom.gov.co/crc/compilacion/docs/concepto_crc_0506667_2025.htm)). El tope exacto aplicable no quedó confirmado en fuente oficial.

### 1.3 Argentina: Registro Nacional "No Llame" (AAIP)

**Base legal.**
- [Ley 26.951](https://www.argentina.gob.ar/normativa/nacional/ley-26951-233066/texto) protege a "titulares o usuarios autorizados de los servicios de telefonía, en cualquiera de sus modalidades".
- [Decreto 2501/2014](https://www.argentina.gob.ar/normativa/nacional/240407/texto) la reglamenta. Permite sumar nuevas tecnologías compatibles y exige llamar con un número visible y guardar el registro de llamadas salientes.
- [Disposición DNPDP 3/2015](https://www.argentina.gob.ar/normativa/nacional/norma-241100/texto) fija el procedimiento de descarga.
- [Resolución AAIP 126/2024](https://www.argentina.gob.ar/normativa/nacional/norma-399750/texto) actualiza el procedimiento y las sanciones.

**Qué cubre.** Telefonía fija y móvil.
- SMS, WhatsApp y email: **no confirmado en fuente oficial**. La ley se define por "servicios de telefonía" y el email no aparece. Los mensajes publicitarios por email entran en el art. 27 de la Ley 25.326 (ver Parte 2).
- Excepciones (art. 3): bien público, emergencias, campañas electorales y quien tiene una **relación contractual vigente** con la persona, si llama por el objeto de ese contrato.

**Obligación de consulta.** Quien hace publicidad telefónica debe consultar el registro **antes del contacto y al menos cada 30 días corridos** ([art. 7 de la ley, Res. AAIP 234/2019](https://www.argentina.gob.ar/sites/default/files/rs-2019-234-apn-aaip.pdf)).

**Cómo accede una empresa.**
- Hoy:
  - Por **API de consultas automatizadas**: se pide en Trámites a Distancia ("Consultas automatizadas a servicios (API) de la AAIP"). Exige tener inscripta en el **Registro Nacional de Bases de Datos** una base llamada "publicidad" ([Solicitar acceso](https://www.argentina.gob.ar/servicio/solicitar-acceso-al-sistema-de-consultas-automatizadas-del-registro-nacional-no-llame)).
  - O consulta **uno a uno** en nollame.aaip.gob.ar ([Res. 126/2024](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-126-2024-399750/actualizacion)).
- Antes (Disp. 3/2015): **descarga de la lista completa en .txt** con una constancia PDF con fecha, hora y hash, para usuarios habilitados. Si esa descarga sigue activa en 2026: **no confirmado en fuente oficial**.
- Costo: no se encontró arancel en fuente oficial.

**Sanciones** (Res. AAIP 126/2024, común a Ley 25.326 y 26.951):

| Infracción | Sanción |
|---|---|
| Leve | Hasta 2 apercibimientos y/o multa de $1.000 a $80.000 |
| Grave | Hasta 4 apercibimientos, suspensión de 1 a 30 días y/o multa de $80.001 a $90.000 |
| Muy grave | Hasta 6 apercibimientos, suspensión de 31 a 365 días, clausura y/o multa de $90.001 a $100.000 |

- Si una conducta junta varias multas, el **tope es el máximo de la escala × 500**.
- Pagar dentro de 20 días hábiles reduce la multa un **50 %**.
- Hay sanciones públicas a empresas: [más denunciadas 2024](https://www.argentina.gob.ar/aaip/empresas-mas-sancionadas-registro-no-llame), [ADT 2024](https://www.argentina.gob.ar/sites/default/files/rs-2024-45-apn-aaip.pdf).

**B2B.** Se inscriben los titulares o usuarios de líneas. Si una persona jurídica puede inscribir su línea: **no confirmado en fuente oficial**. La AAIP recuerda que, además del registro, hay que respetar el **bloqueo individual** del art. 27 inc. 3 de la Ley 25.326.

### 1.4 Chile: "No Molestar" (SERNAC)

**Base legal.** Art. 28 B de la Ley 19.496 ([SERNAC Jurídico, art. 28 B](https://www.sernac.cl/portal/609/w3-propertyvalue-58918.html)):
- **Email:** todo mensaje promocional debe indicar el asunto, la identidad del remitente y una **dirección válida para pedir la suspensión**. Desde que se pide, el envío queda prohibido.
- **Llamadas, mensajería telefónica, fax y correo postal:** el proveedor debe dar una forma **expedita** de pedir la suspensión.
- Es un régimen de **opt-out**, no de consentimiento previo.
- Qué cambió exactamente la Ley 21.398 (Pro Consumidor) en el 28 B: **no confirmado en fuente oficial**.

**El sistema.** El [Decreto 62 de 2019](https://www.bcn.cl/leychile/Navegar?idNorma=1142343&idParte=0) (publicado el 13-feb-2020) regula el Sistema No Molestar.
- El derecho se entiende ejercido **desde que el consumidor hace la solicitud** en la plataforma, y la notificación al proveedor se entiende hecha en ese momento.
- El proveedor debe revisar la plataforma **antes de lanzar campañas**.
- Usar el sistema **no exime** al proveedor de tener su propio canal de baja.
- El SERNAC envía un email al proveedor inscrito el día hábil siguiente con las solicitudes del día anterior ([No Molestar](https://www.sernac.cl/portal/617/w3-propertyvalue-63007.html)).
- Un plazo de cumplimiento de 1 o 7 días hábiles aparece en notas del SERNAC de distintas fechas ([relanzamiento 2019](https://www.economia.gob.cl/2019/05/07/ministerio-de-economia-y-sernac-lanzan-nueva-plataforma-no-molestar.htm)). El decreto **no fija ese plazo** en lo que se pudo revisar. Para el producto: tomarlo como **inmediato**.

**Acceso de la empresa.** Inscripción **voluntaria** en el [Portal del Proveedor](https://www.sernac.cl/app/nuevo-proveedor/) ([guía del portal](https://www.sernac.cl/portal/617/articles-12190_archivo_01.pdf)). El proveedor ve las solicitudes que **lo nombran a él**: no es una lista nacional descargable. No hay costo.

**Canales.** Toda comunicación promocional o publicitaria del proveedor por el canal que corresponda: email, llamadas y mensajería.

**Sanciones.** Multas según la Ley 19.496; el SERNAC cita hasta **50 UTM** en un caso de spam ([Corte condena por spam](https://www.sernac.cl/portal/604/w3-article-6818.html)). El SERNAC además denuncia a empresas incumplidoras ([denuncia a diez empresas](https://www.sernac.cl/portal/604/w3-article-56353.html)).

**B2B.** Es ley del consumidor. Si protege a un ejecutivo contactado por su rol: **no confirmado**. Desde el 1-dic-2026 la Ley 21.719 cubre a las personas naturales en cualquier contexto (Parte 2).

### 1.5 Brasil: "Não Me Perturbe", Procon estatales y prefijo 0303

**Não Me Perturbe** ([Anatel, Bloqueio de telemarketing](https://www.gov.br/anatel/pt-br/consumidor/quer-reclamar/bloqueio-de-telemarketing); [naomeperturbe.com.br](https://www.naomeperturbe.com.br/inicio.html)):
- Es **autorregulación** de las operadoras de telecom y de los bancos.
- Bloquea **ofertas de telefonía, TV e internet** y de **crédito consignado**, con efecto en **hasta 30 días**.
- Desde la determinación de Anatel de sep-2025, la adhesión es **obligatoria para todas las prestadoras de telecom**, incluso las pequeñas ([MCom](https://www.gov.br/mcom/pt-br/noticias/2025/setembro/anatel-determina-adesao-de-todas-as-prestadoras-de-servicos-de-telecomunicacoes-ao-nao-me-perturbe)).
- **No es una lista a la que pueda acceder un SaaS B2B ni sus clientes** fuera de esos sectores: solo opera para las empresas adheridas.
- Excepciones: confirmación de datos, fraude, cobranza y retención.

**Listas estatales (Procon).** El ejemplo más grande es São Paulo: [Lei estadual 13.226/2008](https://www.al.sp.gov.br/repositorio/legislacao/lei/2008/original-lei-13226-07.10.2008.html), hoy consolidada en la Lei 17.832/2023 (texto consolidado no confirmado) ([Procon-SP, Bloqueio de telemarketing](https://www.procon.sp.gov.br/bloqueio-de-telemarketing-4/)).
- Las empresas de telemarketing, **o quien las contrata**, deben **registrarse en Procon-SP y obtener la lista**, que trae solo números, antes de cada campaña.
- No pueden llamar **desde el día 30** de la inscripción.
- La regla alcanza a empresas de otros estados que llaman a líneas de SP.
- Responden **solidariamente** el anunciante y el call center.
- Un material de 2021 del Procon-SP incluye **SMS y aplicaciones** ([PDF 2021](https://www.procon.sp.gov.br/wp-content/uploads/2021/10/bloqueiotelemarketing_setembro2021-1.pdf)). Si sigue vigente: no confirmado.
- Formato del archivo y costo: **no confirmados en fuente oficial**.
- Otros estados (por ejemplo [Procon-RS](https://www.procon.rs.gov.br/passo-a-passo-do-bloqueio)) tienen o tuvieron listas propias.

**Prefijo 0303.** Anatel exigió desde jun-2022 que el telemarketing activo (llamadas o mensajes de oferta) use el prefijo 0303. Según la [página vigente de Anatel](https://www.gov.br/anatel/pt-br/regulado/numeracao/telemarketing-ativo-prefixo-0303), el **Acórdão 201 del 14-ago-2025 lo volvió facultativo**. Importa para el dialer: el número de origen en Brasil.

**B2B.** Ni el Não Me Perturbe ni la lista de Procon-SP distinguen B2B en lo revisado: protegen la línea del consumidor. La regla de fondo para B2B es la LGPD (Parte 2).

### 1.6 Perú: no hay registro, hay consentimiento previo

- **"Gracias… no insista" ya no existe.** Desde que se modificó el art. 58 del Código de Protección y Defensa del Consumidor (Ley 29571) en 2018, no hace falta inscribirse en nada: **está prohibido** usar call centers, llamadas, SMS o mensajes electrónicos para promocionar productos o servicios **sin consentimiento previo** del consumidor ([INDECOPI, Gracias No Insista](https://indecopi.gob.pe/testbusqueda/-/asset_publisher/assVAmoRuJlX/content/gracias-no-insis-1?inheritRedirect=false); [Llamadas spam](https://consumidor.gob.pe/2025/06/20/llamadas-telefonicas-no-deseadas-llamadas-spam/)).
- La **Ley 32323 (2025)** lo endureció:
  - El consentimiento debe ser "libre, previo, informado, expreso e inequívoco" y **revocable en cualquier momento**.
  - El spam es **infracción muy grave**, con multas de **hasta 450 UIT**.
  - Fuentes: [El Peruano](https://elperuano.pe/noticia/270087-te-molestan-las-llamadas-spam-conoce-como-la-nueva-ley-32323-te-protege-y-reclama-tus-derechos), [hasta 450 UIT](https://www.elperuano.pe/noticia/270953-te-llaman-sin-permiso-indecopi-puede-sancionar-con-multas-de-hasta-450-uit).
  - Prevé numeración especial para proveedores. Si ya está reglamentada: **no confirmado**.
- **Primer contacto (Reglamento de datos, D.S. 016-2024-JUS, art. 26):** se permite **una única llamada** para pedir el consentimiento general de publicidad o prospección, solo si:
  - los datos vienen de una fuente lícita,
  - la llamada pide el consentimiento antes de ofrecer nada,
  - y, si la persona se niega, **no se la vuelve a contactar** para eso.
  - Fuentes: [MINJUSDH](https://www.gob.pe/institucion/minjus/noticias/1137398-nuevo-reglamento-de-proteccion-de-datos-personales-refuerza-el-consentimiento-de-usuarios-para-recibir-llamadas-publicitarias), [ANPD](https://www.gob.pe/institucion/anpd/campa%C3%B1as/128319-nuevo-reglamento-de-proteccion-de-datos-personales).
- **Denuncias:** Reclama Virtual de INDECOPI y el WhatsApp "No Insista". Hay sanciones recientes a bancos y telcos ([Claro, Movistar, Rappi](https://www.indecopi.gob.pe/en_US/web/dpc/-/indecopi-sanciono-a-claro-movistar-y-rappi-por-remitir-promociones-a-usuarios-sin-su-consentimiento)).
- **B2B:** el Código protege a consumidores. Si un ejecutivo contactado por su rol cuenta como consumidor: **no confirmado**. La Ley 29733 sí lo cubre como persona natural (Parte 2).

---

## Parte 2. Leyes de protección de datos aplicadas a prospección B2B

### Resumen

| País | Ley | Base para prospectar sin consentimiento | Oposición / baja | ¿Exige guardar registro de supresión? | Regulador | Multa máxima |
|---|---|---|---|---|---|---|
| Brasil | LGPD, Lei 13.709/2018 | **Sí: legítimo interés** (art. 7 IX + art. 10) con prueba de ponderación documentada | Oposición (art. 18 §2); sin plazo legal fijo para oposición | No hay "lista de exclusión" nominal; responsabilidad y prueba (art. 6 X, art. 37) | ANPD | 2 % de la facturación en Brasil, **hasta R$ 50 millones por infracción** |
| Colombia | Ley 1581/2012 + Decreto 1377/2013 | Regla general: **autorización previa**. Los datos públicos y los datos corporativos de una persona jurídica quedan fuera según la SIC | Supresión o revocatoria; reclamos en 15 días hábiles | Se debe conservar prueba de la autorización | SIC | 2.000 SMMLV |
| México | LFPDPPP 2025 (DOF 20-mar-2025) | **Consentimiento** con excepciones (art. 9); no hay legítimo interés. El reglamento de 2011 excluía datos laborales básicos; su vigencia no está confirmada | Derechos ARCO: respuesta en 20 días + 15 para hacerla efectiva | Reglamento 2011: **listados de exclusión** | Secretaría Anticorrupción y Buen Gobierno | Hasta 320.000 UMA (verificar) |
| Chile | Ley 21.719 (desde 1-dic-2026; hoy Ley 19.628) | **Sí: interés legítimo** (art. 13) | Oposición; 30 días corridos (fuente secundaria) | Responsabilidad proactiva | Agencia de Protección de Datos Personales | 20.000 UTM o 4 % de los ingresos |
| Argentina | Ley 25.326 + Decreto 1558/2001 | Art. 27: publicidad con datos de **fuentes accesibles al público**, facilitados por el titular o con consentimiento | **Retiro o bloqueo "en cualquier momento"**, total o por canal | Bloqueo (el dato se conserva bloqueado) | AAIP | $100.000 × 500 (Res. 126/2024) |
| Perú | Ley 29733 + D.S. 016-2024-JUS | **Consentimiento previo** para prospección; una única llamada para pedirlo | Oposición atendida en **10 días** | Prueba del consentimiento y de la negativa | ANPD (MINJUSDH) | 100 UIT, con tope del 10 % de los ingresos |

### 2.1 Brasil: LGPD (Lei 13.709/2018)

- **Base legal:** consentimiento (art. 7 I) o **legítimo interés** (art. 7 IX). El art. 10 I incluye expresamente el "apoio e promoção de atividades do controlador" ([texto compilado, Planalto](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm)).
- **Guía de la ANPD sobre legítimo interés** ([guía](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_legitimo_interesse.pdf/@@display-file/file), [noticia](https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-lanca-guia-orientativo-sobre-legitimo-interesse)):
  - Pide una **prueba de ponderación por finalidad** en tres fases: finalidad, necesidad, y ponderación con salvaguardas.
  - **Documentarla** cumple el principio de rendición de cuentas.
  - El interés debe estar ligado a actividades actuales del responsable.
  - Incluye un ejemplo de campaña promocional basada en legítimo interés.
  - El art. 10 §2 exige **transparencia** sobre este tratamiento.
- **Oposición:** el titular puede oponerse al tratamiento sin consentimiento (art. 18 §2). Plazo general:
  - La confirmación o el acceso completo se responde en **15 días** (art. 19 II).
  - Para la oposición la ley **no fija plazo**. Si una resolución posterior de la ANPD lo fija: no confirmado.
- **Derechos:** confirmación, acceso, corrección, anonimización, bloqueo o eliminación, portabilidad, información sobre con quién se compartieron los datos, revocación y oposición (art. 18).
- **Regulador:** ANPD.
- **Sanciones** (art. 52): advertencia, multa de hasta **2 % de la facturación en Brasil limitada a R$ 50 millones por infracción**, multa diaria, publicidad de la infracción, y bloqueo o eliminación ([ANPD, dosimetría](https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-publica-regulamento-de-dosimetria)).
- **En la práctica:** el email B2B frío es defendible con legítimo interés **si** hay prueba de ponderación, aviso de origen y una baja efectiva. Para llamadas también cuentan Procon y Anatel (Parte 1).

### 2.2 Colombia: Ley 1581 de 2012 + Decreto 1377 de 2013 (DUR 1074/2015)

- **Base legal:** **autorización previa, expresa e informada** del titular ([Ley 1581](http://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html)).
  - No se necesita para **datos públicos**, como la profesión u oficio o la calidad de comerciante ([SIC, preguntas frecuentes](https://sic.gov.co/preguntas-frecuentes-pdp)).
  - **Concepto de la SIC:** el correo institucional, el celular corporativo y la dirección de contacto **de una persona jurídica** "escapan de la órbita de protección" de la Ley 1581 ([SIC, datos corporativos](https://sedeelectronica.sic.gov.co/boletin-juridico/conceptos/ambito-de-aplicacion-de-la-ley-1581-de-2012-en-datos-corporativos)).
  - **Cuidado:** el email *nombre.apellido@empresa* de una persona identificable sigue siendo, en la lectura prudente, dato personal. El concepto habla de datos de la persona jurídica. **No confirmado** que alcance al email nominal del empleado.
- **Derechos:** conocer, actualizar, rectificar, pedir prueba de la autorización, ser informado del uso, quejarse ante la SIC, y **revocar o pedir supresión**.
  - Consultas: **10 días hábiles**, prorrogables 5 (art. 14).
  - Reclamos, incluida la supresión: **15 días hábiles**, prorrogables 8 (art. 15).
- **Registro:** el responsable debe **conservar prueba de la autorización**. También hay que inscribir las bases de datos en el RNBD, según el tamaño de la empresa.
- **Sanciones:** multas de **hasta 2.000 SMMLV**, suspensión y cierre (art. 23). **Regulador:** SIC, Delegatura de Protección de Datos.
- Además rigen la **Ley 2300** y el **RNE** (Parte 1) para cualquier contacto comercial.

### 2.3 México: LFPDPPP 2025

- **Nueva ley** publicada en el DOF el **20-mar-2025** y vigente desde el 21-mar-2025. Abrogó la de 2010 ([texto vigente, Diputados](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf); [texto original](https://www.diputados.gob.mx/LeyesBiblio/ref/lfpdppp/LFPDPPP_orig_20mar25.pdf); [DOF](https://dof.gob.mx/nota_detalle.php?codigo=5752569&fecha=20%2F03%2F2025)).
- La autoridad es la **Secretaría Anticorrupción y Buen Gobierno**, que reemplazó al INAI ([SABG](https://www.gob.mx/buengobierno/prensa/inician-trabajos-autoridades-garantes-federales-de-acceso-a-la-informacion-y-proteccion-de-datos-personales)).
- **Base legal:** **consentimiento** del titular, con las excepciones del art. 9: que lo permita una norma, **fuentes de acceso público** (las que por ley pueden consultarse públicamente, no un sitio web cualquiera), entre otras.
  - La ley **no tiene una base de "interés legítimo"** como la LGPD o el RGPD.
  - El **Reglamento de 2011, art. 5** excluía nombre, puesto, domicilio, teléfono y email **de trabajo** de quien presta servicios a una persona moral, siempre que se traten para representar al empleador ([Reglamento](https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LFPDPPP.pdf)).
  - Si ese reglamento y esa exclusión siguen aplicando con la ley 2025: **no confirmado en fuente oficial**.
- **Derechos ARCO** (acceso, rectificación, cancelación, oposición):
  - Respuesta en **20 días hábiles** y, si procede, ejecución en **15 días** más. Prorrogable una vez.
  - Revocación del consentimiento y **limitación del uso** (por ejemplo, para publicidad).
  - El Reglamento de 2011 define los **"listados de exclusión"**: registros gratuitos de la negativa del titular. Se espera que la práctica continúe; con la ley 2025 **no está confirmado** como obligación.
- **Sanciones:** multas de **100 a 160.000 UMA** y de **200 a 320.000 UMA** según la fracción. Pueden duplicarse con datos sensibles y sumarse por reincidencia. Hay que verificar los montos en el texto vigente.
- Además rige el **REPEP** (Parte 1) para llamadas y SMS.

### 2.4 Chile: Ley 21.719 (vigente desde 1-dic-2026) y Ley 19.628 (hasta entonces)

- **Publicación:** 13-dic-2024 ([BCN, Ley 21.719](https://www.bcn.cl/leychile/navegar?idNorma=1209272); [Diario Oficial](https://www.diariooficial.interior.gob.cl/publicaciones/2024/12/13/44023/01/2583630.pdf)).
- **Vigencia: 1-dic-2026**, salvo que se apruebe la postergación.
  - **Ojo, posible postergación:** el Gobierno ingresó el **31-ago-2026** un proyecto (boletín 18.623-07) para correrla al **1-dic-2027** ([Min. Economía](https://www.economia.gob.cl/2026/09/01/gobierno-propone-ampliar-plazo-para-implementar-nueva-ley-de-proteccion-de-datos-y-institucionalidad.htm)).
  - Al 2026-10-17 seguía en primer trámite en el Senado según fuentes secundarias. Hay que revisar su estado antes de diciembre.
- **Base legal (art. 13):** consentimiento, o tratamiento necesario para el **interés legítimo del responsable o de un tercero** si no prevalecen los derechos del titular. El titular puede pedir que le informen cuál es ese interés.
- **Derechos:** acceso, rectificación, supresión, **oposición**, portabilidad y bloqueo.
  - Plazo de respuesta: **30 días corridos**, prorrogables 30. Viene de fuentes secundarias; confirmar en la BCN.
  - Bloqueo temporal: 2 días hábiles.
  - La oposición a marketing directo o a un tratamiento basado en interés legítimo obliga a cesar, según fuentes secundarias. El texto literal **no está confirmado aquí**.
- **Regulador:** nueva **Agencia de Protección de Datos Personales**.
- **Sanciones:**

| Infracción | Multa |
|---|---|
| Leve | Hasta 5.000 UTM |
| Grave | Hasta 10.000 UTM o 2 % de los ingresos anuales, lo que sea mayor |
| Gravísima | Hasta 20.000 UTM o 4 % de los ingresos anuales, lo que sea mayor |

- **Hoy** sigue la [Ley 19.628](https://www.bcn.cl/leychile/navegar?idNorma=141599), basada en consentimiento con excepciones para fuentes accesibles al público, más el art. 28 B y el No Molestar (Parte 1).

### 2.5 Argentina: Ley 25.326 (AAIP)

- **Base legal:** consentimiento, con excepciones como las fuentes de acceso público irrestricto ([Ley 25.326](https://www.argentina.gob.ar/sites/default/files/arg_ley25326.pdf)).
- **Publicidad (art. 27):** se pueden usar datos "aptos para establecer perfiles" para publicidad si figuran en **documentos accesibles al público**, si los dio el propio titular o si hay consentimiento.
- **Baja:** el titular puede pedir **en cualquier momento** el **retiro o bloqueo** (art. 27 inc. 3).
  - El [Decreto 1558/2001](https://www.argentina.gob.ar/normativa/nacional/decreto-1558-2001-70368/texto) permite el bloqueo **parcial, por medio de comunicación**: solo email, solo teléfono, etc.
  - Toda comunicación publicitaria a distancia debe avisar **de forma destacada** de ese derecho.
  - A pedido del titular, hay que decirle **quién proveyó sus datos**.
  - La [Disposición 4/2009](https://www.argentina.gob.ar/normativa/nacional/norma-151221/texto) exige incluir ese aviso y un mecanismo operativo.
- **Derechos:**
  - Acceso: **10 días corridos** (art. 14).
  - Rectificación, actualización o supresión: **5 días hábiles** (art. 16).
- **Registro:** el bloqueo implica **conservar el dato bloqueado** para no volver a usarlo. Las bases deben estar inscriptas en el RNBD.
- **Sanciones:** escala de la Res. AAIP 126/2024 (ver 1.3). "No retirar o bloquear" el nombre y email de bases publicitarias cuando el titular lo pide es una infracción tipificada.
- **Regulador:** AAIP.

### 2.6 Perú: Ley 29733 + Reglamento D.S. 016-2024-JUS (vigente desde 31-mar-2025)

- **Base legal:** **consentimiento previo** para publicidad y prospección comercial ([Ley 29733, El Peruano](https://diariooficial.elperuano.pe/Normas/obtenerDocumento?idNorma=23); [Reglamento D.S. 016-2024-JUS](https://cdn.www.gob.pe/uploads/document/file/7568330/6426760-decreto-supremo-n-016-2024-jus-reglamento-de-la-ley-n-29733-ley-de-proteccion-de-datos-personales-publicado-nov-2024.pdf?v=1738386453)).
  - Se permite **una sola llamada** para pedir ese consentimiento con datos de fuente lícita (art. 26, ver 1.6).
  - Si el reglamento excluye datos de contacto profesional: **no confirmado en fuente oficial**.
- **Oposición y revocación:** en cualquier momento, por un medio **sencillo y gratuito**, atendida en un **máximo de 10 días**.
  - Procede en especial cuando no hubo consentimiento y los datos vienen de fuentes públicas (art. 86).
  - Una vez negada, **no se puede volver a contactar** a la persona para pedirlo.
- **Derechos:** información, acceso, rectificación, cancelación, oposición y tratamiento objetivo.
- **Regulador:** Autoridad Nacional de Protección de Datos Personales (MINJUSDH).
- **Sanciones:**

| Infracción | Multa |
|---|---|
| Leve | 0,5 a 5 UIT |
| Grave | Más de 5 a 50 UIT. Prospectar sin consentimiento cae aquí, según el MINJUSDH |
| Muy grave | Más de 50 a 100 UIT. Usar datos de fuente ilícita cae aquí |

  Ninguna multa puede superar el 10 % de los ingresos brutos anuales. Sobre esto se suman las multas de INDECOPI por la Ley 32323.

### 2.7 Política de plataforma (no es ley, pero corta el canal)

- **WhatsApp Business:** la [política de mensajería de WhatsApp Business](https://business.whatsapp.com/policy) exige **opt-in previo** del destinatario y respetar las bajas. Meta puede bajar la calidad del número o bloquearlo. Ese es el origen de las fallas de plantilla que ya maneja `_shared/wati.ts` (ver `docs/OMNICANAL.md`).
- **LinkedIn:** el envío lo controla Dripify (Activity Control). Las reglas de LinkedIn sobre automatización no están en el alcance de este documento.

---

## Parte 3. Qué hace Predictable

Construido el 2026-10-17 (migración `20261017000004_suppression.sql`, `supabase/functions/_shared/suppression.ts`, edge function `suppression`, pantalla Campañas → «Bajas y exclusiones» en `js/suppression.js`). La UI muestra qué se hizo y con qué fuente; no da asesoría legal.

| Obligación (dónde aparece) | Función de Predictable |
|---|---|
| Respetar la baja de cada persona y por canal (MX art. 18 BIS; CL art. 28 B; AR art. 27 inc. 3 con bloqueo por medio; PE oposición; BR art. 18 §2; CO RNE por canal) | **Lista de supresión por usuario y por canal** (`suppression_entries`): email, teléfono, LinkedIn y **dominio** (toda una empresa), cada uno en «todos los canales» o en email, WhatsApp, LinkedIn o llamadas. Los dominios de correo gratuito no se aceptan como dominio. |
| Honrar la baja de inmediato (CL 28 B; AR Decreto 1558 art. 27; PE 10 días; MX ARCO) | **Bajas automáticas, sin intervención**: botón «Darse de baja» o texto «no me escribas» por WhatsApp (`wati-webhook`), respuesta «no me escribas» por email (leída del hilo de Gmail conectado; sin Gmail, Apollo no entrega el texto), baja con el enlace del correo que Apollo reporta como `unsubscribe` (List-Unsubscribe; el correo lo envía Apollo) y respuesta por LinkedIn (`dripify-webhook`). Decisión del dueño: una baja por cualquier canal suprime **todos los datos del lead en todos los canales**. |
| Excluir números inscritos en registros oficiales (REPEP, RNE, No Llame, No Molestar, Procon-SP) | **Importación del archivo que la empresa del cliente descargó o consultó con su propia cuenta**: Predictable no se registra en su nombre, no consulta ni hace scraping. Cada importación guarda la fecha de descarga y la de vigencia (por defecto 15 días para REPEP y 30 para No Llame y Procon-SP) y la pantalla la marca «Vencida» cuando pasa. Hasta 100.000 números se guarda el archivo entero; más grande, se cruza en el navegador con los teléfonos de los contactos del cliente y solo se guardan las coincidencias (la pantalla lo dice). La importación nueva de un registro reemplaza a la anterior. No Me Perturbe y Perú no están: el primero no lo puede consultar un tercero y Perú no tiene registro. |
| Listas propias del cliente (bajas históricas, CRM, exclusiones de abogados) | **Carga manual o por CSV**, por canal o por dominio, con motivo. |
| Demostrar cumplimiento (BR art. 6 X y guía ANPD; CO prueba de autorización; PE prueba de la negativa; AR constancia de consulta) | **Cada supresión queda registrada** con fecha, origen, base (`opt_out` baja del titular, `registry` registro oficial, `user_policy` decisión del equipo) y prueba (texto del lead e ids del mensaje, o archivo, registro y fechas). Nunca se borra: se «quita» con motivo obligatorio y la fila queda en el registro; si vuelve a suprimirse, el estado anterior queda dentro de la prueba. Exportable a CSV. |
| No contactar a quien está suprimido, aunque ya esté enrolado (todas) | **`campaign-run` revisa la lista antes de cada envío**: el paso suprimido se omite (`skipped` con el motivo) y la cadencia sigue con el siguiente; si la lista no se puede leer, el paso espera 1 h en vez de enviar. **El enrolamiento** (Campañas y la API pública) no enrola a quien está suprimido en todos los canales de la campaña. **El dialer** llama a `isSuppressed(db, userId, "phone", …)` o a la acción `check` de la edge function `suppression` antes de marcar. |
| Horarios y frecuencia (CO Ley 2300: lun–vie 7–19, sáb 8–15, sin domingos ni festivos, un contacto al día) | **`campaign-run` aplica la regla a los leads de Colombia** (`_shared/contact-rules.ts`, 2026-10-18): el país sale de `country` de la lista o, si falta, del prefijo +57; el envío solo sale en el horario legal en hora de Colombia, sin domingos ni los 18 festivos (Ley Emiliani y Semana Santa calculados), y como máximo **un envío de campaña por día y por lead** en cualquier canal y campaña. El paso espera con el motivo; no se omite. Se suma a la ventana de la campaña. Decisión del dueño: no se limitan los canales por semana (una respuesta ya detiene la cadencia). LinkedIn: Predictable sube el perfil a Dripify en el horario legal, pero Dripify envía con su propio horario (Activity Control): configúralo en Dripify. |

---

## Parte 4. Fuentes

**México**
- PROFECO, REPEP: https://repep.profeco.gob.mx/
- REPEP, Preguntas frecuentes: https://repep.profeco.gob.mx/preguntasfrecuentes.jsp
- REPEP, Descargas: https://repep.profeco.gob.mx/Descargas.jsp
- REPEP, Sanciones: https://repep.profeco.gob.mx/Sanciones.jsp
- REPEP, Cómo denunciar: https://repep.profeco.gob.mx/Denunciar.jsp
- PROFECO, ¿Qué es el REPEP?: https://www.profeco.gob.mx/servicios/repeb.asp
- PROFECO, Líbrate de las llamadas y mensajes molestos: https://www.gob.mx/profeco/documentos/librate-de-las-llamadas-y-mensajes-molestos-de-publicidad?state=published
- CONAMER, trámite PROFECO-00-019: https://catalogonacional.gob.mx/FichaTramite?traHomoclave=PROFECO-00-019
- Ley Federal de Protección al Consumidor: https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf
- CONDUSEF, REUS: https://www.condusef.gob.mx/?p=contenido&idc=2158&idcat=3
- CONDUSEF, Reglas del REUS: https://www.condusef.gob.mx/documentos/marco_legal/Reglas_del_Registro_Publico_de_Usuarios.pdf
- Trámite CONDUSEF-00-014-E: https://www.gob.mx/public/tramites/detalleTramite.xhtml?homoclave=CONDUSEF-00-014-E
- LFPDPPP vigente: https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf
- LFPDPPP, texto original del 20-mar-2025: https://www.diputados.gob.mx/LeyesBiblio/ref/lfpdppp/LFPDPPP_orig_20mar25.pdf
- DOF, 20-mar-2025: https://dof.gob.mx/nota_detalle.php?codigo=5752569&fecha=20%2F03%2F2025
- Reglamento LFPDPPP (2011): https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LFPDPPP.pdf
- Secretaría Anticorrupción y Buen Gobierno: https://www.gob.mx/buengobierno/prensa/inician-trabajos-autoridades-garantes-federales-de-acceso-a-la-informacion-y-proteccion-de-datos-personales

**Colombia**
- Ley 2300 de 2023 (Función Pública): https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=213990
- Ley 2300 de 2023 (Senado): http://www.secretariasenado.gov.co/senado/basedoc/ley_2300_2023.html
- Resolución CRC 7356 de 2024: https://www.crcom.gov.co/sites/default/files/normatividad/00007356.pdf
- ABC de la actualización del RNE: https://www.crcom.gov.co/sites/default/files/webcrc/documents/2024-05/ABC-ACTUALIZACION-REGISTRO-NUMEROS-EXCLUIDOS-220524.pdf
- CRC, comunicado del 10 de abril: https://www.crcom.gov.co/es/noticias/comunicado-prensa/partir-10-abril-colombianos-podran-inscribirse-para-evitar-recepcion
- CRC, consulta sobre la plataforma RNE (2024531261): https://www.crcom.gov.co/sites/default/files/normatividad/2024531261.pdf
- CRC, consulta sobre la plataforma RNE (2024537298): https://www.crcom.gov.co/sites/default/files/normatividad/2024537298.pdf
- CRC, consulta 2024515327: https://www.crcom.gov.co/sites/default/files/normatividad/2024515327.pdf
- CRC, respuesta a comentarios: https://www.crcom.gov.co/system/files/Biblioteca%20Virtual/Documento%20de%20respuesta%20a%20comentarios%20-%20Actualizaci%C3%B3n%20del%20RNE/Documento-respuesta-comentarios-RNE-120424.pdf
- CRC, concepto 513485 de 2024: https://normograma.crcom.gov.co/crc/compilacion/docs/concepto_crc_0513485_2024.htm
- CRC, concepto 506667 de 2025: https://normograma.crcom.gov.co/crc/compilacion/docs/concepto_crc_0506667_2025.htm
- Ley 1581 de 2012: http://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html
- SIC, concepto sobre datos corporativos: https://sedeelectronica.sic.gov.co/boletin-juridico/conceptos/ambito-de-aplicacion-de-la-ley-1581-de-2012-en-datos-corporativos
- SIC, preguntas frecuentes: https://sic.gov.co/preguntas-frecuentes-pdp

**Argentina**
- Ley 26.951: https://www.argentina.gob.ar/normativa/nacional/ley-26951-233066/texto
- Decreto 2501/2014: https://www.argentina.gob.ar/normativa/nacional/240407/texto
- Disposición DNPDP 3/2015: https://www.argentina.gob.ar/normativa/nacional/norma-241100/texto
- Resolución AAIP 126/2024 (texto): https://www.argentina.gob.ar/normativa/nacional/norma-399750/texto
- Resolución AAIP 126/2024 (actualizado): https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-126-2024-399750/actualizacion
- Resolución AAIP 234/2019: https://www.argentina.gob.ar/sites/default/files/rs-2019-234-apn-aaip.pdf
- AAIP, acceso a la API de No Llame: https://www.argentina.gob.ar/servicio/solicitar-acceso-al-sistema-de-consultas-automatizadas-del-registro-nacional-no-llame
- AAIP, empresas más denunciadas en 2024: https://www.argentina.gob.ar/aaip/empresas-mas-sancionadas-registro-no-llame
- AAIP, resolución sancionatoria ADT 2024: https://www.argentina.gob.ar/sites/default/files/rs-2024-45-apn-aaip.pdf
- Ley 25.326: https://www.argentina.gob.ar/sites/default/files/arg_ley25326.pdf
- Decreto 1558/2001: https://www.argentina.gob.ar/normativa/nacional/decreto-1558-2001-70368/texto
- Disposición DNPDP 4/2009: https://www.argentina.gob.ar/normativa/nacional/norma-151221/texto

**Chile**
- SERNAC, art. 28 B: https://www.sernac.cl/portal/609/w3-propertyvalue-58918.html
- SERNAC, No Molestar: https://www.sernac.cl/portal/617/w3-propertyvalue-63007.html
- SERNAC, Registro de Proveedores: https://www.sernac.cl/app/nuevo-proveedor/
- SERNAC, Guía del Portal del Proveedor: https://www.sernac.cl/portal/617/articles-12190_archivo_01.pdf
- SERNAC, Corte condena por spam: https://www.sernac.cl/portal/604/w3-article-6818.html
- SERNAC, denuncia a diez empresas: https://www.sernac.cl/portal/604/w3-article-56353.html
- Decreto 62 (BCN): https://www.bcn.cl/leychile/Navegar?idNorma=1142343&idParte=0
- Min. Economía, relanzamiento de No Molestar en 2019: https://www.economia.gob.cl/2019/05/07/ministerio-de-economia-y-sernac-lanzan-nueva-plataforma-no-molestar.htm
- Ley 21.719 (BCN): https://www.bcn.cl/leychile/navegar?idNorma=1209272
- Ley 21.719 (Diario Oficial): https://www.diariooficial.interior.gob.cl/publicaciones/2024/12/13/44023/01/2583630.pdf
- Min. Economía, propuesta de postergación: https://www.economia.gob.cl/2026/09/01/gobierno-propone-ampliar-plazo-para-implementar-nueva-ley-de-proteccion-de-datos-y-institucionalidad.htm
- Ley 19.628: https://www.bcn.cl/leychile/navegar?idNorma=141599

**Brasil**
- Anatel, Não Me Perturbe: https://www.gov.br/anatel/pt-br/consumidor/quer-reclamar/bloqueio-de-telemarketing
- Não Me Perturbe: https://www.naomeperturbe.com.br/inicio.html
- MCom, adhesión obligatoria (sep-2025): https://www.gov.br/mcom/pt-br/noticias/2025/setembro/anatel-determina-adesao-de-todas-as-prestadoras-de-servicos-de-telecomunicacoes-ao-nao-me-perturbe
- Anatel, prefijo 0303: https://www.gov.br/anatel/pt-br/regulado/numeracao/telemarketing-ativo-prefixo-0303
- Procon-SP, bloqueo de telemarketing: https://www.procon.sp.gov.br/bloqueio-de-telemarketing-4/
- Procon-SP, PDF de 2021: https://www.procon.sp.gov.br/wp-content/uploads/2021/10/bloqueiotelemarketing_setembro2021-1.pdf
- Lei SP 13.226/2008: https://www.al.sp.gov.br/repositorio/legislacao/lei/2008/original-lei-13226-07.10.2008.html
- Procon-RS: https://www.procon.rs.gov.br/passo-a-passo-do-bloqueio
- LGPD (Planalto, compilada): https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm
- ANPD, guía de legítimo interés: https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_legitimo_interesse.pdf/@@display-file/file
- ANPD, noticia de la guía: https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-lanca-guia-orientativo-sobre-legitimo-interesse
- ANPD, dosimetría: https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-publica-regulamento-de-dosimetria

**Perú**
- INDECOPI, Gracias No Insista: https://indecopi.gob.pe/testbusqueda/-/asset_publisher/assVAmoRuJlX/content/gracias-no-insis-1?inheritRedirect=false
- INDECOPI, llamadas spam: https://consumidor.gob.pe/2025/06/20/llamadas-telefonicas-no-deseadas-llamadas-spam/
- INDECOPI, sanción a Claro, Movistar y Rappi: https://www.indecopi.gob.pe/en_US/web/dpc/-/indecopi-sanciono-a-claro-movistar-y-rappi-por-remitir-promociones-a-usuarios-sin-su-consentimiento
- El Peruano, Ley 32323: https://elperuano.pe/noticia/270087-te-molestan-las-llamadas-spam-conoce-como-la-nueva-ley-32323-te-protege-y-reclama-tus-derechos
- El Peruano, multas de hasta 450 UIT: https://www.elperuano.pe/noticia/270953-te-llaman-sin-permiso-indecopi-puede-sancionar-con-multas-de-hasta-450-uit
- Ley 29733 (El Peruano): https://diariooficial.elperuano.pe/Normas/obtenerDocumento?idNorma=23
- D.S. 016-2024-JUS: https://cdn.www.gob.pe/uploads/document/file/7568330/6426760-decreto-supremo-n-016-2024-jus-reglamento-de-la-ley-n-29733-ley-de-proteccion-de-datos-personales-publicado-nov-2024.pdf?v=1738386453
- MINJUSDH, el nuevo reglamento y las llamadas: https://www.gob.pe/institucion/minjus/noticias/1137398-nuevo-reglamento-de-proteccion-de-datos-personales-refuerza-el-consentimiento-de-usuarios-para-recibir-llamadas-publicitarias
- ANPD, nuevo reglamento: https://www.gob.pe/institucion/anpd/campa%C3%B1as/128319-nuevo-reglamento-de-proteccion-de-datos-personales

**Plataformas**
- Política de mensajería de WhatsApp Business: https://business.whatsapp.com/policy
