import Link from "next/link";
import { NavLinks } from "@/components/nav-links";
import { signOut } from "../actions";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <a href="#main" className="skip-link">Skip to main content</a>
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center px-4 sm:px-6">
          <Link href="/agents" className="flex items-center gap-2 whitespace-nowrap font-semibold tracking-tight">
            <span aria-hidden className="inline-block size-2.5 rounded-full bg-accent" />
            <span>
              Neato<span className="hidden sm:inline"> Agent Builder</span>
            </span>
          </Link>
          <NavLinks />
          <form action={signOut}>
            <button className="btn btn-quiet whitespace-nowrap">Sign out</button>
          </form>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 outline-none sm:px-6">
        {children}
      </main>
    </>
  );
}
