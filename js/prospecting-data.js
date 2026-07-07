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
  function apolloProxy(endpoint, body) {
    return edgeFetch('apollo-proxy', { endpoint, body: body || {} });
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
    const allowed = ['email', 'email_status', 'phone', 'phone_status', 'outreach', 'sequence_status', 'apollo_contact_id', 'snapshot', 'enriched_at'];
    const safe = {};
    for (const k of allowed) if (k in (patch || {})) safe[k] = patch[k];
    if (!Object.keys(safe).length) return;
    const { error } = await sb().from('prospect_list_members').update(safe).eq('id', memberId);
    if (error) throw new Error('No se pudo actualizar el contacto: ' + error.message);
  }

  // ── Agregar personas a una lista ───────────────────────────
  // Igual que en Apollo: guardar en una lista revela el email laboral.
  // Pipeline: people/bulk_match (1 crédito por match) → POST /contacts
  // (0 créditos, label_names = nombre de la lista) → insert en Supabase.

  function personToRow(person, match, userId, listId, contactId) {
    const p = match || person || {};
    const org = p.organization || person?.organization || {};
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
      company: org.name || p.organization_name || null,
      company_domain: org.primary_domain || null,
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
    const row = {
      list_id: list.id,
      user_id: userId,
      apollo_person_id: null,
      apollo_contact_id: null,
      first_name: firstName || null,
      last_name: lastName || null,
      name: [firstName, lastName].filter(Boolean).join(' ') || null,
      title: String(c.title || '').trim() || null,
      company: null,
      company_domain: null,
      linkedin_url: String(c.linkedin_url || '').trim() || null,
      email: email || null,
      email_status: null,
      phone: phone || null,
      phone_status: phone ? 'revealed' : 'none',
      city: null,
      state: null,
      country: String(c.country || '').trim() || null,
      snapshot: {},
      enriched_at: (email || phone) ? new Date().toISOString() : null,
    };
    const { data, error } = await sb().from('prospect_list_members').insert(row).select().single();
    if (error) throw new Error('No se pudo agregar el contacto: ' + error.message);
    return data;
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

    const enrichable = members.filter((m) => m.apollo_person_id);
    members.filter((m) => !m.apollo_person_id).forEach((m) =>
      failed.push({ name: m.name || m.email || 'contacto', error: 'Sin ID de persona de Apollo — este registro vino como contacto ya guardado; su email ya está enriquecido.' }));

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
        const res = await apolloProxy('/people/match', {
          id: m.apollo_person_id,
          reveal_personal_emails: true,
          reveal_phone_number: !!revealPhones,
        });
        const person = res?.person || null;
        const patch = { enriched_at: new Date().toISOString() };
        if (person) {
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
      num_steps: s.num_steps ?? null,
    }));
  }

  async function fetchEmailAccounts() {
    const data = await apolloProxy('/email_accounts', {});
    return (data?.email_accounts || []).map((a) => ({
      id: a.id,
      email: a.email,
      default: !!a.default,
    }));
  }

  // ── Crear una secuencia (sin salir de la app) ──────────────
  // Igual que fetchSequences/enroll: requiere master key (Apollo devuelve 403
  // si no lo es — el mensaje se traduce en apolloErrorMessage).
  //
  // Solo crea el "shell" de la secuencia (name + permisos) vía la API
  // pública de Apollo: POST /emailer_campaigns.
  //
  // Agregar los correos (pasos) NO es posible desde el servidor: Apollo lo
  // resuelve con un PUT a app.apollo.io/api/v1/sequences/{id} autenticado
  // con la sesión de navegador del usuario (cookie + CSRF token), no con la
  // API key — no existe endpoint público para crear pasos. Por eso el
  // usuario termina de armar los correos dentro de Apollo.
  async function createSequence({ name }) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Escribe un nombre para la secuencia.');

    const created = await apolloProxy('/emailer_campaigns', {
      name: clean,
      permissions: 'private',
    });
    const campaign = created?.emailer_campaign;
    if (!campaign?.id) throw new Error('Apollo no devolvió la secuencia creada. Reintenta.');

    return {
      id: campaign.id,
      name: campaign.name || clean,
      active: !!campaign.active,
      num_steps: campaign.num_steps || 0,
    };
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
    const data = await edgeFetch('generate-outreach', { lead, sender: sender || getSenderInfo() });
    if (!data?.whatsapp_followup || !data?.linkedin_message) {
      throw new Error('La IA no devolvió los mensajes. Reintenta.');
    }
    return {
      whatsapp_followup: data.whatsapp_followup,
      linkedin_message: data.linkedin_message,
      email_subject: data.email_subject || '',
      email_body: data.email_body || '',
      angle: (data.angle && typeof data.angle === 'object') ? data.angle : null,
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

  // ── Contexto del lead para el AI coach (coach_lead_context) ──
  // Persiste el handoff Prospección → coach en Supabase (una fila por usuario)
  // para que sobreviva recargas y otros dispositivos.

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
    searchPeople,
    fetchLists,
    createList,
    deleteList,
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
    fetchSequences,
    fetchEmailAccounts,
    createSequence,
    enrollInSequence,
    generateOutreach,
    ensureBriefReady,
    fetchClientBrief,
    generateClientBrief,
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
