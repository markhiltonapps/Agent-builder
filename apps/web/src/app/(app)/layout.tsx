import { NavLinks } from "@/components/nav-links";
import { SignOutButton } from "@/components/sign-out-button";
import { BrandLink } from "@/components/brand-link";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <a href="#main" className="skip-link">Skip to main content</a>
      <header className="sticky top-0 z-20 px-3 pt-3 sm:px-6">
        <div className="glass glass-bar mx-auto flex h-14 max-w-[1500px] items-center px-2 sm:px-5">
          <BrandLink />
          <NavLinks />
          <SignOutButton />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] flex-1 px-4 pb-24 pt-6 outline-none sm:px-6 lg:pb-6">
        {children}
      </main>
    </>
  );
}
