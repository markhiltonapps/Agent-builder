import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Help" };

const SECTIONS = [
  ["start", "Quick start"],
  ["clients", "Clients"],
  ["pick", "Pick a ready-made agent"],
  ["edit", "Make it yours"],
  ["test", "Test it"],
  ["publish", "Put it live"],
  ["website", "Put it on a website"],
  ["numbers", "Get a phone number"],
  ["booking", "Appointments"],
  ["results", "See how it's doing"],
  ["share", "Share with a client"],
  ["usage", "Usage and billing"],
  ["votel", "Votel: where to look"],
  ["cost", "What it costs"],
  ["trouble", "If something looks wrong"],
] as const;

function Shot({ name, alt, height = 800, width = 1280, caption }: { name: string; alt: string; height?: number; width?: number; caption?: string }) {
  return (
    <figure className="my-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/help/${name}.webp`} alt={alt} width={width} height={height} loading="lazy" style={{ maxWidth: width }}
        className="h-auto w-full rounded-2xl border border-line shadow-[0_18px_50px_-22px_rgb(0_0_0/0.8)]"
      />
      {caption && <figcaption className="mt-2 text-xs text-faint">{caption}</figcaption>}
    </figure>
  );
}

function H({ id, children, first }: { id: string; children: React.ReactNode; first?: boolean }) {
  return <h2 id={id} className={`scroll-mt-24 text-xl font-semibold tracking-tight ${first ? "pt-6" : "pt-10"}`}>{children}</h2>;
}

const P = ({ children }: { children: React.ReactNode }) => <p className="mt-2 text-[0.95rem] leading-relaxed text-muted">{children}</p>;
const B = ({ children }: { children: React.ReactNode }) => <strong className="font-medium text-text">{children}</strong>;
const Steps = ({ children }: { children: React.ReactNode }) => (
  <ol className="mt-3 list-decimal space-y-2 pl-6 text-[0.95rem] leading-relaxed text-muted marker:font-medium marker:text-accent">{children}</ol>
);
const Tip = ({ children }: { children: React.ReactNode }) => (
  <p role="note" className="mt-3 rounded-2xl border border-accent/30 bg-accent/10 p-3 text-sm leading-relaxed text-text">{children}</p>
);

