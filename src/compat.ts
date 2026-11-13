import type { App } from 'obsidian';
import { keyOf, type RecordData, type Kind, type Source } from './core';
import { classify } from './registry';

export interface Snapshot {
  records: Map<string, RecordData>;
  complete: Record<Kind, boolean>;
  errors: string[];
  settingsFormula: { vault: string; tabIds: string[]; available: boolean };
  basesEnabled: boolean;
}
/** All access to non-public Obsidian members is confined to this adapter. */
export class Scanner {
  private cache = new Map<string, { mtime: number; size: number; value: any }>();
  constructor(private app: App) {}
  async scan(includeCore = false, legacy = false, registry: ReadonlySet<string> | null = null, includeDisabledCore = false): Promise<Snapshot> {
    const runtime = this.app as any;
    const core = runtime.internalPlugins?.plugins;
    const basesPlugin = core?.['bases'];
    const basesEnabled = typeof basesPlugin?.enabled === 'boolean' ? basesPlugin.enabled : false;
    const result: Snapshot = {
      records: new Map(), complete: { core: true, community: true }, errors: [],
      settingsFormula: { vault: typeof runtime.appId === 'string' ? runtime.appId : this.app.vault.getName(), tabIds: [], available: false },
      basesEnabled
    };
    const enabled: unknown = runtime.plugins?.enabledPlugins;
    if (!(enabled instanceof Set)) { result.complete.community = false; result.errors.push('Community plugin state API unavailable'); }
    if (includeCore) {
      if (!core || typeof core !== 'object' || !Object.keys(core).length) {
        result.complete.core = false; result.errors.push('Core plugin state API unavailable');
      } else {
        for (const [id, item] of Object.entries<any>(core)) {
          if (typeof item.enabled !== 'boolean' || typeof item.instance?.name !== 'string') {
            result.complete.core = false; result.errors.push(`Core metadata unavailable: ${id}`); continue;
          }
          if (!item.enabled && !includeDisabledCore) continue;
          const record: RecordData = {
            plugin_id: id,
            name: item.instance.name,
            type: 'core',
            source: legacy ? 'builtin' : 'Built-in',
            status: item.enabled ? 'enabled' : 'disabled',
            version: '',
            author: 'Obsidian',
            github: 'https://obsidian.md'
          };
          result.records.set(keyOf(record), record);
        }
      }
    }
    try {
      const adapter = this.app.vault.adapter;
      let bratRepos: string[] = [];
      try {
        const bratPath = `${this.app.vault.configDir}/plugins/obsidian42-brat/data.json`;
        if (await adapter.exists(bratPath)) {
          const raw = await adapter.read(bratPath);
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed?.pluginList)) bratRepos = parsed.pluginList;
        }
      } catch { /* ignore if BRAT absent */ }

      const root = `${this.app.vault.configDir}/plugins`;
      const dirs = (await adapter.list(root)).folders;
      for (const dir of dirs) {
        const path = `${dir}/manifest.json`;
        try {
          const stat = await adapter.stat(path);
          if (!stat || stat.type !== 'file') throw new Error('missing manifest');
          let cached = this.cache.get(path);
          if (!cached || cached.mtime !== stat.mtime || cached.size !== stat.size) {
            cached = { mtime: stat.mtime, size: stat.size, value: JSON.parse(await adapter.read(path)) };
            this.cache.set(path, cached);
          }
          const m = cached.value;
          if (typeof m.id !== 'string' || !m.id || typeof m.name !== 'string' || typeof m.version !== 'string') throw new Error('invalid manifest');
          if (!(enabled instanceof Set)) continue;

          const author = typeof m.author === 'string' ? m.author : '';
          let github = '';
          if (typeof m.authorUrl === 'string' && m.authorUrl.includes('github.com')) github = m.authorUrl.replace(/\/$/, '');
          if (!github && typeof m.fundingUrl === 'string' && m.fundingUrl.includes('github.com')) {
            const match = m.fundingUrl.match(/github\.com\/sponsors\/([^/]+)/);
            if (match) github = `https://github.com/${match[1]}`;
          }

          let source: Source = 'official';
          const bratRepo = bratRepos.find(r => typeof r === 'string' && (r.toLowerCase().endsWith(`/${m.id}`) || r.toLowerCase().includes(m.id.toLowerCase())));
          if (bratRepo) {
            github = `https://github.com/${bratRepo}`;
            if (bratRepo.toLowerCase().includes('theodorepeng') || author.toLowerCase().includes('peng')) {
              source = 'self-developed';
            } else {
              source = 'brat';
            }
          } else if (author.toLowerCase().includes('peng') || (github && github.toLowerCase().includes('theodorepeng'))) {
            source = 'self-developed';
          }
          if (!legacy) source = classify('community', m.id, registry);

          const record: RecordData = {
            plugin_id: m.id,
            name: m.name,
            type: 'community',
            source,
            status: enabled.has(m.id) ? 'enabled' : 'disabled',
            version: m.version,
            author,
            github
          };
          const key = keyOf(record);
          if (result.records.has(key)) throw new Error('duplicate manifest identity');
          result.records.set(key, record);
        } catch {
          result.complete.community = false;
          result.errors.push(`Could not completely scan ${dir.split('/').pop()}`);
        }
      }
    } catch {
      result.complete.community = false; result.errors.push('Community plugin directory unavailable');
    }
    result.settingsFormula.available = enabled instanceof Set && enabled.has('obsidian-advanced-uri');
    const tabs = [...(Array.isArray(runtime.setting?.settingTabs) ? runtime.setting.settingTabs : []), ...(Array.isArray(runtime.setting?.pluginTabs) ? runtime.setting.pluginTabs : [])];
    result.settingsFormula.tabIds = tabs.filter(t => typeof t?.id === 'string').map(t => t.id);
    return result;
  }
}
