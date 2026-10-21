// Base de datos local (IndexedDB): fichas, colecciones y miniaturas.
// ficha:     { url, title, fav, tags[], note, color, links[], cols[], created, updated }
// colección: { id, name, parent, color, created }
// miniatura: { url, blob, t }
;(function (root) {
  'use strict'

  const NAME = 'pestanario'
  const VERSION = 1
  let dbp = null

  function open() {
    if (dbp) return dbp
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('fichas')) db.createObjectStore('fichas', { keyPath: 'url' })
        if (!db.objectStoreNames.contains('cols')) db.createObjectStore('cols', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'url' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return dbp
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function tx(store, mode, fn) {
    const db = await open()
    const t = db.transaction(store, mode)
    const res = fn(t.objectStore(store))
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
    return res instanceof IDBRequest ? res.result : res
  }

  const DB = {
    open,
    all: store => tx(store, 'readonly', s => s.getAll()),
    get: (store, key) => open().then(db => wrap(db.transaction(store).objectStore(store).get(key))),
    put: (store, value) => tx(store, 'readwrite', s => s.put(value)),
    putMany: (store, values) => tx(store, 'readwrite', s => values.forEach(v => s.put(v))),
    del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
    clear: store => tx(store, 'readwrite', s => s.clear()),
    keys: store => tx(store, 'readonly', s => s.getAllKeys()),
  }

  root.DB = DB
})(globalThis)
