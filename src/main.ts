import {
  MarkdownView, Notice,
  Plugin, TFile, TFolder, getLanguage, requestUrl
} from 'obsidian';
import {
  TEMPLATE, defaultInventoryPaths, inventoryPath, compatibleIndexFormula, identity, inFolder, keyOf, legacyLocations, locations, makeBase, newNote,
  patchBase, settingsFormula, settingsLink, splitNote, updateNote,
  type MoveStep, type Paths, type RecordData
} from './core';
import { Scanner, type Snapshot } from './compat';
import { classify, parseRegistry, REGISTRY_URL, registryDue, type RegistryCache } from './registry';
import { inspectRepairNote, repairNote } from './repair';
import { indexLibrary, noteDestination, occupiedNotePaths, pathState, replacementPath, type IndexedNote } from './inventory';
import { COMMANDS, InventorySettings } from './settings';

type Progress = (status: string) => void;
interface PlannedNote { key: string; record: RecordData; path: string; settings?: string }
export interface FillPlan { library: string; createFolder: boolean; entries: PlannedNote[]; issues: string[]; template: string; legacy: boolean }
export interface CreatePlan { root: string; paths: Paths; notes: FillPlan; active: Paths; formula: string }
export interface IndexPlan { path: string; library: string; previous: string; before: string | null; formula: string }
type IndexChange =
  | { kind: 'keep'; scope?: { before: string; after: string; formula: string }; warning?: string; observed?: string }
  | { kind: 'disconnect' }
  | { kind: 'connect'; before: string; formula: string }
  | { kind: 'create' | 'replace'; file: IndexPlan };

export interface PathPlan {
  previous: Paths;
  paths: Paths;
  library?: { keys: string[]; issues: string[] };
  index: IndexChange;
}

interface ImportGroup { key: string; candidates: IndexedNote[]; targets: IndexedNote[]; newPath: string }
export interface ImportPlan { source: string; library: string; groups: ImportGroup[]; issues: string[] }
export interface ImportSelection { key: string; source: string; target: string }
function verifyPreview(approved: unknown, current: unknown): void {
  if (JSON.stringify(approved) !== JSON.stringify(current)) throw new Error('Files or settings changed since the preview. Review again.');
}

interface Known { path: string; home: string; record: RecordData }
interface State extends Paths {
  schemaVersion: 3; vault: string; noteTemplate: string;
  known: Record<string, Known>; excluded: string[];
  binding: { library: string; formula: string } | null;
  includeCore?: boolean;
  migration: Migration | null;
  sourceVersion: 0 | 1;
  sourceUpgrade: SourceUpgrade | null;
  registry: RegistryCache;
  lastRepair?: { backupDir: string; skipped: string[]; repaired: number; moved: number };
}
interface UpgradeFile { path: string; beforeHash: string; afterHash: string; moveTo?: string; create?: boolean }
interface SourceUpgrade { backupDir: string; snapshot: string; files: UpgradeFile[]; next: number; formula: string; canonical?: Record<string, Known>; skipped?: string[] }
interface UpgradePreview { files: { path: string; before: string; after: string; move?: boolean; create?: boolean }[]; changes: string[]; formula: string; canonical: Record<string, Known>; skipped: string[]; recovery?: string }
interface Migration { from: Paths; to: Paths; steps: MoveStep[]; next: number; inFlight: boolean; committed: boolean; fingerprint?: string }
interface SavedState extends Partial<Omit<State, 'schemaVersion'>> { schemaVersion?: number; root?: string; baseOverride?: string; libraryOverride?: string; initialized?: boolean; storage?: unknown }
const defaults = (): State => ({ noteTemplate: TEMPLATE, schemaVersion: 3, base: '', library: '', vault: '', known: {}, excluded: [], binding: null, includeCore: false, migration: null, sourceVersion: 1, sourceUpgrade: null, registry: { ids: [], fetchedAt: 0, attemptedAt: 0 } });
const zh = (): boolean => getLanguage().startsWith('zh');
const tr = (en: string, cn: string): string => zh() ? cn : en;
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const dateNow = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** The clickable settings entry for a record; undefined when Advanced URI is unavailable. */
const settingsLinkFor = (formula: Snapshot['settingsFormula'], record: RecordData): string | undefined =>
  formula.available ? settingsLink(formula.vault, formula.tabIds, record) : undefined;

