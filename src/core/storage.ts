import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Collection,
  ApiRequest,
  Folder,
  Environment,
  HistoryEntry,
} from './types';

const HISTORY_LIMIT = 200;

export const SORT_STEP = 10000;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'collection';
}

export class Storage {
  private readonly collectionsDir: string;
  private readonly environmentsDir: string;
  private cache: Collection[] | null = null;
  private envCache: Environment[] | null = null;
  private historyCache: HistoryEntry[] | null = null;
  private readonly fileNames = new Map<string, string>();
  private readonly envFileNames = new Map<string, string>();

  constructor(private readonly root: string) {
    this.collectionsDir = path.join(root, 'collections');
    this.environmentsDir = path.join(root, 'environments');
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.collectionsDir, { recursive: true });
    await fs.mkdir(this.environmentsDir, { recursive: true });
  }

  async listEnvironments(): Promise<Environment[]> {
    if (this.envCache) {
      return this.envCache;
    }

    await this.ensureDirs();
    const entries = await fs.readdir(this.environmentsDir);
    const environments: Environment[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await fs.readFile(
          path.join(this.environmentsDir, entry),
          'utf8'
        );
        const parsed = JSON.parse(raw) as Environment;
        if (parsed && typeof parsed._id === 'string') {
          parsed.data ??= [];
          environments.push(parsed);
          this.envFileNames.set(parsed._id, entry);
        }
      } catch {
        // skip malformed environment files
      }
    }

    environments.sort((a, b) => a.sortNum - b.sortNum);
    this.envCache = environments;
    return environments;
  }

  async getEnvironment(id: string): Promise<Environment | undefined> {
    return (await this.listEnvironments()).find((e) => e._id === id);
  }

  async saveEnvironment(environment: Environment): Promise<void> {
    await this.ensureDirs();
    environment.modified = new Date().toISOString();

    let fileName = this.envFileNames.get(environment._id);
    if (!fileName) {
      fileName = `tg_env_${slugify(environment.name)}_${environment._id.slice(0, 8)}.json`;
      this.envFileNames.set(environment._id, fileName);
    }

    const target = path.join(this.environmentsDir, fileName);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(environment, null, 2), 'utf8');
    await fs.rename(temp, target);

    if (this.envCache) {
      const index = this.envCache.findIndex((e) => e._id === environment._id);
      if (index >= 0) {
        this.envCache[index] = environment;
      } else {
        this.envCache.push(environment);
        this.envCache.sort((a, b) => a.sortNum - b.sortNum);
      }
    }
  }

  async createEnvironment(name: string): Promise<Environment> {
    const existing = await this.listEnvironments();
    const now = new Date().toISOString();
    const environment: Environment = {
      _id: randomUUID(),
      name,
      default: existing.length === 0,
      sortNum: nextSortNum(existing),
      created: now,
      modified: now,
      data: [],
    };
    await this.saveEnvironment(environment);
    return environment;
  }

  async deleteEnvironment(id: string): Promise<void> {
    const fileName = this.envFileNames.get(id);
    if (fileName) {
      await fs.rm(path.join(this.environmentsDir, fileName), { force: true });
      this.envFileNames.delete(id);
    }
    if (this.envCache) {
      this.envCache = this.envCache.filter((e) => e._id !== id);
    }
  }

  private get historyFile(): string {
    return path.join(this.root, 'history.json');
  }

  async listHistory(): Promise<HistoryEntry[]> {
    if (this.historyCache) {
      return this.historyCache;
    }
    try {
      const raw = await fs.readFile(this.historyFile, 'utf8');
      const parsed = JSON.parse(raw) as HistoryEntry[];
      this.historyCache = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.historyCache = [];
    }
    return this.historyCache;
  }

  /**
   * Records a send. Re-running the same request replaces its existing entry
   * and moves it to the top rather than appending a duplicate.
   */
  async addHistory(entry: HistoryEntry): Promise<void> {
    const history = await this.listHistory();

    const existing = entry.requestId
      ? history.findIndex((e) => e.requestId === entry.requestId)
      : -1;

    if (existing >= 0) {
      const previous = history[existing];
      history.splice(existing, 1);
      history.unshift({
        ...entry,
        _id: previous._id,
        runCount: (previous.runCount ?? 1) + 1,
        firstRunAt: previous.firstRunAt ?? previous.at,
      });
    } else {
      history.unshift({ ...entry, runCount: 1, firstRunAt: entry.at });
    }

    if (history.length > HISTORY_LIMIT) {
      history.length = HISTORY_LIMIT;
    }
    await this.writeHistory(history);
  }

  async replaceHistory(history: HistoryEntry[]): Promise<void> {
    await this.writeHistory(history);
  }

  async clearHistory(): Promise<void> {
    await this.writeHistory([]);
  }

  private async writeHistory(history: HistoryEntry[]): Promise<void> {
    await this.ensureDirs();
    this.historyCache = history;
    const temp = `${this.historyFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify(history, null, 2), 'utf8');
    await fs.rename(temp, this.historyFile);
  }

  async listCollections(): Promise<Collection[]> {
    if (this.cache) {
      return this.cache;
    }

    await this.ensureDirs();
    const entries = await fs.readdir(this.collectionsDir);
    const collections: Collection[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await fs.readFile(
          path.join(this.collectionsDir, entry),
          'utf8'
        );
        const parsed = JSON.parse(raw) as Collection;
        if (parsed && typeof parsed._id === 'string') {
          collections.push(normalize(parsed));
          this.fileNames.set(parsed._id, entry);
        }
      } catch {
        // skip unreadable or malformed files rather than failing the whole load
      }
    }

    collections.sort((a, b) => a.sortNum - b.sortNum);
    this.cache = collections;
    return collections;
  }

  async getCollection(id: string): Promise<Collection | undefined> {
    const all = await this.listCollections();
    return all.find((c) => c._id === id);
  }

  async saveCollection(collection: Collection): Promise<void> {
    await this.ensureDirs();
    collection.modified = new Date().toISOString();

    let fileName = this.fileNames.get(collection._id);
    if (!fileName) {
      fileName = `tg_col_${slugify(collection.colName)}_${collection._id.slice(0, 8)}.json`;
      this.fileNames.set(collection._id, fileName);
    }

    const target = path.join(this.collectionsDir, fileName);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(collection, null, 2), 'utf8');
    await fs.rename(temp, target);

    if (this.cache) {
      const index = this.cache.findIndex((c) => c._id === collection._id);
      if (index >= 0) {
        this.cache[index] = collection;
      } else {
        this.cache.push(collection);
        this.cache.sort((a, b) => a.sortNum - b.sortNum);
      }
    }
  }

  async deleteCollection(id: string): Promise<void> {
    const fileName = this.fileNames.get(id);
    if (fileName) {
      await fs.rm(path.join(this.collectionsDir, fileName), { force: true });
      this.fileNames.delete(id);
    }
    if (this.cache) {
      this.cache = this.cache.filter((c) => c._id !== id);
    }
  }

  async createCollection(name: string): Promise<Collection> {
    const existing = await this.listCollections();
    const now = new Date().toISOString();
    const collection: Collection = {
      _id: randomUUID(),
      colName: name,
      created: now,
      modified: now,
      sortNum: nextSortNum(existing),
      folders: [],
      requests: [],
    };
    await this.saveCollection(collection);
    return collection;
  }

  invalidate(): void {
    this.cache = null;
    this.envCache = null;
    this.historyCache = null;
    this.fileNames.clear();
    this.envFileNames.clear();
  }
}

export function nextSortNum(items: { sortNum: number }[]): number {
  if (items.length === 0) {
    return SORT_STEP;
  }
  return Math.max(...items.map((i) => i.sortNum)) + SORT_STEP;
}

export function siblingsOf(
  collection: Collection,
  containerId: string
): (Folder | ApiRequest)[] {
  return [
    ...collection.folders.filter((f) => f.containerId === containerId),
    ...collection.requests.filter((r) => r.containerId === containerId),
  ];
}

function normalize(collection: Collection): Collection {
  collection.folders ??= [];
  collection.requests ??= [];
  collection.modified ??= collection.created;

  for (const request of collection.requests) {
    request.headers ??= [];
    request.params ??= [];
    request.body ??= { type: 'none', raw: '', form: [] };
    request.auth ??= { type: 'none' };
    request.containerId ??= '';
  }

  for (const folder of collection.folders) {
    folder.containerId ??= '';
  }

  return collection;
}
