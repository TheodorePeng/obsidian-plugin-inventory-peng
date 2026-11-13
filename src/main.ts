import {
  AbstractInputSuggest, App, FileView, MarkdownView, Modal, Notice,
  Plugin, PluginSettingTab, Setting, TFile, TFolder, getLanguage, requestUrl
} from 'obsidian';
import { parseDocument } from 'yaml';
import {
  TEMPLATE, filename, identity, inFolder, inferStorageRoot, keyOf, legacyLocations, locations, makeBase, movePlan, newNote, rootLocations,
  patchBase, settingsFormula, settingsLink, splitNote, updateNote,
  type Location, type MoveStep, type Paths, type RecordData, type StorageChoice
} from './core';
import { Scanner, type Snapshot } from './compat';
import { classify, parseRegistry, REGISTRY_URL, registryDue, type RegistryCache } from './registry';
import { inspectRepairNote, repairNote } from './repair';

interface Known { path: string; home: string; record: RecordData }
interface State extends Location {
  schemaVersion: 2; initialized: boolean; vault: string;
  known: Record<string, Known>; excluded: string[];
  binding: { library: string; formula: string } | null;
  includeCore?: boolean;
  migration: Migration | null;
  sourceVersion: 0 | 1;
  sourceUpgrade: SourceUpgrade | null;
  registry: RegistryCache;
  storage: StorageChoice;
  lastRepair?: { backupDir: string; skipped: string[]; repaired: number; moved: number };
}
interface UpgradeFile { path: string; beforeHash: string; afterHash: string; moveTo?: string; create?: boolean }
interface SourceUpgrade { backupDir: string; snapshot: string; files: UpgradeFile[]; next: number; formula: string; canonical?: Record<string, Known>; skipped?: string[] }
interface UpgradePreview { files: { path: string; before: string; after: string; move?: boolean; create?: boolean }[]; changes: string[]; formula: string; canonical: Record<string, Known>; skipped: string[]; recovery?: string }
interface Migration { from: Paths; to: Paths; steps: MoveStep[]; next: number; inFlight: boolean; committed: boolean; fingerprint?: string; storage?: StorageChoice }
interface SavedState extends Partial<Omit<State, 'schemaVersion'>> { schemaVersion?: number; root?: string; baseOverride?: string; libraryOverride?: string }
const defaults = (): State => ({ schemaVersion: 2, ...rootLocations('Plugins'), storage: { mode: 'root', root: 'Plugins' }, initialized: false, vault: '', known: {}, excluded: [], binding: null, includeCore: false, migration: null, sourceVersion: 1, sourceUpgrade: null, registry: { ids: [], fetchedAt: 0, attemptedAt: 0 } });
const zh = (): boolean => getLanguage().startsWith('zh');
const tr = (en: string, cn: string): string => zh() ? cn : en;
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const repairPrompt = (preview: UpgradePreview, base: string): string => {
  const notes = preview.files.filter(file => !file.move && file.path !== base).length;
  const duplicates = preview.files.filter(file => file.move).length;
  const files = preview.files.map(file => `${file.move ? '[Move to backup] ' : ''}${file.path}`).join('\n');
  return tr(`Repair ${notes} notes, move ${duplicates} duplicates and rebuild one Base? Original data and views will be backed up. Body text and custom properties are preserved.\n\n${preview.changes.join('\n')}\n\nSkipped (${preview.skipped.length}):\n${preview.skipped.join('\n')}\n\nAffected files:\n${files}`, `修复 ${notes} 条笔记，移出 ${duplicates} 条重复笔记，并重建一个标准 Base？将备份原数据和视图，保留正文及自定义属性。\n\n${preview.changes.join('\n')}\n\n跳过（${preview.skipped.length}）：\n${preview.skipped.join('\n')}\n\n受影响文件：\n${files}`);
};
const pathError = (e: unknown): string => {
  const message = errorText(e);
  const translations: Record<string, string> = {
    'Use a non-empty vault-relative path without . or ..': '请输入非空的 Vault 相对路径，不要使用 . 或 ..。',
    'The application config directory is not an inventory location.': '不能将清单放在 Obsidian 配置目录中。',
    'Database file must end in .base': 'Base 文件路径必须以 .base 结尾，并包含文件名。',
    'The Base file cannot be the notes folder or its parent.': 'Base 文件不能与笔记文件夹相同，也不能是其父路径。',
    'The old and new notes folders cannot overlap.': '新旧笔记文件夹不能相互嵌套。',
    'The new Base cannot be inside the old notes folder.': '新的 Base 不能位于旧笔记文件夹中。'
  };
  return zh() ? translations[message] ?? message : message;
};
const dateNow = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
/** The clickable settings entry for a record; undefined when Advanced URI is unavailable. */
const settingsLinkFor = (formula: Snapshot['settingsFormula'], record: RecordData): string | undefined =>
  formula.available ? settingsLink(formula.vault, formula.tabIds, record) : undefined;

class FolderSuggest extends AbstractInputSuggest<string> {
  private showAllOnce = false;
  constructor(app: App, private input: HTMLInputElement) { super(app, input); }
  showAll(): void { this.input.focus(); this.showAllOnce = true; this.input.dispatchEvent(new Event('input')); }
  getSuggestions(query: string): string[] {
    if (this.showAllOnce) { query = ''; this.showAllOnce = false; }
    return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder)
      .map(f => f.path).filter(p => p !== '/' && p.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  }
  renderSuggestion(value: string, el: HTMLElement): void { el.setText(value); }
  selectSuggestion(value: string): void { this.input.value = value; this.input.dispatchEvent(new Event('input')); this.close(); }
}
class BaseSuggest extends AbstractInputSuggest<string> {
  private showAllOnce = false;
  constructor(app: App, private input: HTMLInputElement, private managed: () => string | null) { super(app, input); }
  showAll(): void { this.input.focus(); this.showAllOnce = true; this.input.dispatchEvent(new Event('input')); }
  getSuggestions(query: string): string[] {
    if (this.showAllOnce) { query = ''; this.showAllOnce = false; }
    const managed = this.managed();
    return this.app.vault.getFiles().filter(f => f.extension === 'base' && f.path.toLowerCase().includes(query.toLowerCase())).map(f => f.path)
      .sort((a, b) => a === managed ? -1 : b === managed ? 1 : a.localeCompare(b)).slice(0, 40);
  }
  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value === this.managed() ? value : `${value} — ${tr('existing Base; cannot be adopted', '已有 Base，不能接管')}`);
  }
  selectSuggestion(value: string): void {
    if (value !== this.managed()) { new Notice(tr('Choose a new Base path; existing files are protected.', '请选择新的 Base 路径；已有文件受到保护。')); return; }
    this.input.value = value; this.input.dispatchEvent(new Event('input')); this.close();
  }
}

