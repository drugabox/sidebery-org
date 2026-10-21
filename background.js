// Segundo plano (página de eventos: solo despierta cuando pasa algo).
// - Abre el explorador (pestaña propia o ventana aparte).
// - Aprende a qué panel de Sidebery pertenece cada pestaña leyendo el título de la ventana
//   (Sidebery → «Marcar ventana» con %PN) y, si Sidebery oculta los paneles inactivos, las visibles.
// - Hace miniaturas de la pestaña que miras, si lo activas.
'use strict'

const EXPLORER = browser.runtime.getURL('explorer/explorer.html')
const DEFAULTS = { prefaceRe: '⟦(.+?)⟧', hideInact: false, thumbs: false, openMode: 'tab' }
const isExplorer = t => !!t.url && t.url.startsWith(EXPLORER)

async function getSettings() {
  const { settings } = await browser.storage.local.get('settings')
  return { ...DEFAULTS, ...(settings || {}) }
}

// ---------------------------------------------------------------------------
// Abrir el explorador

async function openExplorer(mode, hash = '') {
  const s = await getSettings()
  mode = mode || s.openMode
  const all = await browser.tabs.query({})
  const found = all.find(isExplorer)
  if (found) {
    await browser.tabs.update(found.id, { active: true, ...(hash ? { url: EXPLORER + hash } : {}) })
    await browser.windows.update(found.windowId, { focused: true })
    return
  }
  if (mode === 'window') {
    const { winBounds } = await browser.storage.local.get('winBounds')
    const b = winBounds || { width: 1200, height: 800 }
    await browser.windows.create({ url: EXPLORER + hash, type: 'popup', ...b })
  } else {
    await browser.tabs.create({ url: EXPLORER + hash })
  }
}

browser.browserAction.onClicked.addListener((tab, info) => {
  openExplorer(info && info.button === 1 ? 'window' : undefined)
})

browser.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'open') return openExplorer(msg.mode, msg.hash || '')
  if (msg && msg.type === 'scan') return scanPanels(msg.windowId, msg.returnTo)
})

browser.commands.onCommand.addListener(cmd => {
  if (cmd === 'open-window') openExplorer('window')
  if (cmd === 'open-tab') openExplorer('tab')
})

browser.runtime.onInstalled.addListener(() => {
  browser.menus.removeAll().then(() => {
    browser.menus.create({ id: 'open-tab', title: 'Abrir Pestañario en una pestaña', contexts: ['browser_action'] })
    browser.menus.create({ id: 'open-window', title: 'Abrir Pestañario en una ventana aparte', contexts: ['browser_action'] })
    browser.menus.create({ id: 'show-tab', title: 'Ver en Pestañario', contexts: ['tab'] })
  })
})

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-tab') openExplorer('tab')
  if (info.menuItemId === 'open-window') openExplorer('window')
  if (info.menuItemId === 'show-tab' && tab) openExplorer(undefined, '#tab=' + tab.id)
})

// ---------------------------------------------------------------------------
// Aprender los paneles de Sidebery

const learnTimers = new Map()
function scheduleLearn(windowId, delay = 400) {
  clearTimeout(learnTimers.get(windowId))
  learnTimers.set(windowId, setTimeout(() => {
    learnTimers.delete(windowId)
    learn(windowId).catch(() => {})
  }, delay))
}

async function learn(windowId) {
  const s = await getSettings()
  let re
  try {
    re = new RegExp(s.prefaceRe)
  } catch {
    return
  }
  const win = await browser.windows.get(windowId, { populate: true }).catch(() => null)
  if (!win || win.type !== 'normal' || win.incognito) return
  const m = re.exec(win.title || '')
  const name = m && m[1] && m[1].trim()
  if (!name) return

  const now = Date.now()
  const upd = {}
  const active = win.tabs.find(t => t.active)
  if (active && !active.pinned) upd[active.id] = [name, now]
  if (s.hideInact) {
    const normal = win.tabs.filter(t => !t.pinned)
    if (normal.some(t => t.hidden)) for (const t of normal) if (!t.hidden) upd[t.id] = [name, now]
  }
  await saveLearned(upd)
}

async function saveLearned(upd) {
  const ids = Object.keys(upd)
  if (!ids.length) return
  const { learned = {} } = await browser.storage.local.get('learned')
  let changed = false
  for (const id of ids) {
    const old = learned[id]
    if (!old || old[0] !== upd[id][0]) {
      browser.sessions.setTabValue(+id, 'sbp', upd[id]).catch(() => {})
      changed = true
    }
    if (!old || old[0] !== upd[id][0] || upd[id][1] - old[1] > 60000) {
      learned[id] = upd[id]
      changed = true
    }
  }
  if (changed) await browser.storage.local.set({ learned })
}

