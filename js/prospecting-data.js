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
      const detail = body?.error || body?.message || ('HTTP ' + res.status);
      const err = new Error(apolloErrorMessage(detail, res.status));
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
      .select('apollo_person_id')
      .eq('list_id', list.id);
    if (exErr) throw new Error('No se pudo leer la lista: ' + exErr.message);
    const existingIds = new Set((existing || []).map((r) => r.apollo_person_id).filter(Boolean));

    const fresh = people.filter((p) => p?.id && !existingIds.has(p.id));
    const alreadyInList = people.length - fresh.length;

    let added = 0;
    let creditsUsed = 0;
    const failed = [];
    const rows = [];

    // 1. Enriquecer email vía bulk_match en lotes de 10
    for (let i = 0; i < fresh.length; i += BULK_MATCH_CHUNK) {
      const chunk = fresh.slice(i, i + BULK_MATCH_CHUNK);
      progress({ done: Math.min(i, fresh.length), total: fresh.length, phase: 'enriching' });
      let matches = new Array(chunk.length).fill(null);
      try {
        const res = await apolloProxy('/people/bulk_match', {
          details: chunk.map((p) => ({ id: p.id })),
          reveal_personal_emails: false,
        });
        matches = res?.matches || matches;
        creditsUsed += res?.credits_consumed ?? matches.filter(Boolean).length;
      } catch (e) {
        // El lote falló completo: registramos y seguimos con snapshot de búsqueda
        chunk.forEach((p) => failed.push({ name: p.name || p.id, error: e.message }));
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
        rows.push(row);
      }
    }

    // 3. Persistir en Supabase
    if (rows.length) {
      progress({ done: fresh.length, total: fresh.length, phase: 'saving' });
      const { error } = await sb().from('prospect_list_members')
        .upsert(rows, { onConflict: 'list_id,apollo_person_id', ignoreDuplicates: true });
      if (error) throw new Error('No se pudieron guardar los contactos: ' + error.message);
      added = rows.length;
    }

    return { added, alreadyInList, failed, creditsUsed };
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

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      progress({ done: i, total: members.length, phase: 'enriching' });
      try {
        if (!m.apollo_person_id) throw new Error('Sin ID de Apollo — vuelve a agregarlo desde Búsqueda.');
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
            patch.phone_status = 'pending';
            phonePending++;
          }
          patch.snapshot = Object.assign({}, m.snapshot || {}, person);
        } else if (revealPhones) {
          patch.phone_status = 'pending';
          phonePending++;
        }
        await updateMember(m.id, patch);
        updated++;
      } catch (e) {
        failed.push({ name: m.name || m.email || 'contacto', error: e.message });
      }
    }
    progress({ done: members.length, total: members.length, phase: 'enriching' });
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
    const enrolledIds = new Set((data?.contacts || []).map((c) => c.id));

    // 3. Marcar estado en Supabase
    let enrolled = 0;
    for (const r of ready) {
      const ok = enrolledIds.size === 0 || enrolledIds.has(r.contactId);
      if (!ok) {
        failed.push({ name: r.member.name || 'contacto', error: 'Apollo no lo enroló (revisa duplicados o verificación de email).' });
        continue;
      }
      enrolled++;
      await updateMember(r.member.id, {
        sequence_status: {
          sequence_id: sequence.id,
          sequence_name: sequence.name,
          enrolled_at: new Date().toISOString(),
        },
      });
    }
    return { enrolled, failed };
  }

  // ── Mensajes personalizados (edge function generate-outreach) ──

  async function generateOutreach({ member, sender }) {
    if (!member) throw new Error('Falta el contacto.');
    const lead = {
      name: member.name || '',
      first_name: member.first_name || (member.name || '').split(' ')[0] || '',
      title: member.title || '',
      company: member.company || '',
      industry: member.snapshot?.organization?.industry || '',
      country: member.country || '',
    };
    const data = await edgeFetch('generate-outreach', { lead, sender: sender || getSenderInfo() });
    if (!data?.whatsapp_followup || !data?.linkedin_message) {
      throw new Error('La IA no devolvió los mensajes. Reintenta.');
    }
    return { whatsapp_followup: data.whatsapp_followup, linkedin_message: data.linkedin_message };
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
      role: stored?.role || profile.role || '',
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
    fetchMembers,
    deleteMembers,
    addPeopleToList,
    enrichMembers,
    updateMember,
    fetchSequences,
    fetchEmailAccounts,
    enrollInSequence,
    generateOutreach,
    getSenderInfo,
    saveSenderInfo,
    firstWhatsAppMessage,
    waLink,
  };
})(window);
