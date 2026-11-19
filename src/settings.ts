import {
  AbstractInputSuggest, App, Modal, Notice, PluginSettingTab, Setting, TFolder,
  ButtonComponent, TextComponent
} from 'obsidian';
import { isMap, isSeq, parseDocument } from 'yaml';
import { INDEX_NAME, TEMPLATE, inventoryPath, type Paths } from './core';
import { pathState } from './inventory';
import type InventoryPlugin from './main';
import type { FillPlan, ImportPlan, ImportSelection, IndexPlan, PathPlan } from './main';

export const COMMANDS = {
  'open-inventory': 'Open Plugin Index',
  'refresh-inventory': 'Refresh Plugin Status',
  'manage-missing': 'Fill Missing Plugin Notes'
} as const;

const LABELS = {
  ...COMMANDS,
  'create-inventory': 'Create Plugin Inventory',
  'import-plugin-notes': 'Import Plugin Notes',
  'manage-exclusions': 'Manage Excluded Plugins',
  'reset-base-views': 'Reset Plugin Index'
} as const;
type SettingsAction = keyof typeof LABELS;
type Progress = (message: string) => void;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

class PathSuggest extends AbstractInputSuggest<string> {
  private browseAll = false;
  constructor(app: App, private input: HTMLInputElement, private choices: () => string[]) {
    super(app, input);
  }
  browse(): void {
    this.input.focus();
    this.browseAll = true;
    this.input.dispatchEvent(new Event('input'));
  }
  getSuggestions(query: string): string[] {
    if (this.browseAll) { query = ''; this.browseAll = false; }
    return this.choices().filter(path => path.toLowerCase().includes(query.toLowerCase())).slice(0, 50);
  }
  renderSuggestion(path: string, el: HTMLElement): void { el.setText(path); }
  selectSuggestion(path: string): void {
    this.input.value = path;
    this.input.dispatchEvent(new Event('input'));
    this.close();
  }
}

interface ReviewOptions<T> {
  title: string;
  description?: string;
  field?: { label: string; value: string; placeholder?: string; bases?: boolean; vaultRoot?: boolean };
  load: (value: string) => Promise<T>;
  describe: (data: T, el: HTMLElement) => boolean;
  apply: (data: T, progress: Progress) => Promise<void>;
  action: string | ((data: T) => string);
  done: () => string;
}

function folderChoices(app: App): string[] {
  return app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder && f.path !== '/').map(f => f.path).sort();
}

function indexChoices(app: App): string[] {
  return app.vault.getFiles().filter(f => f.extension === 'base').map(f => f.path).sort();
}