// Los identificadores de pestaña cambian al reiniciar Firefox: se recupera lo aprendido de
// los datos de sesión de cada pestaña (viajan con ella).
async function rebuildLearned() {
  const tabs = await browser.tabs.query({})
  const learned = {}
  await Promise.all(
    tabs.map(t =>
      browser.sessions
        .getTabValue(t.id, 'sbp')
        .then(v => {
          if (Array.isArray(v)) learned[t.id] = v
        })
        .catch(() => {})
    )
  )
  await browser.storage.local.set({ learned })
}
browser.runtime.onStartup.addListener(rebuildLearned)

let cleanTimer
browser.tabs.onRemoved.addListener(() => {
  clearTimeout(cleanTimer)
  cleanTimer = setTimeout(async () => {
    const { learned = {} } = await browser.storage.local.get('learned')
    const alive = new Set((await browser.tabs.query({})).map(t => String(t.id)))
    let changed = false
    for (const id of Object.keys(learned)) if (!alive.has(id)) {
      delete learned[id]
      changed = true
    }
    if (changed) await browser.storage.local.set({ learned })
  }, 5000)
})

// ---------------------------------------------------------------------------
// Reconocer paneles: activa unas pocas pestañas y lee el panel que Sidebery pone en el título.
// Como cada panel es un tramo seguido, basta con buscar los límites (búsqueda binaria).

const wait = ms => new Promise(r => setTimeout(r, ms))
let scanning = false

async function scanPanels(windowId, returnTo) {
  if (scanning) return { ok: false, error: 'Ya se está reconociendo' }
  scanning = true
  const woken = []
  let original
  try {
    const s = await getSettings()
    const re = new RegExp(s.prefaceRe)
    const readName = async () => {
      const w = await browser.windows.get(windowId)
      const m = re.exec(w.title || '')
      return m && m[1] ? m[1].trim() : null
    }
    if (!(await readName())) {
      return { ok: false, error: 'No veo el panel en el título de la ventana: abre la barra de Sidebery en esta ventana y revisa «Preface value» (⟦%PN⟧).' }
    }
    const all = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index)
    original = returnTo || (all.find(t => t.active) || {}).id
    const list = all.filter(t => !t.pinned && !t.hidden)
    const hiddenToo = all.filter(t => !t.pinned)
    // Con «ocultar paneles inactivos» las pestañas ocultas también cuentan
    const tabs = s.hideInact ? hiddenToo : list.length === hiddenToo.length ? list : hiddenToo
    const n = tabs.length
    if (!n) return { ok: true, probes: 0, learned: 0 }
    const names = new Array(n).fill(null)
    const now = Date.now()
    let lastName = await readName()
    let probes = 0

    const probe = async i => {
      const t = tabs[i]
      probes++
      if (t.discarded) woken.push(t.id)
      await browser.tabs.update(t.id, { active: true })
      const t0 = Date.now()
      let name = null
      await wait(90)
      while (Date.now() - t0 < 1200) {
        name = await readName()
        if (name && (name !== lastName || Date.now() - t0 > 450)) break
        await wait(50)
      }
      names[i] = name
      lastName = name
      if (s.hideInact && name) {
        const vis = await browser.tabs.query({ windowId, hidden: false, pinned: false })
        const ids = new Set(vis.map(v => v.id))
        tabs.forEach((x, j) => {
          if (ids.has(x.id)) names[j] = name
        })
      }
      return name
    }

    // Elige una pestaña cargada cerca del medio (para no despertar las dormidas)
    const pick = (lo, hi) => {
      const mid = (lo + hi) >> 1
      const span = Math.max(1, (hi - lo) >> 2)
      for (let d = 0; d <= span; d++) {
        for (const j of [mid - d, mid + d]) if (j > lo && j < hi && names[j] === null && !tabs[j].discarded) return j
      }
      return mid
    }

    const seg = async (lo, hi) => {
      if (hi - lo <= 1) return
      if (names[lo] !== null && names[lo] === names[hi]) {
        for (let j = lo + 1; j < hi; j++) names[j] = names[lo]
        return
      }
      const m = pick(lo, hi)
      if (names[m] === null) await probe(m)
      await seg(lo, m)
      await seg(m, hi)
    }

    if (names[0] === null) await probe(0)
    if (names[n - 1] === null) await probe(n - 1)
    await seg(0, n - 1)

    const upd = {}
    tabs.forEach((t, j) => {
      if (names[j]) upd[t.id] = [names[j], now]
    })
    await saveLearned(upd)
    return { ok: true, probes, learned: Object.keys(upd).length, panels: [...new Set(names.filter(Boolean))] }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  } finally {
    if (original) await browser.tabs.update(original, { active: true }).catch(() => {})
    const toSleep = woken.filter(id => id !== original)
    if (toSleep.length) setTimeout(() => browser.tabs.discard(toSleep).catch(() => {}), 1500)
    scanning = false
  }
}

// ---------------------------------------------------------------------------
// Árbol tras reiniciar: Firefox olvida openerTabId (que Sidebery usa para reflejar el árbol).
// Se guarda en los datos de sesión de cada pestaña (uid propio y el del padre) y se repone.

const uid = () => Math.random().toString(36).slice(2, 10)
let treeTimer
function scheduleTreeSave() {
  clearTimeout(treeTimer)
  treeTimer = setTimeout(() => saveTree().catch(() => {}), 4000)
}

