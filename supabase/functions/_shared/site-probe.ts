/**
 * _shared/site-probe.ts — huella digital de una empresa leída directamente
 * de su sitio y de su dominio.
 *
 * Apollo sabe qué tecnologías usa una empresa para ~1.500 productos, pero
 * no responde las preguntas que de verdad venden: ¿tiene su dominio
 * verificado en Meta Business Manager? ¿su "WhatsApp" es un botón wa.me sin
 * ningún proceso detrás, o un bot rígido de menús? ¿vende en Mercado Libre,
 * Amazon o Rappi? ¿cobra con una pasarela local? ¿su dominio tiene DMARC?
 * Para eso se descarga la portada pública del sitio (GET, sin login, con
 * timeout) y, cuando la regla lo pide, se leen los registros DNS públicos
 * del dominio (TXT, MX y _dmarc por DNS sobre HTTPS). Todo determinista y
 * cubierto por deno test: una regla mal escrita mandaría cientos de
 * empresas al feed.
 *
 * Solo la portada, solo una vez por ciclo y con límite de concurrencia:
 * es un GET a una página pública, el mismo que hace cualquier navegador.
 * Lo que un sitio carga después por Tag Manager no se ve en el HTML: por
 * eso las reglas "sin X" son más fiables con herramientas que se instalan
 * en el código (widgets, píxeles, enlaces) que con las que se inyectan.
 */

export type TechCategory =
  | "ads" | "meta" | "social" | "analytics"
  | "whatsapp" | "chatbot" | "chat"
  | "marketplace" | "delivery" | "app" | "ecommerce" | "payments" | "shipping"
  | "email_marketing" | "reviews" | "crm" | "booking" | "recruiting" | "consent"
  | "cms" | "email_infra" | "saas" | "site";

export interface TechRule {
  key: string;
  label: string;          // para la tarjeta, en español
  category: TechCategory;
  /** Patrones contra el HTML de la portada: cualquiera que matchee = presente. */
  patterns?: RegExp[];
  /**
   * Patrones contra los registros DNS públicos del dominio, una línea por
   * registro: `TXT "…"`, `MX 10 aspmx.l.google.com.`, `DMARC "v=DMARC1; …"`.
   */
  dns?: RegExp[];
  /** Heurística sobre el HTML que no cabe en una regex (año del ©, formularios). */
  test?: (html: string, now: Date) => boolean;
}

export const CATEGORY_LABEL: Record<TechCategory, string> = {
  ads: "Publicidad", meta: "Meta", social: "Redes sociales", analytics: "Analítica",
  whatsapp: "WhatsApp", chatbot: "Chatbots", chat: "Chat en vivo",
  marketplace: "Marketplaces", delivery: "Apps de delivery", app: "App móvil",
  ecommerce: "Tienda online", payments: "Pagos", shipping: "Envíos",
  email_marketing: "Email marketing", reviews: "Reseñas", crm: "CRM y soporte",
  booking: "Agenda en línea", recruiting: "Reclutamiento", consent: "Cookies y privacidad",
  cms: "Sitio web", email_infra: "Correo del dominio", saas: "Herramientas verificadas",
  site: "Contenido del sitio",
};

/** Enlace (href) a un dominio, con o sin subdominio. `dom` es un fragmento de regex. */
function href(dom: string, path = ""): RegExp {
  return new RegExp(`href=["']?https?:\\/\\/(?:[a-z0-9-]+\\.)*${dom}${path}`, "i");
}
/** Recurso cargado desde un dominio (script, iframe, imagen, link). */
function asset(dom: string): RegExp {
  return new RegExp(`(?:src|href|data-src)=["']?(?:https?:)?\\/\\/(?:[a-z0-9-]+\\.)*${dom}`, "i");
}

/**
 * Sitio desactualizado: el año más reciente del © tiene 3 años o más. Si el
 * año lo escribe un script (getFullYear) no se puede saber y no matchea.
 */
function staleCopyright(html: string, now: Date): boolean {
  if (/getFullYear\s*\(/.test(html)) return false;
  const re = /(?:©|&copy;|&#169;|copyright)\s*(?:<[^>]{0,40}>\s*)?(?:(?:19|20)\d{2}\s*(?:-|–|&ndash;|&#8211;|al|a)\s*)?((?:19|20)\d{2})/gi;
  const year = now.getUTCFullYear();
  let max = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(html)) && n++ < 40) {
    const y = Number(m[1]);
    if (y <= year + 1 && y > max) max = y;
  }
  return max >= 1995 && max <= year - 3;
}

