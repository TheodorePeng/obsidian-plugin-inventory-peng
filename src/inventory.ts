import { TFile, TFolder, type Vault } from 'obsidian';
import { filename, identity, inFolder, keyOf, splitNote, type RecordData } from './core';
import { inspectRepairNote } from './repair';

export function pathState(vault: Vault, path: string, base = false): 'Not configured' | 'Missing' | 'Ready' | 'Path conflict' {
  if (!path) return 'Not configured';
  const file = vault.getAbstractFileByPath(path);
  if (!file) return 'Missing';
  return (base ? file instanceof TFile && file.extension === 'base' : file instanceof TFolder) ? 'Ready' : 'Path conflict';
}

export interface IndexedNote {
  path: string;
  text: string;
  key: string;
}

export interface LibraryIndex {
  notes: Map<string, IndexedNote[]>;
  suspectIds: Set<string>;
  uncertain: boolean;
  issues: string[];
}

function identityHint(text: string): string | null {
  try { return inspectRepairNote(text).uniqueId; } catch { /* Use a simple, unambiguous scalar only. */ }
  const keys = [...text.matchAll(/^\s*(?:plugin_id|"plugin_id"|'plugin_id')\s*:\s*(.*)$/gm)];
  if (keys.length !== 1) return null;
  const id = /^(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+))(?:\s+#.*)?\s*$/.exec(keys[0][1]);
  if (!id) return null;
  if (id[3] && (/^(?:null|true|false)$/i.test(id[3]) || !Number.isNaN(Number(id[3])))) return null;
  return id[1] ?? id[2] ?? id[3];
}

export async function indexLibrary(vault: Vault, library: string): Promise<LibraryIndex> {
  const result: LibraryIndex = { notes: new Map(), suspectIds: new Set(), uncertain: false, issues: [] };
  const files = vault.getMarkdownFiles().filter(f => inFolder(f.path, library)).sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) {
    let text: string;
    try { text = await vault.read(file); } catch {
      result.uncertain = true;
      result.issues.push(`Cannot read: ${file.path}`);
      continue;
    }
    const start = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
    if (!start) continue;
    const remainder = text.slice(start[0].length);
    const end = /^---[ \t]*(?:\r?\n|$)/m.exec(remainder);
    const header = end ? remainder.slice(0, end.index) : remainder;
    try {
      const data = splitNote(text).data as Record<string, unknown>;
      if (data.plugin_id == null && !Object.hasOwn(data, 'plugin_id')) continue;
      const id = identity(data);
      if (!id) throw new Error('Invalid plugin identity');
      const key = keyOf(id);
      const group = result.notes.get(key) ?? [];
      group.push({ path: file.path, text, key });
      result.notes.set(key, group);
    } catch {
      if (!/(?:^|[\s{,])['"]?plugin_id['"]?\s*:/m.test(header)) continue;
      const id = identityHint(text.slice(0, start[0].length) + header + (end?.[0] ?? ''));
      if (id) result.suspectIds.add(id);
      else result.uncertain = true;
      result.issues.push(`Review plugin identity: ${file.path}`);
    }
  }
  for (const [key, notes] of result.notes) {
    if (notes.length > 1) result.issues.push(`Duplicate identity ${key}: ${notes.map(n => n.path).join(', ')}`);
  }
  return result;
}

export function occupiedNotePaths(vault: Vault, library: string): Set<string> {
  return new Set(vault.getAllLoadedFiles().filter(f => inFolder(f.path, library)).map(f => f.path.toLowerCase()));
}

export function noteDestination(vault: Vault, library: string, record: Pick<RecordData, 'name' | 'type' | 'plugin_id'>, reserved: Set<string>): string {
  const name = filename(record) || 'Plugin';
  const id = record.plugin_id.replace(/[^\w-]/g, '-');
  let path = `${library}/${name}.md`;
  let suffix = 1;
  while (reserved.has(path.toLowerCase()) || vault.getAbstractFileByPath(path)) {
    path = `${library}/${name} (${record.type}-${id}${suffix > 1 ? `-${suffix}` : ''}).md`;
    suffix++;
  }
  reserved.add(path.toLowerCase());
  return path;
}

export function replacementPath(path: string, from: string, to: string): string {
  return path === from || inFolder(path, from) ? to + path.slice(from.length) : path;
}
