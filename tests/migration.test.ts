/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian is replaced with an intentionally dynamic in-memory test double. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type InventoryPlugin from '../src/main';
import type { Snapshot } from '../src/compat';
import type { RecordData } from '../src/core';

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
    adapter: { mkdir: async (p: string) => { folder(p); }, exists: async (p: string) => content.has(p) || files.has(p), read: async (p: string) => content.get(p) ?? '', write: async (p: string, v: string) => { content.set(p, v); } },
    getAllLoadedFiles: () => [...files.values()], getMarkdownFiles: () => [...files.values()].filter(f => f instanceof api.TFile && f.path.endsWith('.md')),
    read: async (f: any) => content.get(f.path) ?? '',
    process: async (f: any, transform: (text: string) => string) => { content.set(f.path, transform(content.get(f.path) ?? '')); },
    create: async (p: string, text: string) => { if (files.has(p)) throw new Error('Destination exists'); return file(p, text); },
    createFolder: async (p: string) => { folder(p); }
  };
  const app = { vault, workspace: { getLeavesOfType: () => [] }, fileManager: { renameFile: async (item: any, to: string) => {
    const from = item.path;
    for (const [old, obj] of [...files]) if (old === from || old.startsWith(`${from}/`)) {
      const next = to + old.slice(from.length); files.delete(old); obj.path = next; files.set(next, obj);
      if (content.has(old)) { content.set(next, content.get(old)!); content.delete(old); }
    }
  } } };
  Object.assign(vault, { rename: app.fileManager.renameFile });
  let saved: any;
  const makePlugin = () => {
    const plugin: any = new api.InventoryPlugin(app);
    plugin.settings = { schemaVersion: 2, base, library: 'Old/Library', initialized: true, vault: 'test', known: { x: { path: 'Old/Library/a.md', home: 'Old/Library/a.md', record: {} } }, excluded: ['retained'], binding: { library: 'Old/Library', formula: '""' }, migration: null };
    plugin.saveData = async (value: any) => { saved = structuredClone(value); };
    return plugin;
  };
  return { files, content, file, folder, app, makePlugin, getSaved: () => structuredClone(saved) };
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

