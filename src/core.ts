import { parseDocument, stringify, isMap, isSeq } from 'yaml';

export type Kind = 'core' | 'community';
export type Status = 'enabled' | 'disabled' | 'uninstalled';
export type Source = 'official' | 'brat' | 'self-developed' | 'builtin';
export type Tier = 'must-have' | 'recommended' | 'optional';

export interface RecordData {
  plugin_id: string;
  name: string;
  type: Kind;
  source?: Source;
  status: Status;
  version: string;
  author?: string;
  github?: string;
  tier?: Tier;
}
export interface Paths { root: string; base: string; library: string }
export interface Location { root: string; baseOverride: string; libraryOverride: string }
export const TEMPLATE = '## Configuration\n\n| Setting | Desired Value | Steps | Verification | Reason | Notes |\n|---|---|---|---|---|---|\n| | | | | | |\n';
export const keyOf = (r: Pick<RecordData, 'type' | 'plugin_id'>): string => `${r.type}:${r.plugin_id}`;
export const inFolder = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);
export function cleanPath(value: string): string {
  const p = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some(x => !x || x === '.' || x === '..')) {
    throw new Error('Use a non-empty vault-relative path without . or ..');
  }
  return p;
}
export function locations(s: Location, configDir = '.obsidian'): Paths {
  const root = cleanPath(s.root);
  const base = cleanPath(s.baseOverride || `${root}/Plugin Inventory.base`);
  const library = cleanPath(s.libraryOverride || `${root}/Library`);
  for (const p of [root, base, library]) {
    if (p === configDir || inFolder(p, configDir)) throw new Error('The application config directory is not an inventory location.');
  }
  if (!base.endsWith('.base')) throw new Error('Database file must end in .base');
  if (base === library) throw new Error('Database and notes paths must differ');
  return { root, base, library };
}
export function identity(data: any): Pick<RecordData, 'type' | 'plugin_id'> | null {
  return data && (data.type === 'core' || data.type === 'community') && typeof data.plugin_id === 'string' && data.plugin_id.length > 0
    ? { type: data.type, plugin_id: data.plugin_id } : null;
}
export function splitNote(text: string) {
  const m = /^(\uFEFF?)---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error('Missing or incomplete YAML frontmatter');
  const doc = parseDocument(m[2]);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('Invalid YAML frontmatter');
  const data = doc.toJS() as any;
  return { doc, data, body: text.slice(m[0].length), bom: m[1], eol: text.includes('\r\n') ? '\r\n' : '\n' };
}
export function newNote(record: RecordData, date: string, settings?: string): string {
  const initial: Record<string, any> = {
    plugin_id: record.plugin_id,
    name: record.name,
    type: record.type,
    source: record.source ?? (record.type === 'core' ? 'builtin' : 'official'),
    status: record.status,
    tier: record.tier ?? 'recommended',
    version: record.version,
    author: record.author ?? '',
    github: record.github ?? '',
    aliases: [record.name],
    category: [],
    purpose: '',
    last_seen: date
  };
  if (settings !== undefined) initial.settings = settings;
  return `---\n${stringify(initial)}---\n\n${TEMPLATE}`;
}
export function updateNote(text: string, record: RecordData, date: string): string {
  const n = splitNote(text);
  if (keyOf(identity(n.data) ?? { type: record.type, plugin_id: '' }) !== keyOf(record)) throw new Error('Note identity changed');
  const fields: Record<string, any> = { ...record };
  if (record.status !== 'uninstalled') fields.last_seen = date;
  let changed = false;

  // Remove deprecated favorite property if present
  if (n.doc.has('favorite')) {
    n.doc.delete('favorite');
    changed = true;
  }
  // Ensure tier exists if missing
  if (!n.doc.has('tier')) {
    n.doc.set('tier', record.tier ?? 'recommended');
    changed = true;
  }
  // Ensure aliases exists if missing
  if (!n.doc.has('aliases')) {
    n.doc.set('aliases', [record.name]);
    changed = true;
  }

  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    // github is filled once; never overwrite an existing URL with a coarser manifest author page
    if (k === 'github' && typeof n.data[k] === 'string' && n.data[k].includes('github.com')) continue;
    if (n.data[k] !== v) {
      n.doc.set(k, v);
      changed = true;
    }
  }
  if (!changed) return text;
  const yaml = n.doc.toString({ lineWidth: 0 }).replace(/\r?\n/g, n.eol);
  return `${n.bom}---${n.eol}${yaml}---${n.eol}${n.body}`;
}
export function filename(record: RecordData): string {
  return record.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').trim() || record.plugin_id.replace(/[^\w-]/g, '-');
}
export const folderClause = (library: string): string => `file.inFolder(${JSON.stringify(library)})`;
/** The Advanced URI target for a record: its own settings tab when enabled and present,
 *  otherwise the plugin list page. Mirrors the Base formula decision table. */
