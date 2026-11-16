/**
 * sw.js — Service worker de Predictable (2026-10-06).
 *
 * SOLO notificaciones: los push de la Bandeja (supabase/functions/push-send)
 * y el clic en el aviso de reunión del AI Sales Coach (js/coach-calendar.js).
 * No intercepta `fetch` ni guarda nada en caché a propósito: main es
 * producción y una caché vieja dejaría a la gente con una app desactualizada.
 *
 * Vive en la raíz para que su alcance cubra /index.html (en iPhone, las
 * notificaciones solo funcionan con la app agregada a la pantalla de inicio).
 */
'use strict';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  var title = data.title || 'Predictable';
  // Safari exige mostrar una notificación por cada push: siempre se muestra.
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Tienes un mensaje nuevo en la Bandeja.',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: 'assets/pwa/icon-192.png?v=2',
    badge: 'assets/pwa/badge-96.png?v=2',
    data: { url: data.url || '/index.html#bandeja', conv: data.conv || null },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var d = event.notification.data || {};
  // Aviso de reunión del AI Sales Coach (js/coach-calendar.js): la muestra la
  // propia página, no un push. «Abrir reunión» abre la videollamada; el resto
  // enfoca Predictable y le pasa la reunión para iniciar el coach.
  if (d.kind === 'coach-meeting') {
    if (event.action === 'join' && /^https:\/\//i.test(String(d.meeting_url || ''))) {
      event.waitUntil(self.clients.openWindow(d.meeting_url));
      return;
    }
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (new URL(w.url).origin !== self.location.origin || !/\/index\.html|\/$/.test(new URL(w.url).pathname)) continue;
        w.postMessage({ type: 'predictable:coach-meeting', key: d.key, action: event.action || '' });
        return w.focus();
      }
      return self.clients.openWindow('/index.html?coach_event=' + encodeURIComponent(d.key || ''));
    }));
    return;
  }
  var url = new URL(d.url || '/index.html#bandeja', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
    // Con la app abierta: se enfoca y abre la conversación sin recargar.
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      if (new URL(w.url).origin !== self.location.origin || !/\/index\.html|\/$/.test(new URL(w.url).pathname)) continue;
      w.postMessage({ type: 'predictable:open-conversation', conv: d.conv || null });
      return w.focus();
    }
    return self.clients.openWindow(url);
  }));
});
