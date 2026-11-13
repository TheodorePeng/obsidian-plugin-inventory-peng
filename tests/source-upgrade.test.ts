import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { inspectRepairNote, repairNote } from '../src/repair';
import { classify, parseRegistry, registryDue } from '../src/registry';
import { inferStorageRoot, rootLocations, type RecordData } from '../src/core';

const record: RecordData = { plugin_id: 'abc', name: 'ABC', type: 'community', source: 'Community', status: 'enabled', version: '2' };
test('repair forces managed fields, keeps custom data and exact body', () => {
  const note = '\uFEFF---\r\nplugin_id: wrong\r\nplugin_id: other\r\nsource: strange\r\nsource: [bad]\r\nversion: invalid\r\ntype: community\r\nfavorite: true\r\ncustom: keep # comment\r\ncustom: keep\r\n---\r\n\r\nBody 中文\r\n  spacing  \r\n';
  const changed = repairNote(note, record, '2026-11-13');
  const parsed = inspectRepairNote(changed);
  assert.equal(parsed.data.plugin_id, 'abc'); assert.equal(parsed.data.source, 'Community');
  assert.equal(parsed.data.version, '2'); assert.equal(parsed.data.favorite, true);
  assert.equal(parsed.data.custom, 'keep'); assert.equal(parsed.data.type, undefined);
  assert.equal(parsed.body, inspectRepairNote(note).body);
  assert.ok(changed.includes('# comment')); assert.ok(changed.startsWith('\uFEFF'));
  assert.equal(parseDocument(changed.split('---')[1]).errors.length, 0);
});
test('conflicting custom properties and damaged YAML remain untouched', () => {
  const note = '---\nplugin_id: abc\ncustom: one\ncustom: two\n---\nbody';
  assert.throws(() => repairNote(note, record, '2026-11-13'), /Conflicting custom/);
  assert.throws(() => repairNote('---\na: [\n---\nbody', record, '2026-11-13'), /Invalid YAML/);
  assert.throws(() => repairNote('---\nplugin_id: abc\nno closing boundary', record, '2026-11-13'), /boundary/);
});
test('unknown identity is not inferred from a filename or conflicting duplicate IDs', () => {
  assert.equal(inspectRepairNote('---\nplugin_id: abc\nplugin_id: different\n---\nbody').uniqueId, null);
});
test('root layout has fixed names and does not infer old Library paths', () => {
  assert.deepEqual(rootLocations('My Plugins'), { base: 'My Plugins/Plugin Inventory.base', library: 'My Plugins/Plugin Library' });
  assert.equal(inferStorageRoot(rootLocations('My Plugins')), 'My Plugins');
  assert.equal(inferStorageRoot({ base: 'Plugins/Plugin Inventory.base', library: 'Plugins/Library' }), null);
  assert.throws(() => rootLocations('.obsidian/plugins'));
  assert.throws(() => rootLocations('../escape'));
});
test('directory verification classifies and rejects incomplete data', () => {
  const data = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}` }));
  const ids = new Set(parseRegistry(JSON.stringify(data)));
  assert.equal(classify('core', 'p0', ids), 'Built-in');
  assert.equal(classify('community', 'p0', ids), 'Community');
  assert.equal(classify('community', 'p0', null), 'Non-community');
  assert.equal(classify('community', 'missing', ids), 'Non-community');
  assert.throws(() => parseRegistry('[]'));
  assert.throws(() => parseRegistry(JSON.stringify([...data, data[0]])));
  assert.equal(registryDue({ ids: [], fetchedAt: 0, attemptedAt: 100 }, 101, false), false);
  assert.equal(registryDue({ ids: [], fetchedAt: 0, attemptedAt: 100 }, 101, true), true);
});
