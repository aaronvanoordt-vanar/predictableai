/**
 * _shared/radar-recipes.ts — la biblioteca de detectores del Radar.
 *
 * Recetas concretas y probadas de "qué hecho observable delata que esta
 * empresa necesita a este vendedor". Cada una es un detector completo (kind +
 * config) que el usuario agrega con un clic desde Plan de señales →
 * Biblioteca, sin IA de por medio, y que el planificador recibe como
 * repertorio al diseñar el plan (radar-planner.ts). Pidió el dueño
 * (2026-10-07): los detectores eran vagos y se quedaban en lo que Apollo
 * filtra; la mayoría de estas recetas lee el sitio y el DNS de la empresa
 * (site_probe) o busca su huella pública en internet (web_footprint).
 *
 * Los textos de las consultas usan marcadores que se rellenan con el
 * contexto del usuario: {country} (país en español, una consulta por país,
 * hasta 3), {industry} (primera industria del ICP), {ml_site} (dominio de
 * Mercado Libre del país) y {amazon_site} (dominio de Amazon del país).
 * Todo pasa por normalizeDetector(): una receta que no valide no se entrega
 * (lo cubre deno test).
 */

import { countryLabelEs } from "./radar-geo.ts";
import { normalizeDetector, type DetectorKind, type NormalizedDetector } from "./radar-plan.ts";

export type RecipeCategory =
  | "whatsapp" | "meta_ads" | "marketplaces" | "payments_logistics"
  | "marketing_crm" | "web" | "it_compliance" | "expansion" | "talent";

export const RECIPE_CATEGORIES: { id: RecipeCategory; label: string }[] = [
  { id: "whatsapp", label: "WhatsApp y conversación" },
  { id: "meta_ads", label: "Meta, redes y publicidad" },
  { id: "marketplaces", label: "Marketplaces y e-commerce" },
  { id: "payments_logistics", label: "Pagos y logística" },
  { id: "marketing_crm", label: "Email, CRM y ventas" },
  { id: "web", label: "Sitio web y presencia" },
  { id: "it_compliance", label: "Correo, seguridad y cumplimiento" },
  { id: "expansion", label: "Crecimiento y expansión" },
  { id: "talent", label: "Talento y liderazgo" },
];

export interface RadarRecipe {
  id: string;
  category: RecipeCategory;
  kind: DetectorKind;
  /** ≤ 60 caracteres: lo que caza. */
  name: string;
  /** A qué vendedor le sirve, en una línea. */
  for_who: string;
  /** Por qué este hecho observable predice una compra. */
  rationale: string;
  weight: number;
  decision_maker_titles: string[];
  config: Record<string, unknown>;
}

const probe = (must_have: string[], must_not_have: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ must_have, must_not_have, ...extra });

const CS_TITLES = ["Customer Service Manager", "Head of Customer Experience", "Marketing Manager", "Owner", "General Manager"];
const MKT_TITLES = ["Marketing Director", "Head of Marketing", "Digital Marketing Manager", "Chief Marketing Officer", "Owner"];
const ECOM_TITLES = ["Ecommerce Manager", "Head of Ecommerce", "Chief Digital Officer", "Marketing Director", "Owner"];
const SALES_TITLES = ["Sales Director", "Head of Sales", "Chief Commercial Officer", "Chief Executive Officer"];
const IT_TITLES = ["IT Manager", "Chief Technology Officer", "Chief Information Officer", "Head of IT", "Chief Information Security Officer"];
const OPS_TITLES = ["Operations Manager", "Logistics Manager", "Chief Operating Officer", "Ecommerce Manager"];
const FIN_TITLES = ["Chief Financial Officer", "Finance Manager", "Ecommerce Manager", "Payments Manager"];
const HR_TITLES = ["Human Resources Manager", "Head of Talent Acquisition", "Chief People Officer", "Recruiting Manager"];
const CEO_TITLES = ["Chief Executive Officer", "Founder", "General Manager", "Chief Operating Officer"];

