// Every test script that could call sign-up imports this first. It exists because each sign-up call
// sends a real email, and bounced mail can get email sending restricted for the production project.
//
//   import { assertSafeToSignUp } from "./test-guard.mjs";
//   assertSafeToSignUp({ supabaseUrl, email });   // throws instead of sending anything

export const PRODUCTION_REF = "nstpotkzqgkyrvgkdpel";
const BLOCKED = /@(example\.(com|org|net)|localhost|tokbird\.com)$|\.(test|invalid|example|localhost)$/i;
/** The only addresses allowed to sign up against production in a test: the owner's own inbox, plus-addressed. */
const REAL_INBOX = /^markallenhilton\+[a-z0-9._-]{1,30}@gmail\.com$/i;

export function assertSafeToSignUp({ supabaseUrl, email }) {
  const addr = String(email ?? "").trim();
  if (BLOCKED.test(addr)) throw new Error(`Refusing to sign up ${addr}: that address cannot receive mail and would bounce.`);
  const production = String(supabaseUrl ?? "").includes(PRODUCTION_REF);
  if (production && !REAL_INBOX.test(addr)) {
    throw new Error(
      `Refusing to call sign-up on the production project for ${addr}. ` +
        "Create test users without email (admin API or a direct database insert), or use a staging project. " +
        "A real-flow test may only use markallenhilton+<tag>@gmail.com.",
    );
  }
}