test('legacy recovery verifies an interrupted move and completes without generating notes', async () => {
  const f = fixture(); const p = f.makePlugin();
  const from = p.paths();
  const to = { base: 'New/in.base', library: 'New/Library' };
  p.settings.migration = {
    from, to, steps: [{ from: from.library, to: to.library, kind: 'folder' }, { from: from.base, to: to.base, kind: 'file' }],
    next: 0, inFlight: true, committed: false, fingerprint: await p.fingerprint(from.library)
  };
  await f.app.fileManager.renameFile(f.files.get(from.library), to.library);
  await assert.rejects(p.recoverMigration(), /cannot be verified/);
  assert.ok(p.settings.migration);
  await f.app.fileManager.renameFile(f.files.get(to.library), from.library);
  await p.recoverMigration();
  assert.equal(f.content.get('New/Library/a.md'), 'user text');
  assert.match(f.content.get('New/in.base')!, /New\/Library/);
  assert.equal(p.settings.known.x.path, 'New/Library/a.md');
  assert.deepEqual(p.settings.excluded, ['retained']);
  assert.equal(p.settings.migration, null);
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

const currentRecord: RecordData = { type: 'community', plugin_id: 'abc', name: 'ABC', status: 'enabled', version: '1', source: 'Community' };
type InventoryState = InventoryPlugin['settings'];
type ModernFixturePlugin =
  Omit<InventoryPlugin, 'scanner' | 'loadData' | 'saveData' | 'addCommand' | 'addSettingTab' | 'addRibbonIcon' | 'registerEvent' | 'register'> & {
    scanner: { scan: (includeCore?: boolean, legacy?: boolean, registry?: ReadonlySet<string> | null, includeDisabledCore?: boolean) => Promise<Snapshot> };
    followRename: (from: string, to: string) => Promise<void>;
    loadData: () => Promise<InventoryState>;
    saveData: (data: InventoryState) => Promise<void>;
    addCommand: (command: { id: string; name: string }) => void;
    addSettingTab: () => void;
    addRibbonIcon: () => void;
    registerEvent: () => void;
    register: () => void;
  };
function currentFixture() {
  const f = fixture();
  const p = f.makePlugin() as ModernFixturePlugin;
  p.settings.base = 'Old/in.base';
  p.settings.noteTemplate = '## 自定义\n\n';
  p.settings.binding = { library: 'Old/Library', formula: '""' };
  p.scanner = { scan: async () => ({ records: new Map([['community:abc', currentRecord]]), complete: { core: true, community: true }, errors: [], basesEnabled: false, settingsFormula: { vault: 'test', tabIds: [], available: false } }) };
  return { ...f, p, getSaved: () => f.getSaved() as InventoryState | undefined };
}

test('fills a deleted Library without a Base and uses the saved template once', async () => {
  const f = currentFixture();
  f.files.delete('Old/Library'); f.files.delete('Old/in.base');
  f.files.delete('Old/Library/a.md');
  f.file('Archive/ABC.md', 'Unrelated original outside active Library');
  const plan = await f.p.previewFill();
  assert.deepEqual(plan.entries.map((entry: { path: string }) => entry.path), ['Old/Library/ABC.md']);
  assert.equal(f.files.has('Old/Library'), false);
  await f.p.applyFill(plan);
  assert.match(f.content.get('Old/Library/ABC.md')!, /## 自定义\n\n$/);
  assert.equal(f.content.get('Archive/ABC.md'), 'Unrelated original outside active Library');
  assert.equal(f.files.has('Old/in.base'), false);
  assert.equal((await f.p.previewFill()).entries.length, 0);
});

test('creation can be repeated with new default paths and the prior Library is untouched', async () => {
  const f = currentFixture();
  const plan = await f.p.previewCreate('New');
  await f.p.applyCreate(plan);
  assert.equal(f.p.settings.library, 'New/Plugin Library');
  assert.equal(f.p.settings.base, 'New/Plugin Index.base');
  assert.match(f.content.get('New/Plugin Library/ABC.md')!, /## 自定义\n\n$/);
  assert.equal(f.content.get('Old/Library/a.md'), 'user text');
  await assert.rejects(f.p.previewCreate('New'), /already exists/);
});

test('relocation preserves custom Index views without creating missing notes', async () => {
  const f = currentFixture();
  f.folder('Moved'); f.file('Moved/Personal.md', 'Personal');
  f.content.set('Old/in.base', f.content.get('Old/in.base')!.replace('All Plugins', 'My custom view'));
  await f.p.applyPathChanges(await f.p.previewPathChanges({ library: 'Moved', base: 'Old/in.base' }));
  assert.equal(f.p.settings.library, 'Moved');
  assert.match(f.content.get('Old/in.base')!, /My custom view/);
  assert.match(f.content.get('Old/in.base')!, /file\.inFolder\("Moved"\)/);
  assert.equal(f.files.has('Moved/ABC.md'), false);
});

test('Index takeover rejects stale previews and backs up existing Base before replacement', async () => {
  const f = currentFixture();
  f.file('Custom.base', 'views: []\n');
  const plan = await f.p.previewIndex('Custom.base');
  f.content.set('Custom.base', 'views: [] # edited\n');
  await assert.rejects(f.p.applyIndex(plan), /changed/i);
  assert.equal(f.p.settings.base, 'Old/in.base');
  await f.p.applyIndex(await f.p.previewIndex('Custom.base'));
  assert.equal(f.p.settings.base, 'Custom.base');
  assert.match(f.content.get('Custom.base')!, /file\.inFolder\("Old\/Library"\)/);
  assert.ok([...f.content].some(([path, text]) => path.includes('/inventory-backups/') && text === 'views: [] # edited\n'));
});

test('an explicitly saved empty template persists without falling back to default', async () => {
  const f = currentFixture();
  await f.p.saveTemplate('');
  assert.equal(f.getSaved()?.noteTemplate, '');
  await f.p.applyFill(await f.p.previewFill());
  assert.match(f.content.get('Old/Library/ABC.md')!, /---\n\n$/);
  assert.doesNotMatch(f.content.get('Old/Library/ABC.md')!, /Configuration/);
  assert.equal(f.content.get('Old/Library/a.md'), 'user text');
});

const modernRecord = (id: string, name: string): RecordData => ({ ...currentRecord, plugin_id: id, name });
const installedNote = (id: string, body: string) => `---\nplugin_id: ${id}\nsource: Community\nstatus: disabled\ncustom: keep\n---\n\n${body}`;

test('refresh updates only unambiguous notes and does not edit the Index or create notes', async () => {
  const f = currentFixture();
  f.p.settings.registry = { ids: ['abc'], fetchedAt: Date.now(), attemptedAt: Date.now() };
  f.content.set('Old/Library/a.md', installedNote('abc', '既有正文'));
  const originalBase = f.content.get('Old/in.base');
  f.p.scanner = { scan: async () => ({
    records: new Map([['community:abc', currentRecord], ['community:new', modernRecord('new', 'New Plugin')]]),
    complete: { core: true, community: true }, errors: [], basesEnabled: false, settingsFormula: { vault: 'test', tabIds: [], available: false }
  }) };
  await f.p.refreshNotes();
  assert.match(f.content.get('Old/Library/a.md')!, /status: enabled\ncustom: keep/);
  assert.match(f.content.get('Old/Library/a.md')!, /既有正文$/);
  assert.equal(f.content.get('Old/in.base'), originalBase);
  assert.equal(f.files.has('Old/Library/New Plugin.md'), false);
  assert.match(f.p.summary, /1 missing/);
});

test('fill reports malformed and duplicate identities and skips excluded records', async () => {
  const f = currentFixture();
  f.file('Old/Library/ABC.md', '# Unrelated note');
  f.file('Old/Library/bad.md', '---\nplugin_id: bad\nsource: [\n---\n');
  f.file('Old/Library/dup1.md', installedNote('dup', 'first'));
  f.file('Old/Library/dup2.md', installedNote('dup', 'second'));
  f.p.settings.excluded = ['community:hidden'];
  f.p.scanner = { scan: async () => ({
    records: new Map([['community:abc', currentRecord], ['community:bad', modernRecord('bad', 'Bad')],
      ['community:dup', modernRecord('dup', 'Dup')], ['community:hidden', modernRecord('hidden', 'Hidden')]]),
    complete: { core: true, community: true }, errors: [], basesEnabled: false, settingsFormula: { vault: 'test', tabIds: [], available: false }
  }) };
  const plan = await f.p.previewFill();
  assert.deepEqual(plan.entries.map((e: { path: string }) => e.path), ['Old/Library/ABC (community-abc).md']);
  assert.match(plan.issues.join('\n'), /bad\.md[\s\S]+Duplicate identity community:dup/);
  await f.p.applyFill(plan);
  assert.equal(f.content.get('Old/Library/ABC.md'), '# Unrelated note');
  assert.equal((await f.p.previewFill()).entries.length, 0);
});

test('fill blocks incomplete plugin scans and stale confirmations', async () => {
  const f = currentFixture();
  const plan = await f.p.previewFill();
  f.file('Old/Library/already-present.md', installedNote('abc', 'Saved after preview'));
  await assert.rejects(f.p.applyFill(plan), /changed since the preview/);
  const scan = f.p.scanner.scan;
  f.p.scanner.scan = async () => ({ ...await scan(), complete: { core: true, community: false }, errors: ['Broken manifest: bad-plugin'] });
  await assert.rejects(f.p.previewFill(), /Broken manifest/);
  assert.equal(f.files.has('Old/Library/ABC.md'), false);
});

test('follow rename updates Library and Index paths but ignores unrelated renames', async () => {
  const f = currentFixture();
  await f.p.followRename('Unrelated', 'Renamed');
  assert.equal(f.getSaved(), undefined);
  await f.app.fileManager.renameFile(f.files.get('Old'), 'New');
  await f.p.followRename('Old', 'New');
  assert.equal(f.p.settings.library, 'New/Library');
  assert.equal(f.p.settings.base, 'New/in.base');
  assert.match(f.content.get('New/in.base')!, /file\.inFolder\("New\/Library"\)/);
  assert.equal(f.content.get('New/Library/a.md'), 'user text');
});

test('import only replaces an explicitly selected note and keeps a backup and the original', async () => {
  const f = currentFixture();
  const before = installedNote('abc', 'Latest user edits');
  const old = installedNote('abc', 'Archived user settings');
  f.content.set('Old/Library/a.md', before);
  f.folder('Archive'); f.file('Archive/Original.md', old);
  const plan = await f.p.previewImport('Archive');
  assert.equal(plan.groups[0].targets[0].path, 'Old/Library/a.md');
  await f.p.applyImport(plan, []);
  assert.equal(f.content.get('Old/Library/a.md'), before);
  await f.p.applyImport(plan, [{ key: 'community:abc', source: 'Archive/Original.md', target: 'Old/Library/a.md' }]);
  assert.equal(f.content.get('Old/Library/a.md'), old);
  assert.equal(f.content.get('Archive/Original.md'), old);
  assert.ok([...f.content].some(([path, text]) => path.includes('/inventory-backups/') && text === before));
});

test('v2 load preserves configured paths without saving data or scanning, and registers English commands', async () => {
  const f = currentFixture();
  const original = structuredClone(f.p.settings);
  const commands = new Map<string, string>();
  f.p.loadData = async () => original;
  Object.assign(f.app.vault, { getName: () => 'test', on: () => ({}) });
  f.p.addCommand = (command: { id: string; name: string }) => { commands.set(command.id, command.name); };
  f.p.addSettingTab = () => {}; f.p.addRibbonIcon = () => {}; f.p.registerEvent = () => {}; f.p.register = () => {};
  await f.p.onload();
  assert.equal(f.p.settings.schemaVersion, 3);
  assert.equal(f.p.settings.library, original.library);
  assert.equal(f.p.settings.base, original.base);
  assert.equal('initialized' in f.p.settings, false);
  assert.equal(f.getSaved(), undefined);
  assert.deepEqual([...commands.values()], [
    'Open Plugin Index', 'Refresh Plugin Status', 'Fill Missing Plugin Notes'
  ]);
});

test('quick creation refuses a Library inserted while the preview is scanning', async () => {
  const f = currentFixture();
  const scan = f.p.scanner.scan;
  f.p.scanner.scan = async () => {
    const result = await scan();
    f.folder('New/Plugin Library');
    return result;
  };
  await assert.rejects(f.p.previewCreate('New'), /destination changed/i);
  assert.equal(f.files.has('New/Plugin Library/ABC.md'), false);
});

test('core refresh can detect a formerly enabled feature that is now disabled', async () => {
  const f = currentFixture();
  f.p.settings.sourceVersion = 1;
  f.p.settings.registry = { ids: [], fetchedAt: Date.now(), attemptedAt: Date.now() };
  f.p.settings.includeCore = true;
  f.content.set('Old/Library/a.md', '---\nplugin_id: canvas\nsource: Built-in\nstatus: enabled\n---\n\nBody');
  f.p.scanner.scan = async (_include, _legacy, _catalog, includeDisabled) => ({
    records: new Map(includeDisabled ? [['core:canvas', { type: 'core', plugin_id: 'canvas', name: 'Canvas', source: 'Built-in', status: 'disabled', version: '' }]] : []),
    complete: { core: true, community: true }, errors: [], basesEnabled: false, settingsFormula: { vault: 'test', tabIds: [], available: false }
  });
  await f.p.refreshNotes();
  assert.match(f.content.get('Old/Library/a.md')!, /status: disabled/);
});

test('relocation leaves an ambiguous Index unchanged while committing the Library path', async () => {
  const f = currentFixture();
  f.folder('New');
  const ambiguous = 'filters:\n  and:\n    - \'file.inFolder("Old/Library")\'\n    - \'file.inFolder("New")\'\nviews: []\n';
  f.content.set('Old/in.base', ambiguous);
  await f.p.applyPathChanges(await f.p.previewPathChanges({ library: 'New', base: 'Old/in.base' }));
  assert.equal(f.p.settings.library, 'New');
  assert.equal(f.content.get('Old/in.base'), ambiguous);
  assert.match(await f.p.indexWarning(), /Repair Index Filter/);
  assert.match(f.p.errors.join('\n'), /scope was changed/);
});

test('changing both paths backs up only the selected Index and saves the final pair', async () => {
  const f = currentFixture();
  f.folder('New');
  f.file('New/Selected.base', 'views: [] # unrelated\n');
  const old = f.content.get('Old/in.base');
  const plan = await f.p.previewPathChanges({ library: 'New', base: 'New/Selected.base' });
  assert.equal(plan.index.kind, 'replace');
  assert.equal(f.getSaved(), undefined);
  await assert.rejects(f.p.applyPathChanges(plan), /explicit/i);
  assert.equal(f.content.get('New/Selected.base'), 'views: [] # unrelated\n');
  await f.p.applyPathChanges(plan, true);
  assert.equal(f.content.get('Old/in.base'), old);
  assert.match(f.content.get('New/Selected.base')!, /file\.inFolder\("New"\)/);
  assert.ok([...f.content].some(([path, text]) => path.includes('/inventory-backups/') && text === 'views: [] # unrelated\n'));
  assert.equal(f.getSaved()?.library, 'New');
  assert.equal(f.getSaved()?.base, 'New/Selected.base');
});

test('connecting a compatible existing Index and disconnecting it never write the Base', async () => {
  const f = currentFixture();
  const compatible = api.makeBase('Old/Library', '""').replace('All Plugins', 'My views') as string;
  f.file('Existing.base', compatible);
  const plan = await f.p.previewPathChanges({ library: 'Old/Library', base: 'Existing.base' });
  assert.equal(plan.index.kind, 'connect');
  await f.p.applyPathChanges(plan);
  assert.equal(f.content.get('Existing.base'), compatible);
  const disconnect = await f.p.previewPathChanges({ library: 'Old/Library', base: '' });
  assert.equal(disconnect.index.kind, 'disconnect');
  await f.p.applyPathChanges(disconnect);
  assert.equal(f.getSaved()?.base, '');
  assert.equal(f.content.get('Existing.base'), compatible);
});

test('changed targets or active paths invalidate the whole path preview', async () => {
  const f = currentFixture();
  f.folder('New'); f.file('New/Selected.base', 'views: []');
  const plan = await f.p.previewPathChanges({ library: 'New', base: 'New/Selected.base' });
  f.content.set('New/Selected.base', 'views: [] # revised');
  await assert.rejects(f.p.applyPathChanges(plan, true), /changed since the preview/);
  const revised = await f.p.previewPathChanges({ library: 'New', base: 'New/Selected.base' });
  f.p.settings.base = 'Other.base';
  await assert.rejects(f.p.applyPathChanges(revised, true), /changed since the preview/);
  assert.equal(f.p.settings.library, 'Old/Library');
  assert.equal(f.content.get('New/Selected.base'), 'views: [] # revised');
});

test('a failed settings save reports a completed Index write while keeping the prior connection', async () => {
  const f = currentFixture();
  f.folder('New');
  const oldBase = f.content.get('Old/in.base');
  const plan = await f.p.previewPathChanges({ library: 'New', base: 'New/Created.base' });
  f.p.saveData = async () => { throw new Error('disk full'); };
  await assert.rejects(f.p.applyPathChanges(plan), /Wrote New\/Created.base, but could not save the connection/);
  assert.equal(f.p.settings.library, 'Old/Library');
  assert.equal(f.p.settings.base, 'Old/in.base');
  assert.equal(f.content.get('Old/in.base'), oldBase);
  assert.match(f.content.get('New/Created.base')!, /file\.inFolder\("New"\)/);
});

test('a failed quick create leaves the current inventory linked and reports the created notes', async () => {
  const f = currentFixture();
  const plan = await f.p.previewCreate('New');
  const create = f.app.vault.create;
  f.app.vault.create = async (path, data) => {
    if (path.endsWith('.base')) throw new Error('write failed');
    return create(path, data);
  };
  await assert.rejects(f.p.applyCreate(plan), /1 notes were created in New\/Plugin Library/);
  assert.equal(f.p.settings.library, 'Old/Library');
  assert.equal(f.p.settings.base, 'Old/in.base');
  assert.equal(f.getSaved(), undefined);
});

test('a compatible scalar folder filter is connected intact and follows Library relocation', async () => {
  const f = currentFixture();
  const original = 'filters: \'file.inFolder("Old/Library")\'\nviews: [{type: table, name: My custom view}]\n';
  f.file('Scalar.base', original);
  const plan = await f.p.previewPathChanges({ library: 'Old/Library', base: 'Scalar.base' });
  assert.equal(plan.index.kind, 'connect');
  await f.p.applyPathChanges(plan);
  assert.equal(f.content.get('Scalar.base'), original);
  f.folder('New');
  await f.p.applyPathChanges(await f.p.previewPathChanges({ library: 'New', base: 'Scalar.base' }));
  assert.match(f.content.get('Scalar.base')!, /file\.inFolder\("New"\)/);
  assert.match(f.content.get('Scalar.base')!, /My custom view/);
});