export function settingsTarget(record: Pick<RecordData, 'plugin_id' | 'type' | 'status'>, tabIds: string[]): string {
  if (record.status === 'enabled' && tabIds.includes(record.plugin_id)) return record.plugin_id;
  return record.type === 'core' ? 'core-plugins' : 'community-plugins';
}
/** The Advanced URI URL that opens the settings target. */
export function settingsUrl(vault: string, target: string): string {
  return `obsidian://adv-uri?vault=${encodeURIComponent(vault)}&settingid=${target}`;
}
/** The clickable property value written into a note. */
export function settingsLink(vault: string, tabIds: string[], record: Pick<RecordData, 'plugin_id' | 'type' | 'status'>): string {
  return `[⚙ Settings](${settingsUrl(vault, settingsTarget(record, tabIds))})`;
}
/** The Base-side twin of settingsTarget(): keep both decision tables in sync. */
export function settingsFormula(vault: string, tabIds: string[], available: boolean): string {
  if (!available) return '""';
  const safeTabs = tabIds.filter(x => /^[a-zA-Z0-9_-]+$/.test(x));
  const target = `if(status == "enabled" && ${JSON.stringify(safeTabs)}.contains(plugin_id), plugin_id, if(type == "core", "core-plugins", "community-plugins"))`;
  return `link(${JSON.stringify(`obsidian://adv-uri?vault=${encodeURIComponent(vault)}&settingid=`)} + ${target}, "⚙ Settings")`;
}
export function makeBase(library: string, formula: string): string {
  const columns = [
    'formula.Plugin', 'note.type', 'note.source', 'note.tier', 'formula.Status',
    'note.version', 'note.author', 'note.github', 'note.category', 'note.purpose',
    'formula.Settings', 'note.last_seen'
  ];
  return stringify({
    filters: { and: ['file.ext == "md"', folderClause(library), 'plugin_id != null && plugin_id != "" && (type == "core" || type == "community")'] },
    formulas: { Plugin: 'link(file.path, name)', Status: 'status', Settings: formula },
    properties: {
      'note.type': { displayName: 'Type' },
      'note.source': { displayName: 'Source' },
      'note.tier': { displayName: 'Tier' },
      'note.version': { displayName: 'Version' },
      'note.author': { displayName: 'Author' },
      'note.github': { displayName: 'GitHub' },
      'note.category': { displayName: 'Category' },
      'note.purpose': { displayName: 'Purpose' },
      'note.last_seen': { displayName: 'Last Seen' }
    },
    views: [
      { type: 'table', name: 'All Plugins', order: columns },
      { type: 'table', name: 'Must-Have (装机必备)', filters: 'tier == "must-have"', order: columns },
      { type: 'table', name: 'Community (社区与自研)', filters: 'type == "community"', order: columns },
      { type: 'table', name: 'Self-Developed / BRAT (自研与测试)', filters: 'source == "self-developed" || source == "brat"', order: columns },
      { type: 'table', name: 'Core (内置核心)', filters: 'type == "core"', order: columns },
      { type: 'table', name: 'Uninstalled (已卸载)', filters: 'status == "uninstalled"', order: columns }
    ]
  }, { lineWidth: 0 });
}
/** Patch only a known managed scope and an unchanged managed formula. */
export function patchBase(text: string, oldLibrary: string, library: string, oldFormula: string, formula: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('Invalid Base YAML');
  const and = doc.getIn(['filters', 'and'], true);
  if (!isSeq(and)) throw new Error('Managed Base scope was changed; automatic repair stopped');
  const matches = and.items.map((n, i) => String(n) === folderClause(oldLibrary) ? i : -1).filter(i => i >= 0);
  if (matches.length !== 1) throw new Error('Managed Base scope was changed; automatic repair stopped');
  let changed = false;
  if (oldLibrary !== library) { and.set(matches[0], folderClause(library)); changed = true; }
  if (oldFormula !== formula && doc.getIn(['formulas', 'Settings']) === oldFormula) {
    doc.setIn(['formulas', 'Settings'], formula); changed = true;
  }
  return changed ? doc.toString({ lineWidth: 0 }) : text;
}
