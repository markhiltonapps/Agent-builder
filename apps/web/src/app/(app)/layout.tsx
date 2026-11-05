import { AppHeader } from "@/components/app-header";
import { currentClient } from "@/lib/client";
import { supabaseServer } from "@/lib/supabase/server";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { clients, current } = await currentClient(await supabaseServer());
  return (
    <>
      <a href="#main" className="skip-link">Skip to main content</a>
      <AppHeader clients={clients} current={current} />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] flex-1 px-4 pb-24 pt-6 outline-none sm:px-6 lg:pb-6">
        {children}
      </main>
    </>
  );
}
