import {
  AbstractInputSuggest, App, FileView, MarkdownView, Modal, Notice,
  Plugin, PluginSettingTab, Setting, TFile, TFolder, getLanguage
} from 'obsidian';
import { parseDocument } from 'yaml';
import {
  TEMPLATE, filename, identity, inFolder, keyOf, locations, makeBase, newNote,
  patchBase, settingsFormula, splitNote, updateNote,
  type Location, type Paths, type RecordData
} from './core';
import { Scanner } from './compat';

interface Known { path: string; home: string; record: RecordData }
interface State extends Location {
  schemaVersion: 1; initialized: boolean; vault: string;
  known: Record<string, Known>; excluded: string[];
  binding: { library: string; formula: string } | null;
}
const defaults = (): State => ({ schemaVersion: 1, root: 'Plugins', baseOverride: '', libraryOverride: '', initialized: false, vault: '', known: {}, excluded: [], binding: null });
const zh = (): boolean => getLanguage().startsWith('zh');
const tr = (en: string, cn: string): string => zh() ? cn : en;
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const dateNow = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

class FolderSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private input: HTMLInputElement) { super(app, input); }
  getSuggestions(query: string): string[] {
    return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder)
      .map(f => f.path).filter(p => p !== '/' && p.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  }
  renderSuggestion(value: string, el: HTMLElement): void { el.setText(value); }
  selectSuggestion(value: string): void { this.input.value = value; this.input.dispatchEvent(new Event('input')); this.close(); }
}

