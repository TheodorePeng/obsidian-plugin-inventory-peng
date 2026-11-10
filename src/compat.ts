import type { App } from 'obsidian';
import { keyOf, type RecordData, type Kind } from './core';

export interface Snapshot {
  records: Map<string, RecordData>;
  complete: Record<Kind, boolean>;
  errors: string[];
  settingsFormula: { vault: string; tabIds: string[]; available: boolean };
}
/** All access to non-public Obsidian members is confined to this adapter. */
export class Scanner {
  private cache = new Map<string, { mtime: number; size: number; value: any }>();
  constructor(private app: App) {}
  async scan(): Promise<Snapshot> {
    const runtime = this.app as any;
    const result: Snapshot = {
      records: new Map(), complete: { core: true, community: true }, errors: [],
      settingsFormula: { vault: typeof runtime.appId === 'string' ? runtime.appId : this.app.vault.getName(), tabIds: [], available: false }
    };
    const enabled: unknown = runtime.plugins?.enabledPlugins;
    const core = runtime.internalPlugins?.plugins;
    if (!(enabled instanceof Set)) { result.complete.community = false; result.errors.push('Community plugin state API unavailable'); }
    if (!core || typeof core !== 'object' || !Object.keys(core).length) {
      result.complete.core = false; result.errors.push('Core plugin state API unavailable');
    } else {
      for (const [id, item] of Object.entries(core) as [string, any][]) {
        if (typeof item.enabled !== 'boolean' || typeof item.instance?.name !== 'string') {
          result.complete.core = false; result.errors.push(`Core metadata unavailable: ${id}`); continue;
        }
        const record: RecordData = { plugin_id: id, name: item.instance.name, type: 'core', status: item.enabled ? 'enabled' : 'disabled', version: '' };
        result.records.set(keyOf(record), record);
      }
    }
    try {
      const adapter = this.app.vault.adapter;
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
          const record: RecordData = { plugin_id: m.id, name: m.name, type: 'community', status: enabled.has(m.id) ? 'enabled' : 'disabled', version: m.version };
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
