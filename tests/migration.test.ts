/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian is replaced with an intentionally dynamic in-memory test double. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = await build({ entryPoints: ['tests/fixtures/harness.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { obsidian: resolve('tests/fixtures/obsidian-stub.ts') } });
const tempDir = await mkdtemp(join(tmpdir(), 'inventory-migration-test-'));
const bundlePath = join(tempDir, 'harness.cjs');
await writeFile(bundlePath, bundle.outputFiles[0].contents);
after(async () => { await rm(tempDir, { recursive: true }); });
// eslint-disable-next-line no-unsanitized/method -- this is the test's own bundle in a fresh temporary directory.
const api: any = await import(pathToFileURL(bundlePath).href);

function fixture(nested = false) {
  const files = new Map<string, any>();
  const content = new Map<string, string>();
  const folder = (p: string) => files.set(p, new api.TFolder(p));
  const file = (p: string, text: string) => { files.set(p, new api.TFile(p)); content.set(p, text); return files.get(p); };
  folder('Old'); folder('Old/Library');
  const base = nested ? 'Old/Library/in.base' : 'Old/in.base';
  file(base, api.makeBase('Old/Library', '""')); file('Old/Library/a.md', 'user text');
  const vault = {
    configDir: '.obsidian', getAbstractFileByPath: (p: string) => files.get(p) ?? null,
    adapter: { exists: async (p: string) => content.has(p) || files.has(p), read: async (p: string) => content.get(p) ?? '', write: async (p: string, v: string) => { content.set(p, v); } },
    getAllLoadedFiles: () => [...files.values()], getMarkdownFiles: () => [...files.values()].filter(f => f instanceof api.TFile && f.path.endsWith('.md')),
    read: async (f: any) => content.get(f.path) ?? '',
    process: async (f: any, transform: (text: string) => string) => { content.set(f.path, transform(content.get(f.path) ?? '')); },
    create: async (p: string, text: string) => { if (files.has(p)) throw new Error('Destination exists'); return file(p, text); },
    createFolder: async (p: string) => { folder(p); }
  };
  let failAfterMove = false;
  const app = { vault, workspace: { getLeavesOfType: () => [] }, fileManager: { renameFile: async (item: any, to: string) => {
    const from = item.path;
    for (const [old, obj] of [...files]) if (old === from || old.startsWith(`${from}/`)) {
      const next = to + old.slice(from.length); files.delete(old); obj.path = next; files.set(next, obj);
      if (content.has(old)) { content.set(next, content.get(old)!); content.delete(old); }
    }
    if (failAfterMove) { failAfterMove = false; failSave = true; }
  } } };
  Object.assign(vault, { rename: app.fileManager.renameFile });
  let saved: any; let failSave = false;
  const makePlugin = () => {
    const plugin: any = new api.InventoryPlugin(app);
    plugin.settings = { schemaVersion: 2, base, library: 'Old/Library', initialized: true, vault: 'test', known: { x: { path: 'Old/Library/a.md', home: 'Old/Library/a.md', record: {} } }, excluded: ['retained'], binding: { library: 'Old/Library', formula: '""' }, migration: null };
    plugin.saveData = async (value: any) => { if (failSave) { failSave = false; throw new Error('simulated save failure'); } saved = structuredClone(value); };
    plugin.sync = async () => {}; plugin.updatePolling = () => {};
    return plugin;
  };
  return { files, content, file, folder, app, makePlugin, getSaved: () => structuredClone(saved), failAfterNextMove: () => { failAfterMove = true; } };
}

function oldSourceFixture() {
  const f = fixture(); const p = f.makePlugin();
  const old = '---\nplugin_id: abc\ntype: community\nsource: official\nfavorite: true\ncustom: keep\n---\n\nUser body\n';
  const base = `filters:\n  and:\n    - 'file.ext == "md"'\n    - 'file.inFolder("Old/Library")'\n    - 'plugin_id != null && plugin_id != "" && (type == "core" || type == "community")'\nformulas:\n  Settings: 'old-formula'\nviews:\n  - type: table\n    name: All Plugins\n    order: [type, source]\n`;
  f.content.set('Old/Library/a.md', old); f.content.set('Old/in.base', base);
  p.settings.sourceVersion = 0; p.settings.sourceUpgrade = null;
  p.settings.registry = { ids: ['abc'], fetchedAt: 100, attemptedAt: Date.now() };
  p.settings.binding = { library: 'Old/Library', formula: 'old-formula' };
  p.settings.known = { 'community:abc': { path: 'Old/Library/a.md', home: 'Old/Library/a.md', record: { type: 'community', plugin_id: 'abc' } } };
  p.scanner = { scan: async () => ({ records: new Map([['community:abc', { type: 'community', plugin_id: 'abc', name: 'ABC', status: 'enabled', version: '1', source: 'Community' }]]), complete: { core: true, community: true }, errors: [], settingsFormula: { vault: 'V', tabIds: [], available: false } }) };
  return { ...f, p, old, base };
}

test('moves the folder and nested Base, preserving content and binding', async () => {
  const f = fixture(true); const p = f.makePlugin();
  await p.startMigration({ base: 'New/in.base', library: 'New/Library' });
  assert.equal(f.content.get('New/Library/a.md'), 'user text');
  assert.ok(f.content.get('New/in.base')?.includes('New/Library'));
  assert.equal(p.settings.known.x.path, 'New/Library/a.md');
  assert.deepEqual(p.settings.excluded, ['retained']);
  assert.equal(p.settings.migration, null);
  assert.equal(f.getSaved().base, 'New/in.base');
});

test('existing destinations and altered managed filters stop before any move', async () => {
  const f = fixture(); const p = f.makePlugin(); f.folder('New'); f.folder('New/Library');
  await assert.rejects(p.startMigration({ base: 'New/in.base', library: 'New/Library' }), /already exists/);
  assert.ok(f.files.has('Old/Library/a.md'));
  f.files.delete('New/Library'); f.content.set('Old/in.base', 'filters: {}\nviews: []\n');
  await assert.rejects(p.startMigration({ base: 'New/in.base', library: 'New/Library' }), /scope/);
  assert.ok(f.files.has('Old/Library/a.md'));
});

test('interrupted move remains paused until the original source is restored', async () => {
  const f = fixture(); const p = f.makePlugin(); f.failAfterNextMove();
  await assert.rejects(p.startMigration({ base: 'New/in.base', library: 'New/Library' }), /simulated/);
  const saved = f.getSaved(); assert.equal(saved.migration.inFlight, true);
  const resumed = f.makePlugin(); resumed.settings = saved;
  await assert.rejects(resumed.recoverMigration(), /cannot be verified/);
  assert.ok(resumed.settings.migration); assert.ok(f.files.has('New/Library/a.md'));
  await f.app.fileManager.renameFile(f.files.get('New/Library'), 'Old/Library');
  await resumed.recoverMigration();
  assert.equal(resumed.settings.migration, null);
  assert.equal(f.content.get('New/Library/a.md'), 'user text');
});

test('source upgrade backs up and preserves user content', async () => {
  const f = oldSourceFixture(); const preview = await f.p.previewSourceUpgrade();
  await f.p.startSourceUpgrade(preview);
  assert.equal(f.p.settings.sourceVersion, 1); assert.equal(f.p.settings.sourceUpgrade, null);
  assert.match(f.content.get('Old/Library/a.md')!, /source: Community/);
  assert.doesNotMatch(f.content.get('Old/Library/a.md')!, /^type:/m);
  assert.match(f.content.get('Old/Library/a.md')!, /favorite: true/);
  assert.match(f.content.get('Old/Library/a.md')!, /User body/);
  assert.ok([...f.content.entries()].some(([path, text]) => path.endsWith('snapshot.json') && JSON.parse(text)[0].before === f.old));
});

test('repair preview ignores unrelated notes and quarantines duplicate identities', async () => {
  const f = oldSourceFixture(); f.file('Old/Library/unrelated.md', 'Personal text without frontmatter');
  const preview = await f.p.previewSourceUpgrade(); assert.equal(preview.files.length, 2);
  f.file('Old/Library/duplicate.md', f.old);
  const repair = await f.p.previewSourceUpgrade();
  assert.equal(repair.files.filter((file: any) => file.move).length, 1);
  assert.equal(repair.canonical['community:abc'].path, 'Old/Library/a.md');
});

test('source preview changes and interrupted writes never overwrite edits', async () => {
  const f = oldSourceFixture(); const preview = await f.p.previewSourceUpgrade();
  f.content.set('Old/Library/a.md', f.old + 'edited');
  await assert.rejects(f.p.startSourceUpgrade(preview), /changed since the preview/);
  assert.equal(f.content.get('Old/Library/a.md'), f.old + 'edited');
  f.content.set('Old/Library/a.md', f.old);
  const next = await f.p.previewSourceUpgrade();
  const originalProcess = f.app.vault.process;
  f.app.vault.process = async (file: any, transform: (v: string) => string) => {
    if (file.path === 'Old/in.base') throw new Error('simulated interruption');
    await originalProcess(file, transform);
  };
  await assert.rejects(f.p.startSourceUpgrade(next), /interruption/);
  assert.ok(f.p.settings.sourceUpgrade); assert.equal(f.p.settings.sourceVersion, 0);
  f.app.vault.process = originalProcess;
  f.content.set('Old/in.base', f.base + '\n# user edit\n');
  await assert.rejects(f.p.recoverSourceUpgrade(), /changed during migration/);
  assert.match(f.content.get('Old/in.base')!, /user edit/);
});

test('source upgrade resumes from a persisted journal after an interruption', async () => {
  const f = oldSourceFixture(); const preview = await f.p.previewSourceUpgrade();
  const process = f.app.vault.process;
  f.app.vault.process = async (file: any, transform: (v: string) => string) => {
    if (file.path === 'Old/in.base') throw new Error('interrupted');
    await process(file, transform);
  };
  await assert.rejects(f.p.startSourceUpgrade(preview), /interrupted/);
  const resumed = f.makePlugin(); resumed.settings = f.getSaved(); resumed.sync = async () => {};
  f.app.vault.process = process;
  await resumed.recoverSourceUpgrade();
  assert.equal(resumed.settings.sourceVersion, 1); assert.equal(resumed.settings.sourceUpgrade, null);
  assert.match(f.content.get('Old/Library/a.md')!, /source: Community/);
  assert.match(f.content.get('Old/in.base')!, /Last Detected/);
});

test('source recovery rejects a tampered backup snapshot', async () => {
  const f = oldSourceFixture(); const preview = await f.p.previewSourceUpgrade();
  f.app.vault.process = async () => { throw new Error('interrupted'); };
  await assert.rejects(f.p.startSourceUpgrade(preview), /interrupted/);
  const snapshotPath = f.p.settings.sourceUpgrade.snapshot;
  const snapshot = JSON.parse(f.content.get(snapshotPath)!); snapshot[0].after += 'tampered';
  f.content.set(snapshotPath, JSON.stringify(snapshot));
  await assert.rejects(f.p.recoverSourceUpgrade(), /backup was changed/);
});

test('offline registry preserves the previous cache and marks failed refresh', async () => {
  const f = oldSourceFixture();
  Object.assign(globalThis, { window: globalThis });
  await f.p.updateRegistry(true);
  assert.deepEqual(f.p.settings.registry.ids, ['abc']);
  assert.match(f.p.registryStatus(), /latest update failed/);
  f.p.settings.registry = { ids: [], fetchedAt: 0, attemptedAt: 0 };
  await f.p.updateRegistry(true);
  assert.match(f.p.registryStatus(), /not verified/);
});

test('sync restores a removed Source only for the known note identity', async () => {
  const f = fixture(); const p = f.makePlugin(); delete p.sync;
  const record = { plugin_id: 'abc', name: 'ABC', type: 'community', source: 'Community', status: 'enabled', version: '1' };
  f.content.set('Old/Library/a.md', '---\nplugin_id: abc\nname: ABC\ncustom: keep\n---\n\nMy body\n');
  p.settings.sourceVersion = 1; p.settings.registry = { ids: ['abc'], fetchedAt: Date.now(), attemptedAt: Date.now() };
  p.settings.known = { 'community:abc': { path: 'Old/Library/a.md', home: 'Old/Library/a.md', record } };
  p.scanner = { scan: async () => ({ records: new Map([['community:abc', record]]), complete: { core: true, community: true }, errors: [], settingsFormula: { vault: 'V', tabIds: [], available: false } }) };
  await p.sync();
  assert.match(f.content.get('Old/Library/a.md')!, /source: Community/);
  assert.match(f.content.get('Old/Library/a.md')!, /custom: keep/);
  assert.match(f.content.get('Old/Library/a.md')!, /My body/);
});
test('repair rebuilds a damaged Base, preserves tracked duplicate and quarantines the rest', async () => {
  const f = oldSourceFixture(); f.content.set('Old/in.base', 'broken: [');
  f.file('Old/Library/z.md', f.old + 'Tracked body');
  f.p.settings.known['community:abc'].path = 'Old/Library/z.md';
  const preview = await f.p.previewSourceUpgrade();
  assert.equal(preview.canonical['community:abc'].path, 'Old/Library/z.md');
  await f.p.startSourceUpgrade(preview);
  assert.equal(f.files.has('Old/Library/a.md'), false);
  assert.ok([...f.content.entries()].some(([path, text]) => path.includes('/conflicts/') && text === f.old));
  assert.match(f.content.get('Old/Library/z.md')!, /Tracked body/);
  assert.match(f.content.get('Old/in.base')!, /Last Detected/);
  assert.equal(f.p.settings.lastRepair.moved, 1);
  const again = await f.p.previewSourceUpgrade(); assert.equal(again.files.filter((x: any) => x.move).length, 0);
});
test('conflicting personal properties are skipped without blocking Base repair', async () => {
  const f = oldSourceFixture(); const text = f.old.replace('custom: keep', 'custom: first\ncustom: second');
  f.content.set('Old/Library/a.md', text);
  const preview = await f.p.previewSourceUpgrade(); assert.equal(preview.skipped.length, 1);
  await f.p.startSourceUpgrade(preview);
  assert.equal(f.content.get('Old/Library/a.md'), text); assert.equal(f.p.settings.lastRepair.skipped.length, 1);
});
test('repair recovers a duplicate move that completed before a checkpoint', async () => {
  const f = oldSourceFixture(); f.file('Old/Library/duplicate.md', f.old + 'different body');
  const preview = await f.p.previewSourceUpgrade();
  const original = (f.app.vault as any).rename;
  (f.app.vault as any).rename = async (...args: any[]) => { await original(...args); throw new Error('after-move interruption'); };
  await assert.rejects(f.p.startSourceUpgrade(preview), /interruption/);
  const resumed = f.makePlugin(); resumed.settings = f.getSaved();
  (f.app.vault as any).rename = original;
  await resumed.recoverSourceUpgrade();
  assert.equal(resumed.settings.sourceUpgrade, null);
  assert.equal(resumed.settings.lastRepair.moved, 1);
  assert.ok([...f.content.entries()].some(([path, text]) => path.includes('/conflicts/') && text === f.old + 'different body'));
});
test('repair can recreate a missing managed Base without replacing an existing destination', async () => {
  const f = oldSourceFixture(); f.files.delete('Old/in.base'); f.content.delete('Old/in.base');
  const preview = await f.p.previewSourceUpgrade(); assert.equal(preview.files.at(-1).create, true);
  await f.p.startSourceUpgrade(preview); assert.match(f.content.get('Old/in.base')!, /Last Detected/);
});
test('root mode survives a persisted interrupted path move', async () => {
  const f = fixture(); const p = f.makePlugin(); f.failAfterNextMove();
  const target = { base: 'New/Plugin Inventory.base', library: 'New/Plugin Library' };
  await assert.rejects(p.startMigration(target, { mode: 'root', root: 'New' }), /simulated/);
  const resumed = f.makePlugin(); resumed.settings = f.getSaved();
  assert.deepEqual(resumed.settings.migration.storage, { mode: 'root', root: 'New' });
  await f.app.fileManager.renameFile(f.files.get(target.library), 'Old/Library');
  await resumed.recoverMigration();
  assert.deepEqual(resumed.settings.storage, { mode: 'root', root: 'New' });
});
test('mode changes with unchanged paths persist without moving files', async () => {
  const f = fixture(); const p = f.makePlugin();
  p.settings.base = 'Root/Plugin Inventory.base'; p.settings.library = 'Root/Plugin Library';
  f.folder('Root'); f.folder(p.settings.library); f.file(p.settings.base, api.makeBase(p.settings.library, '""'));
  await p.initialize(p.paths(), { mode: 'root', root: 'Root' });
  assert.equal(p.settings.storage.mode, 'root');
  await p.initialize(p.paths(), { mode: 'independent', root: 'Root' });
  assert.equal(p.settings.storage.mode, 'independent');
  assert.ok(f.files.has('Root/Plugin Inventory.base'));
  await assert.rejects(p.initialize(p.paths(), { mode: 'root', root: 'Wrong' }), /do not match/);
});
test('first creation uses the root layout and persists its mode', async () => {
  const f = fixture(); const p = f.makePlugin(); p.settings.initialized = false;
  p.scanner = { scan: async () => ({ records: new Map(), complete: { core: true, community: true }, errors: [], basesEnabled: true, settingsFormula: { vault: 'V', tabIds: [], available: false } }) };
  await p.initialize({ base: 'Fresh/Plugin Inventory.base', library: 'Fresh/Plugin Library' }, { mode: 'root', root: 'Fresh' });
  assert.ok(f.files.has('Fresh/Plugin Inventory.base')); assert.ok(f.files.has('Fresh/Plugin Library'));
  assert.deepEqual(f.getSaved().storage, { mode: 'root', root: 'Fresh' });
});
test('file explorer moves retain root mode only while the fixed layout remains valid', async () => {
  const f = fixture(); const p = f.makePlugin();
  p.settings.base = 'Root/Plugin Inventory.base'; p.settings.library = 'Root/Plugin Library'; p.settings.storage = { mode: 'root', root: 'Root' };
  f.folder('Root'); f.folder(p.settings.library); f.file(p.settings.base, api.makeBase(p.settings.library, '""'));
  await f.app.fileManager.renameFile(f.files.get('Root'), 'Moved'); await p.trackRename('Root', 'Moved');
  assert.deepEqual(p.settings.storage, { mode: 'root', root: 'Moved' });
  await f.app.fileManager.renameFile(f.files.get(p.settings.base), 'Moved/custom.base'); await p.trackRename('Moved/Plugin Inventory.base', 'Moved/custom.base');
  assert.equal(p.settings.storage.mode, 'independent');
});

test('changed notes can resume through a fresh approved plan without restoring old text', async () => {
  const f = oldSourceFixture(); const process = f.app.vault.process;
  f.app.vault.process = async () => { throw new Error('interrupted'); };
  await assert.rejects(f.p.startSourceUpgrade(await f.p.previewSourceUpgrade()), /interrupted/);
  const journal = structuredClone(f.p.settings.sourceUpgrade);
  const changed = f.old.replace('custom: keep', 'custom: newest').replace('source: official', 'source: unusual') + '\nNew personal body\n';
  f.content.set('Old/Library/a.md', changed);
  f.app.vault.process = process;
  await assert.rejects(f.p.recoverSourceUpgrade(), /changed during migration/);
  const preview = await f.p.previewSourceUpgrade(true);
  assert.equal(f.p.settings.sourceUpgrade.backupDir, journal.backupDir);
  assert.match(preview.files[0].after, /custom: newest/);
  assert.ok(preview.files[0].after.endsWith('\nNew personal body\n'));
  await new Promise(resolve => setTimeout(resolve, 5));
  f.app.vault.process = process;
  await f.p.startSourceUpgrade(preview);
  assert.equal(f.p.settings.sourceUpgrade, null);
  assert.match(f.content.get('Old/Library/a.md')!, /source: Community/);
  assert.match(f.content.get('Old/Library/a.md')!, /custom: newest/);
  assert.ok(f.content.has(journal.snapshot));
  const backup = f.p.settings.lastRepair.backupDir;
  assert.deepEqual(JSON.parse(f.content.get(`${backup}/plugin-data.json`)!).sourceUpgrade, JSON.parse(JSON.stringify(journal)));
  assert.equal(JSON.parse(f.content.get(`${backup}/snapshot.json`)!)[0].before, changed);
});

test('recovery replanning detects edits after preview and keeps the original journal', async () => {
  const f = oldSourceFixture(); f.app.vault.process = async () => { throw new Error('interrupted'); };
  await assert.rejects(f.p.startSourceUpgrade(await f.p.previewSourceUpgrade()), /interrupted/);
  const journal = JSON.stringify(f.p.settings.sourceUpgrade);
  const preview = await f.p.previewSourceUpgrade(true);
  f.content.set('Old/Library/a.md', f.old + 'later edit');
  await assert.rejects(f.p.startSourceUpgrade(preview), /changed since the preview/);
  assert.equal(JSON.stringify(f.p.settings.sourceUpgrade), journal);
  assert.equal(f.content.get('Old/Library/a.md'), f.old + 'later edit');
});

test('fresh recovery safely skips conflicting custom fields and releases the old repair lock', async () => {
  const f = oldSourceFixture(); const process = f.app.vault.process;
  f.app.vault.process = async () => { throw new Error('interrupted'); };
  await assert.rejects(f.p.startSourceUpgrade(await f.p.previewSourceUpgrade()), /interrupted/);
  const changed = f.old.replace('custom: keep', 'custom: keep\ncustom: different');
  f.content.set('Old/Library/a.md', changed);
  const preview = await f.p.previewSourceUpgrade(true);
  assert.equal(preview.skipped.length, 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  f.app.vault.process = process;
  await f.p.startSourceUpgrade(preview);
  assert.equal(f.p.settings.sourceUpgrade, null);
  assert.equal(f.content.get('Old/Library/a.md'), changed);
  assert.equal(f.p.settings.lastRepair.skipped.length, 1);
});


test('replacement journal save failure retains the previous recovery state', async () => {
  const f = oldSourceFixture(); f.app.vault.process = async () => { throw new Error('interrupted'); };
  await assert.rejects(f.p.startSourceUpgrade(await f.p.previewSourceUpgrade()), /interrupted/);
  const journal = JSON.stringify(f.p.settings.sourceUpgrade);
  const preview = await f.p.previewSourceUpgrade(true);
  await new Promise(resolve => setTimeout(resolve, 5));
  f.p.saveData = async () => { throw new Error('disk full'); };
  await assert.rejects(f.p.startSourceUpgrade(preview), /disk full/);
  assert.equal(JSON.stringify(f.p.settings.sourceUpgrade), journal);
  assert.equal(f.content.get('Old/Library/a.md'), f.old);
});
/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- end of dynamic test double. */