export default class InventoryPlugin extends Plugin {
  settings: State = defaults();
  summary = tr('Not initialized', '尚未创建清单');
  errors: string[] = [];
  pending: string[] = [];
  scanner!: Scanner;
  private queue: Promise<void> = Promise.resolve();
  private busy = false;
  private stopping = false;
  private timer: number | null = null;
  private prompted = '';
  private missingOpen = false;
  private lastPersisted = '';

  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<State> | null;
    this.settings = { ...defaults(), ...saved, known: saved?.known ?? {}, excluded: saved?.excluded ?? [] };
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
      const newPath = file.path;
      void this.enqueue(() => this.trackRename(oldPath, newPath));
    }));
    this.register(() => { this.stopping = true; this.stopPolling(); });
    this.app.workspace.onLayoutReady(() => {
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
    if (text !== this.lastPersisted) { await this.saveData(this.settings); this.lastPersisted = text; }
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
  async initialize(draft: Location): Promise<void> {
    return this.enqueue(async () => {
      const paths = locations(draft, this.app.vault.configDir);
      if (this.settings.initialized) {
        const active = this.paths();
        if (paths.base !== active.base || paths.library !== active.library) {
          throw new Error(tr('Stage version: move the existing inventory in Obsidian File Explorer; it will follow the move. Settings-driven migration is not yet enabled.', '阶段版请通过 Obsidian 文件列表移动已有清单，插件会跟踪路径；设置驱动的迁移尚未开放。'));
        }
      }
      const existing = this.app.vault.getAbstractFileByPath(paths.base);
      if (existing && !this.settings.binding) throw new Error(tr('An existing Base needs a different new Base path; it will not be overwritten.', '此位置已有 Base，请为新清单选择其他 Base 路径；不会覆盖现有文件。'));
      const snapshot = await this.scanner.scan();
      if (!snapshot.complete.core || !snapshot.complete.community) throw new Error(snapshot.errors.join('\n'));
      if (!snapshot.records.get('core:bases') || snapshot.records.get('core:bases')?.status !== 'enabled') throw new Error(tr('Enable the Bases core plugin first.', '请先手动启用官方 Bases 插件。'));
      await this.mkdir(paths.library); await this.parent(paths.base);
      const formula = settingsFormula(snapshot.settingsFormula.vault, snapshot.settingsFormula.tabIds, snapshot.settingsFormula.available);
      if (!existing) await this.app.vault.create(paths.base, makeBase(paths.library, formula));
      this.settings = { ...this.settings, ...draft, initialized: true, binding: this.settings.binding ?? { library: paths.library, formula } };
      await this.persist();
      await this.sync();
    });
  }
  async refresh(showNotice = false): Promise<void> {
    if (!this.settings.initialized) { if (showNotice) new Notice(tr('Choose storage paths in settings and create the inventory first.', '请先在设置中选择保存位置并创建清单。')); return; }
    if (this.busy) return this.queue;
    this.busy = true;
    try {
      await this.enqueue(() => this.sync());
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
    const snapshot = await this.scanner.scan();
    const issues = [...snapshot.errors];
    const notes = new Map<string, { path: string; text: string; data: any }[]>();
    let indexComplete = true;
    for (const file of this.app.vault.getMarkdownFiles().filter(f => inFolder(f.path, paths.library))) {
      try {
        const text = await this.app.vault.read(file);
        const n = splitNote(text); const id = identity(n.data);
        if (!id) continue;
        const key = keyOf(id); const group = notes.get(key) ?? [];
        group.push({ path: file.path, text, data: n.data }); notes.set(key, group);
      } catch (e) { indexComplete = false; issues.push(`${file.path}: ${errorText(e)}`); }
    }
    const date = dateNow(); let created = 0, updated = 0;
    for (const [key, group] of notes) {
      if (group.length !== 1) { issues.push(`Duplicate identity: ${key}`); continue; }
      const note = group[0];
      this.settings.excluded = this.settings.excluded.filter(k => k !== key);
      const source = snapshot.records.get(key);
      const old = identity(note.data)!;
      let record: RecordData = source ?? {
        ...old, name: typeof note.data.name === 'string' ? note.data.name : old.plugin_id,
        version: typeof note.data.version === 'string' ? note.data.version : '',
        status: note.data.status === 'enabled' ? 'enabled' : note.data.status === 'disabled' ? 'disabled' : 'uninstalled'
      };
      if (!source && old.type === 'community' && snapshot.complete.community) record = { ...record, status: 'uninstalled' };
      const canUpdate = source ? snapshot.complete[source.type] : old.type === 'community' && snapshot.complete.community;
      this.settings.known[key] = { path: note.path, home: note.path, record };
      if (canUpdate && updateNote(note.text, record, date) !== note.text) {
        try {
          await this.process(note.path, current => updateNote(current, record, date)); updated++;
        } catch (e) { issues.push(errorText(e)); }
      }
    }
    // Never create around a malformed/unfinished note or an already known missing identity.
    if (indexComplete) for (const [key, record] of snapshot.records) {
      if (!snapshot.complete[record.type] || notes.has(key) || this.settings.excluded.includes(key) || this.settings.known[key]) continue;
      const path = await this.availableNotePath(record);
      await this.app.vault.create(path, newNote(record, date));
      this.settings.known[key] = { path, home: path, record }; created++;
    }
    this.pending = indexComplete ? Object.keys(this.settings.known).filter(k => !notes.has(k) && !this.settings.excluded.includes(k)
      && !this.app.vault.getAbstractFileByPath(this.settings.known[k].path)?.path.startsWith(`${paths.library}/`)) : [];
    // A deleted file keeps its old Library path, so also include absent known files.
    if (indexComplete) for (const [key, known] of Object.entries(this.settings.known)) {
      if (!notes.has(key) && !this.settings.excluded.includes(key) && !this.app.vault.getAbstractFileByPath(known.path) && !this.pending.includes(key)) this.pending.push(key);
    }
    const base = this.app.vault.getAbstractFileByPath(paths.base);
    if (base instanceof TFile && this.settings.binding) {
      const formula = settingsFormula(snapshot.settingsFormula.vault, snapshot.settingsFormula.tabIds, snapshot.settingsFormula.available);
      try {
        const before = await this.app.vault.read(base);
        const { library, formula: oldFormula } = this.settings.binding;
        const after = patchBase(before, library, paths.library, oldFormula, formula);
        if (before !== after) await this.process(base.path, current => patchBase(current, library, paths.library, oldFormula, formula));
        // Retain custom formula ownership: only claim a formula we really wrote.
        const actualFormula = parseDocument(after).getIn(['formulas', 'Settings']);
        this.settings.binding.library = paths.library;
        if (actualFormula === formula) this.settings.binding.formula = formula;
      } catch (e) { issues.push(errorText(e)); }
    } else issues.push(tr('Base file missing; restore it or use Restore default views.', 'Base 文件缺失，请恢复文件或使用“恢复默认视图”。'));
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
    const root = moved(before.root), base = moved(before.base), library = moved(before.library);
    this.settings.root = root;
    this.settings.baseOverride = base === `${root}/Plugin Inventory.base` ? '' : base;
    this.settings.libraryOverride = library === `${root}/Library` ? '' : library;
    for (const known of Object.values(this.settings.known)) {
      known.path = moved(known.path); known.home = moved(known.home);
      if (inFolder(known.path, library)) known.home = known.path;
    }
    await this.persist(); await this.sync();
  }
  private isOpen(): boolean {
    if (!this.settings.initialized) return false;
    return this.app.workspace.getLeavesOfType('bases').some(leaf => leaf.view instanceof FileView && leaf.view.file?.path === this.paths().base);
  }
  private stopPolling(): void { if (this.timer !== null) window.clearInterval(this.timer); this.timer = null; }
  private updatePolling(): void {
    if (this.stopping || !this.isOpen()) { this.stopPolling(); return; }
    if (this.timer === null) { void this.refresh(); this.timer = window.setInterval(() => { void this.refresh(); }, 3000); }
  }
  async openInventory(): Promise<void> {
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
    if (!this.pending.length) { new Notice(tr('No missing notes.', '没有缺失记录。')); return; }
    if (this.missingOpen) return;
    this.prompted = [...this.pending].sort().join('|'); this.missingOpen = true;
    new MissingModal(this, () => { this.missingOpen = false; }).open();
  }
  async resolveMissing(key: string, action: 'exclude' | 'restore'): Promise<void> {
    await this.enqueue(async () => {
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
          const snapshot = await this.scanner.scan();
          const record = snapshot.records.get(key) ?? { ...known.record, status: known.record.type === 'community' ? 'uninstalled' as const : known.record.status };
          const path = await this.availableNotePath(record);
          await this.app.vault.create(path, newNote(record, dateNow()));
          this.settings.known[key] = { path, home: path, record };
        }
        this.settings.excluded = this.settings.excluded.filter(k => k !== key);
      }
      await this.persist(); await this.sync();
    });
  }
  async unexclude(key: string): Promise<void> {
    this.settings.excluded = this.settings.excluded.filter(k => k !== key);
    await this.persist(); await this.refresh(); this.showMissing();
  }
  confirmReset(): void {
    new ConfirmModal(this.app, tr('Restore default Base views? A copy of the current Base will be kept.', '恢复默认 Base 视图？会先保留当前 Base 副本。'), async () => {
      await this.enqueue(async () => {
        const path = this.paths().base; const existing = this.app.vault.getAbstractFileByPath(path);
        const snapshot = await this.scanner.scan();
        const formula = settingsFormula(snapshot.settingsFormula.vault, snapshot.settingsFormula.tabIds, snapshot.settingsFormula.available);
        if (existing instanceof TFile) {
          const text = await this.app.vault.read(existing);
          const backup = `${path}.backup-${Date.now()}`;
          await this.app.vault.create(backup, text);
          await this.process(path, current => {
            if (current !== text) throw new Error('Base changed after backup; reset stopped');
            return makeBase(this.paths().library, formula);
          });
        } else { await this.parent(path); await this.app.vault.create(path, makeBase(this.paths().library, formula)); }
        this.settings.binding = { library: this.paths().library, formula }; await this.persist();
      });
    }).open();
  }
}

