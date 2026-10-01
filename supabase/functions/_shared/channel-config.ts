// Escritura de channel_accounts.config sin pisar lo que otro proceso escribió.
//
// `config` es un JSONB que tocan a la vez wati-webhook (send_block, el sello
// del webhook, plantillas), campaign-run (historial) e inbox-send. Reescribirlo
// entero desde una copia leída antes ({...acc.config, x}) borraba en silencio
// las claves que otro había puesto en medio — así se perdía send_block y el
// motor reintentaba todos los WhatsApp retenidos en la misma corrida (ver la
// migración 20261001000001_channel_config_patch.sql).
//
// patchChannelConfig mezcla SOLO las claves de primer nivel de `set` y quita
// las de `unset` en una sentencia (RPC patch_channel_config). Si la migración
// aún no está aplicada, cae a releer la fila justo antes de escribir: no es
// atómico, pero acota la ventana a milisegundos en vez de a toda la petición.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";

// deno-lint-ignore no-explicit-any
type Json = any;

export async function patchChannelConfig(
  db: SupabaseClient,
  id: string,
  set: Record<string, Json> = {},
  unset: string[] = [],
): Promise<Json | null> {
  const { data, error } = await db.rpc("patch_channel_config", { p_id: id, p_set: set, p_unset: unset });
  if (!error) return data ?? null;
  const { data: fresh } = await db.from("channel_accounts").select("config").eq("id", id).maybeSingle();
  const config: Json = { ...(fresh?.config ?? {}), ...set };
  for (const k of unset) delete config[k];
  await db.from("channel_accounts").update({ config }).eq("id", id);
  return config;
}
