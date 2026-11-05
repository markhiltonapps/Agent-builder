# Neato Agent Builder: working notes

- **Keep the help page current.** Whenever a change alters something a person sees or does in the web app
  (a page, a button, a setting, a flow), update `apps/web/src/app/(app)/help/page.tsx` in the same change, and
  retake the matching screenshot in `apps/web/public/help/` if the screen looks different. Do this before
  committing, without being asked.
- The owner is not a developer: explain results in plain words, and give step-by-step directions for anything
  they need to do in another product (Votel, Supabase, GoDaddy, Railway).
- Deploys happen by pushing the branch (Railway builds in about 3 minutes). Database changes are applied with the
  Supabase tools and also saved in `supabase/migrations/`.

## Email safety (read before testing anything that touches sign-in)

The production Supabase project (`nstpotkzqgkyrvgkdpel`) sends REAL emails for sign-up, sign-in links
and password resets, and bounced mail can get email sending restricted for the whole project.

1. NEVER call public `signUp`, `/auth/v1/signup`, `signInWithOtp` or `resetPasswordForEmail` against it
   with fake, test, `example.com` or `tokbird.com` addresses. Each call sends a real email.
2. Test users: create them without any email (the admin API with `email_confirm: true`, or a direct
   insert of a confirmed user in the database), and delete them when done.
3. A test that must use the real sign-up flow uses a real inbox the owner controls
   (`markallenhilton+test1@gmail.com`) and only a handful of sends. No loops, no retries.
4. Automated or repeated tests run against a separate Supabase project or a local one, never production.
5. Never retry sign-up on failure. Back off and rate-limit any script that calls it.

What enforces this in the code: a "Before User Created" auth hook rejects anything not on
`public.signup_allowlist` before an email is sent; the sign-up form checks the address first
(`apps/web/src/lib/signup-guard.ts`); test scripts must import `apps/web/scripts/test-guard.mjs`.

Where email comes from: Supabase Auth sends through Resend (custom SMTP, `smtp.resend.com`) from
`no-reply@mail.neatoventures.com`. The domain `mail.neatoventures.com` is verified in Resend with SPF and DKIM
(DNS at GoDaddy). The "Before User Created" hook is switched on in Supabase (Authentication, Auth Hooks). Users
added from the Supabase dashboard (Add user) may skip that hook, so they are not a way to test it. No separate
test project exists yet (about $10 a month); the owner chose to skip it until automated sign-up tests are needed.