function action(promise: Promise<void>): void { void promise.catch(e => new Notice(errorText(e))); }
class ConfirmModal extends Modal {
  constructor(app: App, private message: string, private run: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('p', { text: this.message });
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
  constructor(app: App, private plugin: InventoryPlugin) { super(app, plugin); }
  display(): void {
    const el = this.containerEl; el.empty();
    const draft: Location = { root: this.plugin.settings.root, baseOverride: this.plugin.settings.baseOverride, libraryOverride: this.plugin.settings.libraryOverride };
    new Setting(el).setName(tr('Storage', '保存位置')).setHeading();
    new Setting(el).setName(tr('Inventory folder', '总目录')).addText(t => {
      t.setValue(draft.root).onChange(v => { draft.root = v; preview(); }); new FolderSuggest(this.app, t.inputEl);
    });
    const previewEl = el.createDiv({ cls: 'pip-path' });
    const preview = (): void => {
      try { const p = locations(draft, this.app.vault.configDir); previewEl.setText(`Database: ${p.base}\nNotes: ${p.library}`); }
      catch (e) { previewEl.setText(errorText(e)); }
    }; preview();
    const details = el.createEl('details'); details.createEl('summary', { text: tr('Advanced paths', '高级独立路径') });
    new Setting(details).setName(tr('Database file override', '独立 Base 路径')).setDesc(tr('Leave blank to follow the inventory folder.', '留空则随总目录自动推导。'))
      .addText(t => t.setValue(draft.baseOverride).onChange(v => { draft.baseOverride = v; preview(); }));
    new Setting(details).setName(tr('Notes folder override', '独立 Library 路径')).setDesc(tr('Leave blank to follow the inventory folder.', '留空则随总目录自动推导。'))
      .addText(t => { t.setValue(draft.libraryOverride).onChange(v => { draft.libraryOverride = v; preview(); }); new FolderSuggest(this.app, t.inputEl); });
    new Setting(el).addButton(b => b.setButtonText(tr('Create / check inventory', '创建／检查清单')).setCta().onClick(() => {
      b.setDisabled(true); action(this.plugin.initialize(draft).then(() => { new Notice(this.plugin.summary); this.display(); }).finally(() => b.setDisabled(false)));
    })).addButton(b => b.setButtonText(tr('Open inventory', '打开清单')).onClick(() => action(this.plugin.openInventory())));
    if (this.plugin.settings.initialized) el.createEl('p', { text: tr('Stage version: relocate the existing folders/Base through Obsidian File Explorer. Paths follow these moves. A transactional migration wizard is deferred.', '阶段版：请在 Obsidian 文件列表中移动已有目录或 Base，插件会跟踪新路径。事务式迁移向导留待后续。') });
    new Setting(el).setName(tr('Inventory', '清单')).setHeading();
    el.createEl('p', { text: this.plugin.summary });
    new Setting(el).addButton(b => b.setButtonText(tr('Refresh', '立即刷新')).onClick(() => action(this.plugin.refresh(true).then(() => this.display()))))
      .addButton(b => b.setButtonText(tr('Missing notes', '缺失记录')).onClick(() => this.plugin.showMissing()))
      .addButton(b => b.setButtonText(tr('Exclusions', '排除项')).onClick(() => new ExclusionsModal(this.plugin).open()));
    new Setting(el).addButton(b => b.setButtonText(tr('Restore default views', '恢复默认视图')).onClick(() => this.plugin.confirmReset()));
    el.createEl('p', { text: tr('Refreshes every 3 seconds while the Base is open. Settings links require Advanced URI; it is never installed automatically.', '清单打开期间每 3 秒检查状态。Settings 跳转需要 Advanced URI；不会自动安装。') });
    for (const message of this.plugin.errors.slice(0, 8)) el.createEl('p', { text: message, cls: 'pip-path' });
    new Setting(el).setName(tr('Note template', '笔记模板')).setHeading();
    el.createEl('p', { text: tr('Applied once to new notes. You and your AI agent own all configuration content.', '仅新建时应用一次。具体配置内容由你和 AI Agent 填写，后续同步不覆盖正文。') });
    el.createEl('pre', { text: TEMPLATE, cls: 'pip-template' });
  }
}