export default class InventoryPlugin extends Plugin {
  settings: State = defaults();
  summary = tr('Not initialized', '尚未创建清单');
  errors: string[] = [];
  pending: string[] = [];
  scanner!: Scanner;
  private queue: Promise<void> = Promise.resolve();
  busy = false;
  private stopping = false;
  private timer: number | null = null;
  private prompted = '';
  private missingOpen = false;
  private lastPersisted = '';
  private persistQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    const saved = await this.loadData() as SavedState | null;
    const legacy = legacyLocations({ root: saved?.root ?? 'Plugins', baseOverride: saved?.baseOverride ?? '', libraryOverride: saved?.libraryOverride ?? '' });
    this.settings = { ...defaults(), ...saved, ...(saved?.schemaVersion === 2 ? {} : legacy), schemaVersion: 2, known: saved?.known ?? {}, excluded: saved?.excluded ?? [], migration: saved?.migration ?? null, sourceVersion: saved?.sourceVersion ?? (saved?.initialized ? 0 : 1), sourceUpgrade: saved?.sourceUpgrade ?? null, registry: saved?.registry ?? defaults().registry };
    // Never retain obsolete override fields in the new persisted representation.
    delete (this.settings as SavedState).root; delete (this.settings as SavedState).baseOverride; delete (this.settings as SavedState).libraryOverride;
    this.settings.storage = saved?.storage ?? (saved ? { mode: 'independent', root: inferStorageRoot(this.settings) ?? (this.settings.base.split('/').slice(0, -1).join('/') || 'Plugins') } : defaults().storage);
    if (this.settings.storage.mode === 'root' && inferStorageRoot(this.settings) !== this.settings.storage.root) this.settings.storage.mode = 'independent';
    if (this.settings.vault && this.settings.vault !== this.app.vault.getName()) {
      this.settings.known = {}; this.settings.excluded = [];
    }
    this.settings.vault = this.app.vault.getName();
    this.scanner = new Scanner(this.app);
    this.addSettingTab(new InventorySettings(this.app, this));
    this.addRibbonIcon('list-checks', tr('Open plugin inventory', '打开插件清单'), () => { void this.openInventory(); });
    const commands: [string, string, string, () => void][] = [
      ['open-inventory', 'Open inventory', '打开清单', () => { void this.openInventory(); }],
      ['refresh-inventory', 'Refresh inventory', '立即刷新', () => { void this.refresh(true); }],
      ['manage-missing', 'Process missing notes', '处理缺失记录', () => this.showMissing()],
      ['manage-exclusions', 'Manage excluded notes', '管理排除项', () => new ExclusionsModal(this).open()],
      ['reset-base-views', 'Restore default views', '恢复默认视图', () => this.confirmReset()]
    ];
    for (const [id, en, cn, callback] of commands) this.addCommand({ id, name: tr(en, cn), callback });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.updatePolling()));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.settings.migration || this.settings.sourceUpgrade) return;
      const newPath = file.path;
      void this.enqueue(() => this.trackRename(oldPath, newPath));
    }));
    this.register(() => { this.stopping = true; this.stopPolling(); });
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.migration || this.settings.sourceUpgrade) { this.summary = tr('Migration interrupted; review recovery in settings.', '迁移尚未完成，请在设置中检查恢复状态。'); return; }
      void this.refresh(false).then(() => this.updatePolling());
    });
  }
  paths(): Paths { return locations(this.settings, this.app.vault.configDir); }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => { if (!this.stopping) await work(); });
    this.queue = run.catch(e => { this.errors = [errorText(e)]; this.summary = this.errors[0]; });
    return run;
  }
  async persist(): Promise<void> {
    if (this.stopping) return;
    const text = JSON.stringify(this.settings);
    const run = this.persistQueue.then(async () => {
      if (text !== this.lastPersisted) { await this.saveData(JSON.parse(text)); this.lastPersisted = text; }
    });
    this.persistQueue = run.catch(() => {});
    await run;
  }
  private registryRequest: Promise<void> | null = null;
  async updateRegistry(force = false): Promise<void> {
    if (this.registryRequest) return this.registryRequest;
    const cache = this.settings.registry ?? (this.settings.registry = defaults().registry);
    if (!registryDue(cache, Date.now(), force)) return;
    this.registryRequest = (async () => {
      cache.attemptedAt = Date.now(); await this.persist();
      let timeout: number | undefined;
      try {
        const response = await Promise.race([
          requestUrl({ url: REGISTRY_URL, throw: false }),
          new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Community directory request timed out')), 15000); })
        ]);
        if (response.status !== 200) throw new Error(`Community directory HTTP ${response.status}`);
        cache.ids = parseRegistry(response.text); cache.fetchedAt = Date.now();
        await this.persist();
      } catch (e) { this.registryIssue = errorText(e); return; }
      finally { if (timeout !== undefined) window.clearTimeout(timeout); }
      this.registryIssue = '';
    })();
    try { await this.registryRequest; } finally { this.registryRequest = null; }
  }
  registryIssue = '';
  registryIds(): ReadonlySet<string> | null { return this.settings.registry?.fetchedAt ? new Set(this.settings.registry.ids) : null; }
  registryStatus(): string {
    const c = this.settings.registry;
    if (!c?.fetchedAt) return tr('Community directory not verified; Non-community includes unverified plugins.', '社区目录尚未核验；Non-community 包含未核验插件。');
    const stale = Date.now() - c.fetchedAt >= 24 * 60 * 60 * 1000;
    return tr(`Directory cached: ${new Date(c.fetchedAt).toLocaleString()}${this.registryIssue ? '; latest update failed' : stale ? '; cache may be outdated' : ''}. Matching uses plugin IDs only.`, `社区目录缓存：${new Date(c.fetchedAt).toLocaleString()}${this.registryIssue ? '；最近更新失败' : stale ? '；缓存可能过期' : ''}。仅按插件 ID 匹配。`);
  }
  private async snapshot(): Promise<Snapshot> {
    if (this.settings.sourceVersion === 1) await this.updateRegistry();
    return this.scanner.scan(Boolean(this.settings.includeCore), this.settings.sourceVersion !== 1, this.registryIds());
  }
  private formula(snapshot: Snapshot): string {
    return settingsFormula(snapshot.settingsFormula.vault, snapshot.settingsFormula.tabIds, snapshot.settingsFormula.available, this.settings.sourceVersion !== 1);
  }
  async previewSourceUpgrade(restart = false, progress?: (done: number, total: number) => void): Promise<UpgradePreview> {
    if (!this.settings.initialized) throw new Error(tr('Create an inventory first.', '请先创建清单。'));
    if (this.settings.migration || (this.settings.sourceUpgrade && !restart)) throw new Error(tr('Finish the existing operation first.', '请先完成现有操作。'));
    const recovery = this.settings.sourceUpgrade ? await this.hashText(JSON.stringify(this.settings.sourceUpgrade)) : undefined;
    const paths = this.paths(); const base = this.app.vault.getAbstractFileByPath(paths.base);
    if (base && !(base instanceof TFile)) throw new Error('The Base path is occupied by a folder.');
    await this.updateRegistry();
    const snap = await this.scanner.scan(true, false, this.registryIds(), true);
    const formula = settingsFormula(snap.settingsFormula.vault, snap.settingsFormula.tabIds, snap.settingsFormula.available);
    const skipped: string[] = [], changes = [tr('The Base will be rebuilt. Custom views remain in the backup.', '将重建标准 Base，自定义视图保存在备份中。')];
    const byPath = new Map<string, { key: string; item: Known }[]>();
    for (const [key, item] of Object.entries(this.settings.known)) { const group = byPath.get(item.path) ?? []; group.push({ key, item }); byPath.set(item.path, group); }
    type Candidate = { path: string; before: string; record: RecordData; observed: boolean };
    const groups = new Map<string, Candidate[]>();
    const candidates = this.app.vault.getMarkdownFiles().filter(f => inFolder(f.path, paths.library)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    let reviewed = 0;
    for (const file of candidates) {
      progress?.(reviewed++, candidates.length);
      const before = await this.app.vault.read(file);
      if (!byPath.has(file.path) && !/^\uFEFF?---[ \t]*\r?\n/.test(before)) continue;
      try {
        if (this.edited(file.path, before)) throw new Error('Save the open note first');
        const n = inspectRepairNote(before); const owners = byPath.get(file.path) ?? [];
        if (owners.length > 1) throw new Error('Multiple tracked identities use this path');
        const known = owners[0]?.item;
        let record: RecordData | undefined;
        if (known) {
          if (!['core', 'community'].includes(known.record.type) || !known.record.plugin_id) throw new Error('Tracked identity is invalid');
          record = snap.records.get(keyOf(known.record)) ?? { ...known.record };
        } else if (n.uniqueId) {
          const matches = [...snap.records.values()].filter(r => r.plugin_id === n.uniqueId);
          if (matches.length > 1) throw new Error('Ambiguous plugin identity');
          record = matches[0];
          if (!record && n.id) record = { ...n.id, name: typeof n.data.name === 'string' ? n.data.name : n.id.plugin_id, version: typeof n.data.version === 'string' ? n.data.version : '', status: n.data.status === 'enabled' ? 'enabled' : n.data.status === 'disabled' ? 'disabled' : 'uninstalled' };
        }
        if (!record) { if (known) throw new Error('Unknown managed identity'); else continue; }
        const observed = snap.records.has(keyOf(record));
        if (!observed && record.type === 'community' && snap.complete.community) record.status = 'uninstalled';
        record.source = classify(record.type, record.plugin_id, this.registryIds());
        const key = keyOf(record); const group = groups.get(key) ?? []; group.push({ path: file.path, before, record, observed }); groups.set(key, group);
      } catch (e) { skipped.push(`${file.path}: ${errorText(e)}`); }
    }
    const files: UpgradePreview['files'] = [], canonical: Record<string, Known> = {};
    for (const [key, group] of groups) {
      const tracked = this.settings.known[key]?.path;
      const chosen = group.find(item => item.path === tracked) ?? group[0];
      try {
        const after = repairNote(chosen.before, chosen.record, dateNow(), settingsLinkFor(snap.settingsFormula, chosen.record), chosen.observed, this.settings.sourceVersion === 0);
        files.push({ path: chosen.path, before: chosen.before, after });
        canonical[key] = { path: chosen.path, home: chosen.path, record: chosen.record };
        for (const other of group) if (other !== chosen) { files.push({ path: other.path, before: other.before, after: other.before, move: true }); changes.push(tr(`Duplicate will move to backup: ${other.path}`, `重复笔记将移入备份：${other.path}`)); }
      } catch (e) { skipped.push(`${chosen.path}: ${errorText(e)}`); }
    }
    progress?.(reviewed, candidates.length);
    const baseText = base instanceof TFile ? await this.app.vault.read(base) : '';
    if (base instanceof TFile && this.edited(base.path, baseText)) throw new Error('Save the Base editor first');
    files.push({ path: paths.base, before: baseText, after: makeBase(paths.library, formula), create: !base });
    return { files, changes, formula, canonical, skipped, ...(recovery ? { recovery } : {}) };
  }
  private async hashText(text: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }
  async startSourceUpgrade(approved: UpgradePreview, progress?: (message: string) => void): Promise<void> {
    return this.enqueue(async () => {
      const preview = await this.previewSourceUpgrade(Boolean(approved.recovery), (done, total) => progress?.(tr(`Checking files: ${done}/${total}`, `正在核对文件：${done}/${total}`)));
      if (JSON.stringify(preview) !== JSON.stringify(approved)) throw new Error(tr('The inventory changed since the preview. Review it again.', '预览后清单已更改，请重新预览。'));
      const paths = this.paths(); let parent = paths.base.includes('/') ? paths.base.slice(0, paths.base.lastIndexOf('/')) : '';
      if (parent === paths.library || inFolder(parent, paths.library)) parent = paths.library.includes('/') ? paths.library.slice(0, paths.library.lastIndexOf('/')) : '';
      const backupDir = `${parent ? `${parent}/` : ''}Plugin Inventory backup ${Date.now()}`;
      if (this.app.vault.getAbstractFileByPath(backupDir)) throw new Error(`Backup path already exists: ${backupDir}`);
      await this.mkdir(backupDir);
      const files: UpgradeFile[] = [];
      await this.app.vault.adapter.write(`${backupDir}/plugin-data.json`, JSON.stringify(this.settings, null, 2));
      for (const file of preview.files) {
        progress?.(tr(`Backing up: ${files.length}/${preview.files.length}`, `正在备份：${files.length}/${preview.files.length}`));
        const current = this.app.vault.getAbstractFileByPath(file.path);
        if (file.create ? Boolean(current) : !(current instanceof TFile) || await this.app.vault.read(current) !== file.before || this.edited(file.path, file.before)) throw new Error(`File changed before backup: ${file.path}`);
        files.push({ path: file.path, beforeHash: await this.hashText(file.before), afterHash: await this.hashText(file.after), create: file.create, ...(file.move ? { moveTo: `${backupDir}/conflicts/${files.length}-${file.path.split('/').pop() ?? 'note.md'}` } : {}) });
      }
      const snapshot = `${backupDir}/snapshot.json`;
      await this.app.vault.adapter.write(snapshot, JSON.stringify(preview.files));
      await this.app.vault.adapter.write(`${backupDir}/manifest.json`, JSON.stringify({ files, changes: preview.changes, skipped: preview.skipped }, null, 2));
      await this.app.vault.adapter.write(`${backupDir}/README.md`, 'Inventory repair backup. snapshot.json contains original and intended text. manifest.json records paths and SHA-256 digests. conflicts/ holds complete duplicate notes. Do not overwrite newer edits when restoring.');
      const previous = this.settings.sourceUpgrade;
      this.stopPolling(); this.settings.sourceUpgrade = { backupDir, snapshot, files, next: 0, formula: preview.formula, canonical: preview.canonical, skipped: preview.skipped };
      try { await this.persist(); } catch (e) { this.settings.sourceUpgrade = previous; throw e; }
      await this.finishSourceUpgrade(progress);
    });
  }
  async recoverSourceUpgrade(progress?: (message: string) => void): Promise<void> { return this.enqueue(() => this.finishSourceUpgrade(progress)); }
  private async finishSourceUpgrade(progress?: (message: string) => void): Promise<void> {
    const m = this.settings.sourceUpgrade; if (!m) return;
    if (!await this.app.vault.adapter.exists(m.snapshot)) throw new Error('Migration snapshot is missing.');
    const entries: unknown = JSON.parse(await this.app.vault.adapter.read(m.snapshot));
    if (!Array.isArray(entries) || entries.length !== m.files.length) throw new Error('Migration snapshot is invalid.');
    const snapshot = entries as { path: unknown; before: unknown; after: unknown }[];
    for (const [index, entry] of m.files.entries()) {
      const saved = snapshot[index];
      if (!saved || saved.path !== entry.path || typeof saved.before !== 'string' || typeof saved.after !== 'string' || await this.hashText(saved.before) !== entry.beforeHash || await this.hashText(saved.after) !== entry.afterHash) throw new Error(`Migration backup was changed: ${entry.path}`);
    }
    while (m.next < m.files.length) {
      progress?.(tr(`Repairing files: ${m.next}/${m.files.length}`, `正在修复文件：${m.next}/${m.files.length}`));
      const entry = m.files[m.next];
      const before = snapshot[m.next].before as string, after = snapshot[m.next].after as string;
      if (entry.moveTo) {
        const source = this.app.vault.getAbstractFileByPath(entry.path), target = this.app.vault.getAbstractFileByPath(entry.moveTo);
        if (!source && target instanceof TFile && await this.app.vault.read(target) === before) { /* completed before the checkpoint */ }
        else {
          if (!(source instanceof TFile) || target || await this.app.vault.read(source) !== before || this.edited(entry.path, before)) throw new Error(`Duplicate changed or destination occupied: ${entry.path}`);
          await this.parent(entry.moveTo);
          // Quarantine preserves all text; it intentionally does not rewrite links.
          await this.app.vault.rename(source, entry.moveTo);
        }
      } else if (entry.create && !this.app.vault.getAbstractFileByPath(entry.path)) {
        await this.parent(entry.path); await this.app.vault.create(entry.path, after);
      } else await this.process(entry.path, current => {
        if ((entry.create && current !== after) || (current !== before && current !== after)) throw new Error(tr(`File changed during migration: ${entry.path}`, `迁移期间文件已更改：${entry.path}`));
        return current === after ? current : after;
      });
      m.next++;
      // A replay accepts either the backed-up or intended bytes, so a crash
      // between checkpoints safely rechecks already-applied files.
      if (m.next % 10 === 0 || m.next === m.files.length) await this.persist();
    }
    this.settings.sourceVersion = 1;
    this.settings.binding = { library: this.paths().library, formula: m.formula };
    if (m.canonical) Object.assign(this.settings.known, m.canonical);
    for (const known of Object.values(this.settings.known)) known.record.source = classify(known.record.type, known.record.plugin_id, this.registryIds());
    this.settings.lastRepair = { backupDir: m.backupDir, skipped: m.skipped ?? [], repaired: m.files.filter(f => !f.moveTo).length, moved: m.files.filter(f => f.moveTo).length };
    await this.persist();
    this.settings.sourceUpgrade = null;
    try { await this.persist(); } catch (e) { this.settings.sourceUpgrade = m; throw e; }
    await this.sync(); this.updatePolling();
  }
  async mkdir(path: string): Promise<void> {
    let prefix = '';
    for (const part of path.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const item = this.app.vault.getAbstractFileByPath(prefix);
      if (item && !(item instanceof TFolder)) throw new Error(`Not a folder: ${prefix}`);
      if (!item) await this.app.vault.createFolder(prefix);
    }
  }
  private async parent(path: string): Promise<void> { const i = path.lastIndexOf('/'); if (i >= 0) await this.mkdir(path.slice(0, i)); }
  private checkParents(path: string): void {
    const parts = path.split('/'); parts.pop(); let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const item = this.app.vault.getAbstractFileByPath(prefix);
      if (item && !(item instanceof TFolder)) throw new Error(tr(`Not a folder: ${prefix}`, `父路径不是文件夹：${prefix}`));
    }
  }
  validateDraft(draft: Location): Paths {
    const paths = locations(draft, this.app.vault.configDir);
    const active = this.settings.initialized ? this.paths() : null;
    const base = this.app.vault.getAbstractFileByPath(paths.base);
    const library = this.app.vault.getAbstractFileByPath(paths.library);
    if (base && paths.base !== active?.base) throw new Error(tr('The Base path already exists. Choose a new file name.', 'Base 路径已存在，请选择新的文件名。'));
    if (library && !(library instanceof TFolder)) throw new Error(tr('The notes path is not a folder.', '笔记路径不是文件夹。'));
    if (active && paths.library !== active.library && library) throw new Error(tr('The destination notes folder already exists. Choose a new folder.', '目标笔记文件夹已存在，请选择新目录。'));
    this.checkParents(paths.base); this.checkParents(paths.library);
    if (active) movePlan(active, paths);
    return paths;
  }
  private storageChoice(paths: Paths, choice?: StorageChoice): StorageChoice {
    if (choice?.mode === 'root') {
      const expected = rootLocations(choice.root, this.app.vault.configDir);
      if (expected.base !== paths.base || expected.library !== paths.library) throw new Error('Root mode paths do not match the selected folder.');
      return { mode: 'root', root: choice.root.trim().replace(/\\/g, '/').replace(/\/+$/, '') };
    }
    return { mode: 'independent', root: choice?.root ?? this.settings.storage?.root ?? 'Plugins' };
  }
  async migrationPreview(draft: Location): Promise<Migration> {
    const to = this.validateDraft(draft); const from = this.paths();
    const steps = movePlan(from, to);
    const base = this.app.vault.getAbstractFileByPath(from.base);
    const folder = this.app.vault.getAbstractFileByPath(from.library);
    if (!(base instanceof TFile) || !(folder instanceof TFolder) || !this.settings.binding) throw new Error(tr('The managed Base or notes folder is missing. Restore it before moving.', '受管 Base 或笔记文件夹缺失，请先恢复。'));
    // Verify ownership of the managed filter before moving anything.
    const text = await this.app.vault.read(base);
    patchBase(text, this.settings.binding.library, to.library, this.settings.binding.formula, this.settings.binding.formula);
    for (const file of this.app.vault.getMarkdownFiles().filter(f => inFolder(f.path, from.library))) {
      if (this.edited(file.path, await this.app.vault.read(file))) throw new Error(tr(`Save the open note before moving: ${file.path}`, `请先保存打开的笔记：${file.path}`));
    }
    const folderStep = steps.find(s => s.kind === 'folder');
    const fileStep = steps.find(s => s.kind === 'file');
    if (fileStep && folderStep && inFolder(fileStep.to, folderStep.to)) {
      const prior = folderStep.from + fileStep.to.slice(folderStep.to.length);
      if (prior !== from.base && this.app.vault.getAbstractFileByPath(prior)) throw new Error(tr('The Base destination will be occupied after moving the folder.', '移动文件夹后 Base 目标位置将被占用。'));
      this.checkParents(prior);
    }
    return { from, to, steps, next: 0, inFlight: false, committed: false };
  }
  async startMigration(draft: Location, choice?: StorageChoice): Promise<void> {
    return this.enqueue(async () => {
      if (this.settings.migration || this.settings.sourceUpgrade) throw new Error(tr('Finish the existing migration first.', '请先完成现有迁移。'));
      const migration = await this.migrationPreview(draft);
      migration.storage = this.storageChoice(migration.to, choice);
      if (!migration.steps.length) { this.settings.storage = migration.storage; await this.persist(); return; }
      this.stopPolling(); this.settings.migration = migration;
      await this.persist();
      await this.finishMigration();
    });
  }
  async recoverMigration(): Promise<void> {
    return this.enqueue(async () => { await this.finishMigration(); });
  }
  private async fingerprint(path: string): Promise<string> {
    const all = this.app.vault.getAllLoadedFiles().filter(f => f.path === path || inFolder(f.path, path));
    if (!all.length) throw new Error(`Missing source: ${path}`);
    const manifest = all.map(f => f instanceof TFile
      ? ['file', f.path.slice(path.length), f.stat.size, f.stat.mtime]
      : ['folder', f.path.slice(path.length)]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(manifest)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  private async finishMigration(): Promise<void> {
    const m = this.settings.migration;
    if (!m) return;
    if (m.inFlight) {
      const step = m.steps[m.next];
      if (!step || !m.fingerprint || !this.app.vault.getAbstractFileByPath(step.from) || this.app.vault.getAbstractFileByPath(step.to) || await this.fingerprint(step.from) !== m.fingerprint) {
        throw new Error(tr(`The interrupted move cannot be verified. Inspect ${step?.from ?? ''} and ${step?.to ?? ''}; restore the original item to its source with the destination absent, then retry.`, `无法确认中断的移动。请检查 ${step?.from ?? ''} 和 ${step?.to ?? ''}；核对后将原文件或文件夹恢复到源位置并确保目标不存在，再重试。`));
      }
      m.inFlight = false; m.fingerprint = undefined; await this.persist();
    }
    while (m.next < m.steps.length) {
      const step = m.steps[m.next];
      const source = this.app.vault.getAbstractFileByPath(step.from);
      if ((step.kind === 'folder' && !(source instanceof TFolder)) || (step.kind === 'file' && !(source instanceof TFile))) throw new Error(tr(`Source missing or changed: ${step.from}`, `源文件或目录缺失／类型已改变：${step.from}`));
      if (!source) throw new Error(`Source missing: ${step.from}`);
      if (this.app.vault.getAbstractFileByPath(step.to)) throw new Error(tr(`Destination exists: ${step.to}`, `目标已存在：${step.to}`));
      await this.parent(step.to);
      m.fingerprint = await this.fingerprint(step.from); m.inFlight = true; await this.persist();
      await this.app.fileManager.renameFile(source, step.to);
      m.next++; m.inFlight = false; m.fingerprint = undefined; await this.persist();
    }
    if (!m.committed) {
      const base = this.app.vault.getAbstractFileByPath(m.to.base);
      if (!(base instanceof TFile) || !(this.app.vault.getAbstractFileByPath(m.to.library) instanceof TFolder) || !this.settings.binding) throw new Error(tr('Moved files cannot be verified.', '无法验证移动后的文件。'));
      const binding = this.settings.binding;
      await this.process(base.path, current => {
        try { return patchBase(current, binding.library, m.to.library, binding.formula, binding.formula); }
        catch (e) {
          // A previous attempt may have written the Base before persisting the journal.
          if (binding.library !== m.to.library) return patchBase(current, m.to.library, m.to.library, binding.formula, binding.formula);
          throw e;
        }
      });
      for (const known of Object.values(this.settings.known)) {
        const moved = (p: string): string => inFolder(p, m.from.library) ? m.to.library + p.slice(m.from.library.length) : p;
        known.path = moved(known.path); known.home = moved(known.home);
      }
      this.settings.base = m.to.base; this.settings.library = m.to.library;
      this.settings.storage = m.storage ?? { mode: 'independent', root: inferStorageRoot(m.to) ?? 'Plugins' };
      binding.library = m.to.library; m.committed = true; await this.persist();
    }
    this.settings.migration = null;
    try { await this.persist(); } catch (e) { this.settings.migration = m; throw e; }
    await this.sync(); this.updatePolling();
  }
  async initialize(draft: Location, choice?: StorageChoice): Promise<void> {
    return this.enqueue(async () => {
      if (this.settings.migration || this.settings.sourceUpgrade) throw new Error(tr('Finish migration recovery first.', '请先完成迁移恢复。'));
      const paths = this.validateDraft(draft);
      const storage = this.storageChoice(paths, choice);
      if (this.settings.initialized) {
        const active = this.paths();
        if (paths.base !== active.base || paths.library !== active.library) {
          throw new Error(tr('Use the move action to change storage locations.', '请使用移动操作更改保存位置。'));
        }
        if (!(this.app.vault.getAbstractFileByPath(paths.base) instanceof TFile)) throw new Error(tr('The managed Base is missing. Restore it before checking.', '受管 Base 已缺失，请恢复后再检查。'));
        const modeChanged = JSON.stringify(this.settings.storage) !== JSON.stringify(storage);
        this.settings.storage = storage; await this.persist(); if (!modeChanged) await this.sync(); return;
      }
      const existing = this.app.vault.getAbstractFileByPath(paths.base);
      if (existing) throw new Error(tr('An existing Base needs a different new Base path; it will not be overwritten.', '此位置已有 Base，请为新清单选择其他 Base 路径；不会覆盖现有文件。'));
      const snapshot = await this.snapshot();
      if (!snapshot.complete.core || !snapshot.complete.community) throw new Error(snapshot.errors.join('\n'));
      if (!snapshot.basesEnabled) throw new Error(tr('Enable the Bases core plugin first.', '请先手动启用官方 Bases 插件。'));
      await this.mkdir(paths.library); await this.parent(paths.base);
      const formula = this.formula(snapshot);
      if (!existing) await this.app.vault.create(paths.base, makeBase(paths.library, formula));
      this.settings = { ...this.settings, ...paths, storage, initialized: true, binding: this.settings.binding ?? { library: paths.library, formula } };
      await this.persist();
      await this.sync();
    });
  }
  async refresh(showNotice = false): Promise<void> {
    if (this.settings.migration || this.settings.sourceUpgrade) { if (showNotice) new Notice(tr('Finish migration recovery first.', '请先完成迁移恢复。')); return; }
    if (!this.settings.initialized) { if (showNotice) new Notice(tr('Choose storage paths in settings and create the inventory first.', '请先在设置中选择保存位置并创建清单。')); return; }
    if (this.busy) return this.queue;
    this.busy = true;
    try {
      await this.enqueue(async () => { if (showNotice && this.settings.sourceVersion === 1) await this.updateRegistry(true); await this.sync(); });
      if (showNotice) new Notice(this.summary);
    } catch (e) { if (showNotice) new Notice(errorText(e)); }
    finally { this.busy = false; }
  }
  private edited(path: string, disk: string): boolean {
    return this.app.workspace.getLeavesOfType('markdown').some(leaf => leaf.view instanceof MarkdownView && leaf.view.file?.path === path && leaf.view.editor.getValue() !== disk);
  }
  private async process(path: string, transform: (text: string) => string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
    await this.app.vault.process(file, text => {
      if (this.edited(path, text)) throw new Error(tr(`Unsaved editor; skipped: ${path}`, `编辑尚未保存，已跳过：${path}`));
      return transform(text);
    });
  }
  private async sync(): Promise<void> {
    const paths = this.paths();
    if (!(this.app.vault.getAbstractFileByPath(paths.library) instanceof TFolder)) throw new Error(tr('Library is missing. Restore or relocate it before refreshing.', 'Library 不存在，请先恢复或重新定位，避免重复生成。'));
    const snapshot = await this.snapshot();
    const issues = [...snapshot.errors];
    const notes = new Map<string, { path: string; text: string; data: Record<string, unknown> }[]>();
    const knownByPath = new Map(Object.entries(this.settings.known).map(([key, value]) => [value.path, { key, value }]));
    let indexComplete = true;
    let readIdx = 0;
    for (const file of this.app.vault.getMarkdownFiles().filter(f => inFolder(f.path, paths.library))) {
      if (++readIdx % 5 === 0) await yieldToEventLoop();
      try {
        if (this.settings.lastRepair?.skipped.some(message => message.startsWith(`${file.path}:`))) { issues.push(`Repair required: ${file.path}`); indexComplete = false; continue; }
        const text = await this.app.vault.read(file);
        const n = splitNote(text); const data = n.data as Record<string, unknown>; const known = knownByPath.get(file.path);
        const id = known
          ? { type: known.value.record.type, plugin_id: known.value.record.plugin_id } : identity(n.data);
        if (!id) continue;
        const key = keyOf(id); const group = notes.get(key) ?? [];
        group.push({ path: file.path, text, data }); notes.set(key, group);
      } catch (e) { indexComplete = false; issues.push(`${file.path}: ${errorText(e)}`); }
    }
    const date = dateNow(); let created = 0, updated = 0;
    let updateIdx = 0;
    for (const [key, group] of notes) {
      if (++updateIdx % 5 === 0) await yieldToEventLoop();
      if (group.length !== 1) { issues.push(`Duplicate identity: ${key}`); continue; }
      const note = group[0];
      if (this.settings.sourceVersion === 1 && splitNote(note.text).doc.has('type') && !(typeof note.data.source === 'string' && ['Built-in', 'Community', 'Non-community'].includes(note.data.source))) { issues.push(tr(`Legacy note needs a source upgrade: ${note.path}`, `旧版笔记需要升级来源字段：${note.path}`)); continue; }
      this.settings.excluded = this.settings.excluded.filter(k => k !== key);
      const source = snapshot.records.get(key);
      const owner = knownByPath.get(note.path);
      const old = owner?.key === key
        ? { type: owner.value.record.type, plugin_id: owner.value.record.plugin_id } : identity(note.data);
      if (!old) { issues.push(tr(`Note identity is missing: ${note.path}`, `笔记身份缺失：${note.path}`)); continue; }
      if (old.type === 'core' && !this.settings.includeCore) continue;
      let record: RecordData = source ?? {
        ...old, name: typeof note.data.name === 'string' ? note.data.name : old.plugin_id,
        version: typeof note.data.version === 'string' ? note.data.version : '',
        status: note.data.status === 'enabled' ? 'enabled' : note.data.status === 'disabled' ? 'disabled' : 'uninstalled'
      };
      if (!source && old.type === 'community' && snapshot.complete.community) record = { ...record, status: 'uninstalled' };
      if (this.settings.sourceVersion === 1) record.source = classify(old.type, old.plugin_id, this.registryIds());
      const canUpdate = source ? snapshot.complete[source.type] : old.type === 'community' && snapshot.complete.community;
      this.settings.known[key] = { path: note.path, home: note.path, record };
      const settings = settingsLinkFor(snapshot.settingsFormula, record);
      const confirmedOwner = knownByPath.get(note.path)?.key === key;
      if (canUpdate && updateNote(note.text, record, date, settings, this.settings.sourceVersion !== 1, confirmedOwner) !== note.text) {
        try {
          await this.process(note.path, current => updateNote(current, record, date, settings, this.settings.sourceVersion !== 1, confirmedOwner)); updated++;
        } catch (e) { issues.push(errorText(e)); }
      }
    }
    // Never create around a malformed/unfinished note or an already known missing identity.
    if (indexComplete) for (const [key, record] of snapshot.records) {
      if (!snapshot.complete[record.type] || notes.has(key) || this.settings.excluded.includes(key) || this.settings.known[key]) continue;
      const path = await this.availableNotePath(record);
      await this.app.vault.create(path, newNote(record, date, settingsLinkFor(snapshot.settingsFormula, record), this.settings.sourceVersion !== 1));
      this.settings.known[key] = { path, home: path, record }; created++;
      await yieldToEventLoop();
    }
    this.pending = indexComplete ? Object.keys(this.settings.known).filter(k => !notes.has(k) && !this.settings.excluded.includes(k)
      && !this.app.vault.getAbstractFileByPath(this.settings.known[k].path)?.path.startsWith(`${paths.library}/`)) : [];
    // A deleted file keeps its old Library path, so also include absent known files.
    if (indexComplete) for (const [key, known] of Object.entries(this.settings.known)) {
      if (!notes.has(key) && !this.settings.excluded.includes(key) && !this.app.vault.getAbstractFileByPath(known.path) && !this.pending.includes(key)) this.pending.push(key);
    }
    const base = this.app.vault.getAbstractFileByPath(paths.base);
    if (base instanceof TFile && this.settings.binding) {
      const formula = this.formula(snapshot);
      try {
        const before = await this.app.vault.read(base);
        const { library, formula: oldFormula } = this.settings.binding;
        const after = patchBase(before, library, paths.library, oldFormula, formula);
        if (before !== after) await this.process(base.path, current => patchBase(current, library, paths.library, oldFormula, formula));
        // Retain custom formula ownership: only claim a formula we really wrote.
        const actualFormula = parseDocument(after).getIn(['formulas', 'Settings']);
        this.settings.binding.library = paths.library;
        if (actualFormula === formula) this.settings.binding.formula = formula;
        else issues.push(tr('The Settings formula was edited manually; the Base column and the note property may differ.', 'Settings 公式已被手动修改，Base 列与 Note 属性可能不一致。'));
      } catch (e) { issues.push(tr(`Repair inventory: ${errorText(e)}`, `需要修复清单：${errorText(e)}`)); }
    } else issues.push(tr('Base file missing; use Repair inventory.', 'Base 文件缺失，请使用“修复清单”。'));
    this.errors = issues;
    this.summary = `${new Date().toLocaleTimeString()} · ${snapshot.records.size} ${tr('plugins', '个插件')} · +${created} / ↻${updated} · ${this.pending.length} ${tr('missing', '条缺失')}${issues.length ? ` · ${issues.length} ${tr('issues', '项问题')}` : ''}`;
    await this.persist();
    if (this.isOpen()) this.maybePrompt();
  }
  private async availableNotePath(record: RecordData): Promise<string> {
    const root = this.paths().library; const name = filename(record);
    let path = `${root}/${name}.md`; let suffix = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `${root}/${name} (${record.type}-${record.plugin_id.replace(/[^\w-]/g, '-')}${suffix > 1 ? `-${suffix}` : ''}).md`; suffix++;
    }
    return path;
  }
  private async trackRename(oldPath: string, newPath: string): Promise<void> {
    if (!this.settings.initialized) return;
    const before = this.paths();
    const moved = (p: string): string => p === oldPath ? newPath : inFolder(p, oldPath) ? newPath + p.slice(oldPath.length) : p;
    const base = moved(before.base), library = moved(before.library);
    this.settings.base = base;
    this.settings.library = library;
    if (this.settings.storage?.mode === 'root') {
      const root = inferStorageRoot({ base, library });
      if (root) this.settings.storage.root = root;
      else { this.settings.storage.mode = 'independent'; new Notice(tr('The inventory now uses independent paths.', '目录结构已变化，已切换为独立路径模式。')); }
    }
    for (const known of Object.values(this.settings.known)) {
      known.path = moved(known.path); known.home = moved(known.home);
      if (inFolder(known.path, library)) known.home = known.path;
    }
    await this.persist(); await this.sync();
  }
  private isOpen(): boolean {
    if (!this.settings.initialized || this.settings.migration || this.settings.sourceUpgrade) return false;
    return this.app.workspace.getLeavesOfType('bases').some(leaf => leaf.view instanceof FileView && leaf.view.file?.path === this.paths().base);
  }
  private stopPolling(): void { if (this.timer !== null) window.clearInterval(this.timer); this.timer = null; }
  private updatePolling(): void {
    if (this.stopping || !this.isOpen()) { this.stopPolling(); return; }
    if (this.timer === null) { void this.refresh(); this.timer = window.setInterval(() => { void this.refresh(); }, 3000); }
  }
  async openInventory(): Promise<void> {
    if (this.settings.migration || this.settings.sourceUpgrade) { new Notice(tr('Finish migration recovery first.', '请先完成迁移恢复。')); return; }
    if (!this.settings.initialized) { new Notice(tr('Create the inventory in plugin settings first.', '请先在插件设置中创建清单。')); return; }
    const file = this.app.vault.getAbstractFileByPath(this.paths().base);
    if (!(file instanceof TFile)) { new Notice(tr('Base file not found.', 'Base 文件不存在。')); return; }
    await this.app.workspace.getLeaf('tab').openFile(file); await this.refresh(); this.updatePolling();
  }
  private maybePrompt(): void {
    const signature = [...this.pending].sort().join('|');
    if (signature && signature !== this.prompted && !this.missingOpen) this.showMissing();
  }
  showMissing(): void {
    if (this.settings.migration || this.settings.sourceUpgrade) { new Notice(tr('Finish migration recovery first.', '请先完成迁移恢复。')); return; }
    if (!this.pending.length) { new Notice(tr('No missing notes.', '没有缺失记录。')); return; }
    if (this.missingOpen) return;
    this.prompted = [...this.pending].sort().join('|'); this.missingOpen = true;
    new MissingModal(this, () => { this.missingOpen = false; }).open();
  }
  async resolveMissing(key: string, action: 'exclude' | 'restore'): Promise<void> {
    if (this.settings.migration || this.settings.sourceUpgrade) throw new Error(tr('Finish migration recovery first.', '请先完成迁移恢复。'));
    await this.enqueue(async () => {
      if (this.settings.migration || this.settings.sourceUpgrade) throw new Error(tr('Finish migration recovery first.', '请先完成迁移恢复。'));
      const known = this.settings.known[key]; if (!known) return;
      if (action === 'exclude') {
        if (!this.settings.excluded.includes(key)) this.settings.excluded.push(key);
      } else {
        const outside = this.app.vault.getAbstractFileByPath(known.path);
        if (outside instanceof TFile && !inFolder(outside.path, this.paths().library)) {
          if (this.app.vault.getAbstractFileByPath(known.home)) throw new Error(`Destination exists: ${known.home}`);
          await this.parent(known.home);
          await this.app.fileManager.renameFile(outside, known.home);
          known.path = known.home;
        } else if (!outside) {
          const snapshot = await this.snapshot();
          const record = snapshot.records.get(key) ?? { ...known.record, status: known.record.type === 'community' ? 'uninstalled' as const : known.record.status };
          const path = await this.availableNotePath(record);
          await this.app.vault.create(path, newNote(record, dateNow(), settingsLinkFor(snapshot.settingsFormula, record), this.settings.sourceVersion !== 1));
          this.settings.known[key] = { path, home: path, record };
        }
        this.settings.excluded = this.settings.excluded.filter(k => k !== key);
      }
      await this.persist(); await this.sync();
    });
  }
  async unexclude(key: string): Promise<void> {
    if (this.settings.migration || this.settings.sourceUpgrade) throw new Error(tr('Finish migration recovery first.', '请先完成迁移恢复。'));
    this.settings.excluded = this.settings.excluded.filter(k => k !== key);
    await this.persist(); await this.refresh(); this.showMissing();
  }
  confirmReset(): void {
    action((async () => {
      const preview = await this.previewSourceUpgrade();
      new ConfirmModal(this.app, repairPrompt(preview, this.paths().base), () => this.startSourceUpgrade(preview)).open();
    })());
  }

}