function renderReview<T>(app: App, el: HTMLElement, options: ReviewOptions<T>, close?: () => void): () => void {
  let revision = 0;
  let busy = false;
  let rootSelected = false;
  if (close) el.createEl('h2', { text: options.title });
  if (options.description) el.createEl('p', { text: options.description });
  let value = options.field?.value ?? '';
  let plan: T | undefined;
  let input: TextComponent | undefined;
  let browse: ButtonComponent | undefined;
  let root: ButtonComponent | undefined;
  const preview = el.createDiv({ cls: 'pip-rows' });
  const feedback = el.createDiv({ cls: 'pip-status', attr: { role: 'status' } });
  let apply: ButtonComponent;
  let review: ButtonComponent;
  const invalidate = () => {
    revision++; plan = undefined;
    preview.empty(); apply.setDisabled(true); feedback.setText('');
  };
  if (options.field) {
    const field = options.field;
    const paths = el.createDiv();
    el.insertBefore(paths, preview);
    const pathRow = new Setting(paths).setClass('pip-path-entry');
    let suggest: PathSuggest;
    pathRow.setName(field.label).addText(t => {
      input = t;
      t.setValue(value).setPlaceholder(field.placeholder ?? '').onChange(next => {
        value = next; rootSelected = false; invalidate();
      });
      t.inputEl.setAttribute('aria-label', field.label);
      suggest = new PathSuggest(app, t.inputEl, () => field.bases ? indexChoices(app) : folderChoices(app));
    }).addButton(b => { browse = b.setButtonText('Browse').onClick(() => suggest.browse()); });
    if (field.vaultRoot) pathRow.addButton(b => {
      root = b.setButtonText('Use Vault Root').onClick(() => {
        value = ''; rootSelected = true; input?.setValue(''); invalidate();
        feedback.setText('Vault root selected.');
      });
    });
  }
  const setBusy = (isBusy: boolean) => {
    busy = isBusy;
    review.setDisabled(isBusy); input?.setDisabled(isBusy); browse?.setDisabled(isBusy); root?.setDisabled(isBusy);
  };
  const render = async () => {
    if (busy) return;
    invalidate();
    if (options.field?.vaultRoot && !value.trim() && !rootSelected) {
      feedback.setText('Enter a root folder or choose Use Vault Root.');
      return;
    }
    const request = revision;
    setBusy(true); feedback.setText('Checking files…');
    try {
      const loaded = await options.load(value);
      if (request !== revision) return;
      plan = loaded;
      if (typeof options.action === 'function') apply.setButtonText(options.action(loaded));
      apply.setDisabled(!options.describe(loaded, preview));
      feedback.setText('');
    } catch (e) {
      if (request === revision) feedback.setText(messageOf(e));
    } finally { setBusy(false); }
  };
  const controls = new Setting(el)
    .addButton(b => { review = b.setButtonText('Review').onClick(() => { void render(); }); })
    .addButton(b => {
      apply = b.setButtonText(typeof options.action === 'string' ? options.action : 'Apply').setCta().setDisabled(true).onClick(async () => {
        if (!plan || busy) return;
        const approved = plan;
        plan = undefined; setBusy(true); apply.setDisabled(true);
        feedback.setText('Applying…');
        try {
          await options.apply(approved, message => feedback.setText(message));
          preview.empty();
          feedback.setText(options.done());
        } catch (e) { feedback.setText(messageOf(e)); }
        finally { setBusy(false); }
      });
    });
  if (close) controls.addButton(b => b.setButtonText('Close').onClick(close));
  if (!options.field) void render();
  return () => { revision++; plan = undefined; };
}

class ReviewModal<T> extends Modal {
  private invalidate?: () => void;

  constructor(app: App, private options: ReviewOptions<T>) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('pip-review');
    this.invalidate = renderReview(this.app, this.contentEl, this.options, () => this.close());
  }
  onClose(): void { this.invalidate?.(); }
}

function details(el: HTMLElement, title: string, lines: string[], expanded = true): void {
  if (!lines.length) return;
  const section = el.createEl('details');
  section.open = expanded;
  section.createEl('summary', { text: title });
  const rows = section.createEl('ul');
  for (const line of lines) rows.createEl('li', { text: line });
}

function showFill(plan: FillPlan, el: HTMLElement, isRepair = true): boolean {
  el.createEl('p', { text: `${plan.entries.length} notes to create in ${plan.library}.` });
  if (plan.createFolder && isRepair) el.createEl('p', { text: 'The Library folder is missing and will be created. If it was moved, edit the Plugin Library path in Settings instead.' });
  details(el, 'New files', plan.entries.map(entry => entry.path));
  details(el, 'Conflicts and skipped files', plan.issues);
  return plan.createFolder || plan.entries.length > 0;
}

function showIndex(plan: IndexPlan, el: HTMLElement): boolean {
  el.createEl('p', { text: `${plan.path}\nLibrary: ${plan.library}`, cls: 'pip-path' });
  if (plan.before === null) {
    el.createEl('p', { text: 'Create the standard Plugin Index.' });
  } else {
    el.createEl('p', { text: 'Back up and replace the entire Base, including views, filters and formulas. Embeds targeting old views may need updating.' });
    const doc = parseDocument(plan.before);
    const views = isMap(doc.contents) ? doc.get('views') : undefined;
    if (doc.errors.length || (views !== undefined && !isSeq(views))) {
      details(el, 'Unreadable Base configuration', ['The original file will be backed up and replaced in full.']);
    } else if (isSeq(views)) {
      const names = views.items.map(view => {
        const name = isMap(view) ? view.get('name') : null;
        return typeof name === 'string' ? name : 'Unnamed view';
      });
      details(el, 'Existing views', names);
    }
  }
  return true;
}

