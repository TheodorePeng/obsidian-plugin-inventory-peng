import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { legacyLocations, locations, movePlan, makeBase, newNote, patchBase, settingsFormula, settingsLink, settingsTarget, settingsUrl, splitNote, updateNote, type RecordData } from '../src/core';

const record: RecordData = { plugin_id: 'example', name: 'Example', type: 'community', source: 'Community', status: 'enabled', version: '1.0.0' };
test('refresh preserves authored properties, comments and mixed-language body', () => {
  const input = newNote(record, '2026-11-10').replace('purpose: ""', 'purpose: 我的用途\ncustom: keep # do not remove') + '\nUser 中文 / AI English\n';
  const changed = updateNote(input, { ...record, status: 'disabled', version: '2.0.0' }, '2026-11-10');
  assert.equal(splitNote(changed).body, splitNote(input).body);
  assert.equal(splitNote(changed).data.purpose, '我的用途');
  assert.equal(splitNote(changed).data.custom, 'keep');
  assert.ok(changed.includes('# do not remove'));
  assert.equal(splitNote(changed).data.version, '2.0.0');
});
test('unchanged refresh is byte-identical; uninstall retains last_seen', () => {
  const note = newNote(record, '2026-11-10');
  assert.equal(updateNote(note, record, '2026-11-10'), note);
  const removed = updateNote(note, { ...record, status: 'uninstalled' }, '2026-11-11');
  assert.equal(splitNote(removed).data.last_seen, '2026-11-10');
  assert.equal(splitNote(removed).body, splitNote(note).body);
});
test('invalid YAML and changed identities stop writes', () => {
  assert.throws(() => updateNote('---\na: [\n---\nbody', record, '2026-11-10'));
  assert.throws(() => updateNote(newNote({ ...record, plugin_id: 'other' }, '2026-11-10'), record, '2026-11-10'));
});
test('only a confirmed owner may restore a missing source', () => {
  const withoutSource = newNote(record, '2026-11-10').replace('source: Community\n', '');
  assert.throws(() => updateNote(withoutSource, record, '2026-11-10'));
  assert.equal(splitNote(updateNote(withoutSource, record, '2026-11-10', undefined, false, true)).data.source, 'Community');
  assert.equal(splitNote(updateNote(withoutSource.replace('plugin_id: example', 'plugin_id: changed'), record, '2026-11-10', undefined, false, true)).data.plugin_id, 'example');
});
test('default and independent paths are scoped to the vault', () => {
  const s = legacyLocations({ root: 'Plugins', baseOverride: '', libraryOverride: '' });
  assert.deepEqual(locations(s), { base: 'Plugins/Plugin Inventory.base', library: 'Plugins/Library' });
  assert.equal(legacyLocations({ root: 'Old', baseOverride: 'Elsewhere/x.base', libraryOverride: 'My Library' }).library, 'My Library');
  for (const library of ['../bad', '/absolute', '.obsidian/plugins', '']) assert.throws(() => locations({ ...s, library }));
  assert.throws(() => locations({ ...s, library: '.Obsidian/plugins' }));
  assert.throws(() => locations({ ...s, base: 'Plugins/bad:name.base' }));
  assert.throws(() => locations({ ...s, base: 'Plugins/x.md' }));
  assert.throws(() => locations({ base: 'Plugins/x.base', library: 'Plugins/x.base/sub' }));
});
test('move plans preserve nested Base and reject overlapping folders', () => {
  assert.deepEqual(movePlan({ base: 'Old/Library/in.base', library: 'Old/Library' }, { base: 'New/Library/in.base', library: 'New/Library' }), [{ from: 'Old/Library', to: 'New/Library', kind: 'folder' }]);
  assert.deepEqual(movePlan({ base: 'Old/Library/in.base', library: 'Old/Library' }, { base: 'New/out.base', library: 'New/Library' }), [{ from: 'Old/Library', to: 'New/Library', kind: 'folder' }, { from: 'New/Library/in.base', to: 'New/out.base', kind: 'file' }]);
  assert.throws(() => movePlan({ base: 'x.base', library: 'Old' }, { base: 'x.base', library: 'Old/New' }));
  assert.throws(() => movePlan({ base: 'x.base', library: 'Old' }, { base: 'Old/new.base', library: 'New' }));
});
test('Base scope changes preserve user views and reject unknown scope', () => {
  const original = makeBase('Plugins/Library', '""');
  const doc = parseDocument(original); doc.setIn(['views', 0, 'name'], 'My custom view');
  const changed = patchBase(doc.toString(), 'Plugins/Library', 'Moved/Library', '""', '"settings"');
  assert.equal(parseDocument(changed).getIn(['views', 0, 'name']), 'My custom view');
  assert.ok(changed.includes('Moved/Library'));
  assert.throws(() => patchBase(changed, 'wrong', 'elsewhere', '"settings"', '""'));
});
test('new notes have managed fields; existing user fields are not removed or recreated', () => {
  const richRecord: RecordData = {
    plugin_id: 'my-plugin', name: 'My Plugin', type: 'community',
    source: 'Non-community', status: 'enabled', version: '1.2.0',
    author: 'Peng', github: 'https://github.com/TheodorePeng/my-plugin', tier: 'must-have'
  };
  const note = newNote(richRecord, '2026-11-11');
  const parsed = splitNote(note).data;
  assert.equal(parsed.favorite, undefined);
  assert.equal(parsed.tier, 'must-have');
  assert.equal(parsed.source, 'Non-community');
  assert.equal(parsed.author, 'Peng');
  assert.equal(parsed.github, 'https://github.com/TheodorePeng/my-plugin');
  assert.deepEqual(parsed.aliases, ['My Plugin']);

  // User-owned fields must survive refresh, and deleted ones stay deleted.
  const legacyNote = `---\nplugin_id: my-plugin\nname: My Plugin\ntype: community\nstatus: enabled\nversion: 1.0.0\nfavorite: true\n---\n\nbody`;
  const updated = updateNote(legacyNote, richRecord, '2026-11-11');
  const updatedParsed = splitNote(updated).data;
  assert.equal(updatedParsed.favorite, true);
  assert.equal(updatedParsed.tier, undefined);
  assert.equal(updatedParsed.source, 'Non-community');
});
test('settings target mirrors the Base formula decision table', () => {
  const tabs = ['alpha', 'beta'];
  const base = { plugin_id: 'alpha', type: 'community' as const, status: 'enabled' as const };
  assert.equal(settingsTarget(base, tabs), 'alpha');
  assert.equal(settingsTarget({ ...base, plugin_id: 'gamma' }, tabs), 'community-plugins');
  assert.equal(settingsTarget({ ...base, status: 'disabled' }, tabs), 'community-plugins');
  assert.equal(settingsTarget({ ...base, type: 'core' }, tabs), 'alpha');
  assert.equal(settingsTarget({ ...base, plugin_id: 'gamma', type: 'core' }, tabs), 'core-plugins');
  assert.equal(settingsTarget({ ...base, type: 'core', status: 'disabled' }, tabs), 'core-plugins');
  // The formula must encode the same table: changing one side alone turns this red.
  const formula = settingsFormula('My Vault', tabs, true);
  assert.ok(formula.includes('if(status == "enabled" && ["alpha","beta"].contains(plugin_id), plugin_id, if(source == "Built-in", "core-plugins", "community-plugins"))'));
  assert.equal(settingsUrl('My Vault', 'alpha'), 'obsidian://adv-uri?vault=My%20Vault&settingid=alpha');
});
test('new note carries a clickable settings property', () => {
  const link = settingsLink('My Vault', ['example'], record);
  const parsed = splitNote(newNote(record, '2026-11-12', link));
  assert.equal(parsed.data.settings, link);
  assert.match(link, /^\[⚙ Settings\]\(obsidian:\/\/adv-uri\?vault=My%20Vault&settingid=example\)$/);
  assert.equal(typeof parsed.data.settings, 'string');
  assert.equal(Object.keys(parsed.data).at(-1), 'settings');
  assert.equal(splitNote(newNote(record, '2026-11-12')).data.settings, undefined);
});
test('refresh writes refreshes and preserves the settings property', () => {
  const link = settingsLink('My Vault', ['example'], record);
  const other = settingsLink('My Vault', ['example'], { ...record, status: 'disabled' });
  const withLink = updateNote(newNote(record, '2026-11-12'), record, '2026-11-12', link);
  assert.equal(splitNote(withLink).data.settings, link);
  assert.equal(Object.keys(splitNote(withLink).data).at(-1), 'settings');
  assert.equal(splitNote(updateNote(withLink, record, '2026-11-12', other)).data.settings, other);
  // No link available: the previous value is kept, neither written nor removed.
  assert.equal(splitNote(updateNote(withLink, { ...record, version: '2.0.0' }, '2026-11-12', undefined)).data.settings, link);
  // An unchanged link must leave the file byte-identical.
  assert.equal(updateNote(withLink, record, '2026-11-12', link), withLink);
});
