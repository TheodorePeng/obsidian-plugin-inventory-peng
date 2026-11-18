import {
  AbstractInputSuggest, App, Modal, Notice, PluginSettingTab, Setting, TFolder,
  type ButtonComponent, type TextComponent
} from 'obsidian';
import { isMap, isSeq, parseDocument } from 'yaml';
import { INDEX_NAME, TEMPLATE } from './core';
import { pathState } from './inventory';
import type InventoryPlugin from './main';
import type { FillPlan, ImportPlan, ImportSelection, IndexPlan } from './main';

export const COMMANDS = {
  'create-inventory': 'Create Plugin Inventory',
  'open-inventory': 'Open Plugin Index',
  'refresh-inventory': 'Refresh Plugin Status',
  'manage-missing': 'Fill Missing Plugin Notes',
  'locate-library': 'Locate Plugin Library',
  'set-plugin-index': 'Set Plugin Index',
  'import-plugin-notes': 'Import Plugin Notes',
  'manage-exclusions': 'Manage Excluded Plugins',
  'reset-base-views': 'Reset Plugin Index'
} as const;

type Command = keyof typeof COMMANDS;
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
  field?: { label: string; value: string; placeholder?: string; bases?: boolean };
  load: (value: string) => Promise<T>;
  describe: (data: T, el: HTMLElement) => boolean;
  apply: (data: T, progress: Progress) => Promise<void>;
  action: string | ((data: T) => string);
  done: () => string;
}

class ReviewModal<T> extends Modal {
  private revision = 0;
  private pending = false;

  constructor(app: App, private options: ReviewOptions<T>) { super(app); }

  onOpen(): void {
    const options = this.options;
    this.contentEl.addClass('pip-review');
    this.contentEl.createEl('h2', { text: options.title });
    if (options.description) this.contentEl.createEl('p', { text: options.description });
    let value = options.field?.value ?? '';
    let plan: T | undefined;
    let input: TextComponent | undefined;
    let browse: ButtonComponent | undefined;
    const pathRow = new Setting(this.contentEl).setClass('pip-path-entry');
    if (options.field) {
      const field = options.field;
      let suggest: PathSuggest;
      pathRow.setName(field.label).addText(t => {
        input = t;
        t.setValue(value).setPlaceholder(field.placeholder ?? '')
          .onChange(next => {
            value = next; this.revision++; plan = undefined;
            preview.empty(); apply.setDisabled(true); feedback.setText('');
          });
        t.inputEl.setAttribute('aria-label', field.label);
        suggest = new PathSuggest(this.app, t.inputEl, () => field.bases
          ? this.app.vault.getFiles().filter(f => f.extension === 'base').map(f => f.path).sort()
          : this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder && f.path !== '/').map(f => f.path).sort());
      }).addButton(b => {
        browse = b.setButtonText('Browse').onClick(() => suggest.browse());
      });
    } else pathRow.settingEl.remove();
    const preview = this.contentEl.createDiv({ cls: 'pip-rows' });
    const feedback = this.contentEl.createDiv({ cls: 'pip-status', attr: { role: 'status' } });
    let apply: ButtonComponent;
    let review: ButtonComponent;
    const busy = (value: boolean) => {
      this.pending = value;
      review.setDisabled(value); input?.setDisabled(value); browse?.setDisabled(value);
    };
    const render = async () => {
      if (this.pending) return;
      const revision = ++this.revision;
      busy(true); apply.setDisabled(true); plan = undefined;
      preview.empty(); feedback.setText('Checking files…');
      try {
        const loaded = await options.load(value);
        if (revision !== this.revision) return;
        plan = loaded;
        if (typeof options.action === 'function') apply.setButtonText(options.action(loaded));
        apply.setDisabled(!options.describe(loaded, preview));
        feedback.setText('');
      } catch (e) {
        if (revision === this.revision) feedback.setText(messageOf(e));
      } finally { busy(false); }
    };
    new Setting(this.contentEl)
      .addButton(b => { review = b.setButtonText('Review').onClick(() => { void render(); }); })
      .addButton(b => {
        apply = b.setButtonText(typeof options.action === 'string' ? options.action : 'Apply').setCta().setDisabled(true).onClick(async () => {
          if (!plan || this.pending) return;
          const approved = plan;
          plan = undefined; busy(true); apply.setDisabled(true);
          feedback.setText('Applying…');
          try {
            await options.apply(approved, message => feedback.setText(message));
            preview.empty();
            feedback.setText(options.done());
          } catch (e) { feedback.setText(messageOf(e)); }
          finally { busy(false); }
        });
      })
      .addButton(b => b.setButtonText('Close').onClick(() => this.close()));
    if (!options.field) void render();
  }

  onClose(): void { this.revision++; }
}