function toolbar(el: HTMLElement, label: string, cls = ''): HTMLElement {
  return el.createDiv({ cls: ['pip-toolbar', cls].filter(Boolean).join(' '), attr: { role: 'group', 'aria-label': label } });
}

function button(el: HTMLElement, label: string, handler: () => void | Promise<void>, accessibleLabel = label): ButtonComponent {
  const control = new ButtonComponent(el).setButtonText(label).onClick(handler);
  control.buttonEl.setAttribute('aria-label', accessibleLabel);
  return control;
}

let pathFieldId = 0;

function pathField(app: App, el: HTMLElement, label: string, initial: string, base: boolean, change: (value: string) => void) {
  const id = `pip-path-${++pathFieldId}`;
  const row = el.createDiv({ cls: 'pip-resource' });
  row.createEl('label', { cls: 'pip-resource-label', text: label, attr: { for: id } });
  const path = toolbar(row, label + ' path', 'pip-resource-path');
  const input = new TextComponent(path).setValue(initial)
    .setPlaceholder(base ? INDEX_NAME : 'Choose an existing folder').onChange(change);
  input.inputEl.id = id;
  input.inputEl.setAttribute('aria-label', label + ' path');
  input.inputEl.setAttribute('aria-describedby', id + '-status');
  const suggest = new PathSuggest(app, input.inputEl, () => base ? indexChoices(app) : folderChoices(app));
  const browse = button(path, 'Browse', () => suggest.browse(), 'Browse ' + label + ' paths');
  const actions = toolbar(row, label + ' actions', 'pip-resource-actions');
  const status = row.createEl('p', { cls: 'pip-path pip-resource-status', attr: { role: 'status', id: id + '-status' } });
  return { input, browse, actions, status };
}

function showPathChanges(plan: PathPlan, el: HTMLElement): string {
  el.createEl('p', { cls: 'pip-path', text: `Plugin Library: ${plan.paths.library}\nPlugin Index: ${plan.paths.base || 'Not configured'}` });
  if (plan.library) {
    el.createEl('p', { text: `${plan.library.keys.length} plugin identities found. Connecting this Library does not move or create notes.` });
    details(el, 'Library issues', plan.library.issues);
  }
  switch (plan.index.kind) {
    case 'connect':
      el.createEl('p', { text: 'Connect the existing Base and keep its contents.' });
      return 'Apply Path Changes';
    case 'disconnect':
      el.createEl('p', { text: 'Disconnect the current Base and keep the file.' });
      return 'Apply Path Changes';
    case 'keep':
      if (plan.index.warning) el.createEl('p', { text: plan.index.warning });
      else if (plan.index.scope?.before !== plan.index.scope?.after) el.createEl('p', { text: 'Update only the directory filter in the current Base.' });
      return 'Apply Path Changes';
    case 'create':
      showIndex(plan.index.file, el);
      return 'Create Index and Apply';
    case 'replace':
      showIndex(plan.index.file, el);
      return 'Back Up and Replace';
  }
}

