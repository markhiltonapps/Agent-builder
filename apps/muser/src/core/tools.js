'use strict';
// Real file tools an agent can ask to use. Every tool works in two steps:
//   plan(args)  validates the request against the shared folders and produces the exact,
//               human-readable list of what would happen (this is what the approval card shows)
//   run(plan)   re-checks the disk and performs it
// Paths are resolved with realpath, so ".." tricks and symlinks cannot leave a shared folder.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

const MAX_ENTRIES = 200;
const MAX_BATCH = 200;
const MAX_READ = 64 * 1024;
const MAX_WRITE = 200 * 1024;
const MAX_RESULT = 24000;

const READ_ONLY_TOOLS = ['list_files', 'read_file'];
const MUTATING_TOOLS = ['make_folder', 'move_files', 'trash_files', 'write_file'];
const ALL_TOOLS = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS];

const realpath = (p) => fs.realpathSync.native(p);
const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lstat = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } };

function nearestExisting(p) {
  let probe = p;
  const rest = [];
  for (;;) {
    if (lstat(probe)) return { probe, rest };
    const parent = path.dirname(probe);
    if (parent === probe) return { probe, rest };
    rest.unshift(path.basename(probe));
    probe = parent;
  }
}

function makeContext(folders) {
  const roots = folders.map((f) => realpath(f));

  // follow=true resolves the final component too (for reading); false keeps a final symlink as
  // the link itself (for moving/trashing), but still resolves everything above it.
  function resolve(input, { follow }) {
    if (typeof input !== 'string' || !input.trim()) throw new ToolError('A path is required.');
    let p = input.trim();
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) {
      if (roots.length !== 1) throw new ToolError(`Use an absolute path (got "${input}").`);
      p = path.join(roots[0], p);
    }
    p = path.resolve(p);
    let real;
    if (follow) {
      const { probe, rest } = nearestExisting(p);
      real = path.join(realpath(probe), ...rest);
    } else {
      const { probe, rest } = nearestExisting(path.dirname(p));
      real = path.join(realpath(probe), ...rest, path.basename(p));
    }
    const root = roots.find((r) => inside(r, real));
    if (!root) throw new ToolError(`"${input}" is outside the folders shared with this agent.`);
    return { real, root };
  }

  function display(real) {
    const root = roots.find((r) => inside(r, real));
    if (!root) return real;
    const rel = path.relative(root, real);
    return rel ? `${path.basename(root)}/${rel.split(path.sep).join('/')}` : path.basename(root);
  }
  return { roots, resolve, display };
}

// Results go back to the model as JSON, so shrink the data to fit instead of cutting the text.
function fit(obj, key, kind) {
  let out = JSON.stringify(obj);
  while (out.length > MAX_RESULT) {
    if (kind === 'list') obj[key].length = Math.floor(obj[key].length * 0.8);
    else obj[key] = obj[key].slice(0, Math.floor(obj[key].length * 0.8));
    obj.truncated = true;
    out = JSON.stringify(obj);
  }
  return out;
}

function typeOf(st) {
  return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
}

