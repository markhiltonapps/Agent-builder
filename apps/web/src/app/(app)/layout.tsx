import Link from "next/link";
import { signOut } from "../actions";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line bg-bg/60 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center justify-between px-4 sm:px-6">
          <Link href="/agents" className="flex items-center gap-2 font-semibold tracking-tight">
            <span aria-hidden className="inline-block size-2.5 rounded-full bg-accent" />
            Neato Agent Builder
          </Link>
          <form action={signOut}>
            <button className="btn btn-quiet">Sign out</button>
          </form>
        </div>
      </header>
      <div className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6">{children}</div>
    </>
  );
}