function hasEmailForm(html: string): boolean {
  return /<form\b/i.test(html) && /type=["']?email\b/i.test(html);
}

export const TECH_RULES: TechRule[] = [
  // ── Publicidad ────────────────────────────────────────────────────────────
  { key: "meta_pixel", label: "Píxel de Meta", category: "ads",
    patterns: [/connect\.facebook\.net\/[a-z_-]+\/fbevents\.js/i, /\bfbq\s*\(\s*['"]init['"]/i] },
  { key: "google_ads_tag", label: "Etiqueta de Google Ads", category: "ads",
    patterns: [/googletagmanager\.com\/gtag\/js\?id=AW-/i, /gtag\s*\(\s*['"]config['"]\s*,\s*['"]AW-/i, /googleads\.g\.doubleclick\.net/i] },
  { key: "tiktok_pixel", label: "Píxel de TikTok", category: "ads",
    patterns: [/analytics\.tiktok\.com\/i18n\/pixel/i, /\bttq\.load\s*\(/i] },
  { key: "linkedin_insight", label: "Insight Tag de LinkedIn", category: "ads",
    patterns: [/snap\.licdn\.com\/li\.lms-analytics/i, /_linkedin_partner_id/i] },
  { key: "bing_uet", label: "Microsoft Ads (UET)", category: "ads", patterns: [/bat\.bing\.com\/bat\.js/i] },
  { key: "pinterest_tag", label: "Etiqueta de Pinterest", category: "ads", patterns: [/s\.pinimg\.com\/ct\/core\.js/i, /\bpintrk\s*\(/i] },
  { key: "snap_pixel", label: "Píxel de Snapchat", category: "ads", patterns: [/sc-static\.net\/scevent\.min\.js/i] },
  { key: "x_pixel", label: "Píxel de X (Twitter)", category: "ads", patterns: [/static\.ads-twitter\.com\/uwt\.js/i, /\btwq\s*\(\s*['"]init['"]/i] },
  { key: "criteo", label: "Criteo (retargeting)", category: "ads", patterns: [/static\.criteo\.net\/js\/ld\/ld\.js/i, /dynamic\.criteo\.com/i] },

  // ── Meta (Business Manager y canales) ────────────────────────────────────
  { key: "meta_domain_verification", label: "Dominio verificado en Meta Business Manager", category: "meta",
    patterns: [/<meta[^>]+name=["']facebook-domain-verification["']/i],
    dns: [/^TXT\s+"?facebook-domain-verification=/im] },
  { key: "messenger_chat", label: "Chat de Facebook Messenger", category: "meta",
    patterns: [/xfbml\.customerchat\.js/i, /class=["'][^"']*fb-customerchat/i, href("m\\.me", "\\/[A-Za-z0-9.]")] },
  { key: "instagram_shop", label: "Tienda de Instagram / Facebook Shops", category: "meta",
    patterns: [/instagram\.com\/[A-Za-z0-9._]+\/shop/i, /facebook\.com\/[A-Za-z0-9.]+\/shop\b/i, /commerce\.facebook\.com/i] },

  // ── Redes sociales (enlaces a sus perfiles) ──────────────────────────────
  { key: "facebook_page", label: "Página de Facebook", category: "social",
    patterns: [/href=["']?https?:\/\/(?:www\.|m\.|web\.|[a-z]{2}-[a-z]{2}\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr[?/]|login|privacy|policies|help)[A-Za-z0-9.\-]{3,}/i] },
  { key: "instagram_profile", label: "Perfil de Instagram", category: "social",
    patterns: [/href=["']?https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|explore|accounts)[A-Za-z0-9._]{2,}/i] },
  { key: "tiktok_profile", label: "Perfil de TikTok", category: "social", patterns: [/href=["']?https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9._]+/i] },
  { key: "youtube_channel", label: "Canal de YouTube", category: "social",
    patterns: [/href=["']?https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|c\/|user\/|@)[A-Za-z0-9_\-]+/i] },
  { key: "linkedin_page", label: "Página de LinkedIn", category: "social", patterns: [/href=["']?https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\//i] },
  { key: "x_profile", label: "Perfil de X (Twitter)", category: "social",
    patterns: [/href=["']?https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!share|intent|home|search)[A-Za-z0-9_]{2,}/i] },

  // ── Analítica y optimización ─────────────────────────────────────────────
  { key: "gtm", label: "Google Tag Manager", category: "analytics",
    patterns: [/googletagmanager\.com\/gtm\.js/i, /GTM-[A-Z0-9]{4,}/] },
  { key: "ga4", label: "Google Analytics", category: "analytics",
    patterns: [/googletagmanager\.com\/gtag\/js\?id=G-/i, /google-analytics\.com\/(analytics|ga)\.js/i, /gtag\s*\(\s*['"]config['"]\s*,\s*['"](G|UA)-/i] },
  { key: "hotjar", label: "Hotjar", category: "analytics", patterns: [/static\.hotjar\.com/i, /\bhjid\s*:/i] },
  { key: "clarity", label: "Microsoft Clarity", category: "analytics", patterns: [/clarity\.ms\/tag\//i] },
  { key: "mixpanel", label: "Mixpanel", category: "analytics", patterns: [/cdn\.mxpnl\.com/i, /mixpanel\.init\s*\(/i] },
  { key: "segment", label: "Segment", category: "analytics", patterns: [/cdn\.segment\.(com|io)\/analytics\.js/i] },
  { key: "amplitude", label: "Amplitude", category: "analytics", patterns: [/cdn\.amplitude\.com/i] },
  { key: "heap", label: "Heap", category: "analytics", patterns: [/cdn\.heapanalytics\.com/i] },
  { key: "ab_testing", label: "Pruebas A/B (VWO, Optimizely)", category: "analytics", patterns: [/visualwebsiteoptimizer\.com/i, /cdn\.optimizely\.com/i] },
  { key: "push_notifications", label: "Notificaciones push (OneSignal…)", category: "analytics", patterns: [/cdn\.onesignal\.com/i, /pushengage\.com/i, /cdn\.pushalert\.co/i] },

  // ── WhatsApp: botón manual y plataformas ─────────────────────────────────
  { key: "whatsapp_click_to_chat", label: "Botón de WhatsApp (wa.me / api.whatsapp)", category: "whatsapp",
    patterns: [/https?:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)\//i, /whatsapp:\/\/send/i] },
  { key: "whatsapp_widget", label: "Botón flotante de WhatsApp (plugin)", category: "whatsapp",
    patterns: [/elfsight\.com\/(whatsapp|platform)/i, /getbutton\.io/i, /joinchat/i, /wa-chat|whatsapp-chat|chaty\b/i, /static\.elfsight/i] },
  { key: "wati", label: "WATI", category: "whatsapp", patterns: [/wati\.io\/|wati-chat|watiWidget/i] },
  { key: "manychat", label: "ManyChat", category: "whatsapp", patterns: [/widget\.manychat\.com/i, /mcwidget/i] },
  { key: "respond_io", label: "Respond.io", category: "whatsapp", patterns: [/respond\.io\/widget|cdn\.respond\.io/i] },
  { key: "kommo", label: "Kommo (amoCRM)", category: "whatsapp", patterns: [/kommo\.com\/|amocrm\.(ru|com)\/js/i] },
  { key: "botmaker", label: "Botmaker", category: "whatsapp", patterns: [/botmaker\.com/i] },
  { key: "treble", label: "Treble", category: "whatsapp", patterns: [/treble\.ai/i] },
  { key: "gupshup", label: "Gupshup", category: "whatsapp", patterns: [/gupshup\.io/i] },
  { key: "zenvia", label: "Zenvia", category: "whatsapp", patterns: [/zenvia\.com/i] },
  { key: "b2chat", label: "B2Chat", category: "whatsapp", patterns: [/b2chat\.io/i] },
  { key: "leadsales", label: "Leadsales", category: "whatsapp", patterns: [/leadsales\.(io|services|com)/i] },
  { key: "blip", label: "Blip (Take)", category: "whatsapp", patterns: [/blip\.ai\b|blipchat|take\.net/i] },
  { key: "yalo", label: "Yalo", category: "whatsapp", patterns: [/yalo\.(ai|com)\b/i] },
  { key: "sirena", label: "Sirena", category: "whatsapp", patterns: [/sirena\.app/i] },
  { key: "callbell", label: "Callbell", category: "whatsapp", patterns: [/callbell\.eu/i] },
  { key: "chattigo", label: "Chattigo", category: "whatsapp", patterns: [/chattigo\.com/i] },
  { key: "octadesk", label: "Octadesk", category: "whatsapp", patterns: [/octadesk\.com/i] },
  { key: "trengo", label: "Trengo", category: "whatsapp", patterns: [/trengo\.(eu|com)/i] },
  { key: "sleekflow", label: "SleekFlow", category: "whatsapp", patterns: [/sleekflow\.io/i] },
  { key: "infobip", label: "Infobip", category: "whatsapp", patterns: [/infobip\.com/i] },
  { key: "twilio", label: "Twilio", category: "whatsapp", patterns: [/twilio\.com\/|twilio-flex|media\.twiliocdn\.com/i] },
  { key: "wasapi", label: "Wasapi", category: "whatsapp", patterns: [/wasapi\.io/i] },
  { key: "gallabox", label: "Gallabox / Zoko / Interakt", category: "whatsapp", patterns: [/gallabox\.com|zoko\.io|interakt\.(ai|shop)/i] },

  // ── Chatbots: rígidos (menús) y con IA ───────────────────────────────────
  { key: "chatbot_rules", label: "Chatbot de menús (Landbot, Typebot, Chatfuel…)", category: "chatbot",
    patterns: [/landbot\.io/i, /typebot\.io/i, /chatfuel\.com/i, /botsify\.com/i, /collect\.chat/i, /hellotars\.com/i, /chatcompose\.com/i] },
  { key: "cliengo", label: "Cliengo", category: "chatbot", patterns: [/cliengo\.com/i] },
  { key: "aivo", label: "Aivo", category: "chatbot", patterns: [/aivo\.co\b|aivochat/i] },
  { key: "chatbot_ai", label: "Chatbot con IA", category: "chatbot",
    patterns: [/voiceflow\.com\/widget|cdn\.botpress\.cloud|chatbase\.co\/embed|kapa\.ai|cdn\.aidbase|chatling\.ai|sitegpt\.ai|customgpt\.ai|dante-ai\.com|chatsimple\.ai/i] },

  // ── Chat en vivo ─────────────────────────────────────────────────────────
  { key: "intercom", label: "Intercom", category: "chat", patterns: [/widget\.intercom\.io|intercomSettings/i] },
  { key: "drift", label: "Drift", category: "chat", patterns: [/js\.driftt\.com|drift\.load\(/i] },
  { key: "zendesk", label: "Zendesk", category: "chat", patterns: [/static\.zdassets\.com|zopim\.com/i], dns: [/^TXT\s+"?v=spf1[^\n]*mail\.zendesk\.com/im] },
  { key: "tidio", label: "Tidio", category: "chat", patterns: [/code\.tidio\.co/i] },
  { key: "crisp", label: "Crisp", category: "chat", patterns: [/client\.crisp\.chat|\$crisp/i] },
  { key: "freshchat", label: "Freshchat", category: "chat", patterns: [/wchat\.freshchat\.com|freshchat\.com\/js/i] },
  { key: "tawk", label: "tawk.to", category: "chat", patterns: [/embed\.tawk\.to/i] },
  { key: "livechat", label: "LiveChat", category: "chat", patterns: [/cdn\.livechatinc\.com/i] },
  { key: "jivochat", label: "JivoChat", category: "chat", patterns: [/code\.jivosite\.com|jivochat/i] },
  { key: "olark", label: "Olark", category: "chat", patterns: [/static\.olark\.com/i] },
  { key: "smartsupp", label: "Smartsupp", category: "chat", patterns: [/smartsuppchat\.com/i] },
  { key: "chatwoot", label: "Chatwoot", category: "chat", patterns: [/chatwoot/i] },
  { key: "userlike", label: "Userlike", category: "chat", patterns: [/userlike-cdn-widgets|userlike\.com\//i] },

  // ── Marketplaces (enlaces a su tienda) ───────────────────────────────────
  { key: "mercadolibre", label: "Mercado Libre", category: "marketplace",
    patterns: [href("mercadoli(?:b|v)re\\.(?:com|cl|co|pe|com\\.[a-z]{2})"), href("mercadoshops\\.com")] },
  { key: "amazon", label: "Amazon", category: "marketplace",
    patterns: [href("amazon\\.(?:com|com\\.mx|com\\.br|es|ca|co\\.uk|de)", "\\/(?:stores|s\\?|sp\\?|shops|[^\"' ]*\\/dp\\/)"), /href=["']?https?:\/\/(?:amzn\.to|a\.co)\//i] },
  { key: "shopee", label: "Shopee", category: "marketplace", patterns: [href("shopee\\.(?:com\\.mx|com\\.br|cl|com\\.co|co)")] },
  { key: "falabella", label: "Falabella", category: "marketplace", patterns: [href("falabella\\.com(?:\\.[a-z]{2})?")] },
  { key: "walmart", label: "Walmart Marketplace", category: "marketplace", patterns: [href("walmart\\.com(?:\\.mx)?", "\\/(?:seller|tienda|browse|ip|search)")] },
  { key: "liverpool", label: "Liverpool", category: "marketplace", patterns: [href("liverpool\\.com\\.mx")] },
  { key: "coppel", label: "Coppel", category: "marketplace", patterns: [href("coppel\\.com")] },
  { key: "ripley", label: "Ripley / Paris", category: "marketplace", patterns: [href("ripley\\.(?:cl|com\\.pe)"), href("paris\\.cl")] },
  { key: "linio", label: "Linio", category: "marketplace", patterns: [href("linio\\.com(?:\\.[a-z]{2})?")] },
  { key: "magalu", label: "Magalu / Americanas", category: "marketplace", patterns: [href("magazineluiza\\.com\\.br"), href("magalu\\.com"), href("americanas\\.com\\.br")] },
  { key: "aliexpress", label: "AliExpress", category: "marketplace", patterns: [href("aliexpress\\.(?:com|us)")] },
  { key: "dafiti", label: "Dafiti", category: "marketplace", patterns: [href("dafiti\\.(?:com\\.br|com\\.co|cl|com\\.ar)")] },
  { key: "claro_shop", label: "Claro Shop / Sanborns", category: "marketplace", patterns: [href("claroshop\\.com"), href("sanborns\\.com\\.mx")] },

  // ── Apps de delivery ─────────────────────────────────────────────────────
  { key: "rappi", label: "Rappi", category: "delivery", patterns: [href("rappi\\.com(?:\\.[a-z]{2})?")] },
  { key: "pedidosya", label: "PedidosYa", category: "delivery", patterns: [href("pedidosya\\.com(?:\\.[a-z]{2})?")] },
  { key: "ifood", label: "iFood", category: "delivery", patterns: [href("ifood\\.com\\.br")] },
  { key: "ubereats", label: "Uber Eats", category: "delivery", patterns: [href("ubereats\\.com")] },
  { key: "didi_food", label: "DiDi Food", category: "delivery", patterns: [href("didi-food\\.com"), href("food\\.didi")] },

  // ── App móvil propia ─────────────────────────────────────────────────────
  { key: "app_store", label: "App en App Store", category: "app", patterns: [/apps\.apple\.com\/[a-z]{2}\/app\//i, /itunes\.apple\.com\/[a-z]{2}\/app\//i] },
  { key: "google_play", label: "App en Google Play", category: "app", patterns: [/play\.google\.com\/store\/apps\/details/i] },

  // ── Plataformas de tienda online ─────────────────────────────────────────
  { key: "shopify", label: "Shopify", category: "ecommerce", patterns: [/cdn\.shopify\.com|Shopify\.theme/i] },
  { key: "woocommerce", label: "WooCommerce", category: "ecommerce", patterns: [/woocommerce/i] },
  { key: "vtex", label: "VTEX", category: "ecommerce", patterns: [/vtexassets\.com|vteximg\.com\.br|vtexcommercestable/i] },
  { key: "magento", label: "Magento", category: "ecommerce", patterns: [/Magento_|mage\/cookies|\/static\/version\d+\/frontend\//i] },
  { key: "tiendanube", label: "Tiendanube", category: "ecommerce", patterns: [/tiendanube\.com|nuvemshop\.com\.br/i] },
  { key: "prestashop", label: "PrestaShop", category: "ecommerce", patterns: [/prestashop/i] },
  { key: "bigcommerce", label: "BigCommerce", category: "ecommerce", patterns: [/cdn\d*\.bigcommerce\.com/i] },
  { key: "jumpseller", label: "Jumpseller", category: "ecommerce", patterns: [/jumpseller\.com|assets\.jumpseller/i] },
  { key: "ecwid", label: "Ecwid", category: "ecommerce", patterns: [/app\.ecwid\.com|ecwid\.com\/script/i] },
  { key: "salesforce_commerce", label: "Salesforce Commerce Cloud", category: "ecommerce", patterns: [/demandware\.(static|net|store)/i] },
  { key: "online_store", label: "Carrito de compras en el sitio", category: "ecommerce",
    patterns: [/(agregar|añadir|anadir) al carrito|add to cart|adicionar ao carrinho|comprar ahora/i] },

  // ── Pagos ────────────────────────────────────────────────────────────────
  { key: "mercadopago", label: "Mercado Pago", category: "payments", patterns: [/sdk\.mercadopago\.com|mercadopago\.com\/checkout/i] },
  { key: "stripe", label: "Stripe", category: "payments", patterns: [/js\.stripe\.com/i], dns: [/^TXT\s+"?stripe-verification=/im] },
  { key: "paypal", label: "PayPal", category: "payments", patterns: [/paypal\.com\/sdk\/js|paypalobjects\.com/i] },
  { key: "payu", label: "PayU", category: "payments", patterns: [/payulatam\.com|checkout\.payu/i] },
  { key: "openpay", label: "Openpay", category: "payments", patterns: [/openpay\.(mx|co|pe)\b|openpay\.js/i] },
  { key: "conekta", label: "Conekta", category: "payments", patterns: [/conekta\.(io|com)/i] },
  { key: "kushki", label: "Kushki", category: "payments", patterns: [/kushkipagos\.com|cdn\.kushki/i] },
  { key: "wompi", label: "Wompi", category: "payments", patterns: [/wompi\.(co|com)\b/i] },
  { key: "culqi", label: "Culqi", category: "payments", patterns: [/culqi\.com/i] },
  { key: "niubiz", label: "Niubiz / Izipay", category: "payments", patterns: [/niubiz\.com\.pe|vnforapps\.com|izipay\.pe|micuentaweb\.pe/i] },
  { key: "epayco", label: "ePayco", category: "payments", patterns: [/epayco\.(co|com)\b/i] },
  { key: "transbank", label: "Webpay (Transbank) / Flow", category: "payments", patterns: [/transbank\.cl|webpay\.cl|www\.flow\.cl/i] },
  { key: "clip", label: "Clip", category: "payments", patterns: [/payclip|clip\.mx/i] },
  { key: "dlocal", label: "dLocal / EBANX", category: "payments", patterns: [/dlocal(go)?\.com|ebanx\.com/i] },
  { key: "pagseguro", label: "PagSeguro / PagBank", category: "payments", patterns: [/pagseguro\.uol|pagbank/i] },
  { key: "adyen", label: "Adyen", category: "payments", patterns: [/checkoutshopper-[a-z]+\.adyen\.com|adyen\.com\/checkout/i] },
  { key: "bnpl", label: "Compra ahora, paga después (Addi, Kueski, Aplazo…)", category: "payments",
    patterns: [/addi\.com|kueskipay|kueski\.com|aplazo\.mx|atrato\.mx|sistecredito/i] },

  // ── Envíos ───────────────────────────────────────────────────────────────
  { key: "shipping_platform", label: "Plataforma de envíos (Envia, Skydropx, 99minutos…)", category: "shipping",
    patterns: [/envia\.com\b|skydropx|99minutos|shipit\.cl|enviame\.io|melhorenvio|aftership\.com|shipbob|17track/i] },
  { key: "order_tracking", label: "Rastreo de pedidos en el sitio", category: "shipping",
    patterns: [/rastrea tu (pedido|env[ií]o|orden)|seguimiento de (tu )?(pedido|env[ií]o|orden)|track your order|rastreie seu pedido/i] },

  // ── Email marketing ──────────────────────────────────────────────────────
  { key: "klaviyo", label: "Klaviyo", category: "email_marketing", patterns: [/static\.klaviyo\.com|klaviyo\.com\/onsite/i] },
  { key: "mailchimp", label: "Mailchimp", category: "email_marketing", patterns: [/chimpstatic\.com|list-manage\.com/i], dns: [/^TXT\s+"?v=spf1[^\n]*(servers\.mcsv\.net|spf\.mandrillapp\.com)/im] },
  { key: "rd_station", label: "RD Station", category: "email_marketing", patterns: [/rdstation\.com|d335luupugsy2\.cloudfront\.net/i] },
  { key: "activecampaign", label: "ActiveCampaign", category: "email_marketing", patterns: [/activehosted\.com|trackcmp\.net/i] },
  { key: "brevo", label: "Brevo (Sendinblue)", category: "email_marketing", patterns: [/sibforms\.com|sendinblue\.com|brevo\.com/i], dns: [/^TXT\s+"?brevo-code:/im] },
  { key: "doppler", label: "Doppler", category: "email_marketing", patterns: [/fromdoppler\.com/i] },
  { key: "emblue", label: "emBlue", category: "email_marketing", patterns: [/embluemail\.com|emblue\.com/i] },
  { key: "perfit", label: "Perfit", category: "email_marketing", patterns: [/perfit\.(com\.ar|io)|perfitapp/i] },
  { key: "omnisend", label: "Omnisend", category: "email_marketing", patterns: [/omnisend(cdn)?\.com|omnisrc\.com/i] },
  { key: "mailerlite", label: "MailerLite", category: "email_marketing", patterns: [/mailerlite\.com|mlcdn\.com/i] },

  // ── Reseñas ──────────────────────────────────────────────────────────────
  { key: "reviews_widget", label: "Reseñas de clientes (Trustpilot, Yotpo, Judge.me…)", category: "reviews",
    patterns: [/widget\.trustpilot\.com|staticw2\.yotpo\.com|yotpo\.com\/|judge\.me|judgeme|reviews\.io|okendo\.io|stamped\.io|elfsight\.com\/google-reviews/i] },

  // ── CRM y soporte ────────────────────────────────────────────────────────
  { key: "hubspot_chat", label: "HubSpot", category: "crm",
    patterns: [/js\.hs-scripts\.com|js\.hsforms\.net|hs-analytics\.net|hubspot\.com\/.*\/conversations/i],
    dns: [/^TXT\s+"?v=spf1[^\n]*hubspotemail\.net/im, /^TXT\s+"?hubspot-developer-verification=/im] },
  { key: "pipedrive", label: "Pipedrive", category: "crm", patterns: [/webforms\.pipedrive\.com|leadbooster-chat\.pipedrive\.com/i] },
  { key: "salesforce", label: "Salesforce", category: "crm",
    patterns: [/salesforceliveagent\.com|force\.com\/|pardot\.com/i], dns: [/^TXT\s+"?v=spf1[^\n]*_spf\.salesforce\.com/im] },
  { key: "zoho", label: "Zoho", category: "crm", patterns: [/salesiq\.zoho|zohopublic|zoho\.com\/crm/i] },
  { key: "bitrix24", label: "Bitrix24", category: "crm", patterns: [/bitrix24\.(com|es|mx|com\.br)|cdn-ru\.bitrix24/i] },
  { key: "freshworks", label: "Freshdesk / Freshsales", category: "crm", patterns: [/freshdesk\.com|freshsales\.io|myfreshworks\.com/i] },

  // ── Agenda en línea ──────────────────────────────────────────────────────
  { key: "calendly", label: "Calendly", category: "booking", patterns: [/assets\.calendly\.com|calendly\.com\/[a-z0-9-]+/i] },
  { key: "hubspot_meetings", label: "HubSpot Meetings", category: "booking", patterns: [/meetings\.hubspot\.com/i] },
  { key: "booking_widget", label: "Agenda en línea (AgendaPro, Doctoralia, Fresha, Cal.com…)", category: "booking",
    patterns: [/agendapro\.com|reservo\.cl|doctoralia\.|docplanner|fresha\.com|booksy\.com|simplybook\.(me|it)|cal\.com\/|acuityscheduling\.com|calendar\.app\.google|calendar\.google\.com\/calendar\/appointments|setmore\.com|youcanbook\.me/i] },
  { key: "restaurant_booking", label: "Reservas de restaurante (OpenTable…)", category: "booking", patterns: [/opentable\.(com|com\.mx)|resy\.com|covermanager\.com|meitre\.app/i] },
  { key: "hotel_booking_engine", label: "Motor de reservas hotelero", category: "booking",
    patterns: [/cloudbeds\.com|siteminder\.com|thebookingbutton|mews\.(li|com)\/distributor|simplebooking\.it|omnibees|bookassist|synxis\.com/i] },

  // ── Reclutamiento ────────────────────────────────────────────────────────
  { key: "ats", label: "Sistema de reclutamiento (Greenhouse, Lever, Teamtailor…)", category: "recruiting",
    patterns: [/boards\.greenhouse\.io|jobs\.lever\.co|apply\.workable\.com|teamtailor\.com|bamboohr\.com\/(jobs|careers)|recruitee\.com|breezy\.hr|hiringroom\.com|gupy\.io|buk\.(cl|co|mx|pe)\/trabaja|jobvite\.com|smartrecruiters\.com/i] },
  { key: "job_board_link", label: "Vacantes en bolsas de empleo (Computrabajo, Bumeran, OCC…)", category: "recruiting",
    patterns: [href("computrabajo\\.com"), href("bumeran\\.com"), href("occ\\.com\\.mx"), href("elempleo\\.com"), href("laborum\\.cl"), href("trabajando\\.com")] },

  // ── Cookies y privacidad ─────────────────────────────────────────────────
  { key: "cookie_consent", label: "Banner de cookies (Cookiebot, OneTrust…)", category: "consent",
    patterns: [/consent\.cookiebot\.com|cdn\.cookielaw\.org|onetrust|cookieyes\.com|cdn-cookieyes|complianz|cookie-law-info|iubenda\.com|termly\.io|usercentrics/i] },

  // ── Cómo está hecho el sitio ─────────────────────────────────────────────
  { key: "wordpress", label: "WordPress", category: "cms", patterns: [/wp-content\/|wp-includes\//i] },
  { key: "wix", label: "Wix", category: "cms", patterns: [/static\.parastorage\.com|wix\.com\//i] },
  { key: "squarespace", label: "Squarespace", category: "cms", patterns: [/squarespace\.com|static1\.squarespace/i] },
  { key: "webflow", label: "Webflow", category: "cms", patterns: [/webflow\.com|data-wf-site/i] },
  { key: "godaddy_builder", label: "GoDaddy Website Builder", category: "cms", patterns: [/img1\.wsimg\.com|godaddysites/i] },
  { key: "jimdo_weebly", label: "Jimdo / Weebly / Google Sites", category: "cms", patterns: [/jimdo(cdn)?\.com|jimstatic|editmysite\.com|weebly\.com|sites\.google\.com/i] },
  { key: "joomla_drupal", label: "Joomla / Drupal", category: "cms", patterns: [/\/media\/jui\/|content=["']Joomla|drupal-settings-json|\/sites\/default\/files\//i] },
  { key: "framer", label: "Framer", category: "cms", patterns: [/framerusercontent\.com/i] },

  // ── Correo del dominio (DNS) ─────────────────────────────────────────────
  { key: "google_workspace", label: "Google Workspace", category: "email_infra",
    dns: [/^MX\s+\d+\s+(aspmx\.l\.google\.com|alt\d\.aspmx\.l\.google\.com|smtp\.google\.com|aspmx\d?\.googlemail\.com)/im] },
  { key: "microsoft_365", label: "Microsoft 365 (correo o tenant verificado)", category: "email_infra",
    dns: [/^MX\s+\d+\s+\S+\.mail\.protection\.outlook\.com/im, /^TXT\s+"?MS=ms\d+/im] },
  { key: "zoho_mail", label: "Zoho Mail", category: "email_infra", dns: [/^MX\s+\d+\s+mx\d*\.zoho\.(com|eu|in)/im] },
  { key: "spf", label: "Registro SPF", category: "email_infra", dns: [/^TXT\s+"?v=spf1/im] },
  { key: "dmarc", label: "Registro DMARC", category: "email_infra", dns: [/^DMARC\s+"?v=DMARC1/im] },
  { key: "dmarc_enforced", label: "DMARC que bloquea (quarantine/reject)", category: "email_infra",
    dns: [/^DMARC\s+"?v=DMARC1[^\n]*;\s*p=(quarantine|reject)/im] },
  { key: "email_sending_service", label: "Envío masivo de correo (SendGrid, Mailgun, Amazon SES)", category: "email_infra",
    dns: [/^TXT\s+"?v=spf1[^\n]*(sendgrid\.net|mailgun\.org|amazonses\.com|sparkpostmail\.com|mailjet\.com)/im] },

  // ── Herramientas que verificaron el dominio (DNS / meta) ─────────────────
  { key: "google_search_console", label: "Google Search Console", category: "saas",
    patterns: [/<meta[^>]+name=["']google-site-verification["']/i], dns: [/^TXT\s+"?google-site-verification=/im] },
  { key: "atlassian", label: "Atlassian (Jira / Confluence)", category: "saas", dns: [/^TXT\s+"?atlassian-domain-verification=/im] },
  { key: "docusign", label: "DocuSign", category: "saas", dns: [/^TXT\s+"?docusign=/im] },
  { key: "adobe", label: "Adobe (cuentas de empresa)", category: "saas", dns: [/^TXT\s+"?adobe-idp-site-verification=/im] },
  { key: "apple_business", label: "Apple (dominio verificado)", category: "saas", dns: [/^TXT\s+"?apple-domain-verification=/im] },
  { key: "zoom", label: "Zoom (cuenta de empresa)", category: "saas", dns: [/^TXT\s+"?ZOOM_verify_/im] },

  // ── Contenido del sitio ──────────────────────────────────────────────────
  { key: "mobile_viewport", label: "Sitio adaptado a celular", category: "site", patterns: [/<meta[^>]+name=["']viewport["']/i] },
  { key: "site_outdated", label: "Sitio desactualizado (© de hace 3+ años)", category: "site", test: staleCopyright },
  { key: "contact_form", label: "Formulario de contacto", category: "site", test: hasEmailForm },
  { key: "privacy_policy", label: "Aviso de privacidad", category: "site",
    patterns: [/aviso de privacidad|pol[ií]tica de privacidad|privacy policy|pol[ií]tica de (tratamiento|protecci[oó]n) de datos|pol[ií]tica de privacidade/i] },
  { key: "careers_page", label: "Página de empleos (Trabaja con nosotros)", category: "site",
    patterns: [/trabaj[ae] con nosotros|bolsa de trabajo|[uú]nete a nuestro equipo|trabalhe conosco|join our team|href=["'][^"']*\/(careers|empleos|vacantes|trabaja-con-nosotros)\b/i] },
  { key: "franchise_program", label: "Vende franquicias", category: "site",
    patterns: [/(adquiere|obt[eé]n|abre) tu franquicia|franquicias disponibles|informes de franquicia|seja um franqueado|franchise opportunit|href=["'][^"']*\/franquicias?\b/i] },
  { key: "distributor_program", label: "Red de distribuidores", category: "site",
    patterns: [/s[eé] distribuidor|hazte distribuidor|quiero ser distribuidor|distribuidores autorizados|red de distribuidores|seja um (revendedor|distribuidor)|become a (dealer|distributor|reseller)/i] },
  { key: "multi_branch", label: "Varias sucursales o tiendas físicas", category: "site",
    patterns: [/nuestras sucursales|encuentra tu (sucursal|tienda)|localiza tu tienda|store locator|nossas lojas|nuestras tiendas|href=["'][^"']*\/(sucursales|tiendas|ubicaciones)\b/i] },
  { key: "quote_request", label: "Pide cotizaciones en el sitio", category: "site",
    patterns: [/solicita (una |tu )?cotizaci[oó]n|cotiza (ahora|aqu[ií]|ya|tu)|pide (tu|una) cotizaci[oó]n|solicitar cotizaci[oó]n|request a quote|solicite (um )?or[cç]amento/i] },
  { key: "demo_cta", label: "Ofrece demos", category: "site",
    patterns: [/(agenda|solicita|pide|agendar|solicitar) (una |tu )?demo|book a demo|request a demo|agende uma demonstra/i] },
  { key: "pricing_page", label: "Página de precios", category: "site", patterns: [/href=["'][^"']*\/(precios|planes|pricing|plans|tarifas)\b/i] },
  { key: "multi_language", label: "Sitio en varios idiomas", category: "site", patterns: [/hreflang=["']?[a-z]{2}/i] },
  { key: "blog", label: "Blog", category: "site", patterns: [/href=["'][^"']*\/blog\b/i] },
  { key: "newsletter_signup", label: "Suscripción a newsletter", category: "site", patterns: [/suscr[ií]bete|newsletter|bolet[ií]n de noticias/i] },
];

const RULE_BY_KEY: Map<string, TechRule> = new Map(TECH_RULES.map((r) => [r.key, r]));
const keysOf = (...cats: TechCategory[]) => TECH_RULES.filter((r) => cats.includes(r.category)).map((r) => r.key);

const WHATSAPP_BUTTONS = ["whatsapp_click_to_chat", "whatsapp_widget"];
const WHATSAPP_PLATFORMS = keysOf("whatsapp").filter((k) => !WHATSAPP_BUTTONS.includes(k));

/** Grupos que las reglas del detector pueden nombrar en lugar de una clave. */
export const TECH_GROUPS: Record<string, string[]> = {
  any_ads_pixel: keysOf("ads"),
  any_social: keysOf("social"),
  any_analytics: keysOf("analytics"),
  any_whatsapp_button: WHATSAPP_BUTTONS,
  any_whatsapp_platform: WHATSAPP_PLATFORMS,
  // "Cualquier herramienta de WhatsApp" (plugin o plataforma). Histórico: así se escribieron los detectores de 2026-09.
  any_whatsapp_tool: ["whatsapp_widget", ...WHATSAPP_PLATFORMS],
  any_rule_bot: ["chatbot_rules", "cliengo", "manychat"],
  any_chatbot: [...keysOf("chatbot"), "manychat"],
  // Cualquier conversación en el sitio que no sea el botón de WhatsApp: chat en vivo, bots y Messenger.
  any_chat: [...keysOf("chat"), ...keysOf("chatbot"), "messenger_chat"],
  any_marketplace: keysOf("marketplace"),
  any_delivery_app: keysOf("delivery"),
  any_mobile_app: keysOf("app"),
  any_ecommerce: keysOf("ecommerce"),
  any_entry_ecommerce: ["woocommerce", "tiendanube", "jumpseller", "ecwid", "prestashop"],
  any_enterprise_ecommerce: ["vtex", "magento", "salesforce_commerce"],
  any_payments: keysOf("payments"),
  any_local_payments: keysOf("payments").filter((k) => !["stripe", "paypal", "adyen", "bnpl"].includes(k)),
  any_shipping: keysOf("shipping"),
  any_email_marketing: keysOf("email_marketing"),
  any_reviews: keysOf("reviews"),
  any_crm: keysOf("crm"),
  any_booking: keysOf("booking"),
  any_ats: keysOf("recruiting"),
  any_consent: keysOf("consent"),
  any_site_builder: ["wix", "squarespace", "godaddy_builder", "jimdo_weebly"],
  any_corporate_email: ["google_workspace", "microsoft_365", "zoho_mail"],
};

const GROUP_LABEL: Record<string, string> = {
  any_ads_pixel: "píxel de anuncios", any_social: "redes sociales", any_analytics: "analítica",
  any_whatsapp_button: "botón de WhatsApp", any_whatsapp_platform: "plataforma de WhatsApp",
  any_whatsapp_tool: "herramienta de WhatsApp", any_rule_bot: "chatbot de menús", any_chatbot: "chatbot",
  any_chat: "chat en vivo", any_marketplace: "marketplace", any_delivery_app: "app de delivery",
  any_mobile_app: "app móvil", any_ecommerce: "tienda online", any_entry_ecommerce: "tienda en plataforma de entrada",
  any_enterprise_ecommerce: "e-commerce enterprise", any_payments: "pasarela de pago",
  any_local_payments: "pasarela de pago local", any_shipping: "integración de envíos",
  any_email_marketing: "email marketing", any_reviews: "reseñas", any_crm: "CRM", any_booking: "agenda en línea",
  any_ats: "sistema de reclutamiento", any_consent: "banner de cookies", any_site_builder: "constructor de sitios",
  any_corporate_email: "correo de Google o Microsoft",
};

export function isTechKey(k: unknown): boolean {
  return typeof k === "string" && (RULE_BY_KEY.has(k) || Object.prototype.hasOwnProperty.call(TECH_GROUPS, k));
}

export function techLabel(k: string): string {
  const r = RULE_BY_KEY.get(k);
  if (r) return r.label;
  return GROUP_LABEL[k] || k;
}

function expand(k: string): string[] {
  return TECH_GROUPS[k] ? TECH_GROUPS[k] : [k];
}

/** "rappi" de rappi.com.mx, "dafiti" de www.dafiti.com.co; "" si es muy corto para no borrar de más. */
export function brandLabel(domain: unknown): string {
  const d = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, "");
  if (!isPublicHostname(d)) return "";
  const labels = d.split(".");
  const n = labels.length;
  const sld = n >= 3 && labels[n - 1].length === 2 && ["com", "co", "net", "org", "gob", "gov", "edu", "ac"].includes(labels[n - 2]);
  const brand = labels[sld ? n - 3 : n - 2] || "";
  return /^[a-z0-9-]{4,}$/.test(brand) ? brand : "";
}

/**
 * Huellas encontradas en un HTML (y, si se pasan, en los registros DNS del
 * dominio). Ordenadas como TECH_RULES (estable).
 */
export function detectTech(html: string, dnsText = "", opts: { now?: Date; selfDomain?: string } = {}): string[] {
  const now = opts.now || new Date();
  // Los enlaces del sitio a su propia marca no son huella: rappi.com.mx
  // enlazando a rappi.com o rappi.com.co no "vende en Rappi". Se quitan los
  // hosts de la marca (cualquier subdominio y dominio de país).
  let src = String(html || "");
  const brand = brandLabel(opts.selfDomain);
  if (brand) {
    src = src.replace(new RegExp(`(?:https?:)?\\/\\/(?:[a-z0-9-]+\\.)*${brand}\\.(?:com|net|org|co|[a-z]{2})(?:\\.[a-z]{2})?(?![a-z0-9-]|\\.[a-z])`, "gi"), "");
  }
  const dns = String(dnsText || "");
  if (!src && !dns) return [];
  const found: string[] = [];
  for (const r of TECH_RULES) {
    const hit = (src && r.patterns && r.patterns.some((p) => p.test(src))) ||
      (src && r.test && r.test(src, now)) ||
      (dns && r.dns && r.dns.some((p) => p.test(dns)));
    if (hit) found.push(r.key);
  }
  return found;
}

/**
 * Reglas del detector: { must_have: [...], must_not_have: [...] }, cada
 * entrada una clave o un grupo (any_chat…). Una regla vacía no matchea
 * nada: un detector "sin regla" no puede llenar el feed con todo el ICP.
 * Cada clave de must_have tiene que estar (para "una de varias" están los
 * grupos); ninguna de must_not_have puede estar.
 */
export interface ProbeRules { must_have: string[]; must_not_have: string[] }

export function evaluateProbeRules(found: string[], rules: ProbeRules): boolean {
  const have = new Set(found);
  const mh = (rules.must_have || []).filter(isTechKey);
  const mn = (rules.must_not_have || []).filter(isTechKey);
  if (!mh.length && !mn.length) return false;
  for (const k of mh) if (!expand(k).some((x) => have.has(x))) return false;
  for (const k of mn) if (expand(k).some((x) => have.has(x))) return false;
  return true;
}

/**
 * Qué hay que leer para evaluar estas reglas: la portada, el DNS o ambos.
 * Una regla de solo DNS (DMARC, Google Workspace) no necesita la portada;
 * una que mezcla (verificación de Meta) se beneficia de las dos.
 */
export function probeNeeds(rules: ProbeRules): { html: boolean; dns: boolean } {
  let html = false, dns = false;
  for (const k of [...(rules.must_have || []), ...(rules.must_not_have || [])].filter(isTechKey)) {
    for (const x of expand(k)) {
      const r = RULE_BY_KEY.get(x);
      if (!r) continue;
      if (r.patterns || r.test) html = true;
      if (r.dns) dns = true;
    }
  }
  return { html, dns };
}

/** Titular en español a partir de las reglas (≤ 70 caracteres). */
export function probeHeadline(found: string[], rules: ProbeRules): string {
  const have = new Set(found);
  const parts: string[] = [];
  for (const k of (rules.must_not_have || []).filter(isTechKey)) parts.push("sin " + techLabel(k));
  for (const k of (rules.must_have || []).filter(isTechKey)) {
    const hit = expand(k).find((x) => have.has(x));
    parts.push("con " + techLabel(hit || k));
  }
  const s = parts.join(", ");
  const cap = s.charAt(0).toUpperCase() + s.slice(1);
  return cap.length > 70 ? cap.slice(0, 67) + "…" : cap;
}

/** Etiquetas legibles de lo detectado, para la tarjeta de la señal. */
export function detectedLabels(found: string[]): string[] {
  return found.map((k) => RULE_BY_KEY.get(k)?.label || k);
}

/**
 * Catálogo para el prompt del plan: claves por categoría + grupos. Sale de
 * TECH_RULES, así el modelo nunca propone una clave que no existe.
 */
export function probeKeysSpec(): string {
  const byCat = new Map<TechCategory, string[]>();
  for (const r of TECH_RULES) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r.key);
  }
  const lines = [...byCat.entries()].map(([c, ks]) => `  ${c}: ${ks.join(", ")}`);
  return lines.join("\n") + `\n  groups (any of): ${Object.keys(TECH_GROUPS).join(", ")}`;
}

// ── DNS público (DNS sobre HTTPS) ───────────────────────────────────────────

const DOH_URL = "https://dns.google/resolve";

async function dohQuery(name: string, type: "TXT" | "MX", signal: AbortSignal): Promise<string[] | null> {
  try {
    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: "application/dns-json" }, signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    // 0 = NOERROR, 3 = NXDOMAIN (el nombre no existe: respuesta válida y vacía).
    if (j?.Status !== 0 && j?.Status !== 3) return null;
    const want = type === "TXT" ? 16 : 15;
    return (Array.isArray(j?.Answer) ? j.Answer : [])
      .filter((a: { type?: number }) => a?.type === want)
      .map((a: { data?: string }) => String(a?.data || ""))
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Registros públicos del dominio como texto (una línea por registro):
 * `TXT "…"`, `MX 10 host.`, `DMARC "v=DMARC1; …"`. ok = false si alguna
 * consulta falló: entonces una regla "sin DMARC" no puede afirmarse.
 */
export async function fetchDnsText(domain: string, timeoutMs = 6000): Promise<{ ok: boolean; text: string }> {
  const d = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!d || !isPublicHostname(d)) return { ok: false, text: "" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const [txt, mx, dmarc] = await Promise.all([
      dohQuery(d, "TXT", ctrl.signal), dohQuery(d, "MX", ctrl.signal), dohQuery("_dmarc." + d, "TXT", ctrl.signal),
    ]);
    if (!txt || !mx || !dmarc) return { ok: false, text: "" };
    // Un TXT largo llega partido en varias cadenas entre comillas: se unen.
    const join = (s: string) => s.replace(/"\s+"/g, "");
    const lines = [
      ...txt.map((t) => "TXT " + join(t)),
      ...mx.map((m) => "MX " + m),
      ...dmarc.map((t) => "DMARC " + join(t)),
    ];
    return { ok: true, text: lines.join("\n") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Solo hosts públicos con nombre: nada de IPs literales, localhost ni
 * dominios internos. Los dominios sondeados salen de Apollo (incluidas las
 * cuentas del CRM del propio usuario), así que sin esto el runtime hacía GET
 * a lo que le pidieran (SSRF ciego).
 */
export function isPublicHostname(host: string): boolean {
  const h = String(host || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!h || h.length > 253) return false;
  if (h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;           // IPv6 / IPv4 literal
  if (/^(localhost|.*\.(local|localhost|internal|lan|intranet|home|corp|test|invalid))$/.test(h)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h);                                     // exige un TLD
}

/** Lee como máximo `max` caracteres y corta la conexión: no se carga la página entera en memoria. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch { /* ya cerrado */ }
  return out.slice(0, max);
}

/** Sondeo: portada pública, con timeout, solo hosts públicos y lectura acotada. */
export async function fetchHomepage(domain: string, timeoutMs = 8000): Promise<{ ok: boolean; html: string; status: number; finalUrl: string }> {
  const d = String(domain || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!d || !isPublicHostname(d)) return { ok: false, html: "", status: 0, finalUrl: "" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (const url of [`https://${d}/`, `https://www.${d}/`]) {
      try {
        const res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: ctrl.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; PredictableRadar/1.0; +https://predictableai.vanarsi.com)",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "es-419,es;q=0.9,en;q=0.7",
          },
        });
        let finalHost = "";
        try { finalHost = new URL(res.url || url).hostname; } catch { /* sin URL final */ }
        if (finalHost && !isPublicHostname(finalHost)) continue;   // redirigió a un host privado
        const type = res.headers.get("content-type") || "";
        if (!res.ok || (type && !/html|xml|text\/plain/i.test(type))) continue;
        const html = await readCapped(res, 600_000);
        return { ok: true, html, status: res.status, finalUrl: res.url || url };
      } catch (_) { /* siguiente variante */ }
    }
    return { ok: false, html: "", status: 0, finalUrl: "" };
  } finally {
    clearTimeout(timer);
  }
}