async function loadTreeCache() {
  try {
    const { tree } = await browser.storage.session.get('tree')
    if (tree) return tree
  } catch {}
  // La página de fondo se ha reiniciado sin caché: leer de las pestañas
  const tabs = await browser.tabs.query({})
  const tree = {}
  await Promise.all(tabs.map(t => browser.sessions.getTabValue(t.id, 'pu').then(v => {
    if (Array.isArray(v)) tree[t.id] = v
  }).catch(() => {})))
  return tree
}

async function saveTree() {
  const tabs = await browser.tabs.query({})
  const old = await loadTreeCache() // tabId → [uid, uidPadre], ya guardado en la pestaña
  const ids = new Set(tabs.map(t => t.id))
  const uids = {}
  for (const t of tabs) uids[t.id] = old[t.id] ? old[t.id][0] : uid()
  const tree = {}
  for (const t of tabs) {
    const pid = t.openerTabId !== undefined && t.openerTabId !== t.id && ids.has(t.openerTabId) ? t.openerTabId : null
    const o = old[t.id]
    // Sin openerTabId (Firefox lo pierde al reiniciar) se conserva el padre guardado;
    // Sidebery marca las raíces apuntándolas a sí mismas.
    const parentUid = pid ? uids[pid] : t.openerTabId === undefined && o ? o[1] : ''
    const v = [uids[t.id], parentUid]
    tree[t.id] = v
    if (!o || o[0] !== v[0] || o[1] !== v[1]) browser.sessions.setTabValue(t.id, 'pu', v).catch(() => {})
  }
  try {
    await browser.storage.session.set({ tree })
  } catch {}
}

async function restoreTree() {
  const tabs = await browser.tabs.query({})
  const vals = new Map()
  await Promise.all(tabs.map(t => browser.sessions.getTabValue(t.id, 'pu').then(v => {
    if (Array.isArray(v)) vals.set(t.id, v)
  }).catch(() => {})))
  const byUid = new Map([...vals.entries()].map(([id, v]) => [v[0], id]))
  const byId = new Map(tabs.map(t => [t.id, t]))
  for (const [id, v] of vals) {
    const t = byId.get(id)
    const pid = v[1] && byUid.get(v[1])
    if (!t || !pid || t.openerTabId !== undefined) continue
    const p = byId.get(pid)
    if (!p || p.windowId !== t.windowId) continue
    browser.tabs.update(id, { openerTabId: pid }).catch(() => {})
  }
  try {
    await browser.storage.session.set({ tree: Object.fromEntries(vals) })
  } catch {}
}

browser.runtime.onStartup.addListener(() => setTimeout(() => restoreTree().catch(() => {}), 8000))
browser.tabs.onCreated.addListener(scheduleTreeSave)
browser.tabs.onMoved.addListener(scheduleTreeSave)
browser.tabs.onAttached.addListener(scheduleTreeSave)
browser.tabs.onRemoved.addListener(scheduleTreeSave)

// ---------------------------------------------------------------------------
// Miniaturas de la pestaña que miras (solo si lo activas: necesita acceso a las webs)

const lastShot = new Map()
const thumbTimers = new Map()
const channel = new BroadcastChannel('pestanario')

function scheduleThumb(tabId, delay = 1200) {
  clearTimeout(thumbTimers.get(tabId))
  thumbTimers.set(tabId, setTimeout(() => {
    thumbTimers.delete(tabId)
    captureThumb(tabId).catch(() => {})
  }, delay))
}

async function captureThumb(tabId) {
  const s = await getSettings()
  if (!s.thumbs) return
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) return
  const tab = await browser.tabs.get(tabId)
  if (!tab.active || tab.discarded || tab.status !== 'complete' || !/^https?:/.test(tab.url)) return
  const key = Model.normUrl(tab.url)
  if (Date.now() - (lastShot.get(key) || 0) < 10 * 60000) return
  lastShot.set(key, Date.now())
  const scale = Math.min(1, 400 / (tab.width || 1280))
  const dataUrl = await browser.tabs.captureTab(tabId, { format: 'jpeg', quality: 60, scale })
  const blob = await (await fetch(dataUrl)).blob()
  await DB.put('thumbs', { url: key, blob, t: Date.now() })
  channel.postMessage({ type: 'thumb', url: key })
}

// ---------------------------------------------------------------------------
// Eventos de pestañas (solo los necesarios)

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  scheduleLearn(windowId)
  scheduleThumb(tabId)
})

browser.tabs.onUpdated.addListener(
  (tabId, change, tab) => {
    if ('hidden' in change) scheduleLearn(tab.windowId, 300)
    if (change.status === 'complete' && tab.active) scheduleThumb(tabId, 800)
  },
  { properties: ['hidden', 'status'] }
)

browser.windows.onFocusChanged.addListener(id => {
  if (id !== browser.windows.WINDOW_ID_NONE) scheduleLearn(id)
})
