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
