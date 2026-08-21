export function validatePath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError('ファイル名を入力してください');
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('空の要素、.、.. はファイル名に使えません');
  }
  return normalized;
}

/** 保存方式を将来差し替える場合も、この契約へ実装を載せる。 */
export class ProjectFS {
  async list() { throw new Error('ProjectFS.list() is not implemented'); }
  async read(_path) { throw new Error('ProjectFS.read() is not implemented'); }
  async write(_path, _content) { throw new Error('ProjectFS.write() is not implemented'); }
  async delete(_path) { throw new Error('ProjectFS.delete() is not implemented'); }
}

export class IndexedDbProjectFS extends ProjectFS {
  constructor({ indexedDB = globalThis.indexedDB, databaseName = 'X68kDevProjectFS' } = {}) {
    super();
    if (!indexedDB) throw new Error('IndexedDB を利用できません');
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.database = null;
  }

  async open() {
    if (this.database) return this;
    this.database = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'path' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return this;
  }

  async request(mode, action) {
    await this.open();
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction('files', mode);
      const request = action(transaction.objectStore('files'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async list() {
    const records = await this.request('readonly', (store) => store.getAll());
    return records.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(path) {
    return (await this.request('readonly', (store) => store.get(validatePath(path)))) ?? null;
  }

  async write(path, content) {
    if (typeof content !== 'string') throw new TypeError('保存内容は文字列で指定してください');
    const record = { path: validatePath(path), content, updatedAt: Date.now() };
    await this.request('readwrite', (store) => store.put(record));
    return record;
  }

  async delete(path) {
    await this.request('readwrite', (store) => store.delete(validatePath(path)));
  }
}
