// js/prospecting-data.js
// ───────────────────────────────────────────────────────────
// Capa de datos de Prospección: habla con el edge function
// apollo-proxy (Apollo API), con Supabase (prospect_lists /
// prospect_list_members) y con generate-outreach (mensajes IA).
//
// Contrato consumido por js/prospecting.js (window.prospectingData).
// Todas las funciones async lanzan Error con mensaje en español.
// ───────────────────────────────────────────────────────────
(function (global) {
  'use strict';

  const BULK_MATCH_CHUNK = 10; // límite del API de Apollo (people/bulk_match)
  const SENDER_LS_KEY = 'prospecting_sender_v1';

  // ── Pipeline CRM (columna contact_status de prospect_list_members) ──
  // Valores = datos en Supabase (no traducir); labels = UI en español.
  const CONTACT_STATUSES = [
    { value: 'no_contactado',    label: 'No contactado',     pill: 'gray'  },
    { value: 'saludo_enviado',   label: 'Saludo enviado',    pill: 'blue'  },
    { value: 'reunion_agendada', label: 'Reunión conseguida', pill: 'green' },
    { value: 'reunion_tomada',   label: 'Reunión tomada',    pill: 'teal'  },
    { value: 'no_interesado',    label: 'No interesado',     pill: 'red'   },
    { value: 'no_show',          label: 'No se presentó',    pill: 'amber' },
  ];
  // Estados que cuentan como "reunión conseguida" en el dashboard.
  const MEETING_STATUSES = ['reunion_agendada', 'reunion_tomada'];

  // ── Helpers base ───────────────────────────────────────────

  function sb() {
    if (!global.supabaseClient) throw new Error('Supabase no está inicializado. Recarga la página.');
    return global.supabaseClient;
  }

  async function getUserId() {
    if (global.currentUser?.id) return global.currentUser.id;
    const { data } = await sb().auth.getUser();
    if (!data?.user) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    return data.user.id;
  }

  async function getAccessToken() {
    const { data } = await sb().auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    return token;
  }

  async function edgeFetch(fnName, payload) {
    const token = await getAccessToken();
    const res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + fnName, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* respuesta no-JSON */ }
    if (!res.ok) {
      const detail = body?.detail || body?.error || body?.message || ('HTTP ' + res.status);
      // Solo el proxy habla con Apollo: no etiquetar errores de otras
      // functions (p. ej. la IA de generate-outreach) como "Error de Apollo".
      const msg = fnName === 'apollo-proxy'
        ? apolloErrorMessage(detail, res.status)
        : fnName === 'gmail-proxy'
          ? gmailErrorMessage(detail, res.status)
          : res.status === 401
            ? 'Sesión expirada. Vuelve a iniciar sesión.'
            : 'No se pudo generar el contenido (' + detail + '). Reintenta.';
      const err = new Error(msg);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return body;
  }

  // Todas las llamadas a Apollo van vía el edge function apollo-proxy
  // (la API key vive en secrets de Supabase, nunca en el cliente).
  // `method` solo hace falta en los endpoints que aceptan más de un verbo
  // (PUT/DELETE sobre pasos y touches); el proxy valida el par endpoint+método
  // contra su allowlist y rechaza cualquier combinación que no esté ahí.
  function apolloProxy(endpoint, body, method) {
    const payload = { endpoint, body: body || {} };
    if (method) payload.method = method;
    return edgeFetch('apollo-proxy', payload);
  }

  function apolloErrorMessage(detail, status) {
    const d = String(detail || '').toLowerCase();
    if (status === 401) return 'Sesión expirada. Vuelve a iniciar sesión.';
    if (status === 403 || d.includes('master key') || d.includes('api key is not a master'))
      return 'Tu API key de Apollo debe ser una master key para esta operación (403).';
    if (status === 429 || d.includes('rate limit'))
      return 'Apollo limitó las solicitudes (429). Espera un minuto y reintenta.';
    if (status === 402 || d.includes('insufficient') || d.includes('credit'))
      return 'No hay créditos suficientes en tu cuenta de Apollo.';
    if (d.includes('endpoint not allowed'))
      return 'El proxy de Apollo no reconoce este endpoint — hay que volver a desplegar apollo-proxy (supabase functions deploy apollo-proxy).';
    return 'Error de Apollo: ' + detail;
  }

  // Los dos estados de "hay que (re)conectar Gmail" viajan como 428 con un
  // código estable, para que la UI ofrezca el botón en vez de un error suelto.
  function gmailErrorMessage(detail, status) {
    const d = String(detail || '');
    if (d === 'gmail_not_connected') return 'Conecta tu Gmail para leer y responder los hilos.';
    if (d === 'gmail_reauth_required') return 'Se perdió el acceso a Gmail. Vuelve a conectarlo.';
    if (d === 'thread_not_found') return 'Este hilo ya no existe en el buzón conectado.';
    if (status === 401) return 'Sesión expirada. Vuelve a iniciar sesión.';
    if (status === 503) return 'Gmail no está configurado en el servidor todavía.';
    return d || 'No se pudo hablar con Gmail. Reintenta.';
  }

  function isMaskedEmail(email) {
    return !email || String(email).includes('email_not_unlocked');
  }

  // Elimina valores vacíos antes de mandar filtros a Apollo.
  function cleanFilters(filters) {
    const out = {};
    for (const [k, v] of Object.entries(filters || {})) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) { if (v.length) out[k] = v; continue; }
      if (typeof v === 'object') {
        const nested = cleanFilters(v);
        if (Object.keys(nested).length) out[k] = nested;
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  // ── Búsqueda (0 créditos — no devuelve emails ni teléfonos) ─

  async function searchPeople(filters) {
    const body = cleanFilters(filters);
    if (!body.page) body.page = 1;
    if (!body.per_page) body.per_page = 25;
    const data = await apolloProxy('/mixed_people/api_search', body);
    return {
      people: data?.people || [],
      contacts: data?.contacts || [],
      pagination: data?.pagination || { page: body.page, per_page: body.per_page, total_entries: 0, total_pages: 0 },
      breadcrumbs: data?.breadcrumbs || [],
      partial_results_only: !!data?.partial_results_only,
    };
  }

  // ── ICP desde la búsqueda (Supabase: client_icp + intel_hub_intake) ─
  // El ICP ya no se pregunta en el onboarding: se arma con los filtros que el
  // usuario usa en Búsqueda (search people) y se persiste para que el
  // Intelligence Hub (generate-intel-hub) y el brief (generate-client-brief)
  // lo consuman. Best-effort: nunca lanza ni bloquea la búsqueda.

  let lastIcpSignature = null; // evita re-escribir en cada página de resultados
  let declaredIcp = null;      // ¿el usuario ya declaró su ICP en el contexto?

  // Desde el contexto de empresa v2 el ICP se DECLARA en el primer paso
  // (js/company-context.js), no se deduce de la búsqueda. Si ya está declarado,
  // esta sincronización deja de escribir: una búsqueda exploratoria no puede
  // reescribir en silencio el ICP con el que corren el radar y los mensajes.
  async function hasDeclaredIcp() {
    if (declaredIcp !== null) return declaredIcp;
    try {
      const userId = await getUserId();
      const { data } = await sb().from('intel_hub_intake')
        .select('icp_countries, icp_industry_tags, icp_titles, icp_seniorities, context_confirmed_at')
        .eq('user_id', userId).maybeSingle();
      const filled = (a) => Array.isArray(a) && a.length > 0;
      declaredIcp = !!data && (
        !!data.context_confirmed_at || filled(data.icp_countries) ||
        filled(data.icp_industry_tags) || filled(data.icp_titles) || filled(data.icp_seniorities)
      );
    } catch (e) {
      // Ante la duda, no pisar: es más barato no sincronizar que corromper el ICP.
      declaredIcp = true;
    }
    return declaredIcp;
  }

  async function syncIcpFromSearch(filters) {
    try {
      if (await hasDeclaredIcp()) return;
      const f = filters || {};
      const join = (a) => (Array.isArray(a) ? a.filter(Boolean) : []).join(', ');
      const roles = join(f.person_titles) || join(f.person_seniorities);
      const geos = join([...new Set(
        [].concat(f.person_locations || [], f.organization_locations || [])
      )]);
      const sizes = join((f.organization_num_employees_ranges || [])
        .map((r) => String(r).replace(',', '-')));
      const industries = join([...new Set(
        [].concat(f.q_organization_keyword_tags || [], f.market_segments || [])
      )]);

      if (!roles && !geos && !sizes && !industries) return;

      const signature = JSON.stringify([roles, geos, sizes, industries]);
      if (signature === lastIcpSignature) return;

      const userId = await getUserId();

      // Solo columnas con valor: el upsert de PostgREST no toca las que no
      // se envían, así una búsqueda sin (p. ej.) industria no borra la previa.
      const icp = {};
      if (roles) icp.roles = roles;
      if (geos) icp.geographies = geos;
      if (sizes) icp.company_sizes = sizes;
      if (industries) icp.industries = industries;

      const intake = {};
      if (roles) intake.icp_roles = roles;
      if (geos) intake.icp_geographies = geos;
      if (sizes) intake.icp_company_sizes = sizes;
      if (industries) intake.icp_industries = industries;

      const [r1, r2] = await Promise.all([
        sb().from('client_icp').upsert(
          { profile_id: userId, ...icp },
          { onConflict: 'profile_id' }
        ),
        sb().from('intel_hub_intake').upsert(
          { user_id: userId, ...intake },
          { onConflict: 'user_id' }
        ),
      ]);
      if (r1.error || r2.error) {
        console.warn('[icp-sync]', r1.error || r2.error);
        return;
      }
      lastIcpSignature = signature;
    } catch (e) {
      console.warn('[icp-sync]', e);
    }
  }

  // ── Listas (Supabase, RLS por dueño) ───────────────────────

  async function fetchLists() {
    const { data, error } = await sb()
      .from('prospect_lists')
      .select('id, name, created_at, prospect_list_members(count)')
      .order('created_at', { ascending: false });
    if (error) throw new Error('No se pudieron cargar tus listas: ' + error.message);
    return (data || []).map((l) => ({
      id: l.id,
      name: l.name,
      created_at: l.created_at,
      member_count: l.prospect_list_members?.[0]?.count ?? 0,
    }));
  }

  async function createList(name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Escribe un nombre para la lista.');
    const userId = await getUserId();
    const { data, error } = await sb()
      .from('prospect_lists')
      .insert({ user_id: userId, name: clean })
      .select()
      .single();
    if (error) {
      if (String(error.code) === '23505') throw new Error('Ya tienes una lista con ese nombre.');
      throw new Error('No se pudo crear la lista: ' + error.message);
    }
    return data;
  }

  async function deleteList(listId) {
    const { error } = await sb().from('prospect_lists').delete().eq('id', listId);
    if (error) throw new Error('No se pudo eliminar la lista: ' + error.message);
  }

  async function renameList(listId, newName) {
    const clean = String(newName || '').trim();
    if (!clean) throw new Error('Escribe un nombre para la lista.');
    const { error } = await sb().from('prospect_lists').update({ name: clean }).eq('id', listId);
    if (error) throw new Error('No se pudo renombrar la lista: ' + error.message);
  }

  // Apollo person/contact IDs ya guardados en las listas indicadas — se usa
  // para excluir de la búsqueda a personas ya trabajadas antes (no volver a
  // contactar a quien ya está en una lista).
  async function fetchListMemberIds(listIds) {
    const ids = (listIds || []).filter(Boolean);
    if (!ids.length) return { personIds: new Set(), contactIds: new Set() };
    const { data, error } = await sb()
      .from('prospect_list_members')
      .select('apollo_person_id, apollo_contact_id')
      .in('list_id', ids);
    if (error) throw new Error('No se pudieron leer las listas a excluir: ' + error.message);
    return {
      personIds: new Set((data || []).map((r) => r.apollo_person_id).filter(Boolean)),
      contactIds: new Set((data || []).map((r) => r.apollo_contact_id).filter(Boolean)),
    };
  }

  // ── Importar listas desde Apollo ────────────────────────────
  // Apollo no expone una API pública para "saved searches" (solo para
  // Lists/Labels) — ver fetchSavedSearches más abajo. Esto trae las listas
  // (labels) que ya existen en la cuenta de Apollo del usuario y copia sus
  // contactos a una lista nueva de Predictable (prospect_lists), fusionando
  // con el flujo existente en vez de crear una vista aparte.

  async function fetchApolloLists() {
    const data = await apolloProxy('/labels', {});
    return (data?.labels || []).filter((l) => l && l.id != null).map((l) => ({
      id: l.id,
      name: l.name || 'Sin nombre',
      modality: l.modality || 'contacts',
      count: l.cached_count ?? l.count ?? l.contacts_count ?? null,
    }));
  }

  const APOLLO_LIST_IMPORT_MAX_PAGES = 50; // 50 × 100 = 5,000 contactos por importación

  async function fetchApolloListContacts(labelId, onProgress) {
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const perPage = 100;
    const contacts = [];
    let page = 1;
    let totalPages = 1;
    do {
      const data = await apolloProxy('/contacts/search', {
        contact_label_ids: [labelId],
        page,
        per_page: perPage,
      });
      contacts.push(...(data?.contacts || []));
      totalPages = data?.pagination?.total_pages || 1;
      progress({ done: page, total: Math.min(totalPages, APOLLO_LIST_IMPORT_MAX_PAGES) });
      page++;
    } while (page <= totalPages && page <= APOLLO_LIST_IMPORT_MAX_PAGES);
    return { contacts, truncated: totalPages > APOLLO_LIST_IMPORT_MAX_PAGES };
  }

  async function importApolloList({ apolloListId, apolloListName, onProgress }) {
    if (apolloListId == null) throw new Error('Selecciona una lista de Apollo.');
    const userId = await getUserId();
    const progress = typeof onProgress === 'function' ? onProgress : () => {};

    // 1. Crear (o reutilizar, con sufijo si el nombre ya existe) la lista local.
    const baseName = String(apolloListName || 'Lista de Apollo').trim() || 'Lista de Apollo';
    let list;
    try {
      list = await createList(baseName);
    } catch (e) {
      if (!/ese nombre/.test(e.message)) throw e;
      list = await createList(baseName + ' (Apollo)');
    }

    // 2. Traer los contactos de esa lista en Apollo (paginado).
    const { contacts, truncated } = await fetchApolloListContacts(
      apolloListId,
      (p) => progress(Object.assign({ phase: 'fetching' }, p))
    );

    // 3. Deduplicar contra miembros ya guardados en la lista (por contact id
    // de Apollo — mismo criterio que las filas "Guardado" en addPeopleToList).
    const { data: existing, error: exErr } = await sb()
      .from('prospect_list_members')
      .select('apollo_contact_id')
      .eq('list_id', list.id);
    if (exErr) throw new Error('No se pudo leer la lista: ' + exErr.message);
    const existingContactIds = new Set((existing || []).map((r) => r.apollo_contact_id).filter(Boolean));
    const fresh = contacts.filter((c) => c?.id && !existingContactIds.has(c.id));
    const alreadyInList = contacts.length - fresh.length;

    // 4. Insertar en Supabase.
    progress({ phase: 'saving', done: 0, total: fresh.length });
    const rows = fresh.map((c) => {
      const row = personToRow(c, null, userId, list.id, c.id);
      row.apollo_person_id = c.person_id || null;
      row.email = isMaskedEmail(c.email) ? null : c.email;
      row.phone = (c.phone_numbers || []).map((n) => n?.sanitized_number || n?.raw_number).find(Boolean) || null;
      row.phone_status = row.phone ? 'revealed' : 'none';
      row.enriched_at = (row.email || row.phone) ? new Date().toISOString() : null;
      return row;
    });
    let added = 0;
    if (rows.length) {
      const { data: inserted, error } = await sb().from('prospect_list_members')
        .upsert(rows, { onConflict: 'list_id,apollo_person_id', ignoreDuplicates: true })
        .select('id');
      if (error) throw new Error('No se pudieron guardar los contactos importados: ' + error.message);
      added = inserted ? inserted.length : rows.length;
    }

    return { list, added, alreadyInList, truncated, total: contacts.length };
  }

  // ── Búsquedas guardadas (Supabase, RLS por dueño) ──────────
  // Apollo no expone una API pública para "saved searches" — solo persiste
  // los criterios de filtro en Predictable. Guardar también en Apollo se
  // logra reutilizando addPeopleToList con los resultados ya cargados.

  async function fetchSavedSearches() {
    const { data, error } = await sb()
      .from('prospect_saved_searches')
      .select('id, name, filters, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error('No se pudieron cargar tus búsquedas guardadas: ' + error.message);
    return data || [];
  }

  async function createSavedSearch(name, filters) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Escribe un nombre para la búsqueda.');
    const userId = await getUserId();
    const { data, error } = await sb()
      .from('prospect_saved_searches')
      .insert({ user_id: userId, name: clean, filters: filters || {} })
      .select()
      .single();
    if (error) {
      if (String(error.code) === '23505') throw new Error('Ya tienes una búsqueda guardada con ese nombre.');
      throw new Error('No se pudo guardar la búsqueda: ' + error.message);
    }
    return data;
  }

  async function deleteSavedSearch(id) {
    const { error } = await sb().from('prospect_saved_searches').delete().eq('id', id);
    if (error) throw new Error('No se pudo eliminar la búsqueda guardada: ' + error.message);
  }

  async function fetchMembers(listId) {
    const { data, error } = await sb()
      .from('prospect_list_members')
      .select('*')
      .eq('list_id', listId)
      .order('created_at', { ascending: false });
    if (error) throw new Error('No se pudieron cargar los contactos: ' + error.message);
    return data || [];
  }

  async function deleteMembers(memberIds) {
    if (!memberIds?.length) return;
    const { error } = await sb().from('prospect_list_members').delete().in('id', memberIds);
    if (error) throw new Error('No se pudieron eliminar los contactos: ' + error.message);
  }

  async function updateMember(memberId, patch) {
    const allowed = ['email', 'email_status', 'phone', 'phone_status', 'outreach', 'outreach_status', 'sequence_status', 'apollo_contact_id', 'snapshot', 'enriched_at', 'contact_status', 'company', 'company_domain', 'title', 'first_name', 'last_name', 'name', 'linkedin_url', 'country', 'city', 'state'];
    const safe = {};
    for (const k of allowed) if (k in (patch || {})) safe[k] = patch[k];
    if (!Object.keys(safe).length) return;
    const { error } = await sb().from('prospect_list_members').update(safe).eq('id', memberId);
    if (error) throw new Error('No se pudo actualizar el contacto: ' + error.message);
  }

  // ── Contactos (CRM): todos los miembros de todas las listas ─────────
  // Una sola consulta con el nombre de la lista embebido (FK list_id) para
  // que la pestaña Contactos muestre a qué lista pertenece cada persona.
  async function fetchAllContacts() {
    const { data, error } = await sb()
      .from('prospect_list_members')
      .select('*, prospect_lists(id, name)')
      .order('created_at', { ascending: false });
    if (error) throw new Error('No se pudieron cargar tus contactos: ' + error.message);
    return (data || []).map((m) => {
      m.list_name = (m.prospect_lists && m.prospect_lists.name) || '—';
      return m;
    });
  }

  // Cambia el estado CRM de un contacto (se refleja en Contactos, Inbox y
  // el dashboard porque todos leen la misma fila de Supabase).
  async function setContactStatus(memberId, status) {
    const valid = CONTACT_STATUSES.some((s) => s.value === status);
    if (!valid) throw new Error('Estado de contacto inválido.');
    await updateMember(memberId, { contact_status: status });
  }

  // Conteo de reuniones conseguidas (reunion_agendada + reunion_tomada) —
  // lo consume el KPI "Reuniones generadas" del dashboard.
  async function countMeetings() {
    const { count, error } = await sb()
      .from('prospect_list_members')
      .select('id', { count: 'exact', head: true })
      .in('contact_status', MEETING_STATUSES);
    if (error) throw new Error('No se pudieron contar las reuniones: ' + error.message);
    return count || 0;
  }

  // ── Plantillas locales (message_templates — texto libre con variables) ──
  // Independientes de las plantillas de Meta: viven en Supabase, no
  // requieren WABA ID ni aprobación, y se usan en campañas de WhatsApp.

  async function fetchMessageTemplates() {
    const { data, error } = await sb()
      .from('message_templates')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error('No se pudieron cargar tus plantillas: ' + error.message);
    return data || [];
  }

  async function createMessageTemplate({ name, body, channel }) {
    const cleanName = String(name || '').trim();
    const cleanBody = String(body || '').trim();
    if (!cleanName) throw new Error('Escribe un nombre para la plantilla.');
    if (!cleanBody) throw new Error('Escribe el contenido de la plantilla.');
    const userId = await getUserId();
    const { data, error } = await sb()
      .from('message_templates')
      .insert({ user_id: userId, name: cleanName, body: cleanBody, channel: channel || 'whatsapp' })
      .select()
      .single();
    if (error) {
      if (String(error.code) === '23505') throw new Error('Ya tienes una plantilla con ese nombre.');
      throw new Error('No se pudo guardar la plantilla: ' + error.message);
    }
    return data;
  }

  async function updateMessageTemplate(id, { name, body, channel }) {
    const patch = {};
    if (name != null) patch.name = String(name).trim();
    if (body != null) patch.body = String(body).trim();
    if (channel != null) patch.channel = channel;
    const { error } = await sb().from('message_templates').update(patch).eq('id', id);
    if (error) throw new Error('No se pudo actualizar la plantilla: ' + error.message);
  }

  async function deleteMessageTemplate(id) {
    const { error } = await sb().from('message_templates').delete().eq('id', id);
    if (error) throw new Error('No se pudo eliminar la plantilla: ' + error.message);
  }

  // Sustituye {{nombre}} / {{apellido}} / {{nombre_completo}} / {{empresa}} /
  // {{rol}} con los datos reales del contacto (campañas y previews).
  function renderTemplateForMember(body, member) {
    const m = member || {};
    const firstName = m.first_name || String(m.name || '').split(' ')[0] || '';
    const values = {
      nombre: firstName,
      apellido: m.last_name || '',
      nombre_completo: m.name || [m.first_name, m.last_name].filter(Boolean).join(' ') || firstName,
      empresa: m.company || '',
      rol: m.title || '',
    };
    return String(body || '').replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (full, key) => {
      const k = key.toLowerCase();
      return (k in values) ? values[k] : full;
    });
  }

  // Variables sin dato real para este contacto (aviso antes de enviar).
  function missingTemplateVars(body, member) {
    const rendered = renderTemplateForMember(body, member);
    const out = [];
    const re = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;
    let match;
    while ((match = re.exec(rendered)) !== null) {
      if (out.indexOf(match[1]) === -1) out.push(match[1]);
    }
    // También variables conocidas cuyo valor quedó vacío
    ['nombre', 'empresa', 'rol'].forEach((k) => {
      const hasVar = new RegExp('\\{\\{\\s*' + k + '\\s*\\}\\}').test(String(body || ''));
      if (!hasVar) return;
      const val = k === 'nombre'
        ? (member?.first_name || String(member?.name || '').split(' ')[0] || '')
        : k === 'empresa' ? (member?.company || '') : (member?.title || '');
      if (!val && out.indexOf(k) === -1) out.push(k);
    });
    return out;
  }

  // ── Agregar personas a una lista ───────────────────────────
  // Igual que en Apollo: guardar en una lista revela el email laboral.
  // Pipeline: people/bulk_match (1 crédito por match) → POST /contacts
  // (0 créditos, label_names = nombre de la lista) → insert en Supabase.

  function personToRow(person, match, userId, listId, contactId) {
    const p = match || person || {};
    // Apollo's Person schema nests the employer under `organization`, but its
    // Contact schema (returned for people already saved as Apollo contacts —
    // Búsqueda's "Guardado" rows) only carries the employer as flat
    // `organization_name`/`account` fields. Check every shape so the company
    // is never lost depending on which schema the row came from.
    const org = p.organization || person?.organization || p.account || person?.account || {};
    const email = isMaskedEmail(p.email) ? null : p.email;
    return {
      list_id: listId,
      user_id: userId,
      apollo_person_id: person?.id || p.id || null,
      apollo_contact_id: contactId || null,
      first_name: p.first_name || null,
      last_name: p.last_name || null,
      name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
      title: p.title || null,
      company: org.name || p.organization_name || person?.organization_name || null,
      company_domain: org.primary_domain || org.domain || p.organization_domain || null,
      linkedin_url: p.linkedin_url || null,
      email,
      email_status: p.email_status || null,
      city: p.city || null,
      state: p.state || null,
      country: p.country || null,
      snapshot: match || person || {},
      enriched_at: email ? new Date().toISOString() : null,
    };
  }

  async function createApolloContact(row, listName) {
    const body = {
      first_name: row.first_name || undefined,
      last_name: row.last_name || undefined,
      title: row.title || undefined,
      organization_name: row.company || undefined,
      email: row.email || undefined,
      website_url: row.company_domain ? 'https://' + row.company_domain : undefined,
      label_names: [listName],
    };
    const data = await apolloProxy('/contacts', body);
    return data?.contact?.id || null;
  }

  async function addPeopleToList({ list, people, onProgress }) {
    if (!list?.id || !list?.name) throw new Error('Selecciona una lista válida.');
    if (!people?.length) throw new Error('Selecciona al menos una persona.');
    const userId = await getUserId();
    const progress = typeof onProgress === 'function' ? onProgress : () => {};

    // Deduplicar contra los miembros existentes de la lista
    const { data: existing, error: exErr } = await sb()
      .from('prospect_list_members')
      .select('apollo_person_id, apollo_contact_id')
      .eq('list_id', list.id);
    if (exErr) throw new Error('No se pudo leer la lista: ' + exErr.message);
    const existingIds = new Set((existing || []).map((r) => r.apollo_person_id).filter(Boolean));
    const existingContactIds = new Set((existing || []).map((r) => r.apollo_contact_id).filter(Boolean));

    // Las filas "Guardado" de la búsqueda son CONTACTOS de Apollo (otro
    // espacio de IDs): su id NO es un person id — no pasan por bulk_match
    // y ya traen el email desbloqueado. El unique de la tabla no cubre
    // apollo_person_id NULL, así que se deduplican aquí por contact id.
    const savedContacts = people.filter((p) => p?._saved && p?.id && !existingContactIds.has(p.id));
    const fresh = people.filter((p) => !p?._saved && p?.id && !existingIds.has(p.id));
    const alreadyInList = people.length - fresh.length - savedContacts.length;

    let creditsUsed = 0;
    const failed = [];
    const warnings = []; // guardados pero sin email enriquecido
    const rows = [];

    for (const c of savedContacts) {
      const row = personToRow(c, null, userId, list.id, c.id);
      row.apollo_person_id = c.person_id || null; // solo si Apollo lo expone
      row.email = isMaskedEmail(c.email) ? null : c.email;
      row.enriched_at = row.email ? new Date().toISOString() : null;
      rows.push(row);
    }

    // 1. Enriquecer email vía bulk_match en lotes de 10
    for (let i = 0; i < fresh.length; i += BULK_MATCH_CHUNK) {
      const chunk = fresh.slice(i, i + BULK_MATCH_CHUNK);
      progress({ done: Math.min(i, fresh.length), total: fresh.length, phase: 'enriching' });
      let matches = new Array(chunk.length).fill(null);
      let chunkError = null;
      try {
        const res = await apolloProxy('/people/bulk_match', {
          details: chunk.map((p) => ({ id: p.id })),
          reveal_personal_emails: false,
        });
        matches = res?.matches || matches;
        creditsUsed += res?.credits_consumed ?? matches.filter(Boolean).length;
      } catch (e) {
        // El lote falló completo: se guardan igual (con snapshot de búsqueda),
        // pero sin email — se reporta como advertencia, no como fallo.
        chunkError = e.message;
      }

      // 2. Crear contacto en Apollo (label = nombre de la lista) y armar fila
      for (let j = 0; j < chunk.length; j++) {
        const person = chunk[j];
        const match = matches[j] || null;
        const row = personToRow(person, match, userId, list.id, null);
        try {
          row.apollo_contact_id = await createApolloContact(row, list.name);
        } catch (e) {
          // No bloquea el guardado local: la pestaña Secuencias reintenta al enrolar.
          console.warn('[prospecting-data] contacto Apollo falló:', e.message);
        }
        if (chunkError || (!row.email && !match)) {
          warnings.push({
            name: person.name || person.id,
            error: 'Guardado sin email' + (chunkError ? ' — ' + chunkError : ' (Apollo no encontró match)'),
          });
        }
        rows.push(row);
      }
    }

    // 3. Persistir en Supabase (added = filas realmente insertadas)
    let added = 0;
    if (rows.length) {
      progress({ done: fresh.length, total: fresh.length, phase: 'saving' });
      const { data: inserted, error } = await sb().from('prospect_list_members')
        .upsert(rows, { onConflict: 'list_id,apollo_person_id', ignoreDuplicates: true })
        .select('id');
      if (error) throw new Error('No se pudieron guardar los contactos: ' + error.message);
      added = inserted ? inserted.length : rows.length;
    }

    return { added, alreadyInList, failed, warnings, creditsUsed };
  }

  // ── Agregar contacto manualmente ────────────────────────────
  // Inserta directo en Supabase (sin pasar por Apollo /contacts): estos
  // contactos no tienen apollo_person_id, así que nunca chocan con el
  // UNIQUE(list_id, apollo_person_id) (NULL nunca colisiona en Postgres).

  async function addManualMember({ list, contact }) {
    if (!list?.id) throw new Error('Selecciona una lista válida.');
    const c = contact || {};
    const firstName = String(c.first_name || '').trim();
    const lastName = String(c.last_name || '').trim();
    const email = String(c.email || '').trim();
    if (!firstName && !lastName && !email) {
      throw new Error('Escribe al menos un nombre o un correo.');
    }
    const userId = await getUserId();
    const phone = String(c.phone || '').trim();
    let company = String(c.company || '').trim();
    let companyDomain = '';
    let title = String(c.title || '').trim();
    let apolloPersonId = null;
    let snapshot = {};

    // La empresa del contacto se jala automáticamente: si el usuario no la
    // escribió, se busca a la persona en Apollo (email / LinkedIn / nombre)
    // y se completa empresa + dominio + cargo. Best-effort: si Apollo no la
    // encuentra, el contacto se guarda igual con lo que se escribió.
    if (!company && (email || c.linkedin_url || (firstName && lastName))) {
      try {
        const res = await apolloProxy('/people/match', cleanFilters({
          email: email || undefined,
          linkedin_url: String(c.linkedin_url || '').trim() || undefined,
          first_name: firstName || undefined,
          last_name: lastName || undefined,
          reveal_personal_emails: false,
        }));
        const p = res?.person;
        if (p) {
          const org = p.organization || {};
          company = org.name || p.organization_name || '';
          companyDomain = org.primary_domain || org.domain || '';
          if (!title) title = p.title || '';
          apolloPersonId = p.id || null;
          snapshot = p;
        }
      } catch (e) {
        console.warn('[prospecting-data] auto-empresa (Apollo) falló:', e.message);
      }
    } else if (company && !companyDomain) {
      companyDomain = normalizeCompanyDomain(c.company_domain);
    }

    const row = {
      list_id: list.id,
      user_id: userId,
      apollo_person_id: apolloPersonId,
      apollo_contact_id: null,
      first_name: firstName || null,
      last_name: lastName || null,
      name: [firstName, lastName].filter(Boolean).join(' ') || null,
      title: title || null,
      company: company || null,
      company_domain: companyDomain || null,
      linkedin_url: String(c.linkedin_url || '').trim() || null,
      email: email || null,
      email_status: null,
      phone: phone || null,
      phone_status: phone ? 'revealed' : 'none',
      city: null,
      state: null,
      country: String(c.country || '').trim() || null,
      snapshot: snapshot,
      enriched_at: (email || phone) ? new Date().toISOString() : null,
    };
    const { data, error } = await sb().from('prospect_list_members').insert(row).select().single();
    if (error) throw new Error('No se pudo agregar el contacto: ' + error.message);
    return data;
  }

  function normalizeCompanyDomain(s) {
    let v = String(s || '').trim().toLowerCase();
    v = v.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return v.split(/[/?#]/)[0];
  }

  // Autocompletar datos desde una URL de LinkedIn vía Apollo (1 crédito si
  // encuentra match). Devuelve null si Apollo no encontró a la persona.

  async function matchByLinkedinUrl(url) {
    const clean = String(url || '').trim();
    if (!clean) throw new Error('Pega una URL de LinkedIn.');
    const data = await apolloProxy('/people/match', {
      linkedin_url: clean,
      reveal_personal_emails: true,
    });
    const p = data?.person;
    if (!p) return null;
    const org = p.organization || {};
    const phone = (p.phone_numbers || []).map((n) => n?.sanitized_number || n?.raw_number).find(Boolean) || '';
    return {
      first_name: p.first_name || '',
      last_name: p.last_name || '',
      title: p.title || '',
      email: isMaskedEmail(p.email) ? '' : (p.email || ''),
      phone,
      country: p.country || '',
      company: org.name || '',
      linkedin_url: p.linkedin_url || clean,
    };
  }

  // ── Enriquecimiento (emails personales + teléfonos) ────────
  // El teléfono es asíncrono: Apollo lo envía al edge function
  // apollo-webhook, que actualiza la fila (phone_status pending → revealed).

  async function enrichMembers({ members, revealPhones, onProgress }) {
    if (!members?.length) throw new Error('Selecciona al menos un contacto.');
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    let updated = 0;
    let phonePending = 0;
    const failed = [];

    const enrichable = members.filter((m) => m.apollo_person_id || m.email || m.linkedin_url || m.name);
    members.filter((m) => !m.apollo_person_id && !m.email && !m.linkedin_url && !m.name).forEach((m) =>
      failed.push({ name: m.name || m.email || 'contacto', error: 'No hay datos suficientes (nombre, email o LinkedIn) para buscarlo en Apollo.' }));

    // El webhook de Apollo solo actualiza filas en 'pending' y Apollo puede
    // llamar ANTES de que termine el loop: marcar pending por adelantado
    // (se revierte para los que fallen).
    if (revealPhones && enrichable.length) {
      const { error } = await sb().from('prospect_list_members')
        .update({ phone_status: 'pending' })
        .in('id', enrichable.map((m) => m.id))
        .in('phone_status', ['none', 'unavailable']);
      if (error) throw new Error('No se pudo preparar el enriquecimiento: ' + error.message);
    }

    const patches = []; // {id, patch} — se aplican en paralelo al final
    for (let i = 0; i < enrichable.length; i++) {
      const m = enrichable[i];
      progress({ done: i, total: enrichable.length, phase: 'enriching' });
      try {
        const query = m.apollo_person_id
          ? { id: m.apollo_person_id }
          : {
              email: m.email || undefined,
              linkedin_url: m.linkedin_url || undefined,
              first_name: m.first_name || undefined,
              last_name: m.last_name || undefined,
              organization_name: m.company || undefined,
            };
        const res = await apolloProxy('/people/match', Object.assign(query, {
          reveal_personal_emails: true,
          reveal_phone_number: !!revealPhones,
        }));
        const person = res?.person || null;
        const patch = { enriched_at: new Date().toISOString() };
        if (person) {
          if (!m.apollo_person_id && person.id) patch.apollo_person_id = person.id;
          const work = isMaskedEmail(person.email) ? null : person.email;
          const personal = (person.personal_emails || []).find((e) => !isMaskedEmail(e)) || null;
          if (work || personal) patch.email = m.email || work || personal;
          if (person.email_status) patch.email_status = person.email_status;
          // Algunos planes devuelven el teléfono en la misma respuesta
          const syncPhone = (person.phone_numbers || [])
            .map((n) => n?.sanitized_number || n?.raw_number)
            .find(Boolean);
          if (syncPhone) {
            patch.phone = syncPhone;
            patch.phone_status = 'revealed';
          } else if (revealPhones) {
            phonePending++; // queda en 'pending' (ya marcado arriba)
          }
          patch.snapshot = Object.assign({}, m.snapshot || {}, person);
        } else if (revealPhones) {
          phonePending++;
        }
        patches.push({ id: m.id, patch });
        updated++;
      } catch (e) {
        failed.push({ name: m.name || m.email || 'contacto', error: e.message });
        // Revertir el 'pending' adelantado al valor original (nunca pisar 'revealed')
        if (revealPhones && (m.phone_status === 'none' || m.phone_status === 'unavailable')) {
          patches.push({ id: m.id, patch: { phone_status: m.phone_status } });
        }
      }
    }

    progress({ done: enrichable.length, total: enrichable.length, phase: 'saving' });
    const results = await Promise.allSettled(patches.map((p) => updateMember(p.id, p.patch)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const m = enrichable.find((x) => x.id === patches[i].id);
        failed.push({ name: m?.name || 'contacto', error: 'No se pudo guardar: ' + r.reason?.message });
      }
    });
    return { updated, phonePending, failed };
  }

  // ── Secuencias de Apollo ───────────────────────────────────

  async function fetchSequences() {
    const data = await apolloProxy('/emailer_campaigns/search', { per_page: 100 });
    return (data?.emailer_campaigns || []).map((s) => ({
      id: s.id,
      name: s.name,
      active: !!s.active,
      archived: !!s.archived,
      num_steps: s.num_steps ?? null,
      // Resumen de pasos que ya devuelve el search (sin asunto ni cuerpo:
      // esos viven en los touches, ver fetchSequenceSteps).
      steps: (Array.isArray(s.emailer_steps) ? s.emailer_steps : []).map((st) => ({
        id: st.id,
        position: st.position,
        waitTime: st.wait_time ?? 0,
        waitMode: st.wait_mode || 'day',
        type: st.type || 'auto_email',
      })).sort((a, b) => (a.position || 0) - (b.position || 0)),
      // Métricas reales de Apollo — nunca inventadas: si Apollo no las manda,
      // se quedan en null y la UI muestra «—».
      stats: {
        scheduled: numOrNull(s.unique_scheduled),
        delivered: numOrNull(s.unique_delivered),
        opened: numOrNull(s.unique_opened),
        replied: numOrNull(s.unique_replied),
        bounced: numOrNull(s.unique_bounced),
        unsubscribed: numOrNull(s.unique_unsubscribed),
        openRate: numOrNull(s.open_rate),
        replyRate: numOrNull(s.reply_rate),
        bounceRate: numOrNull(s.bounce_rate),
      },
    }));
  }

  function numOrNull(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  async function fetchEmailAccounts() {
    const data = await apolloProxy('/email_accounts', {});
    return (data?.email_accounts || []).map((a) => ({
      id: a.id,
      email: a.email,
      default: !!a.default,
    }));
  }

  // ── Constructor de secuencias (sin salir de la app) ────────
  // Igual que fetchSequences/enroll: requiere master key (Apollo devuelve 403
  // si no lo es — el mensaje se traduce en apolloErrorMessage).
  //
  // Una secuencia en Apollo son tres recursos encadenados:
  //   emailer_campaign  →  emailer_step (un correo del cadence, con su espera)
  //                     →  emailer_touch (el asunto y el cuerpo)
  // POST /emailer_steps crea el paso Y un touch vacío; PUT /emailer_touches/{id}
  // le escribe el asunto y el cuerpo. Pasar emailer_steps directamente a
  // POST/PUT /emailer_campaigns NO funciona: responde 200 y los descarta.

  // Cuerpo escrito por el usuario (texto plano, con variables {{first_name}})
  // → HTML para Apollo. Se escapa: el usuario escribe texto, no marcado.
  function bodyToHtml(text) {
    const esc = String(text || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const paras = esc.split(/\n{2,}/).map((p) => p.replace(/\n/g, '<br>'));
    return paras.filter((p) => p.length).map((p) => '<p>' + p + '</p>').join('') || '<p></p>';
  }

  // HTML de Apollo → texto plano para el textarea.
  function htmlToBody(html) {
    if (!html) return '';
    return String(html)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div)\s*>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Lee el asunto y el cuerpo de cada paso. El search de secuencias solo trae
  // el resumen del paso, así que hay que pedir sus touches uno por uno (son
  // pocos: 3-6 pasos por secuencia).
  async function fetchSequenceSteps(steps) {
    const list = Array.isArray(steps) ? steps : [];
    const loaded = await Promise.all(list.map(async (st) => {
      let touch = null;
      try {
        const res = await apolloProxy('/emailer_touches?emailer_step_id=' + encodeURIComponent(st.id), null, 'GET');
        const touches = Array.isArray(res?.emailer_touches) ? res.emailer_touches : [];
        // Varios touches en un paso = variantes A/B. La app edita la primera y
        // deja intactas las demás (ver saveSequence).
        touch = touches[0] || null;
      } catch (_) {
        // Un paso ilegible no debe tumbar el editor completo.
      }
      const tmpl = touch?.emailer_template || {};
      return {
        id: st.id,
        position: st.position,
        waitTime: st.waitTime ?? 0,
        waitMode: st.waitMode || 'day',
        type: st.type || 'auto_email',
        touchId: touch?.id || null,
        touchType: touch?.type || (st.position === 1 ? 'new_thread' : 'reply_to_thread'),
        variants: Math.max(1, touch ? 1 : 0),
        subject: tmpl.subject || '',
        body: htmlToBody(tmpl.body_html || tmpl.body_text || ''),
        unreadable: !touch,
      };
    }));
    return loaded.sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  async function createSequenceShell(name) {
    const created = await apolloProxy('/emailer_campaigns', {
      name,
      permissions: 'private',
    });
    const campaign = created?.emailer_campaign;
    if (!campaign?.id) throw new Error('Apollo no devolvió la secuencia creada. Reintenta.');
    return campaign;
  }

  async function writeStepContent(touchId, step) {
    // Apollo rechaza un asunto en un paso que responde en el mismo hilo.
    const template = { body_html: bodyToHtml(step.body), creation_type: 'manual' };
    if (step.touchType !== 'reply_to_thread') template.subject = String(step.subject || '').trim();
    await apolloProxy('/emailer_touches/' + encodeURIComponent(touchId), {
      id: touchId,
      status: 'approved',
      type: step.touchType || 'new_thread',
      emailer_template: template,
    }, 'PUT');
  }

  /**
   * Crea o actualiza una secuencia completa (nombre + correos).
   * `steps` es el estado deseado; los pasos que ya no aparecen se borran.
   * Devuelve { id, name, created } y avisa por onProgress.
   */
  async function saveSequence({ id, name, steps, existingSteps, onProgress }) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Escribe un nombre para la secuencia.');
    const desired = Array.isArray(steps) ? steps : [];
    if (!desired.length) throw new Error('Agrega al menos un correo a la secuencia.');
    for (const [i, s] of desired.entries()) {
      const isReply = s.touchType === 'reply_to_thread';
      if (!isReply && !String(s.subject || '').trim()) {
        throw new Error('El correo ' + (i + 1) + ' necesita un asunto.');
      }
      if (!String(s.body || '').trim()) {
        throw new Error('El correo ' + (i + 1) + ' necesita un cuerpo.');
      }
    }
    const progress = typeof onProgress === 'function' ? onProgress : () => {};

    let sequenceId = id;
    let created = false;
    if (!sequenceId) {
      progress({ phase: 'sequence', done: 0, total: desired.length });
      const campaign = await createSequenceShell(clean);
      sequenceId = campaign.id;
      created = true;
    } else {
      progress({ phase: 'sequence', done: 0, total: desired.length });
      await apolloProxy('/emailer_campaigns/' + encodeURIComponent(sequenceId), {
        id: sequenceId,
        name: clean,
      }, 'PUT');
    }

    // Borrar los pasos que el usuario quitó del editor.
    const keepIds = new Set(desired.filter((s) => s.id).map((s) => String(s.id)));
    const stale = (Array.isArray(existingSteps) ? existingSteps : [])
      .filter((s) => s.id && !keepIds.has(String(s.id)));
    for (const s of stale) {
      await apolloProxy('/emailer_steps/' + encodeURIComponent(s.id), null, 'DELETE');
    }

    for (const [i, step] of desired.entries()) {
      progress({ phase: 'steps', done: i, total: desired.length });
      const position = i + 1;
      if (step.id) {
        await apolloProxy('/emailer_steps/' + encodeURIComponent(step.id), {
          id: step.id,
          position,
          wait_time: Number(step.waitTime) || 0,
          wait_mode: step.waitMode || 'day',
        }, 'PUT');
        if (step.touchId) {
          await writeStepContent(step.touchId, step);
        }
      } else {
        const res = await apolloProxy('/emailer_steps', {
          emailer_campaign_id: sequenceId,
          position,
          type: 'auto_email',
          wait_time: Number(step.waitTime) || 0,
          wait_mode: step.waitMode || 'day',
        });
        // Apollo crea el paso junto con un touch (y su plantilla) en blanco:
        // ese touch es el que recibe el asunto y el cuerpo.
        const touchId = res?.emailer_touch?.id;
        if (!touchId) {
          throw new Error('Apollo creó el correo ' + position + ' pero no devolvió dónde escribirlo. Revísalo en Apollo.');
        }
        await writeStepContent(touchId, step);
      }
    }
    progress({ phase: 'steps', done: desired.length, total: desired.length });

    return { id: sequenceId, name: clean, created };
  }

  async function setSequenceActive(sequenceId, active) {
    if (!sequenceId) throw new Error('Falta la secuencia.');
    if (active) {
      await apolloProxy('/emailer_campaigns/' + encodeURIComponent(sequenceId) + '/approve', {});
    } else {
      await apolloProxy('/emailer_campaigns/' + encodeURIComponent(sequenceId), {
        id: sequenceId,
        active: false,
      }, 'PUT');
    }
    // La respuesta del PUT devuelve el estado anterior, así que el estado real
    // se relee del search en vez de confiar en ella.
    const fresh = await fetchSequences();
    const found = fresh.find((s) => String(s.id) === String(sequenceId));
    return { sequences: fresh, active: found ? found.active : active };
  }

  async function archiveSequence(sequenceId) {
    if (!sequenceId) throw new Error('Falta la secuencia.');
    await apolloProxy('/emailer_campaigns/' + encodeURIComponent(sequenceId) + '/archive', {});
  }

  async function fetchSchedules() {
    const data = await apolloProxy('/emailer_schedules', null, 'GET');
    return (data?.emailer_schedules || []).map((s) => ({
      id: s.id,
      name: s.name,
      default: !!s.default,
      timeZone: s.time_zone || null,
    }));
  }

  /**
   * Saca contactos de una secuencia. mode 'stop' detiene los pasos pendientes
   * conservando el histórico; 'remove' los quita del todo.
   */
  async function removeFromSequence({ sequenceId, members, mode, reason }) {
    if (!sequenceId) throw new Error('Falta la secuencia.');
    const rows = (Array.isArray(members) ? members : []).filter((m) => m.apollo_contact_id);
    if (!rows.length) throw new Error('Ninguno de los contactos seleccionados está enrolado en Apollo.');

    await apolloProxy('/emailer_campaigns/remove_or_stop_contact_ids', {
      emailer_campaign_ids: [sequenceId],
      contact_ids: rows.map((m) => m.apollo_contact_id),
      mode: mode === 'stop' ? 'stop' : 'remove',
      ...(mode === 'stop' && reason ? { stop_reason: reason } : {}),
    });

    // Limpiar el estado local para que la tabla deje de mostrarlos enrolados.
    const { error } = await sb().from('prospect_list_members')
      .update({ sequence_status: null })
      .in('id', rows.map((m) => m.id));
    if (error) {
      return { removed: rows.length, warning: 'Se sacaron de Apollo, pero no se pudo actualizar el estado local: ' + error.message };
    }
    return { removed: rows.length };
  }

  async function enrollInSequence({ sequence, emailAccountId, members, listName, onProgress }) {
    if (!sequence?.id) throw new Error('Selecciona una secuencia.');
    if (!emailAccountId) throw new Error('Selecciona la cuenta de correo remitente.');
    if (!members?.length) throw new Error('Selecciona al menos un contacto.');
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const failed = [];
    const ready = []; // {member, contactId}

    // 1. Asegurar que cada miembro exista como contacto en Apollo
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      progress({ done: i, total: members.length, phase: 'contacts' });
      try {
        let contactId = m.apollo_contact_id;
        if (!contactId) {
          let row = m;
          if (!m.email && m.apollo_person_id) {
            // Apollo enriquece el email al guardar como contacto: lo replicamos
            const res = await apolloProxy('/people/match', { id: m.apollo_person_id });
            const person = res?.person;
            if (person && !isMaskedEmail(person.email)) {
              row = Object.assign({}, m, { email: person.email, email_status: person.email_status });
              await updateMember(m.id, {
                email: person.email,
                email_status: person.email_status || null,
                enriched_at: new Date().toISOString(),
              });
            }
          }
          contactId = await createApolloContact(row, listName || 'Predictable');
          if (!contactId) throw new Error('Apollo no devolvió el ID del contacto.');
          await updateMember(m.id, { apollo_contact_id: contactId });
        }
        ready.push({ member: m, contactId });
      } catch (e) {
        failed.push({ name: m.name || 'contacto', error: e.message });
      }
    }

    if (!ready.length) return { enrolled: 0, failed };

    // 2. Enrolar todos en una sola llamada
    progress({ done: members.length, total: members.length, phase: 'enrolling' });
    const data = await apolloProxy('/emailer_campaigns/' + sequence.id + '/add_contact_ids', {
      emailer_campaign_id: sequence.id,
      contact_ids: ready.map((r) => r.contactId),
      send_email_from_email_account_id: emailAccountId,
    });
    // Una respuesta sin contactos = Apollo NO enroló a nadie (duplicados,
    // email sin verificar, etc.) — jamás tratarla como éxito.
    const enrolledIds = new Set((Array.isArray(data?.contacts) ? data.contacts : []).map((c) => c.id));

    // 3. Marcar estado en Supabase (una sola escritura — mismo valor para todos)
    const okMembers = [];
    for (const r of ready) {
      if (enrolledIds.has(r.contactId)) okMembers.push(r.member);
      else failed.push({ name: r.member.name || 'contacto', error: 'Apollo no lo enroló (ya está en otra secuencia, email sin verificar o duplicado).' });
    }
    if (okMembers.length) {
      const { error } = await sb().from('prospect_list_members')
        .update({
          sequence_status: {
            sequence_id: sequence.id,
            sequence_name: sequence.name,
            enrolled_at: new Date().toISOString(),
          },
        })
        .in('id', okMembers.map((m) => m.id));
      if (error) {
        // Enrolados en Apollo pero sin marcar localmente: avisar sin revertir.
        failed.push({ name: '(estado local)', error: 'Enrolados en Apollo, pero no se pudo guardar el estado: ' + error.message });
      }
    }
    return { enrolled: okMembers.length, failed };
  }

  // ── Bandeja: correos enviados (Apollo) + hilo real (Gmail) ─────────
  //
  // Reparto de responsabilidades, y por qué:
  //   Apollo  → qué se envió, a quién, cuándo, en qué estado, y si contestaron.
  //   Gmail   → el texto de la conversación y el envío de la respuesta.
  // Apollo NO expone los correos entrantes: los 100 mensajes de una página son
  // todos `outreach_automatic_email`, no hay endpoint de hilo, y sus filtros
  // `contact_ids` / `provider_thread_id` se aceptan y se ignoran en silencio
  // (comprobado contra la API real). Lo único que da del lado entrante es
  // `replied` y `reply_class`. El puente es `provider_thread_id`, que para un
  // buzón de Gmail es el id del hilo de Gmail.

  const MESSAGE_STATS = [
    { value: '',            label: 'Todos los estados' },
    { value: 'delivered',   label: 'Entregados' },
    { value: 'scheduled',   label: 'Programados' },
    { value: 'opened',      label: 'Abiertos' },
    { value: 'not_opened',  label: 'Sin abrir' },
    { value: 'clicked',     label: 'Con clic' },
    { value: 'replied',     label: 'Respondidos' },
    { value: 'bounced',     label: 'Rebotados' },
    { value: 'spam_blocked', label: 'Bloqueados por spam' },
    { value: 'unsubscribed', label: 'Dados de baja' },
  ];

  // Clasificación de sentimiento que hace Apollo sobre la respuesta.
  const REPLY_CLASSES = {
    willing_to_meet: { label: 'Quiere reunirse', pill: 'green' },
    follow_up_question: { label: 'Tiene una pregunta', pill: 'blue' },
    person_referral: { label: 'Refiere a otra persona', pill: 'blue' },
    out_of_office: { label: 'Fuera de oficina', pill: 'gray' },
    already_left_company_or_not_right_person: { label: 'No es la persona', pill: 'gray' },
    not_interested: { label: 'No interesado', pill: 'red' },
    unsubscribe: { label: 'Pidió baja', pill: 'red' },
    none_of_the_above: { label: 'Otro', pill: 'gray' },
  };

  async function fetchOutreachEmails({ sequenceId, stat, page, perPage } = {}) {
    const body = { page: page || 1, per_page: perPage || 25 };
    // Solo se mandan los filtros que Apollo respeta de verdad.
    if (sequenceId) body.emailer_campaign_ids = [sequenceId];
    if (stat) body.emailer_message_stats = [stat];

    const data = await apolloProxy('/emailer_messages/search', body);
    const rows = (data?.emailer_messages || []).map((m) => ({
      id: m.id,
      status: m.status || null,
      subject: m.subject || '',
      // El cuerpo solo viene cuando el correo ya se armó: los `scheduled`
      // llegan vacíos, y eso se muestra como tal en vez de inventarlo.
      body: htmlToBody(m.body_html || '') || (m.body_text || ''),
      toName: m.to_name || '',
      toEmail: m.to_email || '',
      fromEmail: m.from_email || '',
      sequenceId: m.emailer_campaign_id || null,
      contactId: m.contact_id || null,
      threadId: m.provider_thread_id || null,
      dueAt: m.due_at || null,
      completedAt: m.completed_at || null,
      replied: m.replied === true,
      replyClass: m.reply_class || null,
      bounced: !!m.bounce,
      spamBlocked: !!m.spam_blocked,
      notSentReason: m.not_sent_reason || null,
      failureReason: m.failure_reason || null,
      delayReason: m.schedule_delayed_reason || null,
    }));
    return {
      rows,
      page: data?.pagination?.page ?? (page || 1),
      // Apollo no siempre manda total_entries en este endpoint: si falta, la UI
      // pagina por "¿vino una página llena?" en vez de mostrar un total falso.
      total: data?.pagination?.total_entries ?? null,
      totalPages: data?.pagination?.total_pages ?? null,
    };
  }

  // ── Gmail ──────────────────────────────────────────────────────────

  function gmailFetch(action, payload) {
    return edgeFetch('gmail-proxy', { action, payload: payload || {} });
  }

  /** Buzón conectado del usuario, o null. Nunca expone el refresh token. */
  async function fetchGmailAccount() {
    const userId = await getUserId();
    const { data, error } = await sb()
      .from('gmail_accounts')
      // Columnas explícitas a propósito: el grant de SELECT es por columna y
      // un select('*') fallaría al tocar refresh_token.
      .select('id, email, status, last_error, connected_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error('No se pudo leer la conexión de Gmail: ' + error.message);
    return data || null;
  }

  async function startGmailConnect() {
    const redirectUri = window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + 'gmail-callback.html';
    // CSRF: el callback compara este valor con el `state` que devuelva Google.
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('gmail_oauth_state', state);
    const res = await gmailFetch('auth_url', { redirect_uri: redirectUri, state });
    if (!res?.url) throw new Error('No se pudo iniciar la conexión con Google.');
    window.location.assign(res.url);
  }

  async function disconnectGmail() {
    await gmailFetch('disconnect', {});
  }

  async function fetchGmailThread(threadId) {
    if (!threadId) throw new Error('Este correo todavía no tiene un hilo en Gmail.');
    const res = await gmailFetch('thread', { thread_id: threadId });
    return {
      mailbox: res?.mailbox || '',
      messages: (res?.messages || []).sort((a, b) => (a.internal_date || 0) - (b.internal_date || 0)),
    };
  }

  /**
   * Responde por Apollo, en dos pasos: crear el borrador y despacharlo.
   *
   * ⚠️ El segundo paso ENVÍA UN CORREO REAL de inmediato. No programa ni
   * valida: se comprobó a la mala que `send_now` con el cuerpo vacío despachó
   * un mensaje a un prospecto un segundo después, y no hay forma de
   * deshacerlo (/cancel, /unschedule y DELETE sobre un emailer_message dan
   * 404). Quien llame a esto debe confirmar con el usuario antes.
   *
   * Apollo IGNORA in_response_to_emailer_message_id (comprobado: el mensaje
   * sale con provider_thread_id null), así que al prospecto le llega como hilo
   * nuevo aunque el asunto lleve "Re:". Por eso no se manda ese parámetro: no
   * hace nada y sugeriría una garantía que no existe.
   */
  async function sendApolloReply({ contactId, subject, body, emailAccountId, emailAccountAddress }) {
    if (!contactId) throw new Error('Este correo no tiene un contacto de Apollo asociado.');
    if (!String(body || '').trim()) throw new Error('Escribe la respuesta antes de enviarla.');
    if (!emailAccountId || !emailAccountAddress) throw new Error('Selecciona el buzón desde el que quieres responder.');

    const clean = String(subject || '').trim();
    const draft = await apolloProxy('/emailer_messages', {
      contact_id: contactId,
      subject: /^re:/i.test(clean) ? clean : ('Re: ' + clean),
      body_html: bodyToHtml(body),
    });
    const messageId = draft?.emailer_message?.id;
    if (!messageId) throw new Error('Apollo no devolvió el borrador. No se envió nada.');

    const sent = await apolloProxy('/emailer_messages/' + encodeURIComponent(messageId) + '/send_now', {
      id: messageId,
      send_from: { email_account_id: emailAccountId, email: emailAccountAddress },
    });
    const result = sent?.emailer_message || {};
    // Apollo responde 200 aunque bloquee el envío: el estado real manda.
    if (result.status === 'failed' || result.not_sent_reason) {
      throw new Error('Apollo no envió el correo: ' + (result.failure_reason || result.not_sent_reason || 'motivo no informado') + '.');
    }
    return { id: messageId, status: result.status || null };
  }

  // ── Importación de listas legadas (localStorage 'apollo_lists') ────
  // La versión anterior guardaba las listas (incl. enrichment pagado) solo
  // en el navegador. Esto las migra una vez a Supabase.

  function readLegacyLists() {
    try {
      const raw = JSON.parse(localStorage.getItem('apollo_lists') || 'null');
      if (!Array.isArray(raw)) return [];
      return raw.filter((l) => l && Array.isArray(l.contacts) && l.contacts.length);
    } catch (_) { return []; }
  }

  async function importLegacyLists({ onProgress } = {}) {
    const legacy = readLegacyLists();
    if (!legacy.length) return { lists: 0, members: 0 };
    const userId = await getUserId();
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const isApolloId = (v) => /^[a-f0-9]{24}$/.test(String(v || ''));
    let listsCreated = 0;
    let membersCreated = 0;

    for (let i = 0; i < legacy.length; i++) {
      const old = legacy[i];
      progress({ done: i, total: legacy.length });
      let list;
      try {
        list = await createList(old.name || 'Lista importada ' + (i + 1));
      } catch (e) {
        if (!/ese nombre/.test(e.message)) throw e;
        list = await createList((old.name || 'Lista importada') + ' (importada)');
      }
      listsCreated++;
      const rows = (old.contacts || []).map((c) => ({
        list_id: list.id,
        user_id: userId,
        apollo_person_id: isApolloId(c.apolloId) ? c.apolloId : (isApolloId(c.id) ? c.id : null),
        name: c.name || null,
        title: c.title || null,
        company: c.company || null,
        linkedin_url: c.linkedinUrl || null,
        email: isMaskedEmail(c.email) ? null : (c.email || null),
        phone: c.phone || null,
        phone_status: c.phone ? 'revealed' : 'none',
        country: c.country || null,
        snapshot: c,
        enriched_at: (c.email || c.phone) ? new Date().toISOString() : null,
      }));
      if (rows.length) {
        const { data: inserted, error } = await sb().from('prospect_list_members')
          .upsert(rows, { onConflict: 'list_id,apollo_person_id', ignoreDuplicates: true })
          .select('id');
        if (error) throw new Error('No se pudo importar «' + list.name + '»: ' + error.message);
        membersCreated += inserted ? inserted.length : rows.length;
      }
    }
    try { localStorage.setItem('apollo_lists_imported_v1', '1'); } catch (_) { /* ignore */ }
    return { lists: listsCreated, members: membersCreated };
  }

  function hasLegacyListsPendingImport() {
    try {
      if (localStorage.getItem('apollo_lists_imported_v1')) return 0;
      return readLegacyLists().reduce((n, l) => n + l.contacts.length, 0);
    } catch (_) { return 0; }
  }

  // ── Mensajes personalizados (edge function generate-outreach) ──
  // Personalización en 5 capas (Mercado → Industria → Empresa → Rol → Persona)
  // usando el brief del cliente (client_brief) + insights del Intelligence Hub.

  // Garantiza que el brief ("MI Cliente", la síntesis de la matriz) exista
  // antes de personalizar: si no está listo, dispara generate-client-brief y
  // espera a que termine (~1 min). Si la matriz (intel_hub_intake) no existe,
  // lanza — sin matriz no hay base honesta para personalizar.
  // Devuelve el status final ('ready' | 'error' | ...) para que la UI avise
  // si se generará solo con la matriz cruda.
  let briefReadyUntil = 0; // cache: evita re-consultar en cada lead del lote
  async function ensureBriefReady(onStatus) {
    const notify = typeof onStatus === 'function' ? onStatus : function () {};
    if (Date.now() < briefReadyUntil) return 'ready';
    let brief = await fetchClientBrief();
    if (brief?.status === 'ready') {
      briefReadyUntil = Date.now() + 10 * 60 * 1000;
      return 'ready';
    }
    if (!brief || brief.status !== 'generating') {
      notify('Generando el contexto de tu empresa (matriz + investigación)…');
      try {
        await generateClientBrief();
      } catch (e) {
        // Sin matriz no hay nada que esperar: el error del server ya es accionable.
        if (/onboarding|intake/i.test(String(e.detail || e.message))) throw e;
        return brief?.status || 'missing';
      }
    } else {
      notify('Tu contexto de empresa aún se está generando…');
    }
    for (let i = 0; i < 24; i++) { // hasta ~2 min
      await new Promise((r) => setTimeout(r, 5000));
      brief = await fetchClientBrief();
      if (brief?.status === 'ready') {
        briefReadyUntil = Date.now() + 10 * 60 * 1000;
        return 'ready';
      }
      if (brief?.status === 'error') return 'error';
    }
    return brief?.status || 'missing';
  }

  async function generateOutreach({ member, sender }) {
    if (!member) throw new Error('Falta el contacto.');
    if (!member.name && !member.first_name) throw new Error('Este lead no tiene nombre — no se puede personalizar.');
    if (!member.company && !member.title) throw new Error('Este lead no tiene empresa ni cargo — no hay contexto para personalizar el mensaje.');
    const snap = member.snapshot || {};
    const org = snap.organization || {};
    const lead = {
      name: member.name || '',
      first_name: member.first_name || (member.name || '').split(' ')[0] || '',
      title: member.title || '',
      company: member.company || '',
      company_domain: member.company_domain || org.primary_domain || '',
      industry: org.industry || '',
      country: member.country || '',
      city: member.city || '',
      linkedin_url: member.linkedin_url || '',
      // Señales del enrichment (Apollo) — afinan las capas Rol/Empresa.
      headline: snap.headline || '',
      seniority: snap.seniority || '',
      departments: snap.departments || [],
      company_size: org.estimated_num_employees ? String(org.estimated_num_employees) : '',
    };
    // member_id lets the function persist the result server-side (survives
    // the browser reloading or the tab closing mid-generation).
    const data = await edgeFetch('generate-outreach', {
      lead,
      sender: sender || getSenderInfo(),
      member_id: member.id,
      // El backend re-lee la preferencia del perfil; esto solo la adelanta.
      engine: global.AIEngine && global.AIEngine.get('outreach'),
    });
    if (!data?.whatsapp_followup || !data?.linkedin_message) {
      throw new Error('La IA no devolvió los mensajes. Reintenta.');
    }
    return {
      whatsapp_followup: data.whatsapp_followup,
      linkedin_message: data.linkedin_message,
      email_subject: data.email_subject || '',
      email_body: data.email_body || '',
      angle: (data.angle && typeof data.angle === 'object') ? data.angle : null,
      // Preparación para la reunión (la consume el AI coach) — additivo,
      // puede venir null en respuestas del backend anterior.
      coach_prep: (data.coach_prep && typeof data.coach_prep === 'object') ? data.coach_prep : null,
      generated_via: data.generated_via || null,
    };
  }

  // ── Brief del cliente ("MI Cliente") ────────────────────────
  // Contexto del vendedor generado por generate-client-brief: identidad,
  // mecanismo, ICP, social proof y filtros Apollo recomendados. RLS por dueño.

  async function fetchClientBrief() {
    const { data, error } = await sb().from('client_brief').select('*').maybeSingle();
    if (error) throw new Error('No se pudo leer tu brief: ' + error.message);
    return data || null;
  }

  async function generateClientBrief() {
    return edgeFetch('generate-client-brief', {});
  }

  // ── Tendencias de outbound (outreach_playbooks) ─────────────
  // Investigación web periódica (foros tipo r/sales y r/coldemail, academias y
  // reportes de Apollo/Lavender/Gong, operadores) sobre qué está funcionando
  // HOY en frío. La corre generate-outreach-playbook; generate-outreach la
  // aplica al redactar SOLO si la fila está `enabled` y `ready`. Es una capa
  // de recomendación: apagarla no degrada la generación, solo la deja como
  // estaba antes. RLS por dueño.

  async function fetchOutreachPlaybook() {
    const { data, error } = await sb().from('outreach_playbooks').select('*').maybeSingle();
    if (error) {
      // La migración puede no estar aplicada todavía: la pestaña debe seguir
      // funcionando sin tendencias en vez de romperse entera.
      if (/does not exist|schema cache/i.test(error.message || '')) return null;
      throw new Error('No se pudieron leer tus tendencias: ' + error.message);
    }
    return data || null;
  }

  async function generateOutreachPlaybook() {
    return edgeFetch('generate-outreach-playbook', {});
  }

  // Guarda solo las preferencias del usuario (cadencia + si se aplican al
  // redactar). El contenido de la investigación lo escribe la edge function.
  async function saveOutreachPlaybookPrefs({ cadence, enabled }) {
    const patch = { user_id: await getUserId() };
    if (cadence !== undefined) patch.cadence = cadence;
    if (enabled !== undefined) patch.enabled = !!enabled;
    const { data, error } = await sb()
      .from('outreach_playbooks')
      .upsert(patch, { onConflict: 'user_id' })
      .select()
      .maybeSingle();
    if (error) throw new Error('No se pudo guardar la preferencia: ' + error.message);
    return data || null;
  }

  // ── Contexto del lead para el AI coach (coach_lead_context) ──
  // Persiste el handoff Prospección → coach en Supabase (una fila por usuario)
  // para que sobreviva recargas y otros dispositivos.

  // Construye el contexto que viaja al coach desde un prospect_list_member:
  // quién es, por qué le importa (hipótesis del angle), riesgos (objeción +
  // neutralizador) y el outreach completo. Lo usan tanto el botón "Preparar
  // reunión con el coach" (Prospección) como el selector de lead del coach.
  function buildCoachLeadContext(m) {
    const ang = (m.outreach && m.outreach.angle) || {};
    return {
      id: String(m.id),
      name: m.name || '',
      title: m.title || '',
      company: m.company || '',
      brief_who: (m.name || '—') + (m.title ? ' · ' + m.title : '') + (m.company ? ' en ' + m.company : '') + '.',
      brief_why: ang.hypothesis
        ? ang.hypothesis + (ang.social_proof && ang.social_proof !== 'ninguno' ? ' Social proof sugerido: ' + ang.social_proof + '.' : '')
        : 'Lead trabajado desde Prospección.',
      brief_risks: ang.objection
        ? 'Objeción probable: ' + ang.objection + (ang.neutralizer ? '. Neutralizador: ' + ang.neutralizer + '.' : '')
        : 'Sin alertas previas.',
      // Preparación de reunión generada junto con el outreach (nuevo
      // generate-outreach). null para leads con outreach antiguo.
      coach_prep: (m.outreach && m.outreach.coach_prep) || null,
      person_hook: ang.person_hook || null,
      outreach: m.outreach || null,
    };
  }

  async function saveCoachContext(memberId, ctx) {
    const userId = await getUserId();
    const { error } = await sb().from('coach_lead_context').upsert(
      { user_id: userId, member_id: memberId || null, lead: ctx || {} },
      { onConflict: 'user_id' }
    );
    if (error) throw new Error('No se pudo guardar el contexto para el coach: ' + error.message);
  }

  async function fetchLatestCoachContext() {
    const { data, error } = await sb()
      .from('coach_lead_context')
      .select('lead, member_id, updated_at')
      .maybeSingle();
    if (error) throw new Error('No se pudo leer el contexto del coach: ' + error.message);
    return data?.lead || null;
  }

  // ── Remitente (para el saludo de WhatsApp) ─────────────────

  function getSenderInfo() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(SENDER_LS_KEY) || 'null'); } catch (_) { /* ignore */ }
    const profile = global.currentProfile || {};
    const user = global.currentUser || {};
    const fallbackName = profile.name || user.user_metadata?.full_name || (user.email || '').split('@')[0] || '';
    return {
      name: stored?.name || fallbackName,
      // OJO: profiles.role es el rol de PERMISOS ('admin'/'sdr', en inglés) —
      // no es un cargo y no debe colarse en el saludo. El usuario escribe
      // su cargo real en la tarjeta "Tu presentación".
      role: stored?.role || '',
      company: stored?.company || profile.company_name || '',
    };
  }

  function saveSenderInfo(info) {
    try {
      localStorage.setItem(SENDER_LS_KEY, JSON.stringify({
        name: String(info?.name || '').trim(),
        role: String(info?.role || '').trim(),
        company: String(info?.company || '').trim(),
      }));
    } catch (_) { /* storage lleno o bloqueado */ }
  }

  // Primer mensaje fijo de WhatsApp (regla de producto: no se personaliza).
  function firstWhatsAppMessage(sender) {
    const s = sender || getSenderInfo();
    const rolePart = s.role ? ', ' + s.role : '';
    const companyPart = s.company ? ' de ' + s.company : '';
    return 'Hola! Soy ' + s.name + rolePart + companyPart + '. Qué tal todo?';
  }

  // wa.me/<dígitos>?text=<mensaje> — null si el teléfono no sirve.
  function waLink(phone, text) {
    if (!phone) return null;
    let digits = String(phone).replace(/[^\d]/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length < 8 || digits.length > 15) return null;
    return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text || '');
  }

  // ── API pública ────────────────────────────────────────────
  global.prospectingData = {
    CONTACT_STATUSES,
    MEETING_STATUSES,
    searchPeople,
    syncIcpFromSearch,
    fetchLists,
    fetchApolloLists,
    importApolloList,
    fetchAllContacts,
    setContactStatus,
    countMeetings,
    fetchMessageTemplates,
    createMessageTemplate,
    updateMessageTemplate,
    deleteMessageTemplate,
    renderTemplateForMember,
    missingTemplateVars,
    createList,
    deleteList,
    renameList,
    fetchListMemberIds,
    fetchSavedSearches,
    createSavedSearch,
    deleteSavedSearch,
    fetchMembers,
    deleteMembers,
    addPeopleToList,
    addManualMember,
    matchByLinkedinUrl,
    enrichMembers,
    updateMember,
    MESSAGE_STATS,
    REPLY_CLASSES,
    fetchOutreachEmails,
    fetchGmailAccount,
    startGmailConnect,
    disconnectGmail,
    fetchGmailThread,
    sendApolloReply,
    fetchSequences,
    fetchSequenceSteps,
    fetchEmailAccounts,
    fetchSchedules,
    saveSequence,
    setSequenceActive,
    archiveSequence,
    removeFromSequence,
    enrollInSequence,
    generateOutreach,
    ensureBriefReady,
    fetchClientBrief,
    generateClientBrief,
    fetchOutreachPlaybook,
    generateOutreachPlaybook,
    saveOutreachPlaybookPrefs,
    buildCoachLeadContext,
    saveCoachContext,
    fetchLatestCoachContext,
    importLegacyLists,
    hasLegacyListsPendingImport,
    getSenderInfo,
    saveSenderInfo,
    firstWhatsAppMessage,
    waLink,
  };
})(window);
