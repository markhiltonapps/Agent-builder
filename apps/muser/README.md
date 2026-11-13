# Muser

A desktop chat app for personal AI agents. Each agent has a name, a role and **editable
instructions**; chats are **saved** on your computer, replies **stream** in, and you can
**stop** and **retry** them. The window layout follows the desktop app it was modelled on:
an icon rail, a "Chats" drawer, the agent chip at the top, blue and grey bubbles and a
rounded composer.

```
src/core/       Node: JSON store, provider streaming (OpenAI, Anthropic, offline demo), local API
src/renderer/   the UI (plain HTML/CSS/JS, no build step)
src/main/       Electron shell: window, menu, lifecycle
test/           API tests (node:test) and browser tests (Playwright)
scripts/        icon generator
```

## Run

```bash
cd apps/muser
npm install
npm start                 # desktop window (Electron)
npm run serve             # same app in any browser; prints http://127.0.0.1:PORT/
```

Replies need a key: set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, or paste one in **Settings**
(saved to `settings.json`, mode 0600, never sent back to the UI). With no key the app runs
in a clearly labelled **demo mode** that streams a local reply.

Data lives in Electron's user-data folder (`…/data/`), or `~/.muser` when run with
`npm run serve` (override with `MUSER_DATA_DIR`).

## What it does

- **Saved chats.** Every chat is a JSON file, written atomically. Your message is on disk
  before the model is called; the reply is saved as it streams. Pin, rename, search, delete.
- **Editable instructions.** Click the agent at the top. Changes apply to the very next
  reply, in new and existing chats. Limit 8,000 characters.
- **New agent flow.** `+` in the rail → start blank or from a preset → edit name, role,
  avatar and instructions → Create opens a fresh chat with that agent.
- **Streaming, Stop, Retry.** Stop (button or Esc) keeps the partial reply. Retry replaces
  the last reply. Errors show a readable message and offer Retry.
- **Crash safety.** If the app dies mid-reply, the partial text is kept, marked
  "Reply was interrupted", and can be retried after restart.

Shortcuts: `Ctrl/⌘ N` new chat, `Ctrl/⌘ ,` settings, `Esc` stop / close, `Enter` send,
`Shift+Enter` newline.

## Test

```bash
npm test                  # 13 API tests (fake OpenAI/Anthropic upstreams, restart recovery)
npm run test:e2e          # 17 browser checks incl. kill -9 mid-reply and immediate restart
node test/e2e/run.js --live         # + 5 checks against the real OpenAI API (needs OPENAI_API_KEY)
xvfb-run -a node test/e2e/electron-smoke.js    # launches the real Electron app twice
MUSER_PACKAGED=$PWD/dist/linux-unpacked/muser xvfb-run -a node test/e2e/electron-smoke.js
```

Screenshots from the browser run go to `test/e2e/out/` (git-ignored).

## Package

```bash
npm run dist:linux        # dist/linux-unpacked, muser_<v>_amd64.deb
npm run dist:mac          # Muser-<v>-mac.zip (x64), Muser-<v>-arm64-mac.zip
npm run dist:win          # Muser-<v>-win.zip
```

Packages are **unsigned**. Only the Linux package has been launched in testing (see below).

## Security notes

The local server binds to 127.0.0.1, rejects any Host header that is not loopback, and
requires a per-launch token on every `/api` call. The page is served with a strict CSP.
Assistant output is HTML-escaped before the small markdown renderer touches it. The
Electron window runs sandboxed with context isolation, denies all device permissions and
opens links in your browser.

## Not finished

- **Tool use and approvals.** The "Allow / Always allow / Deny" card from the reference is
  not built: agents cannot act on files, mail or the web yet.
- **Voice** (mic button, dictation), **attachments** (the `+` opens New chat / Edit
  instructions / Settings instead), and the rail's other sections (tasks, ideas, apps).
- **Signing and notarisation** for macOS and Windows; **auto-update**.
- **macOS and Windows builds are untested** (built on Linux, never launched). The macOS
  title-bar styling (`hiddenInset`) is therefore unverified.
- **API keys are stored in a 0600 JSON file**, not the OS keychain.
- No message editing, no multi-agent chats, no export.
- Anthropic streaming is covered by tests against a fake upstream only, not a live key.