function moveOne(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function createToolbox({ folders, trash, agentName = 'this agent' }) {
  const ctx = makeContext(folders);
  const who = agentName;

  const tools = {
    list_files: {
      readOnly: true,
      description: 'List the files and folders inside a shared folder, with sizes and last-modified times (ISO dates). Use recursive to look inside subfolders (up to 3 levels, 200 entries).',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of a shared folder or a folder inside one.' }, recursive: { type: 'boolean' } }, required: ['path'] },
      plan(args) {
        const { real } = ctx.resolve(args.path, { follow: true });
        const st = lstat(real);
        if (!st || !fs.statSync(real).isDirectory()) throw new ToolError(`"${args.path}" is not a folder that exists.`);
        const name = ctx.display(real);
        return { readOnly: true, label: `Looked through ${name}`, title: '', summary: '', items: [], op: { real, recursive: !!args.recursive, name } };
      },
      run({ op }) {
        const entries = [];
        let truncated = false;
        const walk = (dir, depth) => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entries.length >= MAX_ENTRIES) { truncated = true; return; }
            const full = path.join(dir, ent.name);
            const st = lstat(full);
            if (!st) continue;
            const type = typeOf(st);
            entries.push({ path: path.relative(op.real, full).split(path.sep).join('/'), type, ...(type === 'file' ? { size: st.size } : {}), modified: st.mtime.toISOString() });
            if (type === 'dir' && op.recursive && depth < 3) walk(full, depth + 1);
          }
        };
        walk(op.real, 1);
        return { outcome: `Looked through ${op.name} (${plural(entries.length, 'item')}${truncated ? ', list cut off' : ''})`, result: fit({ folder: op.real, entries, truncated }, 'entries', 'list') };
      },
    },

    read_file: {
      readOnly: true,
      description: `Read a text file inside a shared folder (first ${MAX_READ / 1024} KB).`,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      plan(args) {
        const { real } = ctx.resolve(args.path, { follow: true });
        const st = lstat(real);
        if (!st || !fs.statSync(real).isFile()) throw new ToolError(`"${args.path}" is not a file that exists.`);
        return { readOnly: true, label: `Read ${ctx.display(real)}`, title: '', summary: '', items: [], op: { real, name: ctx.display(real) } };
      },
      run({ op }) {
        const size = fs.statSync(op.real).size;
        const fd = fs.openSync(op.real, 'r');
        const buf = Buffer.alloc(Math.min(size, MAX_READ));
        try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
        if (buf.includes(0)) return { outcome: `Read ${op.name} (binary file)`, result: JSON.stringify({ path: op.real, size, binary: true, content: null }) };
        return { outcome: `Read ${op.name}`, result: fit({ path: op.real, size, truncated: size > MAX_READ, content: buf.toString('utf8') }, 'content', 'text') };
      },
    },

    make_folder: {
      readOnly: false,
      description: 'Create a folder (and any missing parents) inside a shared folder. Asks the user first.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      plan(args) {
        const { real } = ctx.resolve(args.path, { follow: false });
        const st = lstat(real);
        if (st && !st.isDirectory()) throw new ToolError(`"${args.path}" already exists and is not a folder.`);
        const name = ctx.display(real);
        return { readOnly: false, title: `Allow ${who} to create a folder?`, label: `Create folder ${name}`, summary: st ? `${name} already exists` : `Create ${name}`, items: [st ? `${name} (already exists)` : name], op: { real, name, exists: !!st } };
      },
      run({ op }) {
        fs.mkdirSync(op.real, { recursive: true });
        return { outcome: `Created folder ${op.name}`, result: JSON.stringify({ ok: true, created: op.real }) };
      },
    },

    write_file: {
      readOnly: false,
      description: `Create a text file (max ${MAX_WRITE / 1024} KB) inside a shared folder. Existing files are only replaced when overwrite is true. Asks the user first.`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['path', 'content'] },
      plan(args) {
        if (typeof args.content !== 'string') throw new ToolError('content must be text.');
        const bytes = Buffer.byteLength(args.content);
        if (bytes > MAX_WRITE) throw new ToolError(`content is too large (${bytes} bytes, max ${MAX_WRITE}).`);
        const { real } = ctx.resolve(args.path, { follow: false });
        const st = lstat(real);
        if (st && (!st.isFile() || args.overwrite !== true)) throw new ToolError(st.isFile() ? `"${args.path}" already exists. Set overwrite to true to replace it.` : `"${args.path}" exists and is not a file.`);
        const name = ctx.display(real);
        const verb = st ? 'Replace' : 'Create';
        return { readOnly: false, title: `Allow ${who} to ${st ? 'overwrite' : 'create'} a file?`, label: `${verb} ${name}`, summary: `${verb} ${name} (${bytes} bytes)`, items: [`${verb} ${name} (${bytes} bytes)`], op: { real, name, content: args.content, overwrite: !!st } };
      },
      run({ op }) {
        fs.mkdirSync(path.dirname(op.real), { recursive: true });
        const tmp = `${op.real}.muser-${process.pid}.tmp`;
        fs.writeFileSync(tmp, op.content, { flag: 'wx' });
        if (!op.overwrite && lstat(op.real)) { fs.rmSync(tmp); throw new ToolError(`${op.name} appeared in the meantime; nothing was written.`); }
        fs.renameSync(tmp, op.real);
        return { outcome: `${op.overwrite ? 'Replaced' : 'Created'} ${op.name}`, result: JSON.stringify({ ok: true, path: op.real }) };
      },
    },

    move_files: {
      readOnly: false,
      description: 'Move or rename files and folders inside the shared folders. Each move has a "from" and a "to". If "to" is an existing folder the item is moved into it; otherwise "to" is the new path. Missing folders are created. Nothing is overwritten. Asks the user first.',
      parameters: { type: 'object', properties: { moves: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } }, required: ['moves'] },
      plan(args) {
        if (!Array.isArray(args.moves) || !args.moves.length) throw new ToolError('moves must be a non-empty list.');
        if (args.moves.length > MAX_BATCH) throw new ToolError(`Too many moves at once (max ${MAX_BATCH}).`);
        const ops = [];
        const seenFrom = new Set();
        const seenTo = new Set();
        const newDirs = new Set();
        for (const m of args.moves) {
          const from = ctx.resolve(m && m.from, { follow: false });
          if (!lstat(from.real)) throw new ToolError(`"${m.from}" does not exist.`);
          if (from.real === from.root) throw new ToolError('A shared folder itself cannot be moved.');
          let to = ctx.resolve(m.to, { follow: false });
          const toSt = lstat(to.real);
          if (toSt && toSt.isDirectory()) to = ctx.resolve(path.join(to.real, path.basename(from.real)), { follow: false });
          if (lstat(to.real)) throw new ToolError(`${ctx.display(to.real)} already exists; I will not overwrite it.`);
          if (to.real === from.real) throw new ToolError(`${ctx.display(from.real)} is already there.`);
          if (inside(from.real, to.real)) throw new ToolError(`Cannot move ${ctx.display(from.real)} into itself.`);
          if (seenFrom.has(from.real)) throw new ToolError(`${ctx.display(from.real)} is listed twice.`);
          if (seenTo.has(to.real)) throw new ToolError(`Two items would end up at ${ctx.display(to.real)}.`);
          seenFrom.add(from.real);
          seenTo.add(to.real);
          for (let d = path.dirname(to.real); !lstat(d) && inside(to.root, d) && d !== to.root; d = path.dirname(d)) newDirs.add(d);
          ops.push({ from: from.real, to: to.real });
        }
        const roots = [...new Set(ops.map((o) => path.basename(ctx.roots.find((r) => inside(r, o.from)))))].join(', ');
        const n = ops.length;
        return {
          readOnly: false,
          title: `Allow ${who} to move ${plural(n, 'item')}?`,
          label: `Move ${plural(n, 'item')}`,
          summary: `Move ${plural(n, 'item')} within ${roots}${newDirs.size ? `, creating ${plural(newDirs.size, 'folder')}` : ''}`,
          items: [...[...newDirs].sort().map((d) => `New folder: ${ctx.display(d)}`), ...ops.map((o) => `${ctx.display(o.from)} → ${ctx.display(o.to)}`)],
          op: { ops },
        };
      },
      run({ op }) {
        const moved = [];
        const failed = [];
        for (const { from, to } of op.ops) {
          try {
            if (!lstat(from)) throw new ToolError('no longer exists');
            if (lstat(to)) throw new ToolError('destination appeared in the meantime');
            moveOne(from, to);
            moved.push({ from: ctx.display(from), to: ctx.display(to) });
          } catch (e) {
            failed.push({ from: ctx.display(from), error: e.message });
          }
        }
        return { outcome: failed.length ? `Moved ${moved.length}, ${failed.length} failed` : `Moved ${plural(moved.length, 'item')}`, result: fit({ moved, failed }, 'moved', 'list') };
      },
    },

    trash_files: {
      readOnly: false,
      description: 'Move files or folders inside the shared folders to the Trash (recoverable). Asks the user first.',
      parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
      plan(args) {
        if (!Array.isArray(args.paths) || !args.paths.length) throw new ToolError('paths must be a non-empty list.');
        if (args.paths.length > MAX_BATCH) throw new ToolError(`Too many items at once (max ${MAX_BATCH}).`);
        let targets = [];
        for (const p of args.paths) {
          const r = ctx.resolve(p, { follow: false });
          const st = lstat(r.real);
          if (!st) throw new ToolError(`"${p}" does not exist.`);
          if (r.real === r.root) throw new ToolError('A shared folder itself cannot be trashed.');
          if (!targets.some((t) => t.real === r.real)) targets.push({ real: r.real, root: r.root, dir: st.isDirectory() });
        }
        // Trashing a folder already covers everything inside it.
        targets = targets.filter((t) => !targets.some((o) => o !== t && o.dir && inside(o.real, t.real)));
        const n = targets.length;
        const roots = [...new Set(targets.map((t) => path.basename(t.root)))].join(', ');
        return {
          readOnly: false,
          title: `Allow ${who} to move ${plural(n, 'item')} to Trash?`,
          label: `Move ${plural(n, 'item')} to Trash`,
          summary: `Move ${plural(n, 'item')} in ${roots} to Trash`,
          items: targets.map((t) => `${ctx.display(t.real)}${t.dir ? ' (folder)' : ''}`),
          op: { targets },
        };
      },
      async run({ op }) {
        const trashed = [];
        const failed = [];
        for (const t of op.targets) {
          try {
            if (!lstat(t.real)) throw new ToolError('no longer exists');
            await trash(t.real);
            trashed.push(ctx.display(t.real));
          } catch (e) {
            failed.push({ path: ctx.display(t.real), error: e.message });
          }
        }
        return { outcome: failed.length ? `Moved ${trashed.length} to Trash, ${failed.length} failed` : `Moved ${plural(trashed.length, 'item')} to Trash`, result: fit({ trashed, failed }, 'trashed', 'list') };
      },
    },
  };

  return {
    roots: ctx.roots,
    definitions: () => ALL_TOOLS.map((name) => ({ name, description: tools[name].description, parameters: tools[name].parameters })),
    has: (name) => Object.prototype.hasOwnProperty.call(tools, name),
    isReadOnly: (name) => !!tools[name]?.readOnly,
    plan: (name, args) => tools[name].plan(args && typeof args === 'object' ? args : {}),
    run: async (name, plan) => tools[name].run(plan),
  };
}

// Fallback "Trash" for headless use: a recoverable folder inside Muser's own data directory.
function appTrash(dataDir) {
  const dir = path.join(dataDir, 'trash', new Date().toISOString().replace(/[:.]/g, '-'));
  return async (real) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let dest = path.join(dir, path.basename(real));
    for (let i = 1; lstat(dest); i++) dest = path.join(dir, `${path.basename(real)}.${i}`);
    moveOne(real, dest);
    fs.appendFileSync(path.join(dir, 'manifest.jsonl'), `${JSON.stringify({ original: real, trashedAs: dest, at: Date.now() })}\n`);
  };
}

module.exports = { createToolbox, appTrash, ToolError, READ_ONLY_TOOLS, MUTATING_TOOLS, ALL_TOOLS };