function renderPaths(app: App, el: HTMLElement, plugin: InventoryPlugin, action: (id: Exclude<SettingsAction, 'create-inventory'>) => void, done: () => void, refreshing: () => boolean) {
  const actual = (): Paths => ({ library: plugin.settings.library, base: plugin.settings.base });
  const same = (a: Paths, b: Paths) => a.library === b.library && a.base === b.base;
  let active = actual();
  let draft = { ...active };
  let plan: PathPlan | undefined;
  let working = false;
  let warning = '';
  let statusRequest = 0;
  let review!: ButtonComponent;
  let discard!: ButtonComponent;
  let apply!: ButtonComponent;

  const invalidate = (message = '') => {
    plan = undefined;
    preview.empty(); confirmControls.hidden = true; apply.setDisabled(true);
    feedback.setText(message);
  };
  const change = (key: keyof Paths, value: string) => {
    if (working || value === draft[key]) return;
    draft[key] = value;
    invalidate();
    renderState();
  };
  const rows = el.createDiv({ cls: 'pip-resource-list' });
  const library = pathField(app, rows, 'Plugin Library', active.library, false, value => change('library', value));
  const refresh = button(library.actions, 'Refresh', () => action('refresh-inventory'), COMMANDS['refresh-inventory']);
  const fill = button(library.actions, 'Fill Missing', () => action('manage-missing'), COMMANDS['manage-missing']);
  const importNotes = button(library.actions, 'Import…', () => action('import-plugin-notes'), LABELS['import-plugin-notes']);

  const index = pathField(app, rows, 'Plugin Index', active.base, true, value => change('base', value));
  const open = button(index.actions, 'Open', () => action('open-inventory'), COMMANDS['open-inventory']);
  let repairing = false;
  const repair = button(index.actions, 'Repair Filter', async () => {
    if (repairing) return;
    repairing = true; renderState();
    try { await plugin.repairIndexFilter(); done(); }
    catch (e) { new Notice(messageOf(e)); done(); }
    finally { repairing = false; renderState(); }
  }, 'Repair Index Filter');
  const reset = button(index.actions, 'Reset…', () => action('reset-base-views'), LABELS['reset-base-views']);

  const controls = toolbar(el, 'Path changes', 'pip-draft-actions');
  const feedback = el.createEl('p', { cls: 'pip-inline-status', attr: { role: 'status' } });
  const preview = el.createDiv({ cls: 'pip-path-preview' });
  const confirmControls = toolbar(el, 'Confirm path changes', 'pip-draft-actions');

  function fieldState(raw: string, current: string, isBase: boolean): { valid: boolean; text: string; path: string } {
    if (!raw.trim()) {
      return { valid: isBase, path: '', text: isBase ? (current ? 'Disconnect the Index' : 'Optional · Not configured') : 'Choose an existing Library folder.' };
    }
    try {
      const path = inventoryPath(raw, app.vault.configDir);
      if (isBase && !path.endsWith('.base')) throw new Error('Use a .base file path.');
      const state = pathState(app.vault, path, isBase);
      if (state === 'Path conflict') throw new Error(isBase ? 'A folder occupies this Base path.' : 'A file occupies this Library path.');
      return { valid: state === 'Ready' || isBase || path === current, path,
        text: state === 'Missing' && isBase && path !== current ? 'Available · Create a Base on apply' : state };
    } catch (e) { return { valid: false, text: messageOf(e), path: raw }; }
  }

  function renderState(): void {
    const lib = fieldState(draft.library, active.library, false);
    const idx = fieldState(draft.base, active.base, true);
    const statusText = (text: string, current: string, value: string) => [
      text === 'Ready' ? '' : text,
      current !== value ? `Current: ${current || 'Not configured'}` : ''
    ].filter(Boolean).join('\n');
    const libraryMoved = lib.text === 'Missing' && lib.path === active.library;
    library.status.setText(statusText(libraryMoved ? 'Missing. Browse for the moved folder or use Fill Missing.' : lib.text, active.library, lib.path));
    const currentIndexWarning = idx.path === active.base ? warning : '';
    index.status.setText(statusText(currentIndexWarning ? 'Filter needs attention · ' + currentIndexWarning : idx.text, active.base, idx.path));
    library.input.inputEl.setAttribute('aria-invalid', String(!lib.valid && !!draft.library.trim()));
    index.input.inputEl.setAttribute('aria-invalid', String(!idx.valid && !!draft.base.trim()));

    const recovery = Boolean(plugin.settings.migration || plugin.settings.sourceUpgrade);
    const libraryState = pathState(app.vault, active.library);
    const indexState = pathState(app.vault, active.base, true);
    const busy = working || recovery;
    const dirty = !same(active, draft);
    controls.hidden = !dirty;
    review.setDisabled(busy || !lib.valid || !idx.valid || same(active, { library: lib.path, base: idx.path }));
    discard.setDisabled(working);
    refresh.setButtonText(refreshing() ? 'Refreshing…' : 'Refresh').setDisabled(busy || refreshing() || libraryState !== 'Ready');
    fill.setDisabled(busy || (libraryState !== 'Ready' && libraryState !== 'Missing'));
    importNotes.setDisabled(busy || libraryState !== 'Ready');
    open.setDisabled(working || indexState !== 'Ready');
    repair.buttonEl.hidden = indexState !== 'Ready' || !currentIndexWarning;
    repair.setDisabled(busy || repairing);
    reset.setButtonText(indexState === 'Missing' ? 'Recreate…' : 'Reset…')
      .setDisabled(busy || !active.library || (indexState !== 'Ready' && indexState !== 'Missing'));
    reset.buttonEl.setAttribute('aria-label', indexState === 'Missing' ? 'Recreate Plugin Index' : LABELS['reset-base-views']);
    for (const field of [library, index]) {
      field.input.setDisabled(working);
      field.browse.setDisabled(working);
    }
  }

  review = button(controls, 'Review Path Changes', async () => {
    if (working) return;
    invalidate('Checking paths…');
    working = true; renderState();
    const requested = { ...draft };
    try {
      const next = await plugin.previewPathChanges(requested);
      if (!same(active, next.previous) || !same(draft, requested)) return;
      plan = next;
      const label = showPathChanges(next, preview);
      apply.setButtonText(label).setDisabled(false);
      apply.buttonEl.setAttribute('aria-label', label);
      confirmControls.hidden = false;
      feedback.setText('');
    } catch (e) { feedback.setText(messageOf(e)); }
    finally { working = false; renderState(); }
  });
  discard = button(controls, 'Discard Changes', () => {
    if (working) return;
    draft = { ...active };
    library.input.setValue(draft.library); index.input.setValue(draft.base);
    invalidate(); renderState();
  }, 'Discard Path Changes');
  apply = button(confirmControls, 'Apply Path Changes', async () => {
    if (!plan || working) return;
    const approved = plan;
    invalidate('Applying paths…'); working = true; renderState();
    try {
      await plugin.applyPathChanges(approved, approved.index.kind === 'replace');
      active = actual(); draft = { ...active };
      library.input.setValue(active.library); index.input.setValue(active.base);
      done(); feedback.setText(plugin.summary);
    } catch (e) { feedback.setText(messageOf(e)); }
    finally { working = false; renderState(); }
  }).setCta().setDisabled(true);
  confirmControls.hidden = true;

  return () => {
    const saved = actual();
    if (!same(saved, active)) {
      for (const key of ['library', 'base'] as const) {
        if (draft[key] === active[key]) {
          draft[key] = saved[key];
          (key === 'library' ? library : index).input.setValue(saved[key]);
        }
      }
      active = saved;
      invalidate(same(active, draft) ? '' : 'The current paths changed. Review your draft again.');
    }
    const revision = ++statusRequest;
    warning = '';
    renderState();
    void plugin.indexWarning().then(value => {
      if (revision !== statusRequest) return;
      warning = value; renderState();
    });
  };
}

