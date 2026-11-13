'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolbox } = require('../src/core/tools');

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-tools-')));
  const dl = path.join(base, 'Downloads');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(dl);
  fs.mkdirSync(outside);
  const trashed = [];
  const box = createToolbox({ folders: [dl], trash: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); }, agentName: 'Muser' });
  return { base, dl, outside, trashed, box };
}
const write = (p, text = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const rejects = (fn, re) => assert.throws(fn, (e) => e.name === 'ToolError' && (!re || re.test(e.message)), `expected ToolError ${re || ''}`);

test('list_files reports names, sizes and modified dates, and recurses to a limit', async () => {
  const s = sandbox();
  write(path.join(s.dl, 'a.txt'), 'hello');
  write(path.join(s.dl, 'sub', 'b.txt'));
  const old = new Date('2024-01-02T03:04:05Z');
  fs.utimesSync(path.join(s.dl, 'a.txt'), old, old);
  const flat = JSON.parse((await s.box.run('list_files', s.box.plan('list_files', { path: s.dl }))).result);
  assert.deepEqual(flat.entries.map((e) => e.path), ['a.txt', 'sub']);
  assert.equal(flat.entries[0].size, 5);
  assert.equal(flat.entries[0].modified, old.toISOString());
  const deep = JSON.parse((await s.box.run('list_files', s.box.plan('list_files', { path: s.dl, recursive: true }))).result);
  assert.ok(deep.entries.some((e) => e.path === 'sub/b.txt'));
});

test('paths cannot leave the shared folder: dotdot, absolute, and symlinks', () => {
  const s = sandbox();
  write(path.join(s.outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(s.outside, path.join(s.dl, 'link-out'));
  fs.symlinkSync(path.join(s.outside, 'secret.txt'), path.join(s.dl, 'secret-link.txt'));
  rejects(() => s.box.plan('list_files', { path: path.join(s.dl, '..', 'outside') }), /outside the folders/);
  rejects(() => s.box.plan('list_files', { path: s.outside }), /outside the folders/);
  rejects(() => s.box.plan('list_files', { path: path.join(s.dl, 'link-out') }), /outside the folders/);
  rejects(() => s.box.plan('read_file', { path: path.join(s.dl, 'secret-link.txt') }), /outside the folders/);
  rejects(() => s.box.plan('read_file', { path: path.join(s.dl, 'link-out', 'secret.txt') }), /outside the folders/);
  rejects(() => s.box.plan('move_files', { moves: [{ from: path.join(s.dl, 'x'), to: path.join(s.outside, 'x') }] }), /does not exist|outside/);
  write(path.join(s.dl, 'mine.txt'));
  rejects(() => s.box.plan('move_files', { moves: [{ from: path.join(s.dl, 'mine.txt'), to: path.join(s.outside, 'mine.txt') }] }), /outside the folders/);
  rejects(() => s.box.plan('write_file', { path: path.join(s.outside, 'new.txt'), content: 'x' }), /outside the folders/);
  rejects(() => s.box.plan('write_file', { path: path.join(s.dl, 'link-out', 'new.txt'), content: 'x' }), /outside the folders/);
  rejects(() => s.box.plan('make_folder', { path: path.join(s.dl, '..', 'evil') }), /outside the folders/);
  assert.ok(!fs.existsSync(path.join(s.outside, 'new.txt')));
});

test('trashing a symlink touches the link, never its target', async () => {
  const s = sandbox();
  write(path.join(s.outside, 'precious.txt'), 'keep');
  fs.symlinkSync(path.join(s.outside, 'precious.txt'), path.join(s.dl, 'l.txt'));
  const plan = s.box.plan('trash_files', { paths: [path.join(s.dl, 'l.txt')] });
  await s.box.run('trash_files', plan);
  assert.deepEqual(s.trashed, [path.join(s.dl, 'l.txt')]);
  assert.equal(fs.readFileSync(path.join(s.outside, 'precious.txt'), 'utf8'), 'keep');
});

test('trash_files: plan lists exact items, dedupes children of a folder, refuses the root', async () => {
  const s = sandbox();
  write(path.join(s.dl, 'old', 'a.txt'));
  write(path.join(s.dl, 'b.txt'));
  const plan = s.box.plan('trash_files', { paths: [path.join(s.dl, 'old'), path.join(s.dl, 'old', 'a.txt'), path.join(s.dl, 'b.txt'), path.join(s.dl, 'b.txt')] });
  assert.deepEqual(plan.items, ['Downloads/old (folder)', 'Downloads/b.txt']);
  assert.match(plan.title, /Allow Muser to move 2 items to Trash\?/);
  assert.equal(fs.existsSync(path.join(s.dl, 'b.txt')), true, 'planning changes nothing');
  const out = await s.box.run('trash_files', plan);
  assert.equal(out.outcome, 'Moved 2 items to Trash');
  assert.equal(s.trashed.length, 2);
  rejects(() => s.box.plan('trash_files', { paths: [s.dl] }), /cannot be trashed/);
  rejects(() => s.box.plan('trash_files', { paths: [path.join(s.dl, 'ghost')] }), /does not exist/);
});

test('move_files: into a folder, creating folders, never overwriting', async () => {
  const s = sandbox();
  write(path.join(s.dl, 'math.pdf'));
  write(path.join(s.dl, 'art.pdf'));
  write(path.join(s.dl, 'taken', 'art.pdf'), 'existing');
  const plan = s.box.plan('move_files', { moves: [{ from: path.join(s.dl, 'math.pdf'), to: path.join(s.dl, 'School', '2025', 'Math') }] });
  assert.ok(plan.items.includes('New folder: Downloads/School/2025'), 'new folders are announced');
  assert.ok(plan.items.some((i) => i === 'Downloads/math.pdf → Downloads/School/2025/Math'));
  const out = await s.box.run('move_files', plan);
  assert.equal(out.outcome, 'Moved 1 item');
  assert.ok(fs.existsSync(path.join(s.dl, 'School', '2025', 'Math')));
  // "to" naming an existing folder moves the item into it
  const into = s.box.plan('move_files', { moves: [{ from: path.join(s.dl, 'art.pdf'), to: path.join(s.dl, 'School') }] });
  assert.equal(into.items[0], 'Downloads/art.pdf → Downloads/School/art.pdf');
  // overwrite refused
  rejects(() => s.box.plan('move_files', { moves: [{ from: path.join(s.dl, 'art.pdf'), to: path.join(s.dl, 'taken') }] }), /already exists/);
  // duplicates and self-moves refused
  write(path.join(s.dl, 'one.txt')); write(path.join(s.dl, 'two.txt'));
  rejects(() => s.box.plan('move_files', { moves: [{ from: path.join(s.dl, 'one.txt'), to: path.join(s.dl, 'z.txt') }, { from: path.join(s.dl, 'two.txt'), to: path.join(s.dl, 'z.txt') }] }), /Two items/);
  rejects(() => s.box.plan('move_files', { moves: [{ from: path.join(s.dl, 'School'), to: path.join(s.dl, 'School', 'inner') }] }), /into itself/);
  rejects(() => s.box.plan('move_files', { moves: [{ from: s.dl, to: path.join(s.dl, 'x') }] }), /cannot be moved|into itself/);
  rejects(() => s.box.plan('move_files', { moves: [] }), /non-empty/);
});

test('a plan goes stale safely: the disk is re-checked when it runs', async () => {
  const s = sandbox();
  write(path.join(s.dl, 'a.txt'), 'A');
  write(path.join(s.dl, 'b.txt'), 'B');
  const plan = s.box.plan('move_files', { moves: [{ from: path.join(s.dl, 'a.txt'), to: path.join(s.dl, 'a2.txt') }, { from: path.join(s.dl, 'b.txt'), to: path.join(s.dl, 'b2.txt') }] });
  fs.rmSync(path.join(s.dl, 'a.txt'));           // vanished after approval was requested
  write(path.join(s.dl, 'b2.txt'), 'someone else'); // destination appeared
  const out = JSON.parse((await s.box.run('move_files', plan)).result);
  assert.equal(out.moved.length, 0);
  assert.equal(out.failed.length, 2);
  assert.equal(fs.readFileSync(path.join(s.dl, 'b2.txt'), 'utf8'), 'someone else', 'nothing was overwritten');
  assert.equal(fs.readFileSync(path.join(s.dl, 'b.txt'), 'utf8'), 'B');
});

test('write_file: refuses overwrite unless asked, enforces size, writes atomically', async () => {
  const s = sandbox();
  const f = path.join(s.dl, 'notes.txt');
  const plan = s.box.plan('write_file', { path: f, content: 'hello' });
  assert.match(plan.title, /create a file/);
  await s.box.run('write_file', plan);
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
  rejects(() => s.box.plan('write_file', { path: f, content: 'again' }), /overwrite/);
  const over = s.box.plan('write_file', { path: f, content: 'again', overwrite: true });
  assert.match(over.title, /overwrite a file/);
  await s.box.run('write_file', over);
  assert.equal(fs.readFileSync(f, 'utf8'), 'again');
  rejects(() => s.box.plan('write_file', { path: path.join(s.dl, 'big'), content: 'x'.repeat(200 * 1024 + 1) }), /too large/);
  assert.deepEqual(fs.readdirSync(s.dl), ['notes.txt'], 'no temp files left behind');
});

test('read_file: truncates large files and flags binary ones', async () => {
  const s = sandbox();
  write(path.join(s.dl, 'big.txt'), 'a'.repeat(100 * 1024));
  fs.writeFileSync(path.join(s.dl, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  const big = JSON.parse((await s.box.run('read_file', s.box.plan('read_file', { path: path.join(s.dl, 'big.txt') }))).result);
  assert.equal(big.truncated, true);
  assert.ok(big.content.length > 1000 && big.content.length < 64 * 1024, 'content shrunk to fit the result limit');
  assert.ok((await s.box.run('read_file', s.box.plan('read_file', { path: path.join(s.dl, 'big.txt') }))).result.length <= 24000);
  const bin = JSON.parse((await s.box.run('read_file', s.box.plan('read_file', { path: path.join(s.dl, 'bin.dat') }))).result);
  assert.equal(bin.binary, true);
  assert.equal(bin.content, null);
});

test('relative paths work with one shared folder, and are refused with several', () => {
  const s = sandbox();
  write(path.join(s.dl, 'a.txt'));
  assert.equal(s.box.plan('read_file', { path: 'a.txt' }).label, 'Read Downloads/a.txt');
  const other = path.join(s.base, 'Documents');
  fs.mkdirSync(other);
  const two = createToolbox({ folders: [s.dl, other], trash: async () => {} });
  rejects(() => two.plan('read_file', { path: 'a.txt' }), /absolute path/);
});
