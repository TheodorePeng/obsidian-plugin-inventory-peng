import { isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { identity, type RecordData } from './core';

const managed = new Set(['plugin_id', 'name', 'source', 'status', 'version', 'last_seen', 'settings', 'author', 'github']);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
};
/** Repair only structurally valid frontmatter; body bytes are never re-rendered. */
export function inspectRepairNote(text: string) {
  const match = /^(\uFEFF?)---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('Missing or ambiguous frontmatter boundary');
  const doc = parseDocument(match[2], { uniqueKeys: false });
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('Invalid YAML frontmatter');
  const ids = doc.contents.items.filter(p => isScalar(p.key) && p.key.value === 'plugin_id').map(p => isScalar(p.value) ? p.value.value : null);
  const uniqueId = ids.length > 0 && ids.every(v => typeof v === 'string' && v === ids[0]) ? ids[0] as string : null;
  const valueOf = (node: unknown): unknown => isNode(node) ? node.toJSON() : node;
  const normalize = (node: unknown, top: boolean): void => {
    if (isMap(node)) {
      const keys = new Map<string, unknown>();
      for (let i = 0; i < node.items.length; i++) {
        const pair = node.items[i];
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Complex YAML property keys require review');
        const key = pair.key.value;
        if (keys.has(key)) {
          if (!(top && managed.has(key)) && canonical(valueOf(pair.value)) !== canonical(keys.get(key))) throw new Error(`Conflicting custom property: ${key}`);
          node.items.splice(i--, 1); continue;
        }
        keys.set(key, valueOf(pair.value));
        if (!(top && managed.has(key))) normalize(pair.value, false);
      }
    } else if (isSeq(node)) for (const item of node.items) normalize(item, false);
  };
  normalize(doc.contents, true);
  const data = doc.toJS() as Record<string, unknown>;
  const id = uniqueId ? identity({ ...data, plugin_id: uniqueId }) : null;
  return { doc, data, id, uniqueId, body: text.slice(match[0].length), bom: match[1], eol: text.includes('\r\n') ? '\r\n' : '\n' };
}
export function repairNote(text: string, record: RecordData, date: string, settings?: string, observed = true, legacy = true): string {
  const n = inspectRepairNote(text);
  if (legacy || n.data.type === 'core' || n.data.type === 'community') n.doc.delete('type');
  for (const key of ['plugin_id', 'name', 'source', 'status', 'version'] as const) n.doc.set(key, record[key] ?? (key === 'name' ? record.plugin_id : ''));
  for (const key of ['author', 'github'] as const) if (record[key]) n.doc.set(key, record[key]);
  if (observed && record.status !== 'uninstalled') n.doc.set('last_seen', date);
  else if (n.doc.has('last_seen') && (typeof n.data.last_seen !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(n.data.last_seen))) n.doc.set('last_seen', '');
  if (settings !== undefined) n.doc.set('settings', settings);
  const yaml = n.doc.toString({ lineWidth: 0 }).replace(/\r?\n/g, n.eol);
  return `${n.bom}---${n.eol}${yaml}---${n.eol}${n.body}`;
}