export default function HelpPage() {
  return (
    <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="On this page" className="glass p-4 lg:sticky lg:top-24 lg:h-fit">
        <h2 className="mb-2 text-sm font-medium">On this page</h2>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm lg:block lg:space-y-1">
          {SECTIONS.map(([id, label]) => (
            <li key={id}><a href={`#${id}`} className="link text-muted no-underline hover:text-text hover:underline">{label}</a></li>
          ))}
        </ul>
      </nav>

      <article className="glass min-w-0 p-5 pb-10 sm:p-8 sm:pb-12">
        <h1 className="text-3xl font-semibold tracking-tight">Help</h1>
        <P>
          How to build a phone agent, test it, put it live and watch how it does. In the pictures, the yellow numbers
          match the steps beside them.
        </P>

        <H id="start" first>Quick start</H>
        <P>
          Three words to know. A <B>client</B> is a business you build agents for. An <B>agent</B> is the assistant that
          answers its calls. <B>Publishing</B> makes an agent live: callers only ever reach the published version, so you can
          keep editing safely.
        </P>
        <Steps>
          <li>Add a <B>client</B> (or use the one you have).</li>
          <li>Under <B>Agents</B>, choose <B>New agent</B> and pick the ready-made agent for the business.</li>
          <li>Type the business name and a short description, then create it.</li>
          <li>Change anything you like in the editor, and choose <B>Save changes</B>.</li>
          <li>Choose <B>Test call</B> and talk to it.</li>
          <li>Choose <B>Publish</B>. Then add a phone number, or put it on a website.</li>
        </Steps>

        <H id="clients">Clients</H>
        <P>
          Each client has its own agents, calls and numbers, so nothing gets mixed up. Open <B>Clients</B> in the top bar to
          see them all, add a new one, and switch between them. Once you have two or more, a switcher appears in the top bar.
        </P>
        <Shot name="clients" height={1619} alt="The Clients page with three client cards linked to Votel, the client switcher in the top bar and the Add from Votel panel"
          caption="1: switch client here. 2: a client linked to its Votel contact (below it, the private dashboard link: see Share with a client). 3: Add from Votel, which lists contacts carrying the agent-builder-client tag." />
        <P>
          Clients and Votel stay in step, in both directions, through one tag: <B>agent-builder-client</B>.
        </P>
        <Steps>
          <li><B>From Votel to here:</B> in Votel, open a contact and give it the tag <B>agent-builder-client</B>. Back here, choose <B>Check Votel for clients</B> (under <B>Add from Votel</B>) and then <B>Add as client</B>. It becomes a client with its own empty workspace. If the contact has a company name, that is the client&apos;s name.</li>
          <li><B>From here to Votel:</B> when you add a client, leave <B>Also add this client to Votel</B> ticked. A contact is created in Votel with the tag, or the existing one with the same email or phone is found and tagged. For a client you already had, choose <B>Send to Votel</B> on its card.</li>
          <li><B>What follows:</B> each client card shows <B>Linked to a Votel contact</B>. After that, a one-line note is added to that contact whenever one of the client&apos;s agents takes a call, and new agent cards on the Agent Builder OS board are attached to it.</li>
        </Steps>
        <Tip>
          Nothing is ever deleted in Votel from here. <B>Unlink</B> on a card only stops the matching: the client stays here and the contact stays in Votel.
          A Votel contact can belong to one client only.
        </Tip>

        <H id="pick">Pick a ready-made agent</H>
        <P>
          Under <B>Agents</B>, choose <B>Choose a ready-made agent</B>. There is one for 24 kinds of business, from dental
          offices and law firms to auto repair and real estate. Each one already knows what to ask callers, when to bring in a
          person, and what it must never say.
        </P>
        <Shot name="agents" alt="The Agents page with the Choose a ready-made agent button highlighted" height={800} caption="1: start here." />
        <Shot name="gallery" alt="The gallery of ready-made agents with a search box" caption="1: search by kind of business. 2: click one to see what it does." />
        <P>
          Click a card to see what it handles, what it asks every caller, and the rules it follows. Then make it yours:
        </P>
        <Shot name="template" alt="A ready-made dental agent with a form for the business name and description"
          caption="1: the name callers hear. 2: describe the business: where you are, what you offer, when you're open. 3: create it." />
        <Tip>
          The agent only says what is written in the description. It never makes up prices, hours or availability. If it
          doesn&apos;t know something, it takes a message. So the more you tell it, the more it can answer.
        </Tip>
        <P>
          Prefer to start from words? Under <B>New agent</B>, use <B>Describe it and let AI draft it</B>, or <B>Import from
          Votel</B> to bring over an agent you built in Votel. Either way you get a draft to review, and nothing goes live
          until you publish it.
        </P>

        <H id="edit">Make it yours</H>
        <P>The editor has a list of sections on the left and a live preview of exactly what the agent is told on the right.</P>
        <Shot name="editor" alt="The agent editor with its section list, Save changes button and Test call link"
          caption="1: pick a section. 2: save your changes. 3: test the agent." />
        <ul className="mt-3 list-disc space-y-1 pl-6 text-[0.95rem] text-muted marker:text-faint">
          <li><B>Persona</B>: the agent&apos;s name, the business, and how it sounds.</li>
          <li><B>Greetings</B>: what it says when it answers and when it says goodbye.</li>
          <li><B>Rules</B>: things it must never do, such as quote prices or give advice.</li>
          <li><B>Handoffs</B>: when it should bring in a person or take a message.</li>
          <li><B>Actions</B>: what it can do on a call: send a booking link, request an appointment on your calendar.</li>
          <li><B>Speaking &amp; steps</B>: how it talks, and step-by-step flows for common calls.</li>
          <li><B>Voice &amp; limits</B>: the voice, and how long a call may last.</li>
          <li><B>Advanced settings</B>: the same settings as raw text, for experts. You can ignore it.</li>
        </ul>
        <P>
          Stuck for words? Open <B>Ask AI to change this agent</B>, say what you want (for example, “be more formal”), and
          review the changes before you apply them.
        </P>
        <Shot name="unsaved" height={260} alt="The editor header showing Unsaved changes and a Save changes button"
          caption="1: when you change something, Save changes lights up. Saving makes a new version; it doesn't go live yet." />

        <H id="test">Test it</H>
        <P>
          Choose <B>Test call</B>, then <B>Start call</B>. Your browser asks to use the microphone: choose Allow. Pretend to be
          a customer. Headphones help stop echo. You can mute the microphone or end the call at any time, and the
          transcript appears as you talk.
        </P>
        <Shot name="testcall" alt="The test call page with a Start call button" caption="1: start the call." />
        <Tip>Test calls use the <B>published</B> version. If you just saved changes, publish them first to hear them.</Tip>

        <H id="publish">Put it live</H>
        <P>
          Choose <B>Publish</B>. New calls use that version straight away, and calls already in progress aren&apos;t affected.
          Every save is kept, so you can go back: open <B>Version history</B> and publish an older version to roll back.
        </P>
        <Shot name="publish" alt="The confirmation window asking Make version 1 live" caption="1: confirm." />

        <H id="website">Put it on a website</H>
        <P>
          Open the agent and choose <B>Put on website</B>. The bar at the top shows whether website calls are on. Choose
          <B> Change</B> to switch them on, say which websites may show your agent (optional), set a daily limit, and save. Then
          design what visitors will see. Everything fits on one screen: the controls are on the left in three tabs, and the
          preview and your code are on the right.
        </P>
        <Shot name="embed" height={1289} alt="The Put on website page: the access bar with Visitors can, the design tabs, live preview and the code"
          caption="1: whether visitors can talk, chat or both (in the access bar, after Change). 2: the design tabs. 3: switch between the preview and trying it live. 4: the live preview. 5: your code, with your choices already in it." />
        <Steps>
          <li><B>Words, color, logo:</B> the words on the button, its color (pick a swatch or type your own hex code, like #0f766e), and an optional logo. Upload a PNG, JPG or WebP under 512 KB and it shows as a small round badge.</li>
          <li><B>Shape and size:</B> pill, rounded, square, round, or the <B>Glowing orb</B>: a small sphere that softly pulses so visitors can tell something intelligent is listening. Your words appear beside the orb when someone points at it. Also size, look (solid, glass or outline) and an icon.</li>
          <li><B>Position:</B> where it sits on the screen and how far from the edge.</li>
        </Steps>
        <P>
          The preview is a mock website running the real button, so what you see is what visitors get. Switch it between a
          computer and a phone screen, and between a light and a dark page. To test the real thing without leaving the page,
          choose <B>Try it live</B> above the preview (or click the button in the preview, then <B>Try it live</B>). The live call box appears right there, even if you limited the agent to your own website: allow your microphone and talk
          to your agent, or switch to <B>Chat</B> and type. A test call is a real call, so it costs the usual few cents a minute. A chat costs far less. Both count toward your daily limit.
        </P>
        <P>
          When it looks right, copy the code and paste it into the website just before the closing body tag. You can also choose
          <B> Built into the page</B> to place the call box right inside a page instead of floating. Visitors click, allow their
          microphone, and talk to the live agent, or they choose <B>Chat</B> and type to it. Chat is the same agent with the same rules: it can take a message, send a booking link and request an appointment. Calls show up under Calls and on the Dashboard, marked Website, and chats are marked Website chat.
        </P>
        <P>
          In the access bar at the top (choose <B>Change</B>), under <B>Visitors can</B>, you decide whether visitors may <B>Talk</B>, <B>Chat</B>, or both. Chat-only is the cheapest way to offer an agent on a website. When both are on, the call box starts with a <B>Talk</B> and <B>Chat</B> choice.
        </P>
        <Shot name="chat" width={420} height={640} alt="The call box with Talk and Chat choices, showing a chat with the agent" caption="What a visitor sees when they choose Chat: the agent greets them, they type, and it answers. Nothing starts, or counts toward the daily limit, until they press Start chatting." />
        <Tip>
          The preview never starts a call, so you can click around freely (only <B>Try it live</B> does). Your design is remembered in this browser, so you
          can come back and adjust it later. Codes you pasted earlier keep working exactly as they were.
        </Tip>
        <Tip>
          The <B>websites allowed to show it</B> list is optional. Leaving it blank is easiest, but anyone could copy your code.
          The <B>Most calls and chats per day</B> limit keeps the bill safe either way. To use it in a Votel website, paste the code into
          the page&apos;s custom code option in Votel&apos;s website builder.
        </Tip>

        <H id="numbers">Get a phone number</H>
        <P>
          Open <B>Numbers</B>. Type an area code (add up to three, like 602, 480). If you want certain digits, such as 7777,
          type them and say whether they should be anywhere in the number, at the start or at the end. Choose which agent
          should answer, then <B>Rent this number</B>. Only the owner of a client can rent or release numbers.
        </P>
        <Shot name="numbers" alt="The Numbers page with area code and digits search" caption="1: area codes. 2: digits you want. 3: search." />
        <Tip>
          Matches depend on which numbers are available that day, so a very specific search may find only a few, or none. Try
          fewer digits, another place in the number, or another area code.
        </Tip>

        <H id="booking">Appointments</H>
        <P>Two ways to help callers book, both set up under the agent&apos;s <B>Actions</B> section:</P>
        <ul className="mt-3 list-disc space-y-2 pl-6 text-[0.95rem] leading-relaxed text-muted marker:text-faint">
          <li>
            <B>Booking link</B>: the agent texts or emails the caller your booking page. Texting needs Votel&apos;s text
            registration (10DLC) to be finished; until it is, the agent apologizes and takes a message instead.
          </li>
          <li>
            <B>Calendar requests</B>: switch on <B>Let the agent request appointments on your Votel calendar</B>, choose the
            Votel booking service, and the agent asks for a day and time and adds a request to your calendar.
          </li>
        </ul>
        <Tip>
          A calendar request is <B>pending</B>: your team confirms it, and the agent tells the caller exactly that. Votel
          can&apos;t tell the agent which times are taken, so the agent never says an appointment is booked. Look for the
          requests in Votel under Calendars.
        </Tip>

        <H id="results">See how it&apos;s doing</H>
        <P>
          The <B>Dashboard</B> shows calls, how many reached their goal, how many were handed to a person, average length,
          messages taken and booking links sent, with a chart of calls per day. Use the buttons at the top to look at 7, 30 or
          90 days, or at customer calls only (phone and website, without test calls).
        </P>
        <Shot name="dashboard" alt="The dashboard with number cards and a calls per day chart" caption="1: choose the period. 2: the numbers. 3: calls per day." />
        <P>
          <B>Calls</B> lists every call. Open one to read the full transcript, see what the agent did, and whether it reached
          Votel.
        </P>
        <Shot name="calls" alt="The list of calls" caption="1: open a call." />
        <Shot name="call" alt="A call with its transcript and what the agent did" />

        <H id="share">Share with a client</H>
        <P>
          Give a client their own dashboard without a login. On the <B>Clients</B> page, choose <B>Create dashboard link</B>
          under the client, copy it and send it. They see the same numbers and chart, and nothing else: no transcripts, no
          summaries, no phone numbers.
        </P>
        <Shot name="shared" alt="A client's shared dashboard showing only numbers and a chart" caption="What the client sees." />
        <P>
          Anyone with the link can open it, so treat it like a password. <B>Replace link</B> makes a new one and stops the old
          one working immediately. <B>Turn off</B> removes the link.
        </P>

        <H id="usage">Usage and billing</H>
        <P>
          Open <B>Usage</B> in the top bar to see the total minutes for each client, month by month. Use the arrows to move
          between months. Only clients you own are listed, so each person only sees their own.
        </P>
        <Shot name="usage" height={560} alt="The Usage page: a month, the minutes for each client, billable minutes and download buttons"
          caption="1: choose the month. 2: billable minutes, the number to bill from. 3: chats, counted separately. 4: download every client as a spreadsheet. 5: download the calls behind one client's total." />
        <Steps>
          <li><B>Minutes</B> is the exact time on the line, from pick-up to hang-up.</li>
          <li><B>Billable minutes</B> rounds every call up to a whole minute (a 61-second call counts as 2), the way most phone carriers and agencies bill. Use whichever your agreement with the client says.</li>
          <li><B>Chats</B> are typed, so they have no minutes. They are counted in their own column.</li>
        </Steps>
        <P>
          Choose <B>Download this month (CSV)</B> for a spreadsheet of every client, or <B>Calls (CSV)</B> on a row for the list of
          calls behind that client&apos;s total, handy if a client asks how you got the number. By default only real customer calls
          (phone and website) count. Choose <B>Include them</B> to add your own test calls. Days follow your own clock, so a call
          just before midnight lands on the day you saw it.
        </P>

        <H id="votel">Votel: where to look</H>
        <ul className="mt-3 list-disc space-y-2 pl-6 text-[0.95rem] leading-relaxed text-muted marker:text-faint">
          <li>
            <B>Your agents list</B>: in Votel&apos;s left sidebar, <B>Tasks</B>, then the board named <B>Agent Builder OS</B>.
            Each agent here has a card that shows whether it&apos;s live. In the Agents page, choose <B>Send agents to Votel</B>{" "}
            to refresh it. (Votel&apos;s own <B>Agents</B> page lists the agents built inside Votel, not these.)
          </li>
          <li><B>Your clients</B>: in <B>Contacts</B>, the ones tagged <B>agent-builder-client</B>. Each one has a note for every call its agents take, and its agents&apos; cards on the board are attached to it.</li>
          <li><B>Callers</B>: in <B>Contacts</B>. Each caller who left details has a note with the call summary and a link back to the transcript here.</li>
          <li><B>Follow-ups</B>: in <B>Tasks</B>. Urgent calls and callback requests appear as tasks.</li>
          <li><B>Appointment requests</B>: in <B>Calendars</B>, as pending bookings.</li>
        </ul>

        <H id="cost">What it costs</H>
        <P>These are estimates from the providers&apos; list prices. Your own invoices are the final word.</P>
        <div className="glass mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-faint">
              <tr><th scope="col" className="px-4 py-3 font-medium">Call type</th><th scope="col" className="px-4 py-3 font-medium">Roughly, per minute</th><th scope="col" className="px-4 py-3 font-medium">A 5-minute call</th></tr>
            </thead>
            <tbody className="divide-y divide-line text-muted">
              <tr><th scope="row" className="px-4 py-3 font-medium text-text">Website or test call</th><td className="px-4 py-3">5 to 7 cents</td><td className="px-4 py-3">25 to 35 cents</td></tr>
              <tr><th scope="row" className="px-4 py-3 font-medium text-text">Phone call</th><td className="px-4 py-3">6 to 8 cents</td><td className="px-4 py-3">30 to 40 cents</td></tr>
              <tr><th scope="row" className="px-4 py-3 font-medium text-text">Website chat</th><td className="px-4 py-3">No minutes</td><td className="px-4 py-3">A fraction of a cent to a few cents for a whole conversation</td></tr>
            </tbody>
          </table>
        </div>
        <P>
          That is the voice model (5 cents a minute), a small connection fee, and the agent&apos;s thinking, which varies. A
          phone number is free for your first one, then about $1 a month each, plus about 1 cent a minute on calls after a small
          free allowance. Hosting is a small monthly fee.
        </P>
        <P>
          Chat is typed, so there is no voice model and no line time. It uses a small, low-cost text model, which is why it
          costs a tiny fraction of a call. Offer chat next to talking, or on its own to keep costs lowest.
        </P>

        <H id="trouble">If something looks wrong</H>
        <dl className="mt-3 space-y-4 text-[0.95rem] leading-relaxed">
          <div><dt className="font-medium">The test call can&apos;t hear me.</dt><dd className="text-muted">Your browser may have blocked the microphone. Allow it for this site in the browser&apos;s settings and start again.</dd></div>
          <div><dt className="font-medium">“Your agent didn&apos;t pick up.”</dt><dd className="text-muted">The voice service may be restarting. Wait a minute and try again. If it keeps happening, tell Neato.</dd></div>
          <div><dt className="font-medium">I changed something and callers don&apos;t hear it.</dt><dd className="text-muted">Saving makes a draft. Callers hear the published version, so choose Publish.</dd></div>
          <div><dt className="font-medium">The agent said it would connect a caller to a person, but nothing happened.</dt><dd className="text-muted">Live transfer isn&apos;t available yet. The agent now promises a callback instead and marks the call urgent. Check Votel Tasks for the follow-up.</dd></div>
          <div><dt className="font-medium">Can I listen to a call?</dt><dd className="text-muted">Not inside this app yet. Calls are saved as transcripts. Audio recording is possible through LiveKit, and your callers should be told when calls are recorded.</dd></div>
          <div><dt className="font-medium">The text with the booking link didn&apos;t arrive.</dt><dd className="text-muted">Votel&apos;s text registration (10DLC) may not be finished yet. Until then the agent takes a message instead.</dd></div>
          <div><dt className="font-medium">A page says it couldn&apos;t load.</dt><dd className="text-muted">Reload it. If it still fails, <Link href="/agents" className="link">go back to your agents</Link> and tell Neato what you were doing.</dd></div>
        </dl>
      </article>
    </div>
  );
}
