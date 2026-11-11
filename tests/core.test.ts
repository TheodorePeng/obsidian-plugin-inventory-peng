import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { locations, makeBase, newNote, patchBase, splitNote, updateNote, type RecordData } from '../src/core';

const record: RecordData = { plugin_id: 'example', name: 'Example', type: 'community', status: 'enabled', version: '1.0.0' };
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
test('default and independent paths are scoped to the vault', () => {
  const s = { root: 'Plugins', baseOverride: '', libraryOverride: '' };
  assert.equal(locations(s).library, 'Plugins/Library');
  assert.equal(locations({ ...s, root: 'Other', libraryOverride: 'My Library' }).library, 'My Library');
  for (const root of ['../bad', '/absolute', '.obsidian/plugins', '']) assert.throws(() => locations({ ...s, root }));
});
test('Base scope changes preserve user views and reject unknown scope', () => {
  const original = makeBase('Plugins/Library', '""');
  const doc = parseDocument(original); doc.setIn(['views', 0, 'name'], 'My custom view');
  const changed = patchBase(doc.toString(), 'Plugins/Library', 'Moved/Library', '""', '"settings"');
  assert.equal(parseDocument(changed).getIn(['views', 0, 'name']), 'My custom view');
  assert.ok(changed.includes('Moved/Library'));
  assert.throws(() => patchBase(changed, 'wrong', 'elsewhere', '"settings"', '""'));
});
test('schema upgrade: removes favorite, adds tier, source, author, github, aliases', () => {
  const richRecord: RecordData = {
    plugin_id: 'my-plugin', name: 'My Plugin', type: 'community',
    source: 'self-developed', status: 'enabled', version: '1.2.0',
    author: 'Peng', github: 'https://github.com/TheodorePeng/my-plugin', tier: 'must-have'
  };
  const note = newNote(richRecord, '2026-11-11');
  const parsed = splitNote(note).data;
  assert.equal(parsed.favorite, undefined);
  assert.equal(parsed.tier, 'must-have');
  assert.equal(parsed.source, 'self-developed');
  assert.equal(parsed.author, 'Peng');
  assert.equal(parsed.github, 'https://github.com/TheodorePeng/my-plugin');
  assert.deepEqual(parsed.aliases, ['My Plugin']);

  // Legacy note with favorite: true should have favorite removed on update
  const legacyNote = `---\nplugin_id: my-plugin\nname: My Plugin\ntype: community\nstatus: enabled\nversion: 1.0.0\nfavorite: true\n---\n\nbody`;
  const updated = updateNote(legacyNote, richRecord, '2026-11-11');
  const updatedParsed = splitNote(updated).data;
  assert.equal(updatedParsed.favorite, undefined);
  assert.equal(updatedParsed.tier, 'must-have');
  assert.equal(updatedParsed.source, 'self-developed');
});
