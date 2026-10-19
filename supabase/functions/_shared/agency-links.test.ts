// deno test supabase/functions/_shared/agency-links.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { enterAccountDecision, inviteEmail, parseInvite } from "./agency-links.ts";

Deno.test("parseInvite normaliza y valida", () => {
  assertEquals(parseInvite({ email: "  Info@HAI-Educators.com ", label: " HAI   Educators " }), {
    ok: true, value: { email: "info@hai-educators.com", label: "HAI Educators" },
  });
  assertEquals(parseInvite({ email: "x@y.co" }).ok, true);
  for (const bad of ["", "sin-arroba", "a@b", "a b@c.com", "a@b.com,c@d.com", "<x>@y.com", "ws-1@workspaces.vanarsi.com"]) {
    assertEquals(parseInvite({ email: bad }).ok, false, bad);
  }
  assertEquals(parseInvite({ email: "yo@a.com" }, "YO@a.com").ok, false);
  assertEquals(parseInvite({ email: "a@b.com", label: "x".repeat(81) }).ok, false);
});

Deno.test("inviteEmail escapa el nombre de la agencia", () => {
  const m = inviteEmail('<img src=x onerror=alert(1)> & "Co"');
  assert(!m.html.includes("<img"));
  assert(m.html.includes("&lt;img"));
  assert(m.subject.includes("te invitó"));
});

const base = { callerId: "A", targetId: "B", callerIsTeam: false, targetIsTeam: false, targetIsWorkspace: false };

Deno.test("enterAccountDecision: la agencia solo entra con vínculo activo propio", () => {
  const link = { agency_user_id: "A", member_user_id: "B", status: "active" };
  assertEquals(enterAccountDecision({ ...base, link }), { ok: true, via: "agency" });
  assertEquals(enterAccountDecision({ ...base, link: null }).ok, false);
  assertEquals(enterAccountDecision({ ...base, link: { ...link, status: "revoked" } }).ok, false);
  assertEquals(enterAccountDecision({ ...base, link: { ...link, status: "pending" } }).ok, false);
  assertEquals(enterAccountDecision({ ...base, link: { ...link, agency_user_id: "Z" } }).ok, false);
  assertEquals(enterAccountDecision({ ...base, link: { ...link, member_user_id: "C" } }).ok, false);
});

Deno.test("enterAccountDecision: el equipo entra a cualquier cuenta menos espacios y equipo", () => {
  assertEquals(enterAccountDecision({ ...base, callerIsTeam: true }), { ok: true, via: "team" });
  assertEquals(enterAccountDecision({ ...base, callerIsTeam: true, targetIsTeam: true }).ok, false);
  assertEquals(enterAccountDecision({ ...base, callerIsTeam: true, targetIsWorkspace: true }).ok, false);
  assertEquals(enterAccountDecision({ ...base, callerIsTeam: true, targetId: "A" }).ok, false);
});
