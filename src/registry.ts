import type { Kind, Source } from './core';

export interface RegistryCache { ids: string[]; fetchedAt: number; attemptedAt: number }
export const REGISTRY_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
export const REGISTRY_INTERVAL = 24 * 60 * 60 * 1000;
export function parseRegistry(text: string): string[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || data.length < 100) throw new Error('Invalid or incomplete community directory');
  const ids = new Set<string>();
  for (const item of data as unknown[]) {
    if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string' || !(item as { id: string }).id) throw new Error('Invalid community directory entry');
    ids.add((item as { id: string }).id);
  }
  if (ids.size !== data.length) throw new Error('Duplicate community directory ID');
  return [...ids];
}
export function classify(kind: Kind, id: string, ids: ReadonlySet<string> | null): Source {
  return kind === 'core' ? 'Built-in' : ids?.has(id) ? 'Community' : 'Non-community';
}
export function registryDue(cache: RegistryCache, now: number, force: boolean): boolean {
  return force || !cache.attemptedAt || now - cache.attemptedAt >= REGISTRY_INTERVAL;
}
