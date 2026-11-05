# Neato Agent Builder: working notes

- **Keep the help page current.** Whenever a change alters something a person sees or does in the web app
  (a page, a button, a setting, a flow), update `apps/web/src/app/(app)/help/page.tsx` in the same change, and
  retake the matching screenshot in `apps/web/public/help/` if the screen looks different. Do this before
  committing, without being asked.
- The owner is not a developer: explain results in plain words, and give step-by-step directions for anything
  they need to do in another product (Votel, Supabase, GoDaddy, Railway).
- Deploys happen by pushing the branch (Railway builds in about 3 minutes). Database changes are applied with the
  Supabase tools and also saved in `supabase/migrations/`.