function action(promise: Promise<void>): void { void promise.catch(e => new Notice(errorText(e))); }
class ConfirmModal extends Modal {
  constructor(app: App, private message: string, private run: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('p', { text: this.message, cls: 'pip-confirm' });
    new Setting(this.contentEl).addButton(b => b.setButtonText(tr('Confirm', '确认')).setCta().onClick(() => { this.close(); action(this.run()); }))
      .addButton(b => b.setButtonText(tr('Cancel', '取消')).onClick(() => this.close()));
  }
}
class MissingModal extends Modal {
  constructor(private plugin: InventoryPlugin, private done: () => void) { super(plugin.app); }
  onClose(): void { this.done(); }
  onOpen(): void { this.render(); }
  private render(): void {
    this.contentEl.empty(); this.contentEl.createEl('h2', { text: tr('Missing notes', '缺失记录') });
    this.contentEl.createEl('p', { text: tr('Rebuild deleted notes, move detached notes back, or exclude them. Existing files are never overwritten.', '可重建已删除的 Note、将移出的 Note 移回，或将其排除。不会覆盖现有文件。') });
    const rows = this.contentEl.createDiv({ cls: 'pip-rows' });
    for (const key of [...this.plugin.pending]) {
      const item = this.plugin.settings.known[key]; if (!item) continue;
      new Setting(rows).setName(item.record.name).setDesc(item.path)
        .addButton(b => b.setButtonText(tr('Rebuild / move back', '重建／移回')).onClick(() => { action(this.plugin.resolveMissing(key, 'restore').then(() => this.render())); }))
        .addButton(b => b.setButtonText(tr('Exclude', '排除')).onClick(() => { action(this.plugin.resolveMissing(key, 'exclude').then(() => this.render())); }));
    }
    new Setting(this.contentEl).addButton(b => b.setButtonText(tr('Rebuild / move back all', '全部重建／移回')).onClick(() => {
      action((async () => { for (const k of [...this.plugin.pending]) await this.plugin.resolveMissing(k, 'restore'); this.render(); })());
    })).addButton(b => b.setButtonText(tr('Exclude all', '全部排除')).onClick(() => {
      action((async () => { for (const k of [...this.plugin.pending]) await this.plugin.resolveMissing(k, 'exclude'); this.render(); })());
    }));
  }
}
class ExclusionsModal extends Modal {
  constructor(private plugin: InventoryPlugin) { super(plugin.app); }
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl('h2', { text: tr('Excluded notes', '排除项') });
    for (const key of this.plugin.settings.excluded) {
      new Setting(this.contentEl).setName(this.plugin.settings.known[key]?.record.name ?? key)
        .addButton(b => b.setButtonText(tr('Restore', '恢复管理')).onClick(() => { action(this.plugin.unexclude(key).then(() => this.close())); }));
    }
    if (!this.plugin.settings.excluded.length) this.contentEl.createEl('p', { text: tr('No exclusions.', '没有排除项。') });
  }
}
class InventorySettings extends PluginSettingTab {
  private processing = false;
  constructor(app: App, private plugin: InventoryPlugin) { super(app, plugin); }
  display(): void {
    const el = this.containerEl; el.empty(); el.addClass('pip-settings');
    const repairRecovery = el.createDiv({ cls: 'pip-repair-recovery' });
    const draft: Location = { base: this.plugin.settings.base, library: this.plugin.settings.library };
    let storage: StorageChoice = { ...(this.plugin.settings.storage ?? { mode: 'independent' as const, root: 'Plugins' }) };
    const resolved = (): Paths => storage.mode === 'root' ? rootLocations(storage.root, this.app.vault.configDir) : draft;
    new Setting(el).setName(tr('Storage locations', '存储位置')).setHeading();
    el.createEl('p', { cls: 'pip-intro', text: tr('Choose one storage mode. Changes take effect only after you apply them.', '选择一种保存方式；应用前不会移动文件。') });
    const modeSetting = new Setting(el).setName(tr('Storage mode', '保存方式')).addDropdown(d => d
      .addOption('root', tr('Root folder', '根目录'))
      .addOption('independent', tr('Independent paths', '独立路径'))
      .setValue(storage.mode).setDisabled(Boolean(this.plugin.settings.migration || this.plugin.settings.sourceUpgrade))
      .onChange(value => {
        if (value === 'independent' && storage.mode === 'root') {
          try { const p = resolved(); draft.base = p.base; draft.library = p.library; baseText.setValue(p.base); libraryText.setValue(p.library); } catch { /* retain the last valid independent draft */ }
        } else if (value === 'root') {
          storage.root = inferStorageRoot(draft) ?? (draft.base.split('/').slice(0, -1).join('/') || storage.root || 'Plugins'); rootText.setValue(storage.root);
        }
        storage.mode = value === 'root' ? 'root' : 'independent'; validate();
      }));
    modeSetting.settingEl.addClass('pip-storage-mode');
    const rootGroup = el.createDiv({ cls: 'pip-root-paths' }), independentGroup = el.createDiv({ cls: 'pip-independent-paths' });
    let rootSuggest: FolderSuggest;
    let rootText: import('obsidian').TextComponent;
    new Setting(rootGroup).setName(tr('Root folder', '根目录')).setDesc(tr('Creates Plugin Inventory.base and Plugin Library inside this folder.', '在此目录下使用 Plugin Inventory.base 和 Plugin Library。'))
      .addText(t => { rootText = t; t.inputEl.setAttribute('aria-label', tr('Root folder', '根目录')); t.setValue(storage.root).setPlaceholder('Plugins').onChange(value => { storage.root = value; validate(); }); rootSuggest = new FolderSuggest(this.app, t.inputEl); })
      .addButton(b => b.setButtonText(tr('Choose', '选择')).onClick(() => rootSuggest.showAll())).settingEl.addClass('pip-location');
    const rootPreview = rootGroup.createDiv({ cls: 'pip-path', attr: { 'aria-live': 'polite' } });
    let baseSuggest: BaseSuggest, baseText: import('obsidian').TextComponent;
    const baseSetting = new Setting(independentGroup).setName(tr('Base file', 'Base 文件'))
      .setDesc(tr('A .base file holds the table, views and filters.', '以 .base 结尾，保存表格、视图和筛选。'))
      .addText(t => { baseText = t; t.inputEl.setAttribute('aria-label', tr('Base file', 'Base 文件')); t.setPlaceholder('Plugins/Plugin Inventory.base').setValue(draft.base).onChange(v => { draft.base = v; validate(); }); baseSuggest = new BaseSuggest(this.app, t.inputEl, () => this.plugin.settings.initialized ? this.plugin.paths().base : null); })
      .addButton(b => b.setButtonText(tr('Choose', '选择')).onClick(() => baseSuggest.showAll()));
    baseSetting.settingEl.addClass('pip-location');
    let librarySuggest: FolderSuggest, libraryText: import('obsidian').TextComponent;
    const librarySetting = new Setting(independentGroup).setName(tr('Notes folder', '笔记文件夹'))
      .setDesc(tr('Stores plugin notes and their content. Subfolders are supported.', '保存插件笔记及正文，支持子文件夹。'))
      .addText(t => { libraryText = t; t.inputEl.setAttribute('aria-label', tr('Notes folder', '笔记文件夹')); t.setPlaceholder('Plugins/Plugin Library').setValue(draft.library).onChange(v => { draft.library = v; validate(); }); librarySuggest = new FolderSuggest(this.app, t.inputEl); })
      .addButton(b => b.setButtonText(tr('Choose', '选择')).onClick(() => librarySuggest.showAll()));
    librarySetting.settingEl.addClass('pip-location');
    const feedback = el.createDiv({ cls: 'pip-feedback', attr: { 'aria-live': 'polite' } });
    const explanation = el.createEl('p', { cls: 'pip-help', text: tr('An existing notes folder is scanned for matching plugin notes. Managed properties may be updated; your note text and custom properties are preserved.', '选择已有笔记文件夹时，插件会扫描其中匹配的插件笔记并更新受管属性；笔记正文与自定义属性会保留。') });
    let primary: import('obsidian').ButtonComponent;
    const setButtons = new Setting(el).addButton(b => { primary = b; b.setCta().onClick(() => { void submit(); }); })
      .addButton(b => b.setButtonText(tr('Open inventory', '打开清单')).onClick(() => action(this.plugin.openInventory())));
    setButtons.settingEl.addClass('pip-actions');
    const status = el.createDiv({ cls: 'pip-status', attr: { 'aria-live': 'polite' } });
    const validate = (): void => {
      const migrating = Boolean(this.plugin.settings.migration || this.plugin.settings.sourceUpgrade);
      for (const group of [rootGroup, independentGroup, modeSetting.settingEl]) group.querySelectorAll('input, button, select').forEach(control => control.toggleAttribute('disabled', migrating || this.processing));
      rootGroup.hidden = storage.mode !== 'root'; independentGroup.hidden = storage.mode !== 'independent';
      try {
        const paths = this.plugin.validateDraft(resolved());
        rootPreview.setText(`Base: ${paths.base}\nNotes: ${paths.library}`);
        const active = this.plugin.settings.initialized ? this.plugin.paths() : null;
        const changed = active && (paths.base !== active.base || paths.library !== active.library);
        const modeChanged = JSON.stringify(storage) !== JSON.stringify(this.plugin.settings.storage);
        feedback.removeClass('is-error');
        feedback.setText(changed ? tr('The existing inventory will be moved after you review and confirm.', '确认预览后将移动现有清单。') : tr('Paths are valid.', '路径有效。'));
        primary.setButtonText(!active ? tr('Create inventory', '创建清单') : changed ? tr('Preview and move', '预览并移动清单') : modeChanged ? tr('Save mode', '保存方式') : tr('Check inventory', '检查清单'));
        primary.setDisabled(this.processing || migrating);
      } catch (e) {
        rootPreview.empty(); feedback.addClass('is-error'); feedback.setText(pathError(e)); primary.setDisabled(true);
      }
      repairRecovery.querySelectorAll('button').forEach(control => control.toggleAttribute('disabled', this.processing));
      explanation.toggleClass('is-muted', migrating);
    };
    const execute = async (work: () => Promise<void>): Promise<void> => {
      this.processing = true; validate(); status.setText(tr('Processing…', '正在处理…'));
      try { await work(); status.setText(this.plugin.summary); this.processing = false; this.display(); }
      catch (e) { this.processing = false; if (this.plugin.settings.sourceUpgrade) { this.display(); new Notice(errorText(e)); } else { status.setText(errorText(e)); validate(); renderRecovery(); } }
    };
    const submit = async (): Promise<void> => {
      if (this.processing || this.plugin.settings.migration || this.plugin.settings.sourceUpgrade) return;
      try {
        const paths = this.plugin.validateDraft(resolved()); const selectedStorage = { ...storage }; const current = this.plugin.settings.initialized ? this.plugin.paths() : null;
        if (current && (current.base !== paths.base || current.library !== paths.library)) {
          this.processing = true; validate(); status.setText(tr('Checking paths…', '正在检查路径…'));
          let m: Migration;
          try { m = await this.plugin.migrationPreview(paths); }
          finally { this.processing = false; validate(); status.empty(); }
          const count = this.app.vault.getAllLoadedFiles().filter(f => inFolder(f.path, m.from.library)).length;
          const folderMoves = m.from.library !== m.to.library;
          const message = folderMoves
            ? tr(`Move the entire notes folder, including all ${count} contained files and folders?\n\nBase: ${m.from.base} → ${m.to.base}\nNotes: ${m.from.library} → ${m.to.library}\n\nOther content in the notes folder moves too. Existing destinations are never overwritten.`, `移动整个笔记文件夹（包含其中全部 ${count} 个文件和子文件夹）？\n\nBase：${m.from.base} → ${m.to.base}\n笔记：${m.from.library} → ${m.to.library}\n\n文件夹内的其他内容也会一起移动；不会覆盖已有目标。`)
            : tr(`Move the Base file?\n\nBase: ${m.from.base} → ${m.to.base}\nNotes stay at: ${m.from.library}\n\nExisting destinations are never overwritten.`, `移动 Base 文件？\n\nBase：${m.from.base} → ${m.to.base}\n笔记保留在：${m.from.library}\n\n不会覆盖已有目标。`);
          const links = tr('\n\nObsidian may also update links elsewhere in the vault according to its file-link settings.', '\n\nObsidian 可能根据文件链接设置更新 Vault 中其他位置的链接。');
          new ConfirmModal(this.app, message + links, () => execute(() => this.plugin.startMigration(paths, selectedStorage))).open();
        } else await execute(() => this.plugin.initialize(paths, selectedStorage));
      } catch (e) { status.setText(errorText(e)); }
    };
    validate();
    const recovery = el.createDiv();
    const renderRecovery = (): void => {
      recovery.empty();
      if (!this.plugin.settings.migration) return;
      const m = this.plugin.settings.migration;
      const panel = recovery.createDiv({ cls: 'pip-recovery' });
      panel.createEl('strong', { text: tr('Migration recovery required', '需要恢复迁移') });
      panel.createEl('p', { text: tr(`Completed steps: ${m.next}/${m.steps.length}. Automatic synchronization is paused. ${m.inFlight ? 'The last move may require manual inspection.' : 'You can safely try to continue.'}`, `已完成步骤：${m.next}/${m.steps.length}。自动同步已暂停。${m.inFlight ? '上一次移动可能需要人工检查。' : '可以尝试继续迁移。'}`) });
      panel.createEl('p', { cls: 'pip-path', text: `${m.from.base} → ${m.to.base}\n${m.from.library} → ${m.to.library}` });
      new Setting(panel).addButton(b => b.setButtonText(tr('Continue recovery', '继续恢复')).onClick(() => { void execute(() => this.plugin.recoverMigration()); }));
    };
    renderRecovery();
    new Setting(el).setName(tr('Inventory status', '清单状态')).setHeading();
    el.createEl('p', { cls: 'pip-summary', text: this.plugin.summary });
    el.createEl('p', { cls: 'pip-help', text: this.plugin.registryStatus() });
    const reviewRepair = async (restart = false): Promise<void> => {
      if (this.processing) return;
      this.processing = true; validate();
      status.setText(tr('Reviewing current files…', '正在检查当前文件…'));
      try {
        const preview = await this.plugin.previewSourceUpgrade(restart, (done, total) => status.setText(tr(`Reviewing files: ${done}/${total}`, `正在检查文件：${done}/${total}`)));
        const prefix = restart ? tr('Replace the interrupted repair with a new plan based on current files? The old journal and backups will be preserved.\n\n', '按当前文件重新制定修复计划？旧恢复日志和备份会保留。\n\n') : '';
        new ConfirmModal(this.app, prefix + repairPrompt(preview, this.plugin.paths().base), () => execute(() => this.plugin.startSourceUpgrade(preview, message => status.setText(message)))).open();
        status.empty();
      } catch (e) { status.setText(errorText(e)); }
      finally { this.processing = false; validate(); }
    };
    if (this.plugin.settings.sourceUpgrade) {
      const m = this.plugin.settings.sourceUpgrade;
      const panel = repairRecovery.createDiv({ cls: 'pip-recovery', attr: { role: 'status' } });
      panel.createEl('strong', { text: tr('Repair paused — action required', '修复已暂停，需要处理') });
      panel.createEl('p', { text: tr(`Completed ${m.next}/${m.files.length}. Storage settings and synchronization are paused until repair finishes.`, `已完成 ${m.next}/${m.files.length}。完成修复前，保存位置设置与同步暂停。`) });
      const next = m.files[m.next];
      if (next) panel.createEl('p', { cls: 'pip-path', text: tr(`Next file: ${next.path}`, `待处理文件：${next.path}`) });
      for (const message of this.plugin.errors) panel.createEl('p', { cls: 'pip-error', text: message });
      panel.createEl('p', { text: tr('If a file changed, review current files to create a fresh backup and repair plan. Current body text and custom properties are preserved. Old snapshots will not overwrite new edits.', '文件变化时，请重新预览当前文件，建立新的备份和修复计划。保留当前正文及自定义属性，不用旧快照覆盖新编辑。') });
      panel.createEl('p', { cls: 'pip-path', text: tr(`Existing backup: ${m.backupDir}`, `已有备份：${m.backupDir}`) });
      new Setting(panel)
        .addButton(b => b.setButtonText(tr('Review current files', '重新预览当前文件')).setCta().onClick(() => { void reviewRepair(true); }))
        .addButton(b => b.setButtonText(tr('Retry original repair', '重试原修复')).onClick(() => { if (!this.processing) void execute(() => this.plugin.recoverSourceUpgrade(message => status.setText(message))); }));
    } else if (this.plugin.settings.initialized) {
      new Setting(el).setName(tr('Repair inventory', '修复清单'))
        .setDesc(tr('Correct managed properties, quarantine duplicates and rebuild the standard Base. Custom views are backed up.', '修正受管属性、移出重复笔记并重建标准 Base；旧视图会备份。'))
        .addButton(b => b.setButtonText(tr('Review repair', '预览修复')).onClick(() => { void reviewRepair(); }));
    }
    if (this.plugin.settings.lastRepair) {
      const last = this.plugin.settings.lastRepair;
      el.createEl('p', { cls: 'pip-help', text: tr(`Last repair: ${last.repaired} files, ${last.moved} duplicates, ${last.skipped.length} skipped. Backup: ${last.backupDir}`, `上次修复：${last.repaired} 个文件，移出 ${last.moved} 条重复笔记，跳过 ${last.skipped.length} 项。备份：${last.backupDir}`) });
      for (const skipped of last.skipped) el.createEl('p', { cls: 'pip-error', text: skipped });
    }
    for (const message of this.plugin.errors.slice(0, 8)) el.createEl('p', { text: message, cls: 'pip-error' });
    new Setting(el).addButton(b => b.setButtonText(tr('Refresh', '立即刷新')).onClick(() => action(this.plugin.refresh(true).then(() => this.display()))))
      .addButton(b => b.setButtonText(tr('Missing notes', '缺失记录')).onClick(() => this.plugin.showMissing()))
      .addButton(b => b.setButtonText(tr('Exclusions', '排除项')).onClick(() => new ExclusionsModal(this.plugin).open()));
    new Setting(el).setName(tr('Management', '管理选项')).setHeading();
    new Setting(el).setName(tr('Include Obsidian core plugins', '包含官方内置功能'))
      .setDesc(tr('Track built-in features such as Canvas and Search.', '在清单中记录白板、搜索等官方内置功能。'))
      .addToggle(t => t.setValue(this.plugin.settings.includeCore ?? false).setDisabled(Boolean(this.plugin.settings.migration || this.plugin.settings.sourceUpgrade)).onChange(async v => {
        this.plugin.settings.includeCore = v; await this.plugin.persist(); await this.plugin.refresh(true);
      }));
    el.createEl('p', { cls: 'pip-help', text: tr('The open inventory refreshes every 3 seconds. Settings links require Advanced URI.', '清单打开时每 3 秒刷新；设置跳转需要 Advanced URI。') });
    new Setting(el).setName(tr('Note template', '笔记模板')).setHeading();
    el.createEl('p', { cls: 'pip-help', text: tr('Applied once to new notes. You own the contents.', '仅在新建笔记时应用一次，内容由你维护。') });
    el.createEl('pre', { text: TEMPLATE, cls: 'pip-template' });
  }
}