function importSelections(plan: ImportPlan, el: HTMLElement, selections: Map<string, ImportSelection>): boolean {
  selections.clear();
  details(el, 'Conflicts and skipped files', plan.issues);
  el.createEl('p', { text: 'Select notes to copy. Replacing a current note is optional and creates a backup. Original source files stay in place.' });
  for (const group of plan.groups) {
    let source = group.candidates.length === 1 ? group.candidates[0].path : '';
    let target = group.targets.length ? '' : group.newPath;
    let selected = false;
    const update = () => {
      if (selected && source && target) selections.set(group.key, { key: group.key, source, target });
      else selections.delete(group.key);
    };
    const row = new Setting(el).setName(group.key).setDesc(group.targets.length ? 'Already in current Library' : group.newPath)
      .addToggle(t => {
        t.toggleEl.setAttribute('aria-label', `Import ${group.key}`);
        t.onChange(value => { selected = value; update(); });
      });
    if (group.candidates.length > 1) row.addDropdown(d => {
      d.addOption('', 'Choose source file');
      for (const item of group.candidates) d.addOption(item.path, item.path);
      d.onChange(value => { source = value; update(); });
    });
    if (group.targets.length) row.addDropdown(d => {
      d.addOption('', 'Keep current note');
      for (const item of group.targets) d.addOption(item.path, `Replace ${item.path}`);
      d.onChange(value => { target = value; update(); });
    });
  }
  return plan.groups.length > 0;
}

