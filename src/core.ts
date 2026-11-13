import { parseDocument, stringify, isMap, isSeq } from 'yaml';

export type Kind = 'core' | 'community';
export type Status = 'enabled' | 'disabled' | 'uninstalled';
export type Source = 'Built-in' | 'Community' | 'Non-community' | 'official' | 'brat' | 'self-developed' | 'builtin';
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
export interface Paths { base: string; library: string }
export type Location = Paths;
export interface StorageChoice { mode: 'root' | 'independent'; root: string }
export function rootLocations(root: string, configDir = '.obsidian'): Paths {
  const r = cleanPath(root);
  return locations({ base: `${r}/Plugin Inventory.base`, library: `${r}/Plugin Library` }, configDir);
}
export function inferStorageRoot(paths: Paths): string | null {
  const suffix = '/Plugin Inventory.base';
  if (!paths.base.endsWith(suffix)) return null;
  const root = paths.base.slice(0, -suffix.length);
  return root && paths.library === `${root}/Plugin Library` ? root : null;
}
export interface LegacyLocation { root: string; baseOverride: string; libraryOverride: string }
export interface MoveStep { from: string; to: string; kind: 'file' | 'folder' }
export function legacyLocations(s: LegacyLocation): Location {
  return { base: s.baseOverride || `${s.root}/Plugin Inventory.base`, library: s.libraryOverride || `${s.root}/Library` };
}
export const TEMPLATE = '## Configuration\n\n| Setting | Desired Value | Steps | Verification | Reason | Notes |\n|---|---|---|---|---|---|\n| | | | | | |\n';
export const keyOf = (r: Pick<RecordData, 'type' | 'plugin_id'>): string => `${r.type}:${r.plugin_id}`;
export const inFolder = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);
export function cleanPath(value: string): string {
  const p = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  // eslint-disable-next-line no-control-regex -- reject control characters in user-supplied paths.
  if (!p || p.startsWith('/') || /[:*?"<>|\u0000-\u001f]/.test(p) || p.split('/').some(x => !x || x === '.' || x === '..')) {
    throw new Error('Use a non-empty vault-relative path without . or ..');
  }
  return p;
}
export function locations(s: Location, configDir = '.obsidian'): Paths {
  const base = cleanPath(s.base);
  const library = cleanPath(s.library);
  for (const p of [base, library]) {
    if (p.toLowerCase() === configDir.toLowerCase() || inFolder(p.toLowerCase(), configDir.toLowerCase())) throw new Error('The application config directory is not an inventory location.');
  }
  if (!base.endsWith('.base')) throw new Error('Database file must end in .base');
  if (base === library || inFolder(library, base)) throw new Error('The Base file cannot be the notes folder or its parent.');
  return { base, library };
}
export function movePlan(from: Paths, to: Paths): MoveStep[] {
  const folderMoved = from.library !== to.library;
  if (folderMoved && (inFolder(from.library, to.library) || inFolder(to.library, from.library))) throw new Error('The old and new notes folders cannot overlap.');
  if (folderMoved && (to.base === from.library || inFolder(to.base, from.library))) throw new Error('The new Base cannot be inside the old notes folder.');
  const steps: MoveStep[] = [];
  let base = from.base;
  if (folderMoved) {
    steps.push({ from: from.library, to: to.library, kind: 'folder' });
    if (inFolder(base, from.library)) base = to.library + base.slice(from.library.length);
  }
  if (base !== to.base) steps.push({ from: base, to: to.base, kind: 'file' });
  return steps;
}
export function identity(data: any): Pick<RecordData, 'type' | 'plugin_id'> | null {
  if (!data || typeof data.plugin_id !== 'string' || !data.plugin_id) return null;
  const kind: Kind | null = data.type === 'core' || data.type === 'community' ? data.type
    : data.source === 'Built-in' ? 'core' : data.source === 'Community' || data.source === 'Non-community' ? 'community' : null;
  return kind ? { type: kind, plugin_id: data.plugin_id } : null;
}
export function splitNote(text: string) {
  const m = /^(\uFEFF?)---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error('Missing or incomplete YAML frontmatter');
  const doc = parseDocument(m[2]);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('Invalid YAML frontmatter');
  const data = doc.toJS();
  return { doc, data, body: text.slice(m[0].length), bom: m[1], eol: text.includes('\r\n') ? '\r\n' : '\n' };
}
export function newNote(record: RecordData, date: string, settings?: string, legacy = false): string {
  const initial: Record<string, any> = {
    plugin_id: record.plugin_id,
    name: record.name,
    ...(legacy ? { type: record.type } : {}),
    source: record.source ?? (record.type === 'core' ? (legacy ? 'builtin' : 'Built-in') : (legacy ? 'official' : 'Non-community')),
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
export function updateNote(text: string, record: RecordData, date: string, settings?: string, legacy = false, confirmedOwner = false): string {
  const n = splitNote(text);
  if (keyOf(identity(n.data) ?? { type: record.type, plugin_id: '' }) !== keyOf(record) && !confirmedOwner) throw new Error('Note identity changed');
  const fields: Record<string, any> = { ...record };
  if (!legacy) delete fields.type;
  if (record.status !== 'uninstalled') fields.last_seen = date;
  let changed = false;

  // User-managed favorite, tier and aliases are preserved, including when removed.
  delete fields.tier;

  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    // github is filled once; never overwrite an existing URL with a coarser manifest author page
    if (k === 'github' && typeof n.data[k] === 'string' && n.data[k].includes('github.com')) continue;
    if (n.data[k] !== v) {
      n.doc.set(k, v);
      changed = true;
    }
  }
  // The settings link mirrors the Base formula; without a link the previous value is kept.
  if (settings !== undefined && n.data.settings !== settings) {
    n.doc.set('settings', settings);
    changed = true;
  }
  if (!changed) return text;
  const yaml = n.doc.toString({ lineWidth: 0 }).replace(/\r?\n/g, n.eol);
  return `${n.bom}---${n.eol}${yaml}---${n.eol}${n.body}`;
}
export function filename(record: RecordData): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point: they are invalid in filenames.
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
export function settingsFormula(vault: string, tabIds: string[], available: boolean, legacy = false): string {
  if (!available) return '""';
  const safeTabs = tabIds.filter(x => /^[a-zA-Z0-9_-]+$/.test(x));
  const isCore = legacy ? 'type == "core"' : 'source == "Built-in"';
  const target = `if(status == "enabled" && ${JSON.stringify(safeTabs)}.contains(plugin_id), plugin_id, if(${isCore}, "core-plugins", "community-plugins"))`;
  return `link(${JSON.stringify(`obsidian://adv-uri?vault=${encodeURIComponent(vault)}&settingid=`)} + ${target}, "⚙ Settings")`;
}
export function makeBase(library: string, formula: string): string {
  const columns = [
    'formula.Plugin', 'note.source', 'note.tier', 'formula.Status',
    'note.version', 'note.author', 'note.github', 'note.category', 'note.purpose',
    'formula.Settings', 'note.last_seen'
  ];
  return stringify({
    filters: { and: ['file.ext == "md"', folderClause(library), 'plugin_id != null && plugin_id != "" && (source == "Built-in" || source == "Community" || source == "Non-community")'] },
    formulas: { Plugin: 'link(file.path, name)', Status: 'status', Settings: formula },
    properties: {
      'note.source': { displayName: 'Source' },
      'note.tier': { displayName: 'Tier' },
      'note.version': { displayName: 'Version' },
      'note.author': { displayName: 'Author' },
      'note.github': { displayName: 'GitHub' },
      'note.category': { displayName: 'Category' },
      'note.purpose': { displayName: 'Purpose' },
      'note.last_seen': { displayName: 'Last Detected' }
    },
    views: [
      { type: 'table', name: 'All Plugins', order: columns },
      { type: 'table', name: 'Must-Have (装机必备)', filters: 'tier == "must-have"', order: columns },
      { type: 'table', name: 'Third-party', filters: 'source != "Built-in"', order: columns },
      { type: 'table', name: 'Community', filters: 'source == "Community"', order: columns },
      { type: 'table', name: 'Non-community', filters: 'source == "Non-community"', order: columns },
      { type: 'table', name: 'Core (内置核心)', filters: 'source == "Built-in"', order: columns },
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