function details(el: HTMLElement, title: string, lines: string[]): void {
  if (!lines.length) return;
  const section = el.createEl('details', { attr: { open: '' } });
  section.createEl('summary', { text: title });
  const rows = section.createEl('ul');
  for (const line of lines) rows.createEl('li', { text: line });
}

function showFill(plan: FillPlan, el: HTMLElement): boolean {
  el.createEl('p', { text: `${plan.entries.length} notes to create in ${plan.library}.` });
  if (plan.createFolder) el.createEl('p', { text: 'The Library folder is missing and will be created. If it was moved, use Locate Plugin Library instead.' });
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
  private shown = false;

  constructor(app: App, private inventory: InventoryPlugin) { super(app, inventory); }

  hide(): void {
    this.shown = false;
    this.draft = undefined;
    this.refreshView = undefined;
  }

  updateStatus(): void { this.refreshView?.(); }

  private reportDone(): string {
    this.updateStatus();
    const plugin = this.inventory;
    return [plugin.summary, ...plugin.errors].join('\n');
  }

  run(id: Command): void {
    const plugin = this.inventory;
    const { library, base } = plugin.settings;
    const done = () => this.reportDone();
    const report = (error: unknown) => { this.refreshView?.(); new Notice(messageOf(error)); };
    switch (id) {
      case 'create-inventory':
        new ReviewModal(this.app, {
          title: COMMANDS[id],
          description: 'Create Plugin Library, its Markdown notes, and Plugin Index.base. A successful creation becomes the current inventory.',
          field: { label: 'Root folder', value: '', placeholder: 'Vault root' },
          load: path => plugin.previewCreate(path),
          describe: (plan, el) => {
            el.createEl('p', { text: `Index: ${plan.paths.base}`, cls: 'pip-path' });
            return showFill(plan.notes, el);
          },
          apply: (plan, progress) => plugin.applyCreate(plan, progress), action: 'Create', done
        }).open();
        break;
      case 'manage-missing':
        new ReviewModal(this.app, {
          title: COMMANDS[id], load: () => plugin.previewFill(), describe: showFill,
          apply: (plan, progress) => plugin.applyFill(plan, progress), action: 'Fill Missing Notes', done
        }).open();
        break;
      case 'locate-library':
        new ReviewModal(this.app, {
          title: COMMANDS[id], field: { label: 'Existing folder', value: library },
          description: 'Choose an existing folder in this Vault. Its files stay where they are.',
          load: path => plugin.previewLocate(path),
          describe: (plan, el) => {
            el.createEl('p', { text: `${plan.path}\n${plan.keys.length} plugin identities found.`, cls: 'pip-path' });
            details(el, 'Conflicts and scan issues', plan.issues); return true;
          },
          apply: plan => plugin.applyLocate(plan), action: 'Connect Library', done
        }).open();
        break;
      case 'set-plugin-index':
      case 'reset-base-views': {
        const reset = id === 'reset-base-views';
        new ReviewModal(this.app, {
          title: COMMANDS[id],
          field: reset ? undefined : { label: 'Base path', value: base || INDEX_NAME, bases: true },
          description: reset ? undefined : 'Select an existing Base or enter a new .base path.',
          load: path => plugin.previewIndex(reset ? base : path), describe: showIndex,
          apply: plan => plugin.applyIndex(plan), action: plan => plan.before === null ? 'Create Plugin Index' : reset ? 'Back Up and Reset' : 'Back Up and Replace', done
        }).open();
        break;
      }
      case 'open-inventory':
        if (pathState(this.app.vault, base, true) !== 'Ready') {
          new Notice('Plugin Index unavailable. Choose a Base to continue.');
          this.run('set-plugin-index'); return;
        }
        void plugin.openIndex().catch(report);
        break;
      case 'refresh-inventory':
        if (this.refreshing) return;
        this.refreshing = true;
        this.refreshView?.();
        void plugin.refreshNotes().then(() => new Notice(done()), report).finally(() => {
          this.refreshing = false; this.refreshView?.();
        });
        break;
      case 'import-plugin-notes': {
        const selections = new Map<string, ImportSelection>();
        new ReviewModal(this.app, {
          title: COMMANDS[id], field: { label: 'Old Library folder', value: '' },
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
    const actions = (ids: Command[]) => {
      const row = new Setting(el).setClass('pip-actions');
      for (const id of ids) row.addButton(b => b.setButtonText(COMMANDS[id]).onClick(() => this.run(id)));
      return row;
    };

    heading('Inventory');
    const summary = el.createEl('p', { cls: 'pip-summary', attr: { role: 'status' } });
    const registry = el.createEl('p', { cls: 'pip-help' });
    const issues = el.createDiv();
    actions(['create-inventory', 'refresh-inventory']);

    heading('Plugin Library');
    const library = el.createEl('p', { cls: 'pip-path' });
    actions(['locate-library', 'manage-missing', 'import-plugin-notes']);

    heading('Plugin Index');
    const index = el.createEl('p', { cls: 'pip-path' });
    actions(['set-plugin-index', 'open-inventory', 'reset-base-views'])
      .addButton(b => b.setButtonText('Repair Index Filter').onClick(async () => {
        try { await plugin.repairIndexFilter(); this.reportDone(); }
        catch (e) { new Notice(messageOf(e)); this.refreshView?.(); }
      }));

    heading('Note Template');
    el.createEl('p', { cls: 'pip-help', text: 'Markdown body for newly created notes. Existing notes and their properties are unaffected. Leave blank for an empty body.' });
    const editor = el.createEl('textarea', { cls: 'pip-template', attr: { 'aria-label': 'Note Template', rows: '9' } });
    editor.value = this.draft ?? plugin.settings.noteTemplate;
    let save: ButtonComponent;
    const feedback = el.createEl('p', { cls: 'pip-status', attr: { role: 'status' } });
    const updateDraft = (value: string) => {
      this.draft = value;
      const changed = value !== plugin.settings.noteTemplate;
      save.setDisabled(!changed || this.templateBusy);
      feedback.setText(changed ? 'Unsaved changes.' : '');
    };
    editor.addEventListener('input', () => updateDraft(editor.value));
    new Setting(el).setClass('pip-actions').addButton(b => {
      save = b.setButtonText('Save Template').setCta().onClick(async () => {
        const value = editor.value;
        if (this.templateBusy) return;
        this.templateBusy = true; editor.disabled = true; b.setDisabled(true);
        try {
          await plugin.saveTemplate(value);
          if (this.shown) this.draft = undefined;
          editor.value = value;
          feedback.setText('Template saved.');
        } catch (e) { feedback.setText(messageOf(e)); }
        finally {
          this.templateBusy = false; editor.disabled = false;
          b.setDisabled(editor.value === plugin.settings.noteTemplate);
        }
      });
    }).addButton(b => b.setButtonText('Reset to Default').onClick(() => {
      if (!this.templateBusy) { editor.value = TEMPLATE; updateDraft(editor.value); }
    })).addButton(b => b.setButtonText('Discard Changes').onClick(() => {
      if (!this.templateBusy) { editor.value = plugin.settings.noteTemplate; updateDraft(editor.value); }
    }));
    updateDraft(editor.value);

    heading('Preferences');
    new Setting(el).setName('Include Obsidian core plugins').addToggle(t => t.setValue(Boolean(plugin.settings.includeCore)).onChange(async value => {
      t.setDisabled(true);
      try { await plugin.saveIncludeCore(value); }
      catch (e) { t.setValue(Boolean(plugin.settings.includeCore)); new Notice(messageOf(e)); }
      finally { t.setDisabled(false); }
    }));
    actions(['manage-exclusions']);

    const recovery = el.createDiv({ cls: 'pip-recovery' });
    let statusRevision = 0;
    this.refreshView = () => {
      summary.setText(this.refreshing ? 'Scanning and updating plugin notes…' : plugin.summary);
      registry.setText(plugin.registryStatus());
      issues.empty(); details(issues, 'Issues', plugin.errors);
      const settings = plugin.settings;
      library.setText(`${pathState(this.app.vault, settings.library)}${settings.library ? ' · ' + settings.library : ''}`);
      const indexState = pathState(this.app.vault, settings.base, true);
      const revision = ++statusRevision;
      index.setText(`${indexState}${settings.base ? ' · ' + settings.base : ''}`);
      void plugin.indexWarning().then(warning => {
        if (warning && revision === statusRevision && this.shown) index.setText(`Filter needs attention · ${settings.base}\n${warning}`);
      });
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
    this.contentEl.createEl('h2', { text: COMMANDS['manage-exclusions'] });
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