export class InventorySettings extends PluginSettingTab {
  private draft?: string;
  private templateBusy = false;
  private refreshView?: () => void;
  private refreshing = false;
  private inventoryMessage = '';
  private shown = false;

  constructor(app: App, private inventory: InventoryPlugin) { super(app, inventory); }

  hide(): void {
    this.shown = false;
    this.inventoryMessage = '';
    this.draft = undefined;
    this.refreshView = undefined;
  }

  updateStatus(): void { this.refreshView?.(); }

  private reportDone(showInventoryMessage = false): string {
    const plugin = this.inventory;
    if (showInventoryMessage && this.shown) this.inventoryMessage = plugin.summary;
    this.updateStatus();
    return [plugin.summary, ...plugin.errors].join('\n');
  }

  run(id: Exclude<SettingsAction, 'create-inventory'>): void {
    const plugin = this.inventory;
    const { base } = plugin.settings;
    const done = () => this.reportDone();
    const report = (error: unknown) => { this.refreshView?.(); new Notice(messageOf(error)); };
    switch (id) {
      case 'manage-missing':
        new ReviewModal(this.app, {
          title: LABELS[id], load: () => plugin.previewFill(), describe: showFill,
          apply: (plan, progress) => plugin.applyFill(plan, progress), action: 'Fill Missing Notes', done
        }).open();
        break;
      case 'reset-base-views':
        new ReviewModal(this.app, {
          title: LABELS[id], load: () => plugin.previewIndex(base), describe: showIndex,
          apply: plan => plugin.applyIndex(plan), action: plan => plan.before === null ? 'Create Plugin Index' : 'Back Up and Reset', done
        }).open();
        break;
      case 'open-inventory':
        if (pathState(this.app.vault, base, true) !== 'Ready') {
          new Notice('Plugin Index unavailable. Set the Plugin Index path in Plugin Inventory Peng settings.');
          return;
        }
        void plugin.openIndex().catch(report);
        break;
      case 'refresh-inventory':
        if (this.refreshing) return;
        this.refreshing = true;
        this.refreshView?.();
        void plugin.refreshNotes().then(() => new Notice(this.reportDone(true)), report).finally(() => {
          this.refreshing = false; this.refreshView?.();
        });
        break;
      case 'import-plugin-notes': {
        const selections = new Map<string, ImportSelection>();
        new ReviewModal(this.app, {
          title: LABELS[id], field: { label: 'Old Library folder', value: '' },
          load: path => plugin.previewImport(path), describe: (plan, el) => importSelections(plan, el, selections),
          apply: (plan, progress) => {
            if (!selections.size) return Promise.reject(new Error('Select a source and destination for at least one note, then review again.'));
            return plugin.applyImport(plan, [...selections.values()], progress);
          },
          action: 'Import Selected Notes', done
        }).open();
        break;
      }
      case 'manage-exclusions':
        new ExclusionsModal(this.app, plugin).open();
        break;
    }
  }