export const RADAR_RECIPES: RadarRecipe[] = [
  // ── WhatsApp y conversación ───────────────────────────────────────────────
  { id: "wa_manual", category: "whatsapp", kind: "site_probe", weight: 80,
    name: "Atiende WhatsApp a mano",
    for_who: "Automatización de WhatsApp, chatbots con IA, plataformas tipo Botmaker o WATI",
    rationale: "Tiene el botón de WhatsApp (wa.me o plugin) pero ninguna plataforma ni chatbot detrás: cada conversación la contesta una persona.",
    decision_maker_titles: CS_TITLES,
    config: probe(["any_whatsapp_button"], ["any_whatsapp_platform", "any_chatbot"]) },
  { id: "wa_rule_bot", category: "whatsapp", kind: "site_probe", weight: 75,
    name: "Chatbot rígido de menús",
    for_who: "Agentes de IA conversacional que reemplazan bots de opciones",
    rationale: "Usa un bot de flujos fijos (Landbot, Typebot, Chatfuel, ManyChat, Cliengo…): ya invierte en automatizar, pero con menús que frustran al cliente.",
    decision_maker_titles: CS_TITLES,
    config: probe(["any_rule_bot"], ["chatbot_ai"]) },
  { id: "wa_platform_user", category: "whatsapp", kind: "site_probe", weight: 55,
    name: "Ya usa una plataforma de WhatsApp",
    for_who: "Desplazar a un competidor o vender integraciones sobre WhatsApp Business API",
    rationale: "Tiene instalada una plataforma de WhatsApp (WATI, Botmaker, Treble, Gupshup, B2Chat, Leadsales…): el presupuesto existe y se puede disputar.",
    decision_maker_titles: CS_TITLES,
    config: probe(["any_whatsapp_platform"]) },
  { id: "chat_no_whatsapp", category: "whatsapp", kind: "site_probe", weight: 60,
    name: "Chat en la web pero sin WhatsApp",
    for_who: "Omnicanalidad y WhatsApp Business API",
    rationale: "Atiende por chat web pero no por WhatsApp, el canal donde están sus clientes en Latinoamérica.",
    decision_maker_titles: CS_TITLES,
    config: probe(["any_chat"], ["any_whatsapp_button", "any_whatsapp_platform"]) },
  { id: "no_conversation_channel", category: "whatsapp", kind: "site_probe", weight: 55,
    name: "Sitio sin ningún canal de conversación",
    for_who: "Chat, WhatsApp, chatbots y captación de leads",
    rationale: "Ni chat, ni botón de WhatsApp, ni agenda: el visitante que quiere comprar no tiene a quién preguntarle.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["mobile_viewport"], ["any_chat", "any_whatsapp_button", "any_whatsapp_platform", "any_booking"]) },
  { id: "messenger_user", category: "whatsapp", kind: "site_probe", weight: 50,
    name: "Atiende por Facebook Messenger en su web",
    for_who: "Migración a WhatsApp/omnicanal, social commerce",
    rationale: "Instaló el chat de Messenger: conversa por canales de Meta y es candidata natural a WhatsApp Business API.",
    decision_maker_titles: CS_TITLES,
    config: probe(["messenger_chat"]) },
  { id: "hiring_support_agents", category: "whatsapp", kind: "hiring", weight: 65,
    name: "Contrata agentes de atención",
    for_who: "Automatización de atención, chatbots, WhatsApp",
    rationale: "Abrió vacantes de atención al cliente o community manager: el volumen de conversaciones creció y lo resuelve con gente.",
    decision_maker_titles: CS_TITLES,
    config: { job_titles: ["Customer Service Representative", "Customer Service Agent", "Call Center Agent", "Community Manager", "Customer Support Specialist"], min_jobs: 2, posted_within_days: 30 } },
  { id: "complaints_service", category: "whatsapp", kind: "web_footprint", weight: 60,
    name: "Quejas públicas por mala atención",
    for_who: "Atención al cliente, CX, automatización de respuestas",
    rationale: "Sus clientes se quejan en público de que no contestan (Reclame Aqui, Profeco, reseñas de Google): el dolor es visible y medible.",
    decision_maker_titles: CS_TITLES,
    config: { queries: ["quejas {industry} {country} no responden WhatsApp atención al cliente", "reseñas \"nunca contestan\" {industry} {country}", "site:reclameaqui.com.br {industry} não responde"], sources: ["Reclame Aqui", "Profeco / Buró Comercial", "reseñas de Google", "foros de consumidores"] } },

  // ── Meta, redes y publicidad ──────────────────────────────────────────────
  { id: "meta_bm_verified", category: "meta_ads", kind: "site_probe", weight: 75,
    name: "Dominio verificado en Meta Business Manager",
    for_who: "Agencias y herramientas de Facebook/Instagram Ads, WhatsApp API, social commerce",
    rationale: "Verificó su dominio en Meta Business Manager (etiqueta o registro DNS facebook-domain-verification): tiene el BM activo y opera en serio en Meta.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["meta_domain_verification"]) },
  { id: "meta_pixel_active", category: "meta_ads", kind: "site_probe", weight: 65,
    name: "Pauta en Meta (píxel activo)",
    for_who: "Agencias de performance, creatividades, atribución, CAPI",
    rationale: "Tiene el píxel de Meta instalado: invierte en anuncios de Facebook e Instagram y mide conversiones.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["meta_pixel"]) },
  { id: "meta_bm_no_pixel", category: "meta_ads", kind: "site_probe", weight: 70,
    name: "Business Manager activo pero sin píxel",
    for_who: "Agencias de Meta Ads y medición",
    rationale: "Verificó el dominio en Meta pero no tiene el píxel en la portada: usa Meta a medias y no mide lo que pauta.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["meta_domain_verification"], ["meta_pixel"]) },
  { id: "social_no_ads", category: "meta_ads", kind: "site_probe", weight: 60,
    name: "Redes activas pero sin pauta medida",
    for_who: "Agencias de publicidad digital, growth",
    rationale: "Enlaza sus perfiles de Instagram/Facebook/TikTok pero no tiene ningún píxel de anuncios: crece solo en orgánico.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["any_social"], ["any_ads_pixel"]) },
  { id: "meta_no_google", category: "meta_ads", kind: "site_probe", weight: 55,
    name: "Pauta en Meta pero no en Google",
    for_who: "Agencias de Google Ads, SEM",
    rationale: "Invierte en Meta pero no tiene la etiqueta de Google Ads: le falta captar la demanda que ya busca.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["meta_pixel"], ["google_ads_tag"]) },
  { id: "google_no_meta", category: "meta_ads", kind: "site_probe", weight: 55,
    name: "Pauta en Google pero no en Meta",
    for_who: "Agencias de Meta Ads, social ads",
    rationale: "Tiene la etiqueta de Google Ads pero no el píxel de Meta: no está generando demanda en redes.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["google_ads_tag"], ["meta_pixel"]) },
  { id: "store_no_tiktok", category: "meta_ads", kind: "site_probe", weight: 55,
    name: "Tienda que pauta en Meta y aún no en TikTok",
    for_who: "Agencias de TikTok Ads, UGC, creadores",
    rationale: "Vende online y ya pauta en Meta, pero no tiene el píxel de TikTok: el siguiente canal de adquisición.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["meta_pixel", "any_ecommerce"], ["tiktok_pixel"]) },
  { id: "linkedin_ads_b2b", category: "meta_ads", kind: "site_probe", weight: 60,
    name: "Anuncia en LinkedIn (B2B con presupuesto)",
    for_who: "ABM, generación de demanda B2B, agencias B2B",
    rationale: "Tiene el Insight Tag de LinkedIn: hace marketing B2B pagado y tiene presupuesto de adquisición.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["linkedin_insight"]) },
  { id: "ads_no_tag_manager", category: "meta_ads", kind: "site_probe", weight: 50,
    name: "Pauta sin Tag Manager (medición frágil)",
    for_who: "Analítica, atribución, consultoras de medición",
    rationale: "Tiene píxeles de anuncios pegados en el código sin Google Tag Manager: medición frágil y difícil de mantener.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["any_ads_pixel"], ["gtm"]) },
  { id: "no_analytics", category: "meta_ads", kind: "site_probe", weight: 50,
    name: "Sitio sin analítica ni píxeles",
    for_who: "Analítica web, agencias digitales",
    rationale: "No tiene Google Analytics, Tag Manager ni ningún píxel: no sabe qué pasa en su sitio.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["mobile_viewport"], ["any_analytics", "any_ads_pixel"]) },

  // ── Marketplaces y e-commerce ─────────────────────────────────────────────
  { id: "marketplace_seller", category: "marketplaces", kind: "site_probe", weight: 70,
    name: "Vende en marketplaces",
    for_who: "Tecnología para marketplaces: integradores, repricing, ads en marketplaces, fulfillment",
    rationale: "Su sitio enlaza su tienda en Mercado Libre, Amazon, Shopee, Falabella, Walmart u otro marketplace: opera multicanal y necesita orquestarlo.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["any_marketplace"]) },
  { id: "mercadolibre_seller", category: "marketplaces", kind: "site_probe", weight: 70,
    name: "Vende en Mercado Libre",
    for_who: "Integradores y agencias de Mercado Libre, Mercado Ads, fulfillment",
    rationale: "Enlaza su tienda de Mercado Libre desde su sitio: Mercado Libre es un canal propio de su negocio.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["mercadolibre"]) },
  { id: "amazon_seller", category: "marketplaces", kind: "site_probe", weight: 65,
    name: "Vende en Amazon",
    for_who: "Agencias de Amazon, Amazon Ads, FBA, repricing",
    rationale: "Enlaza su tienda o productos en Amazon: compite en Amazon y necesita visibilidad y operación.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["amazon"]) },
  { id: "store_no_marketplace", category: "marketplaces", kind: "site_probe", weight: 60,
    name: "Tienda propia sin marketplaces",
    for_who: "Integradores de marketplaces, expansión de canales",
    rationale: "Vende online en su propio sitio pero no enlaza ningún marketplace: el siguiente canal de ventas.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["any_ecommerce"], ["any_marketplace"]) },
  { id: "ml_official_stores", category: "marketplaces", kind: "web_footprint", weight: 70,
    name: "Tiendas oficiales en Mercado Libre",
    for_who: "Tecnología y servicios para sellers de Mercado Libre",
    rationale: "Marcas con tienda oficial en Mercado Libre de su país: venden volumen en el marketplace y lo profesionalizan.",
    decision_maker_titles: ECOM_TITLES,
    config: { queries: ["site:{ml_site} tienda oficial {industry}", "tiendas oficiales Mercado Libre {country} {industry}", "marcas {industry} con tienda oficial en Mercado Libre {country}"], sources: ["páginas de tiendas oficiales de Mercado Libre", "prensa de e-commerce"] } },
  { id: "amazon_brands", category: "marketplaces", kind: "web_footprint", weight: 65,
    name: "Marcas con tienda en Amazon",
    for_who: "Agencias de Amazon, Amazon Ads, logística FBA",
    rationale: "Marcas de tu ICP con tienda de marca o productos en Amazon de su país.",
    decision_maker_titles: ECOM_TITLES,
    config: { queries: ["site:{amazon_site} stores {industry}", "marcas {industry} {country} venden en Amazon", "tienda de marca en Amazon {country} {industry}"], sources: ["Amazon Stores", "prensa de e-commerce"] } },
  { id: "other_marketplaces", category: "marketplaces", kind: "web_footprint", weight: 60,
    name: "Vendedores en Shopee, Falabella, Walmart o Liverpool",
    for_who: "Integradores multicanal, agencias de marketplaces",
    rationale: "Marcas que venden en marketplaces de retail además del suyo: operación multicanal que necesita integrarse.",
    decision_maker_titles: ECOM_TITLES,
    config: { queries: ["vendedores {industry} Shopee {country} tienda oficial", "marcas {industry} en Falabella marketplace {country}", "marcas {industry} venden en Walmart marketplace o Liverpool marketplace {country}"], sources: ["páginas de vendedor en marketplaces", "prensa de retail"] } },
  { id: "delivery_apps", category: "marketplaces", kind: "site_probe", weight: 60,
    name: "Vende por Rappi, PedidosYa, iFood o Uber Eats",
    for_who: "Software para restaurantes y retail, pedidos directos, dark kitchens",
    rationale: "Enlaza sus apps de delivery: paga comisión por cada pedido y busca canal directo y operación más eficiente.",
    decision_maker_titles: OPS_TITLES,
    config: probe(["any_delivery_app"]) },
  { id: "entry_platform_store", category: "marketplaces", kind: "site_probe", weight: 55,
    name: "Tienda en plataforma de entrada",
    for_who: "Migraciones a VTEX, Shopify Plus o headless; agencias de e-commerce",
    rationale: "Vende en WooCommerce, Tiendanube, Jumpseller, Ecwid o PrestaShop: candidata a migrar cuando el volumen crece.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["any_entry_ecommerce"]) },
  { id: "enterprise_store", category: "marketplaces", kind: "site_probe", weight: 55,
    name: "E-commerce enterprise (VTEX, Magento, SFCC)",
    for_who: "Partners e integradores de plataformas enterprise, búsqueda y personalización",
    rationale: "Opera una plataforma enterprise de e-commerce: alto volumen y presupuesto para optimizarla.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["any_enterprise_ecommerce"]) },
  { id: "store_no_app", category: "marketplaces", kind: "site_probe", weight: 50,
    name: "Tienda online sin app móvil",
    for_who: "Desarrollo de apps, app commerce",
    rationale: "Vende online pero no enlaza app en App Store ni Google Play: la recompra móvil queda en el navegador.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["any_ecommerce"], ["any_mobile_app"]) },
  { id: "store_no_reviews", category: "marketplaces", kind: "site_probe", weight: 50,
    name: "Tienda online sin reseñas de clientes",
    for_who: "Reseñas, UGC, prueba social",
    rationale: "Vende online sin widget de reseñas: le falta la prueba social que sube la conversión.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["any_ecommerce"], ["any_reviews"]) },

  // ── Pagos y logística ─────────────────────────────────────────────────────
  { id: "store_no_local_payments", category: "payments_logistics", kind: "site_probe", weight: 60,
    name: "Tienda sin pasarela de pago local",
    for_who: "Pasarelas de pago locales, PSPs, cobros",
    rationale: "Vende online sin Mercado Pago, PayU, Openpay, Conekta, Kushki, Wompi u otra pasarela local en la portada: pierde a quien paga con medios locales.",
    decision_maker_titles: FIN_TITLES,
    config: probe(["any_ecommerce"], ["any_local_payments"]) },
  { id: "store_no_bnpl", category: "payments_logistics", kind: "site_probe", weight: 50,
    name: "Tienda sin compra en cuotas (BNPL)",
    for_who: "Compra ahora, paga después (Addi, Kueski, Aplazo…), financiamiento al consumidor",
    rationale: "Vende online sin opción de pagar en cuotas: el ticket y la conversión tienen techo.",
    decision_maker_titles: FIN_TITLES,
    config: probe(["any_ecommerce"], ["bnpl"]) },
  { id: "store_no_shipping", category: "payments_logistics", kind: "site_probe", weight: 55,
    name: "Tienda sin integración de envíos ni rastreo",
    for_who: "Logística de última milla, plataformas de envíos, fulfillment",
    rationale: "Vende online sin plataforma de envíos ni rastreo de pedidos en el sitio: la logística se coordina a mano.",
    decision_maker_titles: OPS_TITLES,
    config: probe(["any_ecommerce"], ["any_shipping"]) },
  { id: "stripe_only_store", category: "payments_logistics", kind: "site_probe", weight: 45,
    name: "Cobra solo con Stripe o PayPal",
    for_who: "Pasarelas locales, adquirencia, medios alternativos (OXXO, PSE, Pix)",
    rationale: "Cobra con Stripe o PayPal pero sin pasarela local: deja fuera efectivo, transferencias y tarjetas locales.",
    decision_maker_titles: FIN_TITLES,
    config: probe(["any_payments"], ["any_local_payments"]) },

  // ── Email, CRM y ventas ──────────────────────────────────────────────────
  { id: "store_no_email_mkt", category: "marketing_crm", kind: "site_probe", weight: 60,
    name: "Tienda online sin email marketing",
    for_who: "Email marketing, automatización (Klaviyo, Brevo…), retención",
    rationale: "Vende online sin Klaviyo, Mailchimp, RD Station ni otra herramienta de email: no recupera carritos ni hace recompra.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["any_ecommerce"], ["any_email_marketing"]) },
  { id: "shopify_no_klaviyo", category: "marketing_crm", kind: "site_probe", weight: 55,
    name: "Tiendas Shopify sin Klaviyo",
    for_who: "Agencias de email/SMS para Shopify, apps de Shopify",
    rationale: "Población acotada a tiendas Shopify según Apollo y, en su sitio, sin Klaviyo ni otra herramienta de email.",
    decision_maker_titles: ECOM_TITLES,
    config: probe(["shopify"], ["any_email_marketing"], { population_using_any: ["shopify"] }) },
  { id: "forms_no_crm", category: "marketing_crm", kind: "site_probe", weight: 60,
    name: "Formulario de contacto sin CRM detrás",
    for_who: "CRM, automatización de marketing, gestión de leads",
    rationale: "Recibe leads por formulario pero no tiene ningún CRM ni herramienta de marketing instalada: los leads caen en un buzón.",
    decision_maker_titles: SALES_TITLES,
    config: probe(["contact_form"], ["any_crm", "any_email_marketing"]) },
  { id: "demo_no_booking", category: "marketing_crm", kind: "site_probe", weight: 55,
    name: "Pide demos pero sin agenda en línea",
    for_who: "Agendamiento, revenue operations, SDR as a service",
    rationale: "Su CTA es pedir una demo pero no tiene agenda en línea: cada reunión se coordina por correo y se pierden leads.",
    decision_maker_titles: SALES_TITLES,
    config: probe(["demo_cta"], ["any_booking"]) },
  { id: "b2b_quote_no_chat", category: "marketing_crm", kind: "site_probe", weight: 55,
    name: "B2B que cotiza sin chat ni WhatsApp",
    for_who: "Chat, WhatsApp comercial, CPQ, automatización de ventas B2B",
    rationale: "Pide cotizaciones en su sitio pero no tiene chat ni WhatsApp: la respuesta al lead depende de un correo.",
    decision_maker_titles: SALES_TITLES,
    config: probe(["quote_request"], ["any_chat", "any_whatsapp_button", "any_whatsapp_platform"]) },
  { id: "hubspot_users", category: "marketing_crm", kind: "site_probe", weight: 50,
    name: "Usa HubSpot",
    for_who: "Partners de HubSpot, integraciones, RevOps",
    rationale: "Tiene HubSpot instalado (formularios, chat o envío de correo desde su dominio).",
    decision_maker_titles: SALES_TITLES,
    config: probe(["hubspot_chat"]) },
  { id: "salesforce_users", category: "marketing_crm", kind: "site_probe", weight: 50,
    name: "Usa Salesforce",
    for_who: "Partners de Salesforce, integraciones, consultoría CRM",
    rationale: "Tiene huellas de Salesforce (Pardot, Live Agent o SPF de Salesforce en su dominio).",
    decision_maker_titles: SALES_TITLES,
    config: probe(["salesforce"]) },
  { id: "hiring_sales_team", category: "marketing_crm", kind: "hiring", weight: 65,
    name: "Arma equipo comercial (SDR/AE)",
    for_who: "Software de ventas, prospección, capacitación comercial",
    rationale: "Abrió vacantes de SDR, BDR o ejecutivos de cuenta: está invirtiendo en crecer ventas ahora.",
    decision_maker_titles: SALES_TITLES,
    config: { job_titles: ["Sales Development Representative", "Business Development Representative", "Account Executive", "Inside Sales Representative"], min_jobs: 2, posted_within_days: 30 } },

  // ── Sitio web y presencia ────────────────────────────────────────────────
  { id: "outdated_site", category: "web", kind: "site_probe", weight: 60,
    name: "Sitio desactualizado (© de hace 3+ años)",
    for_who: "Agencias web, rediseño, marketing digital",
    rationale: "El año del copyright de su sitio tiene 3 años o más: nadie lo mantiene.",
    decision_maker_titles: MKT_TITLES,
    config: probe(["site_outdated"]) },
  { id: "not_mobile_ready", category: "web", kind: "site_probe", weight: 60,
    name: "Sitio no adaptado a celular",
    for_who: "Agencias web, rediseño, UX",
    rationale: "Su portada no declara viewport móvil: en celular se ve como escritorio en miniatura.",
    decision_maker_titles: MKT_TITLES,
    config: probe([], ["mobile_viewport"]) },
  { id: "diy_site_builder", category: "web", kind: "site_probe", weight: 50,
    name: "Sitio hecho en Wix, GoDaddy o Jimdo",
    for_who: "Agencias web y de marketing para pymes",
    rationale: "Su sitio está en un constructor de autoservicio: lo hicieron sin agencia y suele quedarse corto al crecer.",
    decision_maker_titles: CEO_TITLES,
    config: probe(["any_site_builder"]) },
  { id: "services_no_booking", category: "web", kind: "site_probe", weight: 60,
    name: "Clínicas y servicios sin agenda en línea",
    for_who: "Software de agenda, gestión de clínicas y centros de servicio",
    rationale: "Negocio de citas (salud, belleza, bienestar) sin agenda en línea: todo se coordina por teléfono o WhatsApp.",
    decision_maker_titles: CEO_TITLES,
    config: probe([], ["any_booking"], { keywords: ["clinic", "dental", "medical center", "spa", "beauty salon", "physiotherapy"] }) },
  { id: "hotels_no_engine", category: "web", kind: "site_probe", weight: 60,
    name: "Hoteles sin motor de reservas propio",
    for_who: "Motores de reserva, channel managers, revenue management hotelero",
    rationale: "Hotel sin motor de reservas en su sitio: depende de las OTAs y paga su comisión.",
    decision_maker_titles: ["General Manager", "Revenue Manager", "Director of Sales", "Owner"],
    config: probe([], ["hotel_booking_engine"], { keywords: ["hotel", "hospitality", "resort"] }) },
  { id: "has_mobile_app", category: "web", kind: "site_probe", weight: 45,
    name: "Tiene app móvil propia",
    for_who: "Analítica de apps, QA, desarrollo móvil, engagement",
    rationale: "Enlaza su app en App Store o Google Play: tiene producto digital y equipo que lo mantiene.",
    decision_maker_titles: IT_TITLES,
    config: probe(["any_mobile_app"]) },

  // ── Correo, seguridad y cumplimiento ─────────────────────────────────────
  { id: "no_dmarc", category: "it_compliance", kind: "site_probe", weight: 65,
    name: "Dominio sin DMARC",
    for_who: "Ciberseguridad, entregabilidad de correo, Google Workspace / Microsoft 365",
    rationale: "Su dominio no publica DMARC: cualquiera puede suplantar su correo y sus envíos caen en spam (Google y Yahoo ya lo exigen).",
    decision_maker_titles: IT_TITLES,
    config: probe([], ["dmarc"]) },
  { id: "dmarc_not_enforced", category: "it_compliance", kind: "site_probe", weight: 55,
    name: "DMARC sin bloquear (p=none)",
    for_who: "Seguridad de correo, consultoría de entregabilidad",
    rationale: "Publica DMARC pero en modo observación: la suplantación de su dominio no se bloquea.",
    decision_maker_titles: IT_TITLES,
    config: probe(["dmarc"], ["dmarc_enforced"]) },
  { id: "self_hosted_mail", category: "it_compliance", kind: "site_probe", weight: 55,
    name: "Correo sin Google ni Microsoft",
    for_who: "Migraciones a Google Workspace o Microsoft 365, productividad",
    rationale: "Los registros MX de su dominio no apuntan a Google, Microsoft ni Zoho: correo en hosting propio o compartido.",
    decision_maker_titles: IT_TITLES,
    config: probe([], ["any_corporate_email"]) },
  { id: "google_workspace_users", category: "it_compliance", kind: "site_probe", weight: 45,
    name: "Usa Google Workspace",
    for_who: "Partners de Google Cloud, apps del Marketplace de Workspace, seguridad",
    rationale: "Su correo corre en Google Workspace (registros MX del dominio).",
    decision_maker_titles: IT_TITLES,
    config: probe(["google_workspace"]) },
  { id: "microsoft_365_users", category: "it_compliance", kind: "site_probe", weight: 45,
    name: "Usa Microsoft 365",
    for_who: "Partners de Microsoft, Copilot, seguridad y backup de M365",
    rationale: "Su correo corre en Microsoft 365 (registros MX o TXT del dominio).",
    decision_maker_titles: IT_TITLES,
    config: probe(["microsoft_365"]) },
  { id: "trackers_no_consent", category: "it_compliance", kind: "site_probe", weight: 50,
    name: "Píxeles de anuncios sin banner de cookies",
    for_who: "Gestión de consentimiento, cumplimiento de protección de datos, legaltech",
    rationale: "Rastrea con píxeles de publicidad sin herramienta de consentimiento: riesgo con las leyes de datos personales.",
    decision_maker_titles: ["Legal Director", "Data Protection Officer", "Marketing Director", "IT Manager"],
    config: probe(["any_ads_pixel"], ["any_consent"]) },
  { id: "form_no_privacy", category: "it_compliance", kind: "site_probe", weight: 50,
    name: "Recoge datos sin aviso de privacidad",
    for_who: "Cumplimiento de protección de datos, legaltech",
    rationale: "Tiene formulario que pide correo pero ningún enlace a aviso o política de privacidad en la portada.",
    decision_maker_titles: ["Legal Director", "Data Protection Officer", "Chief Executive Officer"],
    config: probe(["contact_form"], ["privacy_policy"]) },

  // ── Crecimiento y expansión ──────────────────────────────────────────────
  { id: "franchise_program", category: "expansion", kind: "site_probe", weight: 60,
    name: "Vende franquicias",
    for_who: "Software para franquicias y multi-sucursal, capacitación, estandarización",
    rationale: "Ofrece franquicias en su sitio: está creciendo por unidades y necesita estandarizar operación y ventas.",
    decision_maker_titles: CEO_TITLES,
    config: probe(["franchise_program"]) },
  { id: "distributor_network", category: "expansion", kind: "site_probe", weight: 55,
    name: "Busca distribuidores",
    for_who: "Portales de distribuidores, PRM, trade marketing, logística",
    rationale: "Recluta distribuidores o revendedores en su sitio: expande su canal indirecto.",
    decision_maker_titles: SALES_TITLES,
    config: probe(["distributor_program"]) },
  { id: "multi_branch", category: "expansion", kind: "site_probe", weight: 50,
    name: "Varias sucursales o tiendas físicas",
    for_who: "Software multi-sucursal, señalización digital, gestión de reseñas locales",
    rationale: "Tiene red de sucursales o localizador de tiendas: operación distribuida que hay que coordinar.",
    decision_maker_titles: OPS_TITLES,
    config: probe(["multi_branch"]) },
  { id: "multi_language", category: "expansion", kind: "site_probe", weight: 50,
    name: "Sitio en varios idiomas (vende fuera)",
    for_who: "Comercio exterior, logística internacional, pagos cross-border, localización",
    rationale: "Su sitio declara versiones en varios idiomas: vende o quiere vender en otros mercados.",
    decision_maker_titles: CEO_TITLES,
    config: probe(["multi_language"]) },
  { id: "expansion_news", category: "expansion", kind: "news", weight: 65,
    name: "Abre sucursales o llega a nuevos países",
    for_who: "Cualquier oferta que acompañe una expansión (tecnología, logística, staffing, inmuebles)",
    rationale: "Anunció aperturas, nuevas plantas o la llegada a otro país: presupuesto nuevo y procesos por montar.",
    decision_maker_titles: CEO_TITLES,
    config: { queries: ["empresa {industry} abre nuevas sucursales {country}", "{industry} anuncia expansión inversión nueva planta {country}", "{industry} llega a {country} apertura"], sources: ["prensa de negocios", "comunicados"], window_days: 90 } },
  { id: "ecommerce_launch_news", category: "expansion", kind: "news", weight: 60,
    name: "Lanzó su tienda online o llegó a un marketplace",
    for_who: "E-commerce, marketplaces, pagos, logística, marketing digital",
    rationale: "Anunció su canal online o su llegada a un marketplace: el canal es nuevo y todo está por resolver.",
    decision_maker_titles: ECOM_TITLES,
    config: { queries: ["{industry} lanza tienda en línea {country}", "marca {industry} llega a Mercado Libre {country}", "{industry} {country} inicia venta en línea e-commerce"], sources: ["prensa de e-commerce y retail"], window_days: 90 } },
  { id: "trade_fair_exhibitors", category: "expansion", kind: "web_footprint", weight: 55,
    name: "Expositores en ferias de su industria",
    for_who: "Ventas B2B, marketing de eventos, logística, exportación",
    rationale: "Aparecen como expositores en ferias de su sector: invierten en conseguir clientes y tienen presupuesto comercial.",
    decision_maker_titles: SALES_TITLES,
    config: { queries: ["lista de expositores feria {industry} {country} 2026", "expositores expo {industry} {country}"], sources: ["sitios oficiales de ferias", "directorios de expositores"] } },
  { id: "exporters_directory", category: "expansion", kind: "web_footprint", weight: 50,
    name: "Empresas exportadoras",
    for_who: "Logística internacional, pagos y cambio de divisas, certificaciones",
    rationale: "Figuran en directorios oficiales de exportadores: operan comercio exterior.",
    decision_maker_titles: ["Export Manager", "Chief Financial Officer", "Logistics Manager", "Chief Executive Officer"],
    config: { queries: ["directorio de exportadores {industry} {country}", "empresas exportadoras {industry} {country} listado"], sources: ["agencias de promoción de exportaciones", "cámaras de comercio"] } },
  { id: "funding_rounds", category: "expansion", kind: "funding", weight: 70,
    name: "Levantó una ronda de inversión",
    for_who: "Cualquier oferta B2B: hay presupuesto nuevo y presión por crecer",
    rationale: "Ronda de inversión en los últimos 90 días: dinero fresco y metas agresivas.",
    decision_maker_titles: CEO_TITLES,
    config: { window_days: 90 } },
  { id: "headcount_growth", category: "expansion", kind: "growth", weight: 60,
    name: "Plantilla +20 % en 6 meses",
    for_who: "Software de operación, RR. HH., ventas, infraestructura",
    rationale: "Crecer rápido rompe procesos: es el momento en que se compra lo que los ordena.",
    decision_maker_titles: CEO_TITLES,
    config: { months: 6, min_growth_pct: 20 } },

  // ── Talento y liderazgo ──────────────────────────────────────────────────
  { id: "careers_no_ats", category: "talent", kind: "site_probe", weight: 55,
    name: "Recluta sin sistema de reclutamiento",
    for_who: "ATS, HR tech, reclutamiento",
    rationale: "Tiene página de empleos pero ningún ATS detrás: las vacantes se gestionan por correo.",
    decision_maker_titles: HR_TITLES,
    config: probe(["careers_page"], ["any_ats"]) },
  { id: "ats_users", category: "talent", kind: "site_probe", weight: 45,
    name: "Usa un ATS (recluta en serio)",
    for_who: "Evaluaciones, employer branding, headhunting",
    rationale: "Publica vacantes con un sistema de reclutamiento: contrata con volumen y proceso.",
    decision_maker_titles: HR_TITLES,
    config: probe(["any_ats"]) },
  { id: "new_commercial_leader", category: "talent", kind: "leadership", weight: 70,
    name: "Nuevo líder comercial o de marketing",
    for_who: "Cualquier oferta de ventas, marketing o e-commerce",
    rationale: "Un CMO, CCO, VP de Ventas o Head de E-commerce con menos de 90 días: revisa proveedores para dejar huella.",
    decision_maker_titles: [],
    config: { titles: ["Chief Marketing Officer", "Chief Commercial Officer", "VP Sales", "VP Marketing", "Head of Ecommerce", "Chief Digital Officer"], max_days_in_role: 90 } },
  { id: "new_tech_leader", category: "talent", kind: "leadership", weight: 65,
    name: "Nuevo líder de tecnología",
    for_who: "Software, nube, ciberseguridad, consultoría TI",
    rationale: "Un CTO, CIO o CISO con menos de 90 días: hereda el stack y decide qué cambiar.",
    decision_maker_titles: [],
    config: { titles: ["Chief Technology Officer", "Chief Information Officer", "Chief Information Security Officer", "VP Engineering", "Head of IT"], max_days_in_role: 90 } },
  { id: "hiring_ecommerce", category: "talent", kind: "hiring", weight: 60,
    name: "Contrata para e-commerce o marketplaces",
    for_who: "Tecnología y servicios de e-commerce y marketplaces",
    rationale: "Abrió vacantes de e-commerce o marketplaces: el canal digital es prioridad este trimestre.",
    decision_maker_titles: ECOM_TITLES,
    config: { job_titles: ["Ecommerce Manager", "Marketplace Manager", "Ecommerce Specialist", "Ecommerce Analyst", "Key Account Manager Marketplaces"], min_jobs: 1, posted_within_days: 30 } },
  { id: "hiring_performance", category: "talent", kind: "hiring", weight: 60,
    name: "Contrata performance marketing",
    for_who: "Agencias de medios, herramientas de pauta y atribución",
    rationale: "Busca especialistas de pauta: invierte en anuncios y quiere más resultado por peso.",
    decision_maker_titles: MKT_TITLES,
    config: { job_titles: ["Performance Marketing Manager", "Paid Media Specialist", "Media Buyer", "Growth Marketing Manager", "Digital Marketing Specialist"], min_jobs: 1, posted_within_days: 30 } },
];

// ── Plantillas de consultas ─────────────────────────────────────────────────

const ML_SITE: Record<string, string> = {
  Mexico: "mercadolibre.com.mx", Argentina: "mercadolibre.com.ar", Colombia: "mercadolibre.com.co",
  Chile: "mercadolibre.cl", Peru: "mercadolibre.com.pe", Uruguay: "mercadolibre.com.uy",
  Ecuador: "mercadolibre.com.ec", Venezuela: "mercadolibre.com.ve", Brazil: "mercadolivre.com.br",
  "Costa Rica": "mercadolibre.co.cr", "Dominican Republic": "mercadolibre.com.do", Panama: "mercadolibre.com.pa",
  Guatemala: "mercadolibre.com.gt", Bolivia: "mercadolibre.com.bo", Paraguay: "mercadolibre.com.py",
};
const AMAZON_SITE: Record<string, string> = {
  Mexico: "amazon.com.mx", Brazil: "amazon.com.br", Spain: "amazon.es", "United States": "amazon.com",
  Canada: "amazon.ca", "United Kingdom": "amazon.co.uk", Germany: "amazon.de", France: "amazon.fr", Italy: "amazon.it",
};

/**
 * Rellena los marcadores de las consultas con el contexto. Una plantilla con
 * {country}/{ml_site}/{amazon_site} se repite por país (hasta 3); el total se
 * acota a 5 (el tope por ciclo del motor).
 */
export function expandQueries(templates: string[], countries: string[], industries: string[]): string[] {
  const industry = String(industries[0] || "").trim();
  const cs = countries.slice(0, 3);
  const fill = (tpl: string, c: string) => tpl
    .replace(/\{industry\}/g, industry)
    .replace(/\{country\}/g, c ? countryLabelEs(c) : "")
    .replace(/\{ml_site\}/g, ML_SITE[c] || "mercadolibre.com")
    .replace(/\{amazon_site\}/g, AMAZON_SITE[c] || "amazon.com")
    .replace(/\s+/g, " ").trim();
  // Una lista de variantes por plantilla; después se intercalan (la primera
  // de cada plantilla, luego la segunda…) para que el tope de 5 no se quede
  // con un solo ángulo repetido por país.
  const variants = templates.map((tpl) => {
    const perCountry = /\{(country|ml_site|amazon_site)\}/.test(tpl) && cs.length;
    return (perCountry ? cs : [""]).map((c) => fill(tpl, c)).filter(Boolean);
  });
  const out: string[] = [];
  for (let i = 0; out.length < 5 && variants.some((v) => v.length > i); i++) {
    for (const v of variants) {
      if (v[i] && !out.includes(v[i])) out.push(v[i]);
      if (out.length >= 5) break;
    }
  }
  return out;
}

/**
 * El planificador puede copiar una receta con sus marcadores: se rellenan
 * aquí, en código, con los países del plan y la industria del ICP.
 */
export function fillDetectorPlaceholders(det: NormalizedDetector, countries: string[], industries: string[]): NormalizedDetector {
  const q = det.config.queries;
  if (Array.isArray(q) && q.some((x) => /\{(country|industry|ml_site|amazon_site)\}/.test(String(x)))) {
    det.config = { ...det.config, queries: expandQueries(q.map(String), countries, industries) };
  }
  return det;
}

export function recipeById(id: unknown): RadarRecipe | null {
  return RADAR_RECIPES.find((r) => r.id === id) || null;
}

/** La receta como detector válido para este usuario (consultas con su país e industria). */
export function buildRecipeDetector(recipe: RadarRecipe, ctx: { countries: string[]; industries: string[] }): NormalizedDetector | null {
  const config: Record<string, unknown> = { ...recipe.config, recipe_id: recipe.id };
  if (Array.isArray(recipe.config.queries)) {
    config.queries = expandQueries(recipe.config.queries as string[], ctx.countries, ctx.industries);
  }
  return normalizeDetector({
    kind: recipe.kind,
    name: recipe.name,
    rationale: recipe.rationale,
    weight: recipe.weight,
    decision_maker_titles: recipe.decision_maker_titles,
    config,
  });
}

/** Lista compacta para el prompt del planificador: id, método y config exacta. */
export function recipesPromptBlock(available: (kind: DetectorKind) => boolean): string {
  const lines = RADAR_RECIPES.filter((r) => available(r.kind)).map((r) =>
    `- [${r.kind}] ${r.name} — for: ${r.for_who} — config: ${JSON.stringify(r.config)}`);
  return `\n\n=== PROVEN DETECTOR RECIPES (copy and adapt; placeholders {country} {industry} {ml_site} {amazon_site} are filled automatically) ===\n` +
    `Prefer a concrete recipe whose "for" matches what the seller sells over a vague news query. Adapt rules/keywords/titles to the seller. You may combine probe keys differently from these examples.\n` +
    lines.join("\n");
}
