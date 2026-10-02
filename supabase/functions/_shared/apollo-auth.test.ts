import { assertEquals } from "jsr:@std/assert@1";
import { defaultEmailAccount, emailAccountsFromConfig, withPreferredDefault } from "./apollo-auth.ts";

const list = [
  { id: "a", email: "a@x.com", default: true, active: true },
  { id: "b", email: "b@x.com", default: false, active: true },
];

Deno.test("buzón elegido por el usuario manda sobre el predeterminado de Apollo", () => {
  assertEquals(defaultEmailAccount(withPreferredDefault(list, "b"))?.id, "b");
});

Deno.test("un id que ya no existe se ignora", () => {
  assertEquals(defaultEmailAccount(withPreferredDefault(list, "zzz"))?.id, "a");
  assertEquals(defaultEmailAccount(withPreferredDefault(list, ""))?.id, "a");
});

Deno.test("emailAccountsFromConfig aplica default_email_account_id", () => {
  const accs = emailAccountsFromConfig({ email_accounts: list, default_email_account_id: "b" });
  assertEquals(defaultEmailAccount(accs)?.email, "b@x.com");
});