  display(): void {
    this.shown = true;
    const plugin = this.inventory;
    const el = this.containerEl;
    el.empty(); el.addClass('pip-settings');
    const heading = (title: string) => new Setting(el).setName(title).setHeading();

    heading('Inventory');
    const setup = toolbar(el, 'Set up inventory', 'pip-first-setup');
    const firstCreate = el.createDiv();
    const paths = el.createDiv({ cls: 'pip-settings-paths' });
    const feedbackGroup = el.createDiv({ cls: 'pip-inventory-feedback' });
    const summary = feedbackGroup.createEl('p', { cls: 'pip-inline-status', attr: { role: 'status' } });
    const registry = feedbackGroup.createEl('p', { cls: 'pip-inline-status' });
    const issues = feedbackGroup.createDiv();
    let setupChoice: 'existing' | 'create' | undefined;
    const useExisting = button(setup, 'Use Existing Paths', () => {
      setupChoice = 'existing'; this.updateStatus(); paths.querySelector('input')?.focus();
    });
    const createNew = button(setup, LABELS['create-inventory'], () => {
      setupChoice = 'create'; this.updateStatus(); firstCreate.querySelector('input')?.focus();
    });
    const updatePaths = renderPaths(this.app, paths, plugin, id => this.run(id), () => this.updateStatus(), () => this.refreshing);

    heading('Note Template');
    el.createEl('p', { cls: 'pip-help', text: 'Markdown for new notes. Leave blank for an empty body.' });
    const editor = el.createEl('textarea', { cls: 'pip-template', attr: { 'aria-label': 'Note Template', rows: '5' } });
    editor.value = this.draft ?? plugin.settings.noteTemplate;
    const templateActions = toolbar(el, 'Note template actions', 'pip-draft-actions');
    const feedback = el.createEl('p', { cls: 'pip-inline-status', attr: { role: 'status' } });
    const updateDraft = (value: string, message = '') => {
      this.draft = value;
      const changed = value !== plugin.settings.noteTemplate;
      resetTemplate.buttonEl.hidden = value === TEMPLATE;
      save.buttonEl.hidden = !changed;
      discard.buttonEl.hidden = !changed;
      templateActions.hidden = resetTemplate.buttonEl.hidden && !changed;
      for (const control of [save, resetTemplate, discard]) control.setDisabled(this.templateBusy);
      feedback.setText(message || (changed ? 'Unsaved changes.' : ''));
    };
    editor.addEventListener('input', () => updateDraft(editor.value));
    const save = button(templateActions, 'Save Template', async () => {
      const value = editor.value;
      if (this.templateBusy) return;
      this.templateBusy = true; editor.disabled = true;
      updateDraft(value, 'Saving template…');
      let result: string;
      try {
        await plugin.saveTemplate(value);
        result = 'Template saved.';
      } catch (e) { result = messageOf(e); }
      finally { this.templateBusy = false; editor.disabled = false; }
      updateDraft(value, result);
    }).setCta();
    const resetTemplate = button(templateActions, 'Reset to Default', () => {
      editor.value = TEMPLATE; updateDraft(editor.value);
    });
    const discard = button(templateActions, 'Discard Changes', () => {
      editor.value = plugin.settings.noteTemplate; updateDraft(editor.value);
    }, 'Discard Template Changes');
    updateDraft(editor.value);

    heading('Preferences');
    new Setting(el).setName('Include Obsidian core plugins').addToggle(t => t.setValue(Boolean(plugin.settings.includeCore)).onChange(async value => {
      t.setDisabled(true);
      try { await plugin.saveIncludeCore(value); }
      catch (e) { t.setValue(Boolean(plugin.settings.includeCore)); new Notice(messageOf(e)); }
      finally { t.setDisabled(false); }
    })).setClass('pip-preferences').addButton(b => b.setButtonText('Manage Exclusions…').onClick(() => this.run('manage-exclusions')));

    const create = el.createEl('details', { cls: 'pip-create' });
    create.createEl('summary', { text: LABELS['create-inventory'] + '…' });
    const createForm = create.createDiv({ cls: 'pip-review-inline' });
    renderReview(this.app, createForm, {
      title: LABELS['create-inventory'],
      description: 'Creates a new Library and Index and makes them current. Existing inventory files stay where they are.',
      field: { label: 'Root folder', value: '', placeholder: 'Enter or select a folder', vaultRoot: true },
      load: root => plugin.previewCreate(root),
      describe: (plan, preview) => {
        preview.createEl('p', { text: `Plugin Library: ${plan.paths.library}\nPlugin Index: ${plan.paths.base}`, cls: 'pip-path' });
        return showFill(plan.notes, preview, false);
      },
      apply: (plan, progress) => plugin.applyCreate(plan, progress),
      action: 'Create and Use',
      done: () => { create.open = false; return this.reportDone(true); }
    });

    const recovery = el.createDiv({ cls: 'pip-recovery' });
    this.refreshView = () => {
      summary.setText(this.refreshing ? 'Scanning and updating plugin notes…' : this.inventoryMessage);
      registry.setText(plugin.registryIssue ? 'Community directory: ' + plugin.registryIssue : '');
      issues.empty(); details(issues, 'Issues', plugin.errors, false);
      feedbackGroup.hidden = !summary.textContent && !registry.textContent && !plugin.errors.length;
      const settings = plugin.settings;
      const configured = Boolean(settings.library);
      setup.hidden = configured;
      paths.hidden = !configured && setupChoice !== 'existing';
      firstCreate.hidden = configured || setupChoice !== 'create';
      create.hidden = !configured;
      const createParent = configured ? create : firstCreate;
      if (createForm.parentElement !== createParent) createParent.appendChild(createForm);
      useExisting.buttonEl.setAttribute('aria-pressed', String(setupChoice === 'existing'));
      createNew.buttonEl.setAttribute('aria-pressed', String(setupChoice === 'create'));
      updatePaths();
      recovery.empty();
      recovery.hidden = !settings.migration && !settings.sourceUpgrade;
      if (recovery.hidden) return;
      new Setting(recovery).setName('Legacy Recovery').setHeading();
      const migration = settings.migration;
      const repair = settings.sourceUpgrade;
      if (migration) {
        const next = migration.steps[migration.next];
        recovery.createEl('p', { text: `Completed ${migration.next}/${migration.steps.length} moves.${next ? ` Next: ${next.from} to ${next.to}.` : ''}` });
        this.recoveryAction(recovery, 'Continue Legacy Move', () => plugin.recoverMigration());
      } else if (repair) {
        recovery.createEl('p', { text: `Completed ${repair.next}/${repair.files.length} files. Backup: ${repair.backupDir}` });
        this.recoveryAction(recovery, 'Continue Legacy Repair', () => plugin.recoverSourceUpgrade());
        new Setting(recovery).addButton(b => b.setButtonText('Review Legacy Repair').onClick(() => {
          new ReviewModal(this.app, {
            title: 'Review Legacy Repair', load: () => plugin.previewSourceUpgrade(true),
            describe: (p, preview) => { details(preview, 'Changes', p.changes); details(preview, 'Files', p.files.map(f => f.path)); details(preview, 'Skipped', p.skipped); return true; },
            apply: (p, progress) => plugin.startSourceUpgrade(p, progress), action: 'Resume with Updated Plan', done: () => this.reportDone()
          }).open();
        }));
      }
    };
    this.refreshView();
  }