export default class InventoryPlugin extends Plugin {
  settings: State = defaults();
  summary = 'No Plugin Library configured.';
  errors: string[] = [];
  scanner!: Scanner;
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;
  private lastPersisted = '';
  private persistQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    const saved = await this.loadData() as SavedState | null;
    const legacy = legacyLocations({ root: saved?.root ?? 'Plugins', baseOverride: saved?.baseOverride ?? '', libraryOverride: saved?.libraryOverride ?? '' });
    this.settings = { ...defaults(), ...saved, ...((saved?.schemaVersion ?? 0) >= 2 ? {} : legacy), schemaVersion: 3, known: saved?.known ?? {}, excluded: saved?.excluded ?? [], migration: saved?.migration ?? null, sourceVersion: saved?.sourceVersion ?? (saved?.initialized ? 0 : 1), sourceUpgrade: saved?.sourceUpgrade ?? null, registry: saved?.registry ?? defaults().registry };
    if (typeof this.settings.noteTemplate !== 'string') this.settings.noteTemplate = TEMPLATE;
    if (saved?.schemaVersion !== 3 && !saved?.initialized && !saved?.migration && !saved?.sourceUpgrade) {
      this.settings.base = '';
      this.settings.library = '';
    }
    // Never retain obsolete override fields in the new persisted representation.
    const migrated: SavedState = this.settings;
    delete migrated.root;
    delete migrated.baseOverride;
    delete migrated.libraryOverride;
    delete migrated.initialized;
    delete migrated.storage;
    if (this.settings.vault && this.settings.vault !== this.app.vault.getName()) {
      this.settings.known = {}; this.settings.excluded = [];
    }
    this.settings.vault = this.app.vault.getName();
    this.scanner = new Scanner(this.app);
    const settings = new InventorySettings(this.app, this);
    this.addSettingTab(settings);
    this.addRibbonIcon('list-checks', COMMANDS['open-inventory'], () => settings.run('open-inventory'));
    for (const [id, name] of Object.entries(COMMANDS)) {
      this.addCommand({ id, name, callback: () => settings.run(id as keyof typeof COMMANDS) });
    }
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.settings.migration || this.settings.sourceUpgrade) return;
      const newPath = file.path;
      void this.enqueue(() => this.followRename(oldPath, newPath)).then(() => settings.updateStatus()).catch(e => new Notice(errorText(e)));
    }));
    this.register(() => { this.stopping = true; });
    const libraryState = pathState(this.app.vault, this.settings.library);
    this.summary = libraryState === 'Ready' ? 'Plugin Library is connected.'
      : libraryState === 'Missing' ? 'Plugin Library is missing. Edit the Plugin Library path in Settings or run Fill Missing Plugin Notes.'
      : libraryState === 'Path conflict' ? 'A file occupies the Plugin Library path.'
      : 'Create a Plugin Inventory or locate an existing Library.';
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
  private formula(snapshot: Snapshot): string {
    return settingsFormula(snapshot.settingsFormula.vault, snapshot.settingsFormula.tabIds, snapshot.settingsFormula.available, this.settings.sourceVersion === 0);
  }
  async previewSourceUpgrade(restart = false, progress?: (done: number, total: number) => void): Promise<UpgradePreview> {
    if (!this.settings.library || !this.settings.base) throw new Error('Missing legacy inventory paths.');
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
      this.settings.sourceUpgrade = { backupDir, snapshot, files, next: 0, formula: preview.formula, canonical: preview.canonical, skipped: preview.skipped };
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
    this.summary = 'Legacy operation completed.';
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
      binding.library = m.to.library; m.committed = true; await this.persist();
    }
    this.settings.migration = null;
    try { await this.persist(); } catch (e) { this.settings.migration = m; throw e; }
    this.summary = 'Legacy operation completed.';
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
  private async followRename(oldPath: string, newPath: string): Promise<void> {
    const { base, library } = this.settings;
    const nextBase = base && replacementPath(base, oldPath, newPath);
    const nextLibrary = library && replacementPath(library, oldPath, newPath);
    if (nextLibrary === library && nextBase === base) return;
    if (nextLibrary) inventoryPath(nextLibrary, this.app.vault.configDir);
    if (nextBase) inventoryPath(nextBase, this.app.vault.configDir);
    await this.changePreferences({ library: nextLibrary, base: nextBase });
    this.errors = [];
    this.summary = 'Updated Plugin Inventory paths.';
    if (library !== nextLibrary) await this.tryIndexFilter();
  }

  private guardOperation(): void {
    if (this.settings.migration || this.settings.sourceUpgrade) throw new Error('Resolve the pending operation in Legacy Recovery first.');
  }

  private async changePreferences(next: Partial<State>): Promise<void> {
    const before = this.settings;
    this.settings = { ...before, ...next };
    try { await this.persist(); } catch (e) { this.settings = before; throw e; }
  }

  saveTemplate(noteTemplate: string): Promise<void> {
    return this.enqueue(() => this.changePreferences({ noteTemplate }));
  }

  saveIncludeCore(includeCore: boolean): Promise<void> {
    return this.enqueue(() => this.changePreferences({ includeCore }));
  }

  setExcluded(key: string, excluded: boolean): Promise<void> {
    return this.enqueue(() => {
      const values = new Set(this.settings.excluded);
      if (excluded) values.add(key); else values.delete(key);
      return this.changePreferences({ excluded: [...values] });
    });
  }

  private async activeSnapshot(legacy = this.settings.sourceVersion === 0): Promise<Snapshot> {
    return this.scanner.scan(Boolean(this.settings.includeCore), legacy, this.registryIds(), true);
  }

  private async planNotes(library: string, legacy: boolean, snapshot: Snapshot): Promise<FillPlan> {
    if (!snapshot.complete.core || !snapshot.complete.community) throw new Error(snapshot.errors.join('\n') || 'Plugin scan is incomplete. Try again.');
    const state = pathState(this.app.vault, library);
    if (state === 'Path conflict') throw new Error(`A file occupies the Library path: ${library}`);
    this.checkParents(library);
    const index = await indexLibrary(this.app.vault, library);
    if (index.uncertain) throw new Error(index.issues.join('\n'));
    const reserved = occupiedNotePaths(this.app.vault, library);
    const entries: PlannedNote[] = [];
    const issues = [...index.issues];
    const template = this.settings.noteTemplate ?? TEMPLATE;
    for (const [key, record] of [...snapshot.records].sort(([a], [b]) => a.localeCompare(b))) {
      if (record.status === 'uninstalled' || this.settings.excluded.includes(key) || index.notes.has(key)) continue;
      if (index.suspectIds.has(record.plugin_id)) continue;
      entries.push({ key, record, path: noteDestination(this.app.vault, library, record, reserved), settings: settingsLinkFor(snapshot.settingsFormula, record) });
    }
    return { library, createFolder: state === 'Missing', entries, issues, template, legacy };
  }

  async previewFill(): Promise<FillPlan> {
    this.guardOperation();
    if (!this.settings.library) throw new Error('Connect or create a Plugin Library in Settings first.');
    const library = inventoryPath(this.settings.library, this.app.vault.configDir);
    return this.planNotes(library, this.settings.sourceVersion === 0, await this.activeSnapshot());
  }

  private async writeNotes(plan: FillPlan, report?: Progress): Promise<void> {
    const created: string[] = [];
    try {
      if (plan.createFolder) {
        await this.parent(plan.library);
        if (this.app.vault.getAbstractFileByPath(plan.library)) throw new Error(`Destination exists: ${plan.library}`);
        await this.app.vault.createFolder(plan.library);
      }
      const date = dateNow();
      for (const entry of plan.entries) {
        if (this.stopping) throw new Error('Plugin unloaded.');
        if (this.app.vault.getAbstractFileByPath(entry.path)) throw new Error(`Destination exists: ${entry.path}`);
        report?.(`Creating ${created.length + 1}/${plan.entries.length}: ${entry.path}`);
        await this.app.vault.create(entry.path, newNote(entry.record, date, entry.settings, plan.legacy, plan.template));
        created.push(entry.path);
      }
    } catch (e) {
      throw new Error(`${errorText(e)}\nCreated ${created.length}/${plan.entries.length} notes in ${plan.library}.${created.length ? '\n' + created.join('\n') : ''}\nReview and retry to fill remaining notes.`);
    }
  }

  applyFill(approved: FillPlan, report?: Progress): Promise<void> {
    return this.enqueue(async () => {
      const fresh = await this.previewFill();
      verifyPreview(approved, fresh);
      await this.writeNotes(fresh, report);
      this.errors = fresh.issues;
      this.summary = `Created ${fresh.entries.length} plugin notes in ${fresh.library}.`;
    });
  }

  async previewCreate(root: string): Promise<CreatePlan> {
    this.guardOperation();
    const paths = defaultInventoryPaths(root, this.app.vault.configDir);
    for (const path of [paths.library, paths.base]) {
      this.checkParents(path);
      if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`Destination already exists: ${path}. Edit the inventory paths in Settings or choose another root folder.`);
    }
    const snapshot = await this.activeSnapshot(false);
    const notes = await this.planNotes(paths.library, false, snapshot);
    if (!notes.createFolder || this.app.vault.getAbstractFileByPath(paths.base)) throw new Error('The creation destination changed. Review again.');
    return { root, paths, notes, active: { library: this.settings.library, base: this.settings.base }, formula: settingsFormula(snapshot.settingsFormula.vault, snapshot.settingsFormula.tabIds, snapshot.settingsFormula.available) };
  }

  applyCreate(approved: CreatePlan, report?: Progress): Promise<void> {
    return this.enqueue(async () => {
      const preview = await this.previewCreate(approved.root);
      verifyPreview(approved, preview);
      await this.writeNotes(preview.notes, report);
      const { paths, formula } = preview;
      try {
        if (this.app.vault.getAbstractFileByPath(paths.base)) throw new Error(`Destination exists: ${paths.base}`);
        report?.(`Creating ${paths.base}`);
        await this.app.vault.create(paths.base, makeBase(paths.library, formula));
      } catch (e) {
        throw new Error(`${errorText(e)}\n${preview.notes.entries.length} notes were created in ${paths.library}. Connect that folder in Settings to use them.`);
      }
      try {
        await this.changePreferences({ ...paths, binding: { library: paths.library, formula }, sourceVersion: 1 });
      } catch (e) {
        throw new Error(`${errorText(e)}\nFiles created at ${paths.library} and ${paths.base}. Connect the Library and Index in Settings to use them.`);
      }
      this.errors = [];
      this.summary = `Created a Library with ${preview.notes.entries.length} plugin notes and an Index.`;
    });
  }

  async previewIndex(value: string): Promise<IndexPlan> {
    this.guardOperation();
    if (!this.settings.library) throw new Error('Connect or create a Plugin Library in Settings first.');
    const { base: path, library } = locations({ base: inventoryPath(value, this.app.vault.configDir), library: inventoryPath(this.settings.library, this.app.vault.configDir) }, this.app.vault.configDir);
    this.checkParents(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file && !(file instanceof TFile)) throw new Error(`Destination is not a Base file: ${path}`);
    const before = file instanceof TFile ? await this.app.vault.read(file) : null;
    const snap = await this.activeSnapshot();
    const formula = this.formula(snap);
    return { path, library, previous: this.settings.base, before, formula };
  }

  async previewPathChanges(draft: Paths): Promise<PathPlan> {
    this.guardOperation();
    const previous = { library: this.settings.library, base: this.settings.base };
    const config = this.app.vault.configDir;
    const library = inventoryPath(draft.library, config);
    const base = draft.base.trim() ? inventoryPath(draft.base, config) : '';
    const paths = base ? locations({ library, base }, config) : { library, base };
    const changedLibrary = library !== previous.library;
    const changedIndex = base !== previous.base;
    if (!changedLibrary && !changedIndex) throw new Error('There are no path changes.');
    const plan: PathPlan = { previous, paths, index: { kind: 'keep' } };
    if (changedLibrary) {
      if (pathState(this.app.vault, library) !== 'Ready') throw new Error(`Choose an existing Library folder: ${library}`);
      const current = await indexLibrary(this.app.vault, library);
      plan.library = { keys: [...current.notes.keys()], issues: current.issues };
    }

    if (changedIndex) {
      if (!base) { plan.index = { kind: 'disconnect' }; return plan; }
      this.checkParents(base);
      const file = this.app.vault.getAbstractFileByPath(base);
      if (file && !(file instanceof TFile)) throw new Error(`Destination is not a Base file: ${base}`);
      const before = file instanceof TFile ? await this.app.vault.read(file) : null;
      const compatible = before === null ? null : compatibleIndexFormula(before, library);
      if (before !== null && compatible !== null) {
        plan.index = { kind: 'connect', before, formula: compatible };
      } else {
        const formula = this.formula(await this.activeSnapshot());
        plan.index = { kind: before === null ? 'create' : 'replace', file: { path: base, library, previous: previous.base, before, formula } };
      }
    } else if (base) {
      const file = this.app.vault.getAbstractFileByPath(base);
      const binding = this.settings.binding;
      if (!(file instanceof TFile)) {
        plan.index = { kind: 'keep', warning: `The current Index needs attention: ${base}` };
      } else {
        const before = await this.app.vault.read(file);
        try {
          if (!binding) throw new Error('The Index filter is unrecognized.');
          const after = patchBase(before, binding.library, library, binding.formula, binding.formula, true);
          plan.index = { kind: 'keep', scope: { before, after, formula: binding.formula } };
        } catch (e) {
          plan.index = { kind: 'keep', observed: before, warning: `${base}: ${errorText(e)}` };
        }
      }
    }
    return plan;
  }

  applyPathChanges(approved: PathPlan, replaceExisting = false): Promise<void> {
    return this.enqueue(async () => {
      const active = { library: this.settings.library, base: this.settings.base };
      verifyPreview(approved.previous, active);
      const plan = await this.previewPathChanges(approved.paths);
      verifyPreview(approved, plan);
      const { paths, index } = plan;
      let binding = this.settings.binding;
      let backup = '';
      let wroteIndex = false;
      if (index.kind === 'disconnect') binding = null;
      if (index.kind === 'connect') {
        const file = this.app.vault.getAbstractFileByPath(paths.base);
        if (!(file instanceof TFile) || await this.app.vault.read(file) !== index.before) throw new Error('Base file changed. Review it again.');
        binding = { library: paths.library, formula: index.formula };
      }
      if (index.kind === 'create' || index.kind === 'replace') {
        if (index.kind === 'replace' && !replaceExisting) throw new Error('Explicit confirmation is required to back up and replace this Base.');
        backup = await this.writeIndexFile(index.file);
        wroteIndex = true;
        binding = { library: paths.library, formula: index.file.formula };
      }
      try {
        await this.changePreferences({ ...paths, binding });
      } catch (e) {
        if (!wroteIndex) throw e;
        throw new Error(`${errorText(e)}\nWrote ${paths.base}, but could not save the connection.${backup ? ` Backup: ${backup}` : ''}`);
      }
      this.errors = [...(plan.library?.issues ?? [])];
      this.summary = `Inventory paths saved.${backup ? ` Backup: ${backup}` : ''}`;
      if (index.kind === 'keep' && index.warning) this.errors.push(index.warning);
      if (index.kind === 'keep' && index.scope) {
        const scope = index.scope;
        try {
          if (scope.after !== scope.before) await this.process(paths.base, before => {
            if (before !== scope.before) throw new Error('Base file changed. Use Repair Index Filter.');
            return scope.after;
          });
          await this.changePreferences({ binding: { library: paths.library, formula: scope.formula } });
        } catch (e) { this.errors.push(`Plugin Index: ${errorText(e)}`); }
      }
    });
  }

  private async backupFile(path: string, text: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    const directory = `${this.app.vault.configDir}/plugins/${this.manifest?.id ?? 'plugin-inventory-peng'}/inventory-backups`;
    if (!await adapter.exists(directory)) await adapter.mkdir(directory);
    const filename = path.split('/').pop();
    const backup = `${directory}/${Date.now()}-${crypto.randomUUID()}-${filename}`;
    await adapter.write(backup, text);
    if (await adapter.read(backup) !== text) throw new Error(`Could not verify backup: ${backup}`);
    return backup;
  }

  private async writeIndexFile(plan: IndexPlan): Promise<string> {
    const text = makeBase(plan.library, plan.formula);
    let backup = '';
    if (plan.before !== null) {
      backup = await this.backupFile(plan.path, plan.before);
      try {
        await this.process(plan.path, before => {
          if (before !== plan.before) throw new Error('Base file changed. Review it again.');
          return text;
        });
      } catch (e) {
        throw new Error(`${errorText(e)}\nBackup: ${backup}`);
      }
    } else {
      await this.parent(plan.path);
      await this.app.vault.create(plan.path, text);
    }
    return backup;
  }

  applyIndex(approved: IndexPlan): Promise<void> {
    return this.enqueue(async () => {
      const plan = await this.previewIndex(approved.path);
      verifyPreview(approved, plan);
      const backup = await this.writeIndexFile(plan);
      try {
        await this.changePreferences({ base: plan.path, binding: { library: plan.library, formula: plan.formula } });
      } catch (e) {
        throw new Error(`${errorText(e)}\nWrote ${plan.path}, but could not save the connection.${backup ? ` Backup: ${backup}` : ''}`);
      }
      this.errors = [];
      this.summary = `Plugin Index set to ${plan.path}.${backup ? ` Backup: ${backup}` : ''}`;
    });
  }

  async indexWarning(): Promise<string> {
    const { base, library, binding } = this.settings;
    if (pathState(this.app.vault, base, true) !== 'Ready') return '';
    if (!binding || binding.library !== library) return 'Repair Index Filter';
    const file = this.app.vault.getAbstractFileByPath(base);
    if (!(file instanceof TFile)) return '';
    try {
      patchBase(await this.app.vault.read(file), library, library, binding.formula, binding.formula);
      return '';
    } catch (e) { return errorText(e); }
  }

  private async updateIndexFilter(): Promise<void> {
    const { base, library, binding } = this.settings;
    if (!base) throw new Error('No Plugin Index is configured.');
    if (!library) throw new Error('No Plugin Library is configured.');
    if (pathState(this.app.vault, base, true) !== 'Ready') throw new Error(`Plugin Index unavailable: ${base}`);
    if (!binding) throw new Error('The current Index filter is not recognized. Set or reset the Plugin Index.');
    // Accept a completed write if the settings save failed, but reject competing scopes.
    const patch = (current: string) => patchBase(current, binding.library, library, binding.formula, binding.formula, true);
    const file = this.app.vault.getAbstractFileByPath(base);
    if (!(file instanceof TFile)) throw new Error(`Plugin Index unavailable: ${base}`);
    const before = await this.app.vault.read(file);
    if (patch(before) !== before) await this.process(base, patch);
    if (binding.library !== library) await this.changePreferences({ binding: { ...binding, library } });
  }

  private async tryIndexFilter(): Promise<void> {
    if (!this.settings.base) return;
    try { await this.updateIndexFilter(); } catch (e) { this.errors.push(`Plugin Index: ${errorText(e)}`); }
  }

  repairIndexFilter(): Promise<void> {
    return this.enqueue(async () => {
      this.guardOperation();
      await this.updateIndexFilter();
      this.errors = [];
      this.summary = 'Plugin Index filter verified.';
    });
  }

  async refreshNotes(): Promise<void> {
    return this.enqueue(async () => {
      this.guardOperation();
      const library = this.settings.library && inventoryPath(this.settings.library, this.app.vault.configDir);
      if (!library || pathState(this.app.vault, library) !== 'Ready') throw new Error(library
        ? `Plugin Library unavailable: ${library}. Edit the path in Settings or run Fill Missing Plugin Notes.`
        : 'Connect or create a Plugin Library in Settings first.');
      if (this.settings.sourceVersion !== 0) await this.updateRegistry();
      const snap = await this.activeSnapshot();
      const index = await indexLibrary(this.app.vault, library);
      const issues = [...snap.errors, ...index.issues];
      let updated = 0;
      const date = dateNow();
      for (const [key, notes] of index.notes) {
        if (this.stopping) break;
        if (notes.length !== 1 || this.settings.excluded.includes(key)) continue;
        const [note] = notes;
        const id = identity(splitNote(note.text).data);
        if (!id || index.suspectIds.has(id.plugin_id) || !snap.complete[id.type] || (id.type === 'core' && !this.settings.includeCore)) continue;
        const observed = snap.records.get(key);
        if (!observed && id.type !== 'community') continue;
        const record: RecordData = observed ?? { ...id, name: '', version: '', status: 'uninstalled' };
        try {
          const patch = (text: string) => updateNote(text, record, date, settingsLinkFor(snap.settingsFormula, record), this.settings.sourceVersion === 0);
          if (patch(note.text) === note.text) continue;
          await this.process(note.path, patch);
          updated++;
        } catch (e) { issues.push(`${note.path}: ${errorText(e)}`); }
      }
      const missing = [...snap.records].filter(([key, r]) => snap.complete[r.type] && !index.notes.has(key)
        && !index.suspectIds.has(r.plugin_id) && !this.settings.excluded.includes(key)).length;
      this.errors = issues;
      this.summary = `Updated ${updated} notes. ${index.uncertain || !snap.complete.community || !snap.complete.core ? 'Scan incomplete.' : `${missing} missing.`}${missing ? ' Run Fill Missing Plugin Notes.' : ''}`;
    });
  }

  async previewImport(value: string): Promise<ImportPlan> {
    this.guardOperation();
    const library = inventoryPath(this.settings.library, this.app.vault.configDir);
    const source = inventoryPath(value, this.app.vault.configDir);
    if (source === library || inFolder(source, library) || inFolder(library, source)) throw new Error('Choose an old Library outside the current Library.');
    if (pathState(this.app.vault, source) !== 'Ready' || pathState(this.app.vault, library) !== 'Ready') throw new Error('Both the source and current Library must exist.');
    const [from, to] = await Promise.all([indexLibrary(this.app.vault, source), indexLibrary(this.app.vault, library)]);
    if (to.uncertain) throw new Error(to.issues.join('\n'));
    const groups: ImportGroup[] = [];
    const reserved = occupiedNotePaths(this.app.vault, library);
    for (const [key, candidates] of from.notes) {
      const id = identity(splitNote(candidates[0].text).data);
      if (!id || from.suspectIds.has(id.plugin_id) || to.suspectIds.has(id.plugin_id)) continue;
      const targets = to.notes.get(key) ?? [];
      const name = candidates[0].path.split('/').pop()!.slice(0, -3);
      groups.push({ key, candidates, targets, newPath: targets.length ? '' : noteDestination(this.app.vault, library, { ...id, name }, reserved) });
    }
    return { source, library, groups, issues: [...from.issues, ...to.issues] };
  }

  applyImport(approved: ImportPlan, selections: ImportSelection[], report?: Progress): Promise<void> {
    return this.enqueue(async () => {
      const plan = await this.previewImport(approved.source);
      verifyPreview(approved, plan);
      const selected = new Set<string>();
      for (const selection of selections) {
        const group = plan.groups.find(g => g.key === selection.key);
        if (selected.has(selection.key) || !group || !group.candidates.some(note => note.path === selection.source)
          || (group.targets.length ? !group.targets.some(note => note.path === selection.target) : selection.target !== group.newPath)) {
          throw new Error('Invalid import selection. Review the notes again.');
        }
        selected.add(selection.key);
      }
      let imported = 0;
      const failures: string[] = [], backups: string[] = [];
      for (const selection of selections) {
        if (this.stopping) break;
        const group = plan.groups.find(g => g.key === selection.key)!;
        const approvedSource = group.candidates.find(note => note.path === selection.source)!;
        const target = group.targets.find(note => note.path === selection.target);
        report?.(`Importing ${selection.source}`);
        try {
          const file = this.app.vault.getAbstractFileByPath(selection.source);
          if (!(file instanceof TFile)) throw new Error('Source no longer exists.');
          const text = await this.app.vault.read(file);
          if (text !== approvedSource.text || this.edited(file.path, text)) throw new Error('Source changed. Review it again.');
          if (target) {
            const destination = this.app.vault.getAbstractFileByPath(target.path);
            if (!(destination instanceof TFile) || await this.app.vault.read(destination) !== target.text || this.edited(target.path, target.text)) throw new Error('Destination changed. Review it again.');
            if (target.text !== text) {
              backups.push(await this.backupFile(target.path, target.text));
              await this.process(target.path, current => {
                if (current !== target.text) throw new Error('Destination changed. Review it again.');
                return text;
              });
            }
          } else await this.app.vault.create(selection.target, text);
          imported++;
        } catch (e) { failures.push(`${selection.source}: ${errorText(e)}`); }
      }
      this.errors = [...plan.issues, ...failures];
      this.summary = `Imported ${imported}/${selections.length} notes.${backups.length ? '\nBackups:\n' + backups.join('\n') : ''}`;
    });
  }

  openIndex(): Promise<void> {
    const file = this.settings.base ? this.app.vault.getAbstractFileByPath(this.settings.base) : null;
    if (!(file instanceof TFile) || file.extension !== 'base') throw new Error('Plugin Index unavailable. Set the path in Plugin Inventory Peng settings.');
    return this.app.workspace.getLeaf('tab').openFile(file);
  }
}
