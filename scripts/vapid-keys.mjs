#!/usr/bin/env node
// Genera el par VAPID para las notificaciones push (supabase/functions/push-send).
//
//   node scripts/vapid-keys.mjs
//
// Pega las dos líneas en Supabase → Edge Functions → Secrets. La privada NO va
// en ningún archivo del repo. Cambiar el par invalida todas las suscripciones:
// cada dispositivo tiene que volver a activar los avisos.
import { webcrypto as crypto } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

console.log(`VAPID_PUBLIC_KEY=${b64u(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log('VAPID_SUBJECT=mailto:<tu-email-de-soporte>');