  private recoveryAction(parent: HTMLElement, label: string, run: () => Promise<void>): void {
    new Setting(parent).addButton(b => b.setButtonText(label).onClick(async () => {
      b.setDisabled(true);
      try { await run(); } catch (e) { new Notice(messageOf(e)); }
      finally { this.refreshView?.(); b.setDisabled(false); }
    }));
  }
}

class ExclusionsModal extends Modal {
  constructor(app: App, private plugin: InventoryPlugin) { super(app); }
  onOpen(): void { this.render(); }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: LABELS['manage-exclusions'] });
    let key = '';
    const update = async (value: string, excluded: boolean) => {
      try {
        if (!/^(?:core|community):[^\s:]+$/.test(value)) throw new Error('Enter a key such as community:templater-obsidian or core:canvas.');
        await this.plugin.setExcluded(value, excluded);
        this.render();
      } catch (e) { new Notice(messageOf(e)); }
    };
    new Setting(this.contentEl).setName('Plugin identity')
      .addText(t => t.setPlaceholder('community:plugin-id').onChange(value => { key = value.trim(); }))
      .addButton(b => b.setButtonText('Exclude').onClick(() => update(key, true)));
    for (const item of this.plugin.settings.excluded) {
      new Setting(this.contentEl).setName(item).addButton(b => b.setButtonText('Remove Exclusion').onClick(() => update(item, false)));
    }
  }
}
