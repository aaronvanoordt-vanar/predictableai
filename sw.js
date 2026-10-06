/**
 * sw.js — Service worker de Predictable (2026-10-06).
 *
 * SOLO notificaciones push de la Bandeja (supabase/functions/push-send).
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
    icon: 'assets/pwa/icon-192.png',
    badge: 'assets/pwa/badge-96.png',
    data: { url: data.url || '/index.html#bandeja', conv: data.conv || null },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var d = event.notification.data || {};
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
