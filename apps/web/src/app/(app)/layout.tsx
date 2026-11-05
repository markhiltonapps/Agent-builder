import { NavLinks } from "@/components/nav-links";
import { SignOutButton } from "@/components/sign-out-button";
import { BrandLink } from "@/components/brand-link";
import { ClientSwitcher } from "@/components/client-switcher";
import { currentClient } from "@/lib/client";
import { supabaseServer } from "@/lib/supabase/server";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { clients, current } = await currentClient(await supabaseServer());
  return (
    <>
      <a href="#main" className="skip-link">Skip to main content</a>
      <header className="sticky top-0 z-20 px-3 pt-3 sm:px-6">
        <div className="glass glass-bar mx-auto flex h-14 max-w-[1500px] items-center px-2 sm:px-5">
          <BrandLink />
          <NavLinks />
          {current && <div className="mr-2 hidden sm:block"><ClientSwitcher clients={clients} currentId={current.id} /></div>}
          <SignOutButton />
        </div>
      </header>
      {current && clients.length > 1 && (
        <div className="mx-auto mt-3 flex max-w-[1500px] px-4 sm:hidden"><ClientSwitcher clients={clients} currentId={current.id} /></div>
      )}
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] flex-1 px-4 pb-24 pt-6 outline-none sm:px-6 lg:pb-6">
        {children}
      </main>
    </>
  );
}
