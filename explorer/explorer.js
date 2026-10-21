// Pestañario: explorador de archivos para pestañas, sobre la organización de Sidebery.
'use strict'

const M = Model
const SELF = browser.runtime.getURL('explorer/explorer.html')
const bc = new BroadcastChannel('pestanario')
const $ = s => document.querySelector(s)
const DEFAULTS = {
  prefaceRe: '⟦(.+?)⟧',
  hideInact: false,
  thumbs: false,
  openMode: 'tab',
  theme: 'auto',
  accent: '',
  fontSize: 13,
  radius: 6,
  density: 'normal',
  view: 'details',
  sort: 'natural',
  zoom: 2,
  side: true,
  insp: true,
  sideW: 270,
  inspW: 320,
}
const OWN_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f', '#8d8d8d']
const CARD = [0, 150, 200, 260, 340]

// ---------------------------------------------------------------------------
// Estado

const S = {
  settings: { ...DEFAULTS },
  sbImport: null,
  learned: {},
  containers: new Map(),
  fichas: new Map(), // clave (url normalizada) → ficha
  cols: new Map(), // id → colección
  wins: [], // ventanas normales
  info: new Map(), // tabId → datos calculados de la pestaña
  panelOrder: [], // nombres de panel en el orden de Sidebery
  panelMeta: new Map(), // nombre → {color, icon}
  items: new Map(), // clave → elemento mostrable
  tabByUrl: new Map(), // url normalizada → elemento de pestaña
  tagCount: new Map(),
  titleIdx: new Map(),
  loc: { t: 'all' },
  hist: [],
  fwd: [],
  sel: new Set(),
  focus: null,
  anchor: null,
  expanded: new Set(),
  expandedP: new Set(),
  cut: null,
  rows: [], // filas visibles (detalles) o elementos (miniaturas)
  query: M.parseQuery(''),
  selfTabId: null,
  treeOpen: new Set(),
  thumbs: new Map(),
}

// ---------------------------------------------------------------------------
// Utilidades

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function hashColor(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `hsl(${Math.abs(h) % 360} 55% 48%)`
}

function ago(t) {
  if (!t) return ''
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'ahora'
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`
  if (s < 86400 * 30) return `hace ${Math.floor(s / 86400)} d`
  return new Date(t).toLocaleDateString()
}

function debounce(fn, ms) {
  let t
  return (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

function lsGet(k, d) {
  try {
    const v = localStorage.getItem(k)
    return v === null ? d : JSON.parse(v)
  } catch {
    return d
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {}
}

let toastTimer
function toast(msg, ms = 3500) {
  const el = $('#status .msg')
  if (!el) return
  el.textContent = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.textContent = ''), ms)
}

const favOk = u => !!u && /^(https?:|data:image|moz-extension:)/.test(u)

function favHtml(it, cls = 'fav') {
  if (favOk(it.fav)) return `<img class="${cls}" src="${esc(it.fav)}" loading="lazy" alt="">`
  const ch = (it.domain || it.title || '?').replace(/^www\./, '')[0] || '?'
  return `<span class="${cls} ph" style="background:${hashColor(it.domain || it.title || '')}">${esc(ch.toUpperCase())}</span>`
}

// ---------------------------------------------------------------------------
// Ajustes

async function loadSettings() {
  const st = await browser.storage.local.get(['settings', 'sbImport', 'learned'])
  S.settings = { ...DEFAULTS, ...(st.settings || {}) }
  S.sbImport = st.sbImport || null
  S.learned = st.learned || {}
  applyLook()
}

async function saveSettings(patch) {
  Object.assign(S.settings, patch)
  await browser.storage.local.set({ settings: S.settings })
  applyLook()
}

let lastLook = ''
function applyLook() {
  const s = S.settings
  if (s.theme === 'light') s.theme = 'claro'
  if (s.theme === 'dark') s.theme = 'oscuro'
  const look = JSON.stringify([s.theme, s.accent, s.fontSize, s.density, s.radius])
  if (look !== lastLook) {
    lastLook = look
    Themes.apply(s).then(() => {
      applyLayout()
      if (typeof renderMain === 'function' && S.info.size) render()
    })
  }
  applyLayout()
}

function applyLayout() {
  const s = S.settings
  const root = document.documentElement
  document.body.classList.toggle('no-side', !s.side)
  document.body.classList.toggle('no-insp', !s.insp)
  root.style.setProperty('--side-w', s.sideW + 'px')
  root.style.setProperty('--insp-w', s.inspW + 'px')
  $('#sort').value = s.sort
  $('#zoom').value = s.zoom
  $('#zoom').hidden = s.view !== 'icons'
  $('#btnExpand').hidden = $('#btnCollapse').hidden = s.view !== 'details'
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('on', b.dataset.view === s.view)
  $('#btnInspector').classList.toggle('on', s.insp)
}

// ---------------------------------------------------------------------------
// Datos: pestañas → paneles y árbol (lo que Sidebery muestra)

async function loadDb() {
  const [fichas, cols] = await Promise.all([DB.all('fichas'), DB.all('cols')])
  S.fichas = new Map(fichas.map(f => [f.url, f]))
  S.cols = new Map(cols.map(c => [c.id, c]))
}

async function loadContainers() {
  try {
    const list = await browser.contextualIdentities.query({})
    S.containers = new Map(list.map(c => [c.cookieStoreId, c]))
  } catch {
    S.containers = new Map()
  }
}

let refreshing = false
let refreshAgain = false
async function refresh() {
  if (refreshing) {
    refreshAgain = true
    return
  }
  refreshing = true
  try {
    const [tabs, wins, self] = await Promise.all([browser.tabs.query({}), browser.windows.getAll(), browser.tabs.getCurrent()])
    S.selfTabId = self ? self.id : null
    buildModel(tabs, wins)
    buildItems()
    render()
  } finally {
    refreshing = false
    if (refreshAgain) {
      refreshAgain = false
      scheduleRefresh()
    }
  }
}
const scheduleRefresh = debounce(refresh, 90)

function buildModel(tabs, wins) {
  S.wins = wins.filter(w => w.type === 'normal').sort((a, b) => a.id - b.id)
  const winIds = new Set(S.wins.map(w => w.id))
  const byWin = new Map()
  for (const t of tabs) {
    if (!winIds.has(t.windowId)) continue
    let l = byWin.get(t.windowId)
    if (!l) byWin.set(t.windowId, (l = []))
    l.push(t)
  }

  const imp = S.sbImport
  S.panelMeta = new Map()
  const order = []
  if (imp) for (const p of imp.panels) {
    S.panelMeta.set(p.name, { color: p.color, icon: p.icon })
    order.push(p.name)
  }

  S.info = new Map()
  for (const w of S.wins) {
    const list = (byWin.get(w.id) || []).sort((a, b) => a.index - b.index)
    const match = M.matchImport(list, imp)
    const known = new Map()
    for (const t of list) {
      let k = null
      const l = S.learned[t.id]
      if (l) k = { panel: l[0], time: l[1] }
      const m = match.get(t.id)
      if (m && m.panel && (!k || imp.time > k.time)) k = { panel: m.panel, time: imp.time }
      if (k) known.set(t.id, k)
    }
    const asg = M.assignPanels(list, known, imp ? imp.panels.map(p => p.name) : [])
    const panelOf = t => asg.get(t.id).panel
    const hint = M.parentsFromLevels(list, t => match.get(t.id)?.lvl, panelOf)
    const tree = M.computeTree(list, panelOf, hint)

    let prevName = null
    for (const t of list) {
      const a = asg.get(t.id)
      const n = tree.get(t.id)
      const sb = match.get(t.id) || null
      S.info.set(t.id, { id: t.id, tab: t, win: w.id, panel: a.panel, sure: a.sure, parent: n.parent, lvl: n.lvl, kids: [], sb })
      if (!t.pinned && a.panel && !order.includes(a.panel)) order.splice(prevName === null ? order.length : order.indexOf(prevName) + 1, 0, a.panel)
      if (!t.pinned && a.panel) prevName = a.panel
    }
    for (const t of list) {
      const i = S.info.get(t.id)
      if (i.parent !== -1) S.info.get(i.parent).kids.push(t.id)
    }
  }
  S.panelOrder = order
}

function fichaFor(key) {
  return S.fichas.get(key)
}

function makeTabItem(i) {
  const t = i.tab
  const url = M.restoreUrl(t.url)
  const key = M.normUrl(t.url)
  const f = fichaFor(key)
  const isGroup = M.sideberyPage(t.url) === 'group'
  const ctr = S.containers.get(t.cookieStoreId)
  const tags = f ? [...new Set([...(f.tags || []), ...M.noteTags(f.note)])] : []
  return {
    key: 't:' + t.id,
    kind: 'tab',
    id: t.id,
    win: i.win,
    url,
    nurl: key,
    title: (f && f.alias) || (i.sb && i.sb.customTitle) || (isGroup ? M.groupName(t.url) || t.title : t.title) || url,
    realTitle: t.title,
    customTitle: i.sb && i.sb.customTitle,
    fav: t.favIconUrl,
    domain: isGroup ? 'grupo de Sidebery' : M.domainOf(url),
    panel: t.pinned ? i.panel || 'Fijadas' : i.panel,
    sure: i.sure,
    sbColor: i.sb && i.sb.color ? M.colorCss(i.sb.color) : '',
    colorName: i.sb && i.sb.color,
    color: f && f.color,
    tags,
    cols: f ? (f.cols || []).map(id => S.cols.get(id)?.name).filter(Boolean) : [],
    note: f ? f.note || '' : '',
    links: f ? f.links || [] : [],
    saved: !!f,
    open: true,
    discarded: !!t.discarded,
    audible: !!t.audible,
    muted: !!(t.mutedInfo && t.mutedInfo.muted),
    pinned: !!t.pinned,
    active: !!t.active,
    hidden: !!t.hidden,
    group: isGroup,
    container: ctr ? ctr.name : '',
    containerColor: ctr ? ctr.colorCode : '',
    last: t.lastAccessed || 0,
    kids: i.kids,
    parent: i.parent,
    lvl: i.lvl,
  }
}

function makeFichaItem(f) {
  const url = f.rawUrl || f.url
  const tags = [...new Set([...(f.tags || []), ...M.noteTags(f.note)])]
  return {
    key: 'f:' + f.url,
    kind: 'ficha',
    url,
    nurl: f.url,
    title: f.alias || f.title || url,
    realTitle: f.title,
    fav: f.fav,
    domain: M.domainOf(url),
    panel: f.panel || '',
    sbColor: f.sbColor ? M.colorCss(f.sbColor) : '',
    color: f.color,
    tags,
    cols: (f.cols || []).map(id => S.cols.get(id)?.name).filter(Boolean),
    note: f.note || '',
    links: f.links || [],
    saved: true,
    open: false,
    last: f.updated || f.created || 0,
    kids: [],
    parent: -1,
    lvl: 0,
  }
}

function buildItems() {
  S.items = new Map()
  S.tabByUrl = new Map()
  for (const i of S.info.values()) {
    if (i.id === S.selfTabId || (i.tab.url || '').startsWith(SELF)) continue
    const it = makeTabItem(i)
    S.items.set(it.key, it)
    if (!S.tabByUrl.has(it.nurl)) S.tabByUrl.set(it.nurl, it)
  }
  for (const f of S.fichas.values()) {
    if (S.tabByUrl.has(f.url)) continue
    const it = makeFichaItem(f)
    S.items.set(it.key, it)
  }
  for (const w of S.wins) {
    const counts = new Map()
    let pinned = 0
    for (const it of S.items.values()) {
      if (it.kind !== 'tab' || it.win !== w.id) continue
      if (it.pinned) pinned++
      else counts.set(it.panel, (counts.get(it.panel) || 0) + 1)
    }
    const names = [...S.panelOrder]
    if (counts.has('')) names.push('')
    for (const name of names) {
      const meta = S.panelMeta.get(name) || {}
      const key = `p:${w.id}|${name}`
      S.items.set(key, { key, kind: 'panel', win: w.id, panel: name, title: (S.wins.length > 1 ? winName(w.id) + ' · ' : '') + panelLabel(name), color: M.colorCss(meta.color) || (name ? hashColor(name) : ''), count: counts.get(name) || 0, tags: [], cols: [], domain: '', last: 0 })
    }
    if (pinned) S.items.set('P:' + w.id, { key: 'P:' + w.id, kind: 'pinnedf', win: w.id, title: (S.wins.length > 1 ? winName(w.id) + ' · ' : '') + 'Fijadas', count: pinned, tags: [], cols: [], domain: '', last: 0 })
  }
  for (const c of S.cols.values()) {
    S.items.set('c:' + c.id, { key: 'c:' + c.id, kind: 'col', id: c.id, title: c.name, color: c.color, tags: [], cols: [], last: c.created, domain: '' })
  }
  S.tagCount = new Map()
  for (const f of S.fichas.values()) {
    const tags = new Set([...(f.tags || []), ...M.noteTags(f.note)])
    const seen = new Set()
    for (const t of tags) {
      const parts = t.split('/')
      for (let k = 1; k <= parts.length; k++) {
        const p = parts.slice(0, k).join('/')
        if (seen.has(p)) continue
        seen.add(p)
        S.tagCount.set(p, (S.tagCount.get(p) || 0) + 1)
      }
    }
  }
  for (const t of S.tagCount.keys()) {
    S.items.set('g:' + t, { key: 'g:' + t, kind: 'tagdir', tag: t, title: t.split('/').pop(), tags: [], cols: [], domain: '', last: 0 })
  }
  S.titleIdx = new Map()
  for (const it of S.items.values()) {
    if (it.kind !== 'tab' && it.kind !== 'ficha') continue
    for (const t of [it.title, it.realTitle]) {
      const k = (t || '').toLowerCase()
      if (k && !S.titleIdx.has(k)) S.titleIdx.set(k, it)
    }
  }
  // Selección: quitar lo que ya no existe
  for (const k of [...S.sel]) if (!S.items.has(k)) S.sel.delete(k)
}

// Elemento para una URL (pestaña abierta si la hay, si no la ficha)
function itemForUrl(nurl) {
  return S.tabByUrl.get(nurl) || S.items.get('f:' + nurl) || null
}

function resolveLink(text) {
  const t = text.trim()
  const n = M.normUrl(t)
  const byUrl = itemForUrl(n)
  if (byUrl) return byUrl
  return S.titleIdx.get(t.toLowerCase()) || null
}

// ---------------------------------------------------------------------------
// Ubicaciones (carpetas)

const tabItem = id => S.items.get('t:' + id)
const winName = id => {
  const n = S.wins.findIndex(w => w.id === id)
  return n < 0 ? 'Ventana' : `Ventana ${n + 1}`
}
const panelLabel = name => name || 'Sin identificar'

function tabsOfPanel(win, panel, pinned = false) {
  const out = []
  for (const it of S.items.values()) if (it.kind === 'tab' && it.win === win && it.panel === panel && it.pinned === pinned) out.push(it)
  return out.sort((a, b) => S.info.get(a.id).tab.index - S.info.get(b.id).tab.index)
}

function locKey(l) {
  return JSON.stringify(l)
}

function sameLoc(a, b) {
  return locKey(a) === locKey(b)
}

function colChildren(id) {
  return [...S.cols.values()].filter(c => (c.parent || null) === id).sort((a, b) => a.name.localeCompare(b.name))
}

function colDescendants(id, acc = new Set()) {
  acc.add(id)
  for (const c of colChildren(id)) colDescendants(c.id, acc)
  return acc
}

function fichaItemsIn(colIds) {
  const out = []
  for (const f of S.fichas.values()) if ((f.cols || []).some(c => colIds.has(c))) out.push(itemForUrl(f.url))
  return out.filter(Boolean)
}

function itemsWithTag(tag, deep) {
  const out = []
  for (const f of S.fichas.values()) {
    const tags = new Set([...(f.tags || []), ...M.noteTags(f.note)])
    let ok = false
    for (const t of tags) if (t === tag || (deep && t.startsWith(tag + '/'))) ok = true
    if (ok) {
      const it = itemForUrl(f.url)
      if (it) out.push(it)
    }
  }
  return out
}

// Contenido directo de una ubicación (sin búsqueda)
function contents(loc) {
  const all = [...S.items.values()]
  switch (loc.t) {
    case 'panel':
      return tabsOfPanel(loc.w, loc.p).filter(it => it.parent === -1)
    case 'pinned':
      return all.filter(it => it.kind === 'tab' && it.win === loc.w && it.pinned).sort((a, b) => S.info.get(a.id).tab.index - S.info.get(b.id).tab.index)
    case 'folder': {
      const i = S.info.get(loc.id)
      return i ? i.kids.map(tabItem).filter(Boolean) : []
    }
    case 'col':
      return [...colChildren(loc.id).map(c => S.items.get('c:' + c.id)), ...fichaItemsIn(new Set([loc.id]))]
    case 'cols':
      return colChildren(null).map(c => S.items.get('c:' + c.id))
    case 'tag': {
      const subs = [...S.tagCount.keys()].filter(t => t.startsWith(loc.tag + '/') && !t.slice(loc.tag.length + 1).includes('/'))
      return [...subs.map(t => S.items.get('g:' + t)), ...itemsWithTag(loc.tag, false)]
    }
    case 'tags':
      return [...S.tagCount.keys()].filter(t => !t.includes('/')).sort().map(t => S.items.get('g:' + t))
    case 'saved':
      return [...S.fichas.values()].map(f => itemForUrl(f.url)).filter(Boolean)
    case 'archive':
      return all.filter(it => it.kind === 'ficha')
    case 'all':
    default:
      return all.filter(it => it.kind === 'pinnedf' || it.kind === 'panel').sort((a, b) => a.win - b.win || (a.kind === 'pinnedf' ? -1 : b.kind === 'pinnedf' ? 1 : panelRank(a.panel) - panelRank(b.panel)))
  }
}

function panelRank(name) {
  const i = S.panelOrder.indexOf(name)
  return name && i >= 0 ? i : 1e6
}

function tabOrder(a, b) {
  const ia = S.info.get(a.id)
  const ib = S.info.get(b.id)
  return ia.win - ib.win || ia.tab.index - ib.tab.index
}

// Todo lo que hay debajo (para buscar dentro de una carpeta)
function subtree(loc) {
  switch (loc.t) {
    case 'panel':
      return [...tabsOfPanel(loc.w, loc.p, true), ...tabsOfPanel(loc.w, loc.p)]
    case 'folder': {
      const out = []
      const walk = id => {
        for (const k of S.info.get(id)?.kids || []) {
          const it = tabItem(k)
          if (it) out.push(it)
          walk(k)
        }
      }
      walk(loc.id)
      return out
    }
    case 'col':
      return fichaItemsIn(colDescendants(loc.id))
    case 'tag':
      return itemsWithTag(loc.tag, true)
    case 'cols':
    case 'tags':
    case 'all':
      return [...S.items.values()].filter(it => it.kind === 'tab' || it.kind === 'ficha')
    default:
      return contents(loc)
  }
}

function locTitle(loc) {
  switch (loc.t) {
    case 'panel':
      return panelLabel(loc.p)
    case 'pinned':
      return 'Fijadas'
    case 'folder':
      return tabItem(loc.id)?.title || 'Carpeta'
    case 'col':
      return S.cols.get(loc.id)?.name || 'Colección'
    case 'cols':
      return 'Colecciones'
    case 'tag':
      return '#' + loc.tag
    case 'tags':
      return 'Etiquetas'
    case 'saved':
      return 'Fichas'
    case 'archive':
      return 'Archivo'
    default:
      return 'Todos los paneles'
  }
}

function crumbsOf(loc) {
  const c = []
  const multi = S.wins.length > 1
  if (loc.t === 'panel' || loc.t === 'pinned') {
    if (multi) c.push({ label: winName(loc.w), loc: null })
    c.push({ label: locTitle(loc), loc })
  } else if (loc.t === 'folder') {
    const it = tabItem(loc.id)
    if (!it) return [{ label: 'Carpeta', loc }]
    if (multi) c.push({ label: winName(it.win), loc: null })
    c.push({ label: panelLabel(it.panel), loc: it.pinned ? { t: 'pinned', w: it.win } : { t: 'panel', w: it.win, p: it.panel } })
    const chain = []
    let p = it.id
    while (p !== -1 && p !== undefined) {
      chain.unshift(p)
      p = S.info.get(p)?.parent
    }
    for (const id of chain) c.push({ label: tabItem(id)?.title || '…', loc: { t: 'folder', id } })
  } else if (loc.t === 'col') {
    c.push({ label: 'Colecciones', loc: { t: 'cols' } })
    const chain = []
    let id = loc.id
    while (id && S.cols.has(id)) {
      chain.unshift(id)
      id = S.cols.get(id).parent
    }
    for (const id of chain) c.push({ label: S.cols.get(id).name, loc: { t: 'col', id } })
  } else if (loc.t === 'tag') {
    c.push({ label: 'Etiquetas', loc: { t: 'tags' } })
    const parts = loc.tag.split('/')
    parts.forEach((p, i) => c.push({ label: (i ? '' : '#') + p, loc: { t: 'tag', tag: parts.slice(0, i + 1).join('/') } }))
  } else {
    c.push({ label: locTitle(loc), loc })
  }
  return c
}

function parentLoc(loc) {
  const c = crumbsOf(loc).filter(x => x.loc)
  return c.length > 1 ? c[c.length - 2].loc : null
}

function go(loc, push = true) {
  if (sameLoc(loc, S.loc)) return
  if (push) {
    S.hist.push(S.loc)
    S.fwd = []
  }
  S.loc = loc
  S.sel.clear()
  S.focus = null
  S.anchor = null
  if ($('#search').value) {
    $('#search').value = ''
    S.query = M.parseQuery('')
  }
  lsSet('loc', loc)
  $('#list').scrollTop = 0
  render()
}

// ---------------------------------------------------------------------------
// Filas de la vista

function isFolder(it) {
  return it.kind === 'col' || it.kind === 'tagdir' || it.kind === 'panel' || it.kind === 'pinnedf' || (it.kind === 'tab' && it.kids.length > 0)
}

function sortItems(arr) {
  const s = S.settings.sort
  const kindRank = it => (isFolder(it) ? 0 : 1)
  if (s === 'natural') return arr
  const cmp = {
    title: (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }),
    domain: (a, b) => (a.domain || '').localeCompare(b.domain || '') || (a.title || '').localeCompare(b.title || ''),
    recent: (a, b) => (b.last || 0) - (a.last || 0),
  }[s]
  return [...arr].sort((a, b) => kindRank(a) - kindRank(b) || cmp(a, b))
}

function treeMode() {
  return S.settings.view === 'details' && S.settings.sort === 'natural' && S.query.empty && ['panel', 'folder', 'all', 'pinned'].includes(S.loc.t)
}

function buildRows() {
  let base
  if (!S.query.empty) base = subtree(S.loc).filter(it => M.matches(it, S.query))
  else base = contents(S.loc)
  base = sortItems(base.filter(Boolean))
  const rows = []
  if (treeMode()) {
    const walk = (it, lvl) => {
      rows.push({ it, lvl })
      if (it.kind === 'panel' && S.expandedP.has(it.key)) for (const c of tabsOfPanel(it.win, it.panel).filter(t => t.parent === -1)) walk(c, lvl + 1)
      if (it.kind === 'pinnedf' && S.expandedP.has(it.key)) for (const c of contents({ t: 'pinned', w: it.win })) walk(c, lvl + 1)
      if (it.kids && it.kids.length && S.expanded.has(it.id)) for (const k of it.kids) {
        const c = tabItem(k)
        if (c) walk(c, lvl + 1)
      }
    }
    for (const it of base) walk(it, 0)
  } else {
    for (const it of base) rows.push({ it, lvl: 0 })
  }
  S.rows = rows
}

// ---------------------------------------------------------------------------
// Pintar

function render() {
  buildRows()
  renderTree()
  renderCrumbs()
  renderMain()
  renderInspector()
  renderStatus()
}

const renderSoon = (() => {
  let raf = 0
  return () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      render()
    })
  }
})()

function renderCrumbs() {
  const parts = crumbsOf(S.loc)
  $('#crumbs').innerHTML = parts
    .map((p, i) => `${i ? '<span class="sep">›</span>' : ''}<a data-i="${i}" ${p.loc ? `data-drop-loc='${esc(locKey(p.loc))}'` : ''}>${esc(p.label)}</a>`)
    .join('')
  $('#crumbs').onclick = e => {
    const a = e.target.closest('a')
    if (!a) return
    const p = parts[+a.dataset.i]
    if (p.loc) go(p.loc)
  }
  $('#btnBack').disabled = !S.hist.length
  $('#btnFwd').disabled = !S.fwd.length
  $('#btnUp').disabled = !parentLoc(S.loc)
  document.title = `${locTitle(S.loc)} · Pestañario`
}

// --- Árbol lateral

function tn({ loc, label, icon = '', count = '', lvl = 0, open = null, openKey = '', color = '', title = '' }) {
  const cur = loc && sameLoc(loc, S.loc) ? ' cur' : ''
  const tw = open === null ? '<span class="tw"></span>' : `<span class="tw" data-tog="${esc(openKey)}">${chev(open)}</span>`
  return `<div class="tn${cur}" style="padding-left:${6 + lvl * 14}px" data-loc='${esc(locKey(loc))}' data-drop-loc='${esc(locKey(loc))}' title="${esc(title || label)}">${tw}<span class="ti">${icon || (color ? `<span class="dot" style="background:${esc(color)}"></span>` : '')}</span><span class="tl">${esc(label)}</span>${count !== '' ? `<span class="tc">${count}</span>` : ''}</div>`
}

function chev(open) {
  return `<svg class="chev${open ? ' open' : ''}" viewBox="0 0 10 10"><path d="M3.5 1.5 7 5l-3.5 3.5"/></svg>`
}

function sec(key, label, extra = '') {
  const open = !S.treeOpen.has('x' + key)
  return [`<div class="tsec"><span class="tw" data-tog="x${key}" style="cursor:pointer">${chev(open)}</span><span class="grow" data-tog="x${key}" style="cursor:pointer">${label}</span>${extra}</div>`, open]
}

function renderTree() {
  const h = []
  const multi = S.wins.length > 1
  const hasSb = S.panelOrder.length > 0
  const allTabs = [...S.items.values()].filter(it => it.kind === 'tab')
  const curPanel = currentPanelKey()

  h.push(tn({ loc: { t: 'all' }, label: 'Todos los paneles', icon: '🗂', count: allTabs.length }))

  for (const w of S.wins) {
    const wk = 'w' + w.id
    let lvl = 0
    const [head, open] = sec(wk, multi ? `${esc(winName(w.id))}${w.focused ? ' · actual' : ''}` : 'Paneles de Sidebery')
    h.push(head)
    if (!open) continue
    const unknown = allTabs.filter(it => it.win === w.id && !it.pinned && !it.panel).length
    if (unknown) h.push(`<div class="hint">${unknown} pestañas aún sin panel: se ubican al abrir su panel en Sidebery. ${S.settings.hideInact ? '' : 'Con <b>«Hide native tabs of inactive panels»</b> activado en Sidebery se aprende el panel entero de golpe. <a href="#" data-act="setup">Cómo</a>'}</div>`)
    const pinned = allTabs.filter(it => it.win === w.id && it.pinned)
    if (pinned.length) h.push(tn({ loc: { t: 'pinned', w: w.id }, label: 'Fijadas', icon: '📌', count: pinned.length, lvl }))
    const names = S.panelOrder.slice()
    if (allTabs.some(it => it.win === w.id && !it.pinned && !it.panel)) names.push('')
    for (const name of names) {
      const tabs = allTabs.filter(it => it.win === w.id && !it.pinned && it.panel === name)
      const meta = S.panelMeta.get(name) || {}
      const pk = `p${w.id}|${name}`
      const roots = tabs.filter(it => it.parent === -1 && it.kids.length)
      const open = S.treeOpen.has(pk) || (curPanel === pk && !S.treeOpen.has('-' + pk))
      const icon = meta.icon ? `<img src="${esc(meta.icon)}" alt="">` : folderSmall(M.colorCss(meta.color) || (name ? hashColor(name) : ''))
      h.push(tn({ loc: { t: 'panel', w: w.id, p: name }, label: panelLabel(name), icon, color: M.colorCss(meta.color) || hashColor(name), count: tabs.length, lvl, open: roots.length ? open : null, openKey: pk }))
      if (open) for (const r of roots) treeFolder(h, r, lvl + 1)
    }
  }

  if (!hasSb) {
    h.push(`<div class="hint">Aún no sé cómo están organizados tus paneles de Sidebery. <b><a href="#" data-act="setup">Conectar con Sidebery</a></b> (dos minutos).</div>`)
  }

  // Colecciones
  const [colHead, colOpen] = sec('cols', 'Colecciones', `<button data-act="newcol" title="Nueva colección">＋</button>`)
  h.push(colHead)
  const colRec = (parent, lvl) => {
    for (const c of colChildren(parent)) {
      const kids = colChildren(c.id)
      const ck = 'c' + c.id
      const open = S.treeOpen.has(ck)
      const n = fichaItemsIn(new Set([c.id])).length
      h.push(tn({ loc: { t: 'col', id: c.id }, label: c.name, icon: folderSmall(c.color), count: n || '', lvl, open: kids.length ? open : null, openKey: ck }))
      if (open) colRec(c.id, lvl + 1)
    }
  }
  if (colOpen) colRec(null, 0)
  if (colOpen && !S.cols.size) h.push(`<div class="hint">Las colecciones son carpetas virtuales: una pestaña puede estar en varias a la vez (como un acceso directo) sin moverla de su panel. Arrastra pestañas aquí.</div>`)

  // Etiquetas
  if (S.tagCount.size) {
    const [tagHead, tagOpen] = sec('tags', 'Etiquetas')
    h.push(tagHead)
    const tagRec = (prefix, lvl) => {
      const list = [...S.tagCount.keys()].filter(t => (prefix ? t.startsWith(prefix + '/') && !t.slice(prefix.length + 1).includes('/') : !t.includes('/'))).sort()
      for (const t of list) {
        const hasKids = [...S.tagCount.keys()].some(x => x.startsWith(t + '/'))
        const k = 'g' + t
        const open = S.treeOpen.has(k)
        h.push(tn({ loc: { t: 'tag', tag: t }, label: t.split('/').pop(), icon: '#', count: S.tagCount.get(t), lvl, open: hasKids ? open : null, openKey: k }))
        if (open) tagRec(t, lvl + 1)
      }
    }
    if (tagOpen) tagRec('', 0)
  }

  // Biblioteca
  const [libHead, libOpen] = sec('lib', 'Biblioteca')
  h.push(libHead)
  const archived = [...S.items.values()].filter(it => it.kind === 'ficha').length
  if (libOpen) {
    h.push(tn({ loc: { t: 'cols' }, label: 'Todas las colecciones', icon: '📚', count: S.cols.size }))
    h.push(tn({ loc: { t: 'tags' }, label: 'Todas las etiquetas', icon: '#', count: S.tagCount.size }))
    h.push(tn({ loc: { t: 'saved' }, label: 'Fichas', icon: '🗃', count: S.fichas.size, title: 'Pestañas con etiquetas, notas, vínculos o colecciones' }))
    h.push(tn({ loc: { t: 'archive' }, label: 'Archivo (cerradas)', icon: '📦', count: archived }))
  }

  $('#tree').innerHTML = h.join('')
}

// Panel y carpetas que contienen la ubicación actual: se despliegan solos
function currentPanelKey() {
  const l = S.loc
  if (l.t === 'panel') return `p${l.w}|${l.p}`
  if (l.t === 'folder') {
    const it = tabItem(l.id)
    return it ? `p${it.win}|${it.panel}` : null
  }
  return null
}

function ancestorsOfLoc() {
  const set = new Set()
  if (S.loc.t !== 'folder') return set
  let p = S.info.get(S.loc.id)?.parent
  while (p !== undefined && p !== -1) {
    set.add(p)
    p = S.info.get(p)?.parent
  }
  return set
}

function treeFolder(h, it, lvl, anc = ancestorsOfLoc()) {
  const k = 't' + it.id
  const open = S.treeOpen.has(k) || (anc.has(it.id) && !S.treeOpen.has('-' + k))
  const sub = it.kids.map(tabItem).filter(c => c && c.kids.length)
  h.push(tn({ loc: { t: 'folder', id: it.id }, label: it.title, icon: favHtml(it), count: it.kids.length, lvl, open: sub.length ? open : null, openKey: k, color: it.sbColor }))
  if (open) for (const c of sub) treeFolder(h, c, lvl + 1, anc)
}

// --- Vista principal

const listEl = () => $('#list')

function renderMain() {
  const view = S.settings.view
  const list = listEl()
  const graph = $('#graph')
  const empty = $('#empty')
  $('#colhead').hidden = view !== 'details'
  list.hidden = view === 'graph'
  graph.hidden = view !== 'graph'
  if (view === 'graph') {
    empty.hidden = true
    Graph.show(graph, graphData(), { onSelect: k => selectOnly(k), onOpen: k => openItem(S.items.get(k)) })
    return
  }
  Graph.hide()
  empty.hidden = S.rows.length > 0
  if (!S.rows.length) {
    empty.textContent = S.query.empty ? emptyText() : 'No hay resultados.'
  }
  if (view === 'details') renderDetails()
  else renderIcons()
}

function emptyText() {
  switch (S.loc.t) {
    case 'col':
      return 'Colección vacía. Arrastra aquí pestañas o fichas: quedan como acceso directo, sin moverse de su panel.'
    case 'archive':
      return 'Aquí aparecen las fichas cuya pestaña está cerrada.'
    case 'saved':
      return 'Una pestaña pasa a ser ficha cuando le pones etiquetas, una nota, un color, un vínculo o la metes en una colección.'
    case 'tags':
      return 'Aún no hay etiquetas. Selecciona pestañas y pulsa T.'
    default:
      return 'Carpeta vacía.'
  }
}

function renderDetails() {
  const sortCol = S.settings.sort
  const cols = [
    ['title', 'Nombre'],
    ['', 'Panel'],
    ['', 'Etiquetas'],
    ['domain', 'Web'],
    ['recent', 'Último uso'],
    ['', 'Estado'],
  ]
  $('#colhead').innerHTML = cols.map(([k, l]) => `<div data-sort="${k}">${l}${k && k === sortCol ? ' ▾' : ''}</div>`).join('')
  const list = listEl()
  const rowH = list.querySelector('.r')?.offsetHeight || parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 28
  S.rowH = rowH
  $('#sizer').style.height = S.rows.length * rowH + 'px'
  const top = list.scrollTop
  const start = Math.max(0, Math.floor(top / rowH) - 8)
  const end = Math.min(S.rows.length, Math.ceil((top + list.clientHeight) / rowH) + 8)
  const win = $('#win')
  win.style.transform = `translateY(${start * rowH}px)`
  const tm = treeMode()
  let html = ''
  for (let i = start; i < end; i++) html += rowHtml(S.rows[i], i, tm)
  win.innerHTML = html
}

// Circulito: relleno = cargada, vacío = dormida, discontinuo = cerrada (ficha)
function loadMark(it) {
  if (it.kind === 'tab') return it.discarded ? '<span class="ld off" title="Dormida (sin cargar)"></span>' : '<span class="ld on" title="Cargada"></span>'
  if (it.kind === 'ficha') return '<span class="ld cl" title="Cerrada (guardada)"></span>'
  return '<span class="ld"></span>'
}

function folderSmall(color) {
  return `<span class="foldersm" style="${color ? `--fc:${esc(color)}` : ''}"><svg viewBox="0 0 64 52"><path d="M2 8a5 5 0 0 1 5-5h16l6 6h28a5 5 0 0 1 5 5v31a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5z"/><path class="front" d="M2 18a5 5 0 0 1 5-5h50a5 5 0 0 1 5 5v27a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5z"/></svg></span>`
}

function rowHtml(r, i, tm) {
  const it = r.it
  const cls = ['r']
  if (S.sel.has(it.key)) cls.push('sel')
  if (S.focus === it.key) cls.push('foc')
  if (S.cut && S.cut.has(it.key)) cls.push('cut')
  if (it.discarded || it.kind === 'ficha') cls.push('dim')
  const stripe = it.sbColor || it.color || ''
  let tw = '<span class="tw"></span>'
  if (tm && it.kind === 'tab' && it.kids.length) tw = `<span class="tw" data-exp="${it.id}">${chev(S.expanded.has(it.id))}</span>`
  if (tm && it.kind === 'panel') tw = `<span class="tw" data-expp="${esc(it.key)}">${chev(S.expandedP.has(it.key))}</span>`
  let icon
  if (it.kind === 'col' || it.kind === 'panel' || it.kind === 'pinnedf') icon = folderSmall(it.kind === 'pinnedf' ? '' : it.color)
  else if (it.kind === 'tab' && it.kids.length) icon = folderSmall(it.sbColor || it.color) + favHtml(it)
  else if (it.kind === 'tagdir') icon = '<span class="fav ph" style="background:none;color:var(--acc);font-size:14px">#</span>'
  else icon = favHtml(it)
  const badges = []
  if (it.kind === 'tab' && it.kids.length) badges.push(`<span class="badge" title="Pestañas hijas">${it.kids.length}</span>`)
  if (it.cols && it.cols.length) badges.push(`<span class="badge" title="En colecciones: ${esc(it.cols.join(', '))}">🔗${it.cols.length}</span>`)
  if (it.note) badges.push(`<span class="badge" title="Tiene nota">✎</span>`)
  if (it.links && it.links.length) badges.push(`<span class="badge" title="Vínculos">⇄${it.links.length}</span>`)
  if (it.color) badges.push(`<span class="dot" style="background:${esc(it.color)};margin-left:4px"></span>`)
  let panel = ''
  if (it.kind === 'tab' || it.kind === 'ficha') {
    const meta = S.panelMeta.get(it.panel) || {}
    const c = M.colorCss(meta.color) || (it.panel ? hashColor(it.panel) : '')
    panel = it.panel || it.kind === 'tab' ? `<span class="dot" style="background:${c}"></span> ${esc(it.kind === 'tab' ? panelLabel(it.panel) : it.panel)}${it.kind === 'tab' && !it.sure && !it.pinned ? ' <span class="muted" title="Deducido por posición">?</span>' : ''}` : ''
  } else if (it.kind === 'col') {
    panel = 'Colección'
  } else if (it.kind === 'panel' || it.kind === 'pinnedf') {
    panel = S.wins.length > 1 ? esc(winName(it.win)) : 'Panel de Sidebery'
  } else panel = 'Etiqueta'
  const tags = (it.tags || []).slice(0, 4).map(t => `<span class="tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')
  let st = ''
  if (it.kind === 'tab') {
    const f = []
    if (it.active) f.push('●')
    if (it.audible) f.push(it.muted ? '🔇' : '🔊')
    if (it.discarded) f.push('💤')
    if (it.pinned) f.push('📌')
    if (it.container) f.push(`<span title="Contenedor ${esc(it.container)}" style="color:${esc(it.containerColor)}">▣</span>`)
    st = f.join(' ')
  } else if (it.kind === 'ficha') st = 'cerrada'
  else if (it.kind === 'col') st = fichaItemsIn(new Set([it.id])).length + ' elem.'
  else if (it.kind === 'panel' || it.kind === 'pinnedf') st = it.count + ' pest.'
  else if (it.kind === 'tagdir') st = (S.tagCount.get(it.tag) || 0) + ' elem.'
  const title = esc(it.title) + (it.customTitle && it.customTitle !== it.realTitle ? '' : '')
  return `<div class="${cls.join(' ')}" data-key="${esc(it.key)}" data-i="${i}" draggable="true" style="--lvl:${r.lvl};${stripe ? `border-left-color:${esc(stripe)}` : ''}" title="${esc(it.url || it.title)}">
<div class="c0">${tw}${loadMark(it)}${icon}<span class="nm">${title}</span>${badges.join('')}</div>
<div class="sub">${panel}</div><div>${tags}</div><div class="sub">${esc(it.domain || '')}</div><div class="sub">${it.kind === 'tab' || it.kind === 'ficha' ? ago(it.last) : ''}</div><div class="st">${st}</div></div>`
}

// --- Miniaturas

function gridGeom() {
  const w = CARD[S.settings.zoom] || 200
  const gap = 12
  const cardH = Math.round(w * 0.62) + 46 + gap
  const width = listEl().clientWidth - gap
  const cols = Math.max(1, Math.floor(width / (w + gap)))
  return { w, gap, cardH, cols }
}

function renderIcons() {
  const list = listEl()
  const g = gridGeom()
  S.grid = g
  document.documentElement.style.setProperty('--card-w', g.w + 'px')
  document.documentElement.style.setProperty('--card-h', g.cardH + 'px')
  document.documentElement.style.setProperty('--gap', g.gap + 'px')
  const nRows = Math.ceil(S.rows.length / g.cols)
  $('#sizer').style.height = nRows * g.cardH + g.gap + 'px'
  const top = list.scrollTop
  const r0 = Math.max(0, Math.floor(top / g.cardH) - 2)
  const r1 = Math.min(nRows, Math.ceil((top + list.clientHeight) / g.cardH) + 2)
  $('#win').style.transform = `translateY(${r0 * g.cardH}px)`
  let html = ''
  for (let r = r0; r < r1; r++) {
    html += '<div class="grow-row">'
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c
      if (i >= S.rows.length) break
      html += cardHtml(S.rows[i].it, i)
    }
    html += '</div>'
  }
  $('#win').innerHTML = html
}

// Carpeta grande (con color e icono encima) para la vista de miniaturas
function folderBig(color, overlay, count) {
  return `<span class="folderbig" style="${color ? `--fc:${esc(color)}` : ''}"><svg viewBox="0 0 64 52"><path d="M2 8a5 5 0 0 1 5-5h16l6 6h28a5 5 0 0 1 5 5v31a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5z"/><path class="front" d="M2 18a5 5 0 0 1 5-5h50a5 5 0 0 1 5 5v27a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5z"/></svg>${overlay ? `<span class="ov">${overlay}</span>` : ''}</span>${count ? `<span class="kids">${count}</span>` : ''}`
}

function cardHtml(it, i) {
  const cls = ['c']
  if (S.sel.has(it.key)) cls.push('sel')
  if (S.focus === it.key) cls.push('foc')
  if (S.cut && S.cut.has(it.key)) cls.push('cut')
  if (it.discarded || it.kind === 'ficha') cls.push('dim')
  let th
  let bg = ''
  if (it.kind === 'col' || it.kind === 'panel' || it.kind === 'pinnedf') th = folderBig(it.kind === 'pinnedf' ? '' : it.color, it.kind === 'pinnedf' ? '📌' : '', it.count)
  else if (it.kind === 'tagdir') th = `<span class="folder" style="color:var(--acc)">#</span>`
  else if (it.kind === 'tab' && it.kids.length) th = folderBig(it.sbColor || it.color, favHtml(it), it.kids.length)
  else {
    const yt = M.youtubeId(it.url)
    const t = yt ? null : thumbFor(it.nurl)
    if (yt) bg = `background-image:${S.settings.zoom >= 3 ? `url('${M.youtubeThumb(yt, true)}'), ` : ''}url('${M.youtubeThumb(yt)}')`
    else if (t) bg = `background-image:url('${t}')`
    th = yt ? '<span class="play">▶</span>' : t ? '' : `<span class="big" style="background:${hashColor(it.domain || it.title || '')}">${favOk(it.fav) ? `<img src="${esc(it.fav)}" alt="">` : esc((it.domain || it.title || '?')[0].toUpperCase())}</span>`
    const fl = []
    if (it.kind === 'tab' || it.kind === 'ficha') fl.push(`<span class="ldw">${loadMark(it)}</span>`)
    if (it.pinned) fl.push('📌')
    if (it.audible) fl.push(it.muted ? '🔇' : '🔊')
    if (it.cols && it.cols.length) fl.push('🔗')
    if (it.note) fl.push('✎')
    if (fl.length) th += `<span class="flags">${fl.map(f => (f.startsWith('<span class="ldw') ? f : `<span>${f}</span>`)).join('')}</span>`
  }
  const sbc = it.sbColor || it.color || ''
  return `<div class="${cls.join(' ')}" data-key="${esc(it.key)}" data-i="${i}" draggable="true" title="${esc((it.title || '') + (it.url ? '\n' + it.url : ''))}">
<div class="th" style="${bg};${sbc ? `--sbc:${esc(sbc)}` : ''}">${th}</div>
<div class="cap">${it.kind === 'tab' || it.kind === 'ficha' ? favHtml(it) : ''}<span class="nm">${esc(it.title)}</span></div></div>`
}

// Miniaturas guardadas (carga perezosa y caché limitada)
const thumbQueue = new Set()
function thumbFor(nurl) {
  if (!nurl) return null
  if (S.thumbs.has(nurl)) return S.thumbs.get(nurl)
  thumbQueue.add(nurl)
  loadThumbsSoon()
  return null
}
const loadThumbsSoon = debounce(async () => {
  const keys = [...thumbQueue]
  thumbQueue.clear()
  let found = false
  const db = await DB.open()
  await new Promise(resolve => {
    const tx = db.transaction('thumbs')
    const st = tx.objectStore('thumbs')
    for (const k of keys) {
      const req = st.get(k)
      req.onsuccess = () => {
        const v = req.result
        if (v && v.blob) {
          S.thumbs.set(k, URL.createObjectURL(v.blob))
          found = true
        } else S.thumbs.set(k, '')
      }
    }
    tx.oncomplete = resolve
    tx.onerror = resolve
  })
  while (S.thumbs.size > 600) {
    const [k, v] = S.thumbs.entries().next().value
    if (v) URL.revokeObjectURL(v)
    S.thumbs.delete(k)
  }
  if (found && S.settings.view === 'icons') renderMain()
}, 30)

function dropThumb(nurl) {
  const v = S.thumbs.get(nurl)
  if (v) URL.revokeObjectURL(v)
  S.thumbs.delete(nurl)
}

// --- Barra de estado

function renderStatus() {
  const n = S.rows.length
  const sel = S.sel.size
  const tabs = [...S.items.values()].filter(it => it.kind === 'tab')
  const unsure = tabs.filter(it => !it.sure && !it.pinned).length
  const imp = S.sbImport
  const parts = [`<span>${n} elementos${sel ? ` · ${sel} seleccionados` : ''}</span>`, '<span class="msg grow"></span>']
  if (imp) parts.push(`<span title="Datos importados de Sidebery">Sidebery: ${imp.panels.length} paneles · importado ${ago(imp.importedAt || imp.time)}</span>`)
  if (unsure && S.panelOrder.length) parts.push(`<span class="warn" data-act="setup" title="Pestañas cuyo panel se deduce por posición">${unsure} sin confirmar</span>`)
  $('#status').innerHTML = parts.join('')
}

// ---------------------------------------------------------------------------
// Panel de detalles (inspector)

function selectedItems() {
  return [...S.sel].map(k => S.items.get(k)).filter(Boolean)
}

function renderInspector() {
  if (!S.settings.insp) return
  const el = $('#inspector')
  const items = selectedItems()
  const ae = document.activeElement
  if (ae && el.contains(ae) && ae.matches('[data-act="note"], [data-act="alias"], [data-act="link"]')) {
    // No pisar lo que se está escribiendo
    if (el.dataset.key === (items[0] && items[0].key)) return
  }
  el.dataset.key = items.length === 1 ? items[0].key : ''
  if (!items.length) {
    el.innerHTML = inspectorLocation()
    return
  }
  if (items.length > 1) {
    el.innerHTML = inspectorMulti(items)
    return
  }
  const it = items[0]
  if (it.kind === 'panel' || it.kind === 'pinnedf') {
    const loc0 = S.loc
    S.loc = it.kind === 'panel' ? { t: 'panel', w: it.win, p: it.panel } : { t: 'pinned', w: it.win }
    el.innerHTML = inspectorLocation()
    S.loc = loc0
  } else if (it.kind === 'col') el.innerHTML = inspectorCol(it)
  else if (it.kind === 'tagdir') el.innerHTML = inspectorTag(it)
  else el.innerHTML = inspectorItem(it)
}

function inspectorLocation() {
  const loc = S.loc
  let h = `<h2>${esc(locTitle(loc))}</h2>`
  if (loc.t === 'panel') {
    const tabs = tabsOfPanel(loc.w, loc.p)
    const meta = S.panelMeta.get(loc.p) || {}
    h += `<div class="kv"><div>Pestañas</div><div>${tabs.length}</div><div>Dormidas</div><div>${tabs.filter(t => t.discarded).length}</div><div>Color</div><div><span class="dot" style="background:${M.colorCss(meta.color) || hashColor(loc.p)}"></span> ${esc(meta.color || '—')}</div></div>`
    h += `<p class="small muted">Arrastra pestañas a este panel desde la lista o el árbol: Sidebery las moverá también.</p>`
  }
  h += `<div class="sect"><div class="lbl">Selecciona algo</div><p class="small muted">Clic para seleccionar, Ctrl/Mayús para varias. Doble clic o Intro para ir a la pestaña. Clic derecho para más opciones.</p></div>`
  return h
}

function inspectorMulti(items) {
  const tabs = items.filter(i => i.kind === 'tab')
  return `<h2>${items.length} seleccionados</h2>
<div class="kv"><div>Pestañas</div><div>${tabs.length}</div><div>Cerradas</div><div>${items.filter(i => i.kind === 'ficha').length}</div></div>
<div class="sect"><div class="lbl">Añadir etiqueta</div><div class="chips"><input type="text" data-act="bulk-tag" placeholder="etiqueta y Intro" list="taglist">${tagDatalist()}</div></div>
<div class="sect"><div class="lbl">Color</div>${swatches('', 'bulk-color')}</div>
<div class="btns">
  <button data-act="tocol">Añadir a colección…</button>
  ${tabs.length ? '<button data-act="topanel">Mover a panel…</button><button data-act="discard">Dormir</button><button data-act="archive">Archivar y cerrar</button><button class="danger" data-act="close">Cerrar</button>' : ''}
</div>`
}

function inspectorCol(it) {
  const c = S.cols.get(it.id)
  const n = fichaItemsIn(colDescendants(it.id)).length
  return `<h2>📁 ${esc(c.name)}</h2>
<div class="kv"><div>Elementos</div><div>${n}</div><div>Subcolecciones</div><div>${colChildren(it.id).length}</div><div>Creada</div><div>${ago(c.created)}</div></div>
<div class="sect"><div class="lbl">Color</div>${swatches(c.color, 'col-color')}</div>
<div class="btns"><button data-act="enter">Abrir</button><button data-act="rename">Renombrar</button><button data-act="openall">Abrir todas</button><button class="danger" data-act="delcol">Eliminar</button></div>
<p class="small muted">Eliminar una colección no borra sus fichas ni cierra pestañas.</p>`
}

function inspectorTag(it) {
  return `<h2>#${esc(it.tag)}</h2>
<div class="kv"><div>Elementos</div><div>${S.tagCount.get(it.tag) || 0}</div></div>
<div class="btns"><button data-act="enter">Abrir</button><button data-act="renametag">Renombrar</button><button class="danger" data-act="deltag">Quitar de todas</button></div>`
}

function swatches(cur, act) {
  return `<div class="swatches">${['', ...OWN_COLORS].map(c => `<span class="sw${c ? '' : ' none'}${(cur || '') === c ? ' on' : ''}" data-act="${act}" data-color="${c}" style="${c ? `background:${c}` : ''}" title="${c ? c : 'Sin color'}"></span>`).join('')}</div>`
}

function tagDatalist() {
  return `<datalist id="taglist">${[...S.tagCount.keys()].sort().map(t => `<option value="${esc(t)}">`).join('')}</datalist>`
}

function linkRow(it, text, extra = '') {
  if (!it) return `<div class="link missing">○ <span class="nm">${esc(text)}</span>${extra}</div>`
  return `<div class="link" data-goto="${esc(it.key)}">${favHtml(it)}<span class="nm">${esc(it.title)}</span>${it.open ? '' : '<span class="muted small">cerrada</span>'}${extra}</div>`
}

function backlinks(it) {
  const out = []
  for (const f of S.fichas.values()) {
    if (f.url === it.nurl) continue
    const direct = (f.links || []).includes(it.nurl)
    const wiki = M.wikiLinks(f.note).some(t => {
      const r = resolveLink(t)
      return r && r.nurl === it.nurl
    })
    if (direct || wiki) out.push(itemForUrl(f.url))
  }
  return out.filter(Boolean)
}

function inspectorItem(it) {
  const f = fichaFor(it.nurl)
  const meta = S.panelMeta.get(it.panel) || {}
  const yt = M.youtubeId(it.url)
  const thumb = yt ? M.youtubeThumb(yt, true) : it.nurl && S.thumbs.get(it.nurl)
  const kv = []
  if (it.kind === 'tab') {
    kv.push(['Panel', `<span class="dot" style="background:${M.colorCss(meta.color) || hashColor(it.panel || '')}"></span> ${esc(panelLabel(it.panel))}${it.sure || it.pinned ? '' : ' <span class="muted">(deducido)</span>'}`])
    if (it.sbColor) kv.push(['Color Sidebery', `<span class="dot" style="background:${esc(it.sbColor)}"></span> ${esc(it.colorName)}`])
    if (it.customTitle) kv.push(['Título Sidebery', esc(it.customTitle)])
    if (it.parent !== -1) kv.push(['Dentro de', `<a data-goto="t:${it.parent}" href="#">${esc(tabItem(it.parent)?.title || '')}</a>`])
    if (it.kids.length) kv.push(['Contiene', `${it.kids.length} pestañas`])
    kv.push(['Estado', [it.active ? 'activa' : '', it.discarded ? 'dormida' : 'cargada', it.audible ? 'con sonido' : '', it.pinned ? 'fijada' : ''].filter(Boolean).join(', ')])
    if (it.container) kv.push(['Contenedor', `<span style="color:${esc(it.containerColor)}">▣</span> ${esc(it.container)}`])
    kv.push(['Último uso', ago(it.last)])
  } else {
    kv.push(['Estado', 'cerrada (guardada)'])
    if (it.panel) kv.push(['Último panel', esc(it.panel)])
  }
  if (f) kv.push(['Ficha', `creada ${ago(f.created)}`])

  const ownTags = (f && f.tags) || []
  const noteOnly = it.tags.filter(t => !ownTags.includes(t))
  const links = (f && f.links) || []
  const wikis = f ? M.wikiLinks(f.note) : []
  const back = backlinks(it)
  const cols = f ? (f.cols || []).filter(id => S.cols.has(id)) : []

  return `<h2>${it.kind === 'tab' || it.kind === 'ficha' ? favHtml(it) + ' ' : ''}${esc(it.title)}</h2>
<div class="url" data-act="copyurl" title="Copiar dirección">${esc(it.url)}</div>
${thumb ? `<img class="thumb" src="${esc(thumb)}" alt=""${yt ? ` data-fallback="${esc(M.youtubeThumb(yt))}"` : ''}>` : ''}
<div class="btns">
  ${it.kind === 'tab' ? `<button class="primary" data-act="activate">Ir a la pestaña</button>${it.kids.length ? '<button data-act="enter">Abrir carpeta</button>' : ''}<button data-act="discard" title="Liberar memoria">Dormir</button><button data-act="archive" title="Guardar como ficha y cerrar">Archivar</button><button class="danger" data-act="close">Cerrar</button>` : `<button class="primary" data-act="reopen">Abrir</button><button data-act="reopenpanel">Abrir en panel…</button><button class="danger" data-act="delficha">Borrar ficha</button>`}
</div>
<div class="sect"><div class="kv">${kv.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div></div>
<div class="sect"><div class="lbl">Nombre propio</div><input type="text" data-act="alias" value="${esc((f && f.alias) || '')}" placeholder="${esc(it.realTitle || it.title)}" style="width:100%"></div>
<div class="sect"><div class="lbl">Etiquetas</div><div class="chips">${ownTags.map(t => `<span class="tag" data-tag="${esc(t)}">#${esc(t)}<span class="x" data-untag="${esc(t)}">✕</span></span>`).join('')}${noteOnly.map(t => `<span class="tag" data-tag="${esc(t)}" title="Desde la nota" style="opacity:.7">#${esc(t)}</span>`).join('')}<input type="text" data-act="tag" placeholder="añadir…" list="taglist">${tagDatalist()}</div></div>
<div class="sect"><div class="lbl">Color propio</div>${swatches(f && f.color, 'color')}</div>
<div class="sect"><div class="lbl"><span class="grow">Colecciones</span><button data-act="tocol" style="font-size:11px;padding:0 6px">＋</button></div><div class="chips">${cols.length ? cols.map(id => `<span class="tag" data-gocol="${esc(id)}">📁 ${esc(S.cols.get(id).name)}<span class="x" data-uncol="${esc(id)}">✕</span></span>`).join('') : '<span class="muted small">Ninguna</span>'}</div></div>
<div class="sect"><div class="lbl"><span class="grow">Vínculos</span></div>
  ${links.map(u => linkRow(itemForUrl(u), u, `<span class="x" data-unlink="${esc(u)}" title="Quitar vínculo">✕</span>`)).join('')}
  <input type="text" data-act="link" placeholder="Vincular con… (título o dirección)" list="linklist" style="width:100%;margin-top:4px">
  <datalist id="linklist"></datalist>
  ${wikis.length ? `<div class="small muted" style="margin-top:6px">En la nota:</div>${wikis.map(w => linkRow(resolveLink(w), w)).join('')}` : ''}
  ${back.length ? `<div class="small muted" style="margin-top:6px">Le enlazan (${back.length}):</div>${back.map(b => linkRow(b, '')).join('')}` : ''}
</div>
<div class="sect"><div class="lbl">Nota</div><textarea data-act="note" placeholder="Escribe en Markdown. [[Título o dirección]] enlaza otra pestaña; #etiqueta añade etiquetas.">${esc((f && f.note) || '')}</textarea></div>`
}

function fillLinkList(input) {
  const q = input.value.toLowerCase()
  if (q.length < 2) return
  const out = []
  for (const it of S.items.values()) {
    if (it.kind !== 'tab' && it.kind !== 'ficha') continue
    if ((it.title || '').toLowerCase().includes(q) || (it.url || '').toLowerCase().includes(q)) out.push(it)
    if (out.length > 30) break
  }
  $('#linklist').innerHTML = out.map(it => `<option value="${esc(it.url)}">${esc(it.title)}</option>`).join('')
}

// ---------------------------------------------------------------------------
// Fichas (base de datos)

function emptyFicha(f) {
  return !(f.tags && f.tags.length) && !f.note && !f.color && !(f.links && f.links.length) && !(f.cols && f.cols.length) && !f.keep && !f.alias
}

async function editFichas(items, fn) {
  const puts = []
  const dels = []
  for (const it of items) {
    if (!it || !(it.kind === 'tab' || it.kind === 'ficha')) continue
    const old = S.fichas.get(it.nurl)
    const f = old ? { ...old, tags: [...(old.tags || [])], links: [...(old.links || [])], cols: [...(old.cols || [])] } : { url: it.nurl, tags: [], note: '', color: '', links: [], cols: [], created: Date.now() }
    fn(f, it)
    if (it.kind === 'tab') {
      f.rawUrl = it.url
      f.title = it.realTitle || f.title
      if (favOk(it.fav) && String(it.fav).length < 8000) f.fav = it.fav
      if (it.panel) f.panel = it.panel
      if (it.colorName) f.sbColor = it.colorName
    }
    f.updated = Date.now()
    if (emptyFicha(f)) {
      if (old) {
        S.fichas.delete(f.url)
        dels.push(f.url)
      }
    } else {
      S.fichas.set(f.url, f)
      puts.push(f)
    }
  }
  if (puts.length) await DB.putMany('fichas', puts)
  for (const u of dels) await DB.del('fichas', u)
  bc.postMessage({ type: 'db' })
  buildItems()
  render()
}

async function saveCol(c) {
  S.cols.set(c.id, c)
  await DB.put('cols', c)
  bc.postMessage({ type: 'db' })
  buildItems()
  render()
}

async function newCollection(parent = null, items = []) {
  const name = await ask('Nueva colección', '', 'Nombre')
  if (!name) return null
  const c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, parent, color: '', created: Date.now() }
  await saveCol(c)
  if (items.length) await addToCol(items, c.id)
  return c
}

async function addToCol(items, colId, moveFrom = null) {
  await editFichas(items, f => {
    if (moveFrom) f.cols = f.cols.filter(c => c !== moveFrom)
    if (!f.cols.includes(colId)) f.cols.push(colId)
  })
  toast(`${items.length} en «${S.cols.get(colId)?.name}»`)
}

async function deleteCol(id) {
  const ids = colDescendants(id)
  const affected = [...S.fichas.values()].filter(f => (f.cols || []).some(c => ids.has(c))).map(f => itemForUrl(f.url))
  if (!(await confirmDlg(`¿Eliminar la colección «${S.cols.get(id).name}» y sus subcolecciones? Las pestañas y fichas no se borran.`))) return
  for (const c of ids) {
    S.cols.delete(c)
    await DB.del('cols', c)
  }
  await editFichas(affected, f => (f.cols = f.cols.filter(c => !ids.has(c))))
  if (S.loc.t === 'col' && ids.has(S.loc.id)) go({ t: 'cols' })
}

async function renameTag(from, to) {
  to = M.cleanTag(to)
  if (!to || to === from) return
  const items = [...S.fichas.values()].map(f => itemForUrl(f.url)).filter(Boolean)
  await editFichas(items, f => {
    f.tags = [...new Set(f.tags.map(t => (t === from ? to : t.startsWith(from + '/') ? to + t.slice(from.length) : t)))]
    if (f.note) f.note = f.note.replace(new RegExp(`(^|[\\s(])#${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s/.,;:!?)]|$)`, 'gu'), `$1#${to}`)
  })
  if (S.loc.t === 'tag' && (S.loc.tag === from || S.loc.tag.startsWith(from + '/'))) go({ t: 'tag', tag: to + S.loc.tag.slice(from.length) }, false)
}

async function deleteTag(tag) {
  if (!(await confirmDlg(`¿Quitar #${tag} (y sus subetiquetas) de todas las fichas?`))) return
  const items = [...S.fichas.values()].map(f => itemForUrl(f.url)).filter(Boolean)
  await editFichas(items, f => (f.tags = f.tags.filter(t => t !== tag && !t.startsWith(tag + '/'))))
  if (S.loc.t === 'tag') go({ t: 'tags' })
}

// ---------------------------------------------------------------------------
// Acciones sobre pestañas

async function activate(it) {
  if (!it || it.kind !== 'tab') return
  await browser.tabs.update(it.id, { active: true })
  await browser.windows.update(it.win, { focused: true })
}

function openItem(it, opts = {}) {
  if (!it) return
  if (it.kind === 'col') return go({ t: 'col', id: it.id })
  if (it.kind === 'tagdir') return go({ t: 'tag', tag: it.tag })
  if (it.kind === 'panel') return go({ t: 'panel', w: it.win, p: it.panel })
  if (it.kind === 'pinnedf') return go({ t: 'pinned', w: it.win })
  if (it.kind === 'ficha') return reopen([it])
  if (opts.enter && it.kids && it.kids.length) return go({ t: 'folder', id: it.id })
  return activate(it)
}

async function reopen(items, panel = null, win = null) {
  const created = []
  for (const it of items) {
    if (!it || it.kind !== 'ficha') continue
    let index
    let windowId = win || (S.wins.find(w => w.focused) || S.wins[0])?.id
    const target = panel !== null ? lastOfPanel(windowId, panel) : null
    if (target) index = S.info.get(target.id).tab.index + 1
    try {
      const t = await browser.tabs.create({ url: it.url, active: items.length === 1, discarded: items.length > 1 && !it.url.startsWith('about:'), windowId, ...(index !== undefined ? { index } : {}), ...(items.length > 1 ? { title: it.title } : {}) })
      created.push(t.id)
    } catch {
      try {
        const t = await browser.tabs.create({ url: it.url, active: items.length === 1, windowId })
        created.push(t.id)
      } catch (e) {
        toast('No se pudo abrir: ' + it.url)
      }
    }
  }
  if (panel !== null && created.length) {
    // Sidebery coloca las pestañas nuevas a su manera; después se llevan al panel pedido.
    await new Promise(r => setTimeout(r, 400))
    await refresh()
    await moveTabs(created, { panel, win: win || (S.wins.find(w => w.focused) || S.wins[0]).id, end: true })
  }
}

function lastOfPanel(win, panel) {
  const tabs = tabsOfPanelAll(win, panel)
  return tabs[tabs.length - 1] || null
}

// Incluye la propia pestaña del explorador (es una pestaña real dentro de un panel)
function tabsOfPanelAll(win, panel) {
  const out = []
  for (const i of S.info.values()) if (i.win === win && i.panel === panel && !i.tab.pinned) out.push(i)
  return out.sort((a, b) => a.tab.index - b.tab.index)
}

function descendants(id, acc = []) {
  for (const k of S.info.get(id)?.kids || []) {
    acc.push(k)
    descendants(k, acc)
  }
  return acc
}

// Mover pestañas (con sus hijas) de forma que Sidebery lo refleje.
// target: { win, panel, end } | { after: id } | { before: id } | { into: id }
async function moveTabs(ids, target) {
  let anchor
  let win
  let panel
  if (target.end) {
    win = target.win
    panel = target.panel
    const last = lastOfPanel(win, panel)
    if (!last) {
      toast('Ese panel está vacío en esta ventana: Sidebery no deja meter pestañas desde fuera en un panel vacío. Abre una pestaña en él primero.', 7000)
      return false
    }
    anchor = { after: last.id }
    const extra = descendants(last.id)
    if (extra.length) anchor = { after: extra[extra.length - 1] }
  } else if (target.into !== undefined) {
    const i = S.info.get(target.into)
    win = i.win
    panel = i.panel
    if (i.kids.length) anchor = { after: target.into }
    else {
      const d = descendants(target.into)
      anchor = { after: d.length ? d[d.length - 1] : target.into }
    }
  } else {
    const ref = target.after !== undefined ? target.after : target.before
    const i = S.info.get(ref)
    win = i.win
    panel = i.panel
    if (target.after !== undefined) {
      const d = descendants(ref)
      anchor = { after: d.length ? d[d.length - 1] : ref }
    } else anchor = { before: ref }
  }

  // Conjunto a mover: las elegidas y sus hijas, en orden
  const set = new Set()
  for (const id of ids) {
    const i = S.info.get(id)
    if (!i || i.tab.pinned) continue
    set.add(id)
    for (const d of descendants(id)) set.add(d)
  }
  const anchorId = anchor.after ?? anchor.before
  if (set.has(anchorId)) {
    toast('No se puede mover una carpeta dentro de sí misma.')
    return false
  }
  const order = [...set].sort((a, b) => S.info.get(a).win - S.info.get(b).win || S.info.get(a).tab.index - S.info.get(b).tab.index)
  if (!order.length) return false

  const panelOf = new Map([...S.info.values()].map(i => [i.id, i.panel]))
  const learnedUpd = {}
  try {
    for (const id of order) {
      const tab = S.info.get(id).tab
      if (tab.windowId !== win) {
        const a = await browser.tabs.get(anchorId)
        await browser.tabs.move(id, { windowId: win, index: a.index })
      }
      const live = (await browser.tabs.query({ windowId: win })).sort((a, b) => a.index - b.index)
      const list = live.map(t => ({ id: t.id, panel: panelOf.get(t.id) ?? '' }))
      for (const f of M.planMove(list, id, anchor)) {
        const from = list.findIndex(x => x.id === id)
        if (from === f) continue
        await browser.tabs.move(id, { index: f })
        M.applyMove(list, from, f)
      }
      panelOf.set(id, panel)
      learnedUpd[id] = [panel, Date.now()]
      anchor = { after: id }
    }
  } catch (e) {
    toast('No se pudo mover: ' + e.message)
  }

  // Lo movido pasa a ese panel (para no deducirlo mal después)
  if (panel) {
    Object.assign(S.learned, learnedUpd)
    for (const [id, v] of Object.entries(learnedUpd)) browser.sessions.setTabValue(+id, 'sbp', v).catch(() => {})
    await browser.storage.local.set({ learned: S.learned })
  }
  await refresh()
  // Igualar openerTabId al árbol que Sidebery calcula, para que las dos vistas coincidan
  for (const id of order) {
    const i = S.info.get(id)
    if (!i) continue
    browser.tabs.update(id, { openerTabId: i.parent === -1 ? id : i.parent }).catch(() => {})
  }
  toast(`${order.length} pestaña${order.length > 1 ? 's' : ''} → ${panelLabel(panel)}`)
  return true
}

async function closeTabs(items) {
  const ids = items.filter(i => i.kind === 'tab').map(i => i.id)
  if (!ids.length) return
  if (ids.length > 15 && !(await confirmDlg(`¿Cerrar ${ids.length} pestañas?`))) return
  await browser.tabs.remove(ids)
  toast(`${ids.length} cerradas. Ctrl+Mayús+T en Firefox las recupera.`)
}

async function archiveTabs(items) {
  const tabs = items.filter(i => i.kind === 'tab')
  if (!tabs.length) return
  await editFichas(tabs, f => (f.keep = true))
  await browser.tabs.remove(tabs.map(t => t.id))
  toast(`${tabs.length} archivadas en «Archivo».`)
}

async function discardTabs(items) {
  const ids = items.filter(i => i.kind === 'tab' && !i.active).map(i => i.id)
  if (ids.length) await browser.tabs.discard(ids)
}

async function copyUrls(items) {
  const urls = items.filter(i => i.url).map(i => i.url)
  if (!urls.length) return
  await navigator.clipboard.writeText(urls.join('\n'))
  toast(`${urls.length} direcciones copiadas`)
}

async function deleteFichas(items) {
  const list = items.filter(i => i.kind === 'ficha' || (i.kind === 'tab' && S.fichas.has(i.nurl)))
  if (!list.length) return
  if (!(await confirmDlg(`¿Borrar ${list.length} ficha(s) con sus etiquetas, notas y vínculos? Las pestañas abiertas no se cierran.`))) return
  for (const it of list) {
    S.fichas.delete(it.nurl)
    await DB.del('fichas', it.nurl)
  }
  bc.postMessage({ type: 'db' })
  buildItems()
  render()
}

// Supr según el sitio: en una colección quita el acceso directo; si no, cierra / borra.
async function deleteAction() {
  const items = selectedItems()
  if (!items.length) return
  if (S.loc.t === 'col') {
    const fichas = items.filter(i => i.kind === 'tab' || i.kind === 'ficha')
    await editFichas(fichas, f => (f.cols = f.cols.filter(c => c !== S.loc.id)))
    for (const c of items.filter(i => i.kind === 'col')) await deleteCol(c.id)
    return
  }
  if (items.some(i => i.kind === 'tab')) return closeTabs(items)
  if (items.some(i => i.kind === 'ficha')) return deleteFichas(items)
  if (items.length === 1 && items[0].kind === 'col') return deleteCol(items[0].id)
  if (items.length === 1 && items[0].kind === 'tagdir') return deleteTag(items[0].tag)
}

async function pasteInto(loc) {
  if (!S.cut || !S.cut.size) return
  const items = [...S.cut].map(k => S.items.get(k)).filter(Boolean)
  S.cut = null
  await dropItems(items, locTarget(loc), false)
}

function locTarget(loc) {
  if (loc.t === 'panel') return { kind: 'panel', win: loc.w, panel: loc.p }
  if (loc.t === 'folder') return { kind: 'into', id: loc.id }
  if (loc.t === 'col') return { kind: 'col', id: loc.id }
  if (loc.t === 'tag') return { kind: 'tag', tag: loc.tag }
  if (loc.t === 'cols') return { kind: 'col', id: null }
  return null
}

// Soltar elementos en un destino
async function dropItems(items, target, copy) {
  if (!target) return
  const tabs = items.filter(i => i.kind === 'tab')
  const data = items.filter(i => i.kind === 'tab' || i.kind === 'ficha')
  const colItems = items.filter(i => i.kind === 'col')
  switch (target.kind) {
    case 'panel':
      if (tabs.length) await moveTabs(tabs.map(t => t.id), { win: target.win, panel: target.panel, end: true })
      if (items.some(i => i.kind === 'ficha')) await reopen(items.filter(i => i.kind === 'ficha'), target.panel, target.win)
      break
    case 'into':
    case 'before':
    case 'after': {
      const ref = target.id
      if (tabs.length) {
        const t = target.kind === 'into' ? { into: ref } : target.kind === 'before' ? { before: ref } : { after: ref }
        await moveTabs(tabs.map(t => t.id), t)
      }
      const closed = items.filter(i => i.kind === 'ficha')
      if (closed.length) {
        const i = S.info.get(ref)
        await reopen(closed, i.panel, i.win)
      }
      break
    }
    case 'col': {
      if (target.id === null) {
        for (const c of colItems) await saveCol({ ...S.cols.get(c.id), parent: null })
        break
      }
      for (const c of colItems) {
        if (colDescendants(c.id).has(target.id)) continue
        await saveCol({ ...S.cols.get(c.id), parent: target.id })
      }
      if (data.length) {
        const from = !copy && S.loc.t === 'col' ? S.loc.id : null
        await addToCol(data, target.id, from)
      }
      break
    }
    case 'tag':
      if (data.length) {
        await editFichas(data, f => {
          if (!f.tags.includes(target.tag)) f.tags.push(target.tag)
        })
        toast(`#${target.tag} añadida a ${data.length}`)
      }
      break
  }
}

// ---------------------------------------------------------------------------
// Selección y teclado

function selectOnly(key) {
  S.sel = new Set(key ? [key] : [])
  S.focus = key
  S.anchor = key
  renderSoon()
}

function rowIndex(key) {
  return S.rows.findIndex(r => r.it.key === key)
}

function clickSelect(key, e) {
  if (e.shiftKey && S.anchor) {
    const a = rowIndex(S.anchor)
    const b = rowIndex(key)
    if (a >= 0 && b >= 0) {
      if (!e.ctrlKey && !e.metaKey) S.sel.clear()
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(S.rows[i].it.key)
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (S.sel.has(key)) S.sel.delete(key)
    else S.sel.add(key)
    S.anchor = key
  } else {
    S.sel = new Set([key])
    S.anchor = key
  }
  S.focus = key
  renderSoon()
}

function moveFocus(delta, e) {
  if (!S.rows.length) return
  let i = rowIndex(S.focus)
  i = i < 0 ? 0 : Math.max(0, Math.min(S.rows.length - 1, i + delta))
  const key = S.rows[i].it.key
  if (e.shiftKey) {
    S.focus = key
    const a = rowIndex(S.anchor ?? key)
    S.sel.clear()
    for (let j = Math.min(a, i); j <= Math.max(a, i); j++) S.sel.add(S.rows[j].it.key)
  } else if (e.ctrlKey) S.focus = key
  else {
    S.sel = new Set([key])
    S.focus = key
    S.anchor = key
  }
  scrollIntoView(i)
  renderSoon()
}

function scrollIntoView(i) {
  const list = listEl()
  let top
  let h
  if (S.settings.view === 'icons' && S.grid) {
    top = Math.floor(i / S.grid.cols) * S.grid.cardH
    h = S.grid.cardH
  } else {
    h = S.rowH || 28
    top = i * h
  }
  if (top < list.scrollTop) list.scrollTop = top
  else if (top + h > list.scrollTop + list.clientHeight) list.scrollTop = top + h - list.clientHeight
}

function focusedItem() {
  return S.items.get(S.focus) || selectedItems()[0]
}

function back() {
  if (!S.hist.length) return
  S.fwd.push(S.loc)
  go(S.hist.pop(), false)
}
function forward() {
  if (!S.fwd.length) return
  S.hist.push(S.loc)
  go(S.fwd.pop(), false)
}
function up() {
  const p = parentLoc(S.loc)
  if (p) go(p)
}

function expandAll(on) {
  if (!on) {
    S.expanded.clear()
    S.expandedP.clear()
  } else {
    for (const r of S.rows) {
      if (r.it.kind === 'panel') {
        S.expandedP.add(r.it.key)
        for (const t of tabsOfPanel(r.it.win, r.it.panel)) if (t.kids.length) S.expanded.add(t.id)
      }
      if (r.it.kind === 'tab') for (const id of [r.it.id, ...descendants(r.it.id)]) if (S.info.get(id)?.kids.length) S.expanded.add(id)
    }
  }
  renderSoon()
}

function setView(v) {
  saveSettings({ view: v })
  render()
}

document.addEventListener('keydown', async e => {
  const inField = e.target.matches('input, textarea, select')
  if (e.key === 'Escape') {
    if (!$('#menu').hidden) return hideMenu()
    if (inField) {
      if (e.target.id === 'search' && e.target.value) {
        e.target.value = ''
        onSearch()
      }
      e.target.blur()
      return
    }
    S.cut = null
    selectOnly(null)
    return
  }
  if ((e.ctrlKey && e.key === 'f') || (!inField && e.key === '/')) {
    e.preventDefault()
    $('#search').focus()
    $('#search').select()
    return
  }
  if (e.ctrlKey && e.key === 'b') {
    e.preventDefault()
    saveSettings({ side: !S.settings.side })
    return
  }
  if (e.ctrlKey && ['1', '2', '3'].includes(e.key)) {
    e.preventDefault()
    setView(['details', 'icons', 'graph'][+e.key - 1])
    return
  }
  if (e.altKey && e.key === 'ArrowLeft') return back()
  if (e.altKey && e.key === 'ArrowRight') return forward()
  if (e.altKey && e.key === 'ArrowUp') return up()
  if (inField) {
    if (e.target.id === 'search' && e.key === 'ArrowDown') {
      e.preventDefault()
      listEl().focus()
      moveFocus(0, e)
    }
    return
  }
  const it = focusedItem()
  const icons = S.settings.view === 'icons'
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      return moveFocus(icons && S.grid ? S.grid.cols : 1, e)
    case 'ArrowUp':
      e.preventDefault()
      return moveFocus(icons && S.grid ? -S.grid.cols : -1, e)
    case 'ArrowRight':
      e.preventDefault()
      if (icons) return moveFocus(1, e)
      if (it && it.kind === 'tab' && it.kids.length && treeMode()) {
        S.expanded.add(it.id)
        return renderSoon()
      }
      if (it && it.kind === 'panel' && treeMode()) {
        S.expandedP.add(it.key)
        return renderSoon()
      }
      return
    case 'ArrowLeft':
      e.preventDefault()
      if (icons) return moveFocus(-1, e)
      if (it && it.kind === 'panel' && S.expandedP.has(it.key)) {
        S.expandedP.delete(it.key)
        return renderSoon()
      }
      if (it && treeMode()) {
        if (S.expanded.has(it.id)) {
          S.expanded.delete(it.id)
          return renderSoon()
        }
        const p = it.parent !== -1 && tabItem(it.parent)
        if (p && rowIndex(p.key) >= 0) return selectOnly(p.key)
      }
      return
    case '*':
      e.preventDefault()
      return expandAll(true)
    case 'Home':
      e.preventDefault()
      return moveFocus(-1e9, e)
    case 'End':
      e.preventDefault()
      return moveFocus(1e9, e)
    case 'Enter':
      e.preventDefault()
      if (!it) return
      if (e.ctrlKey || e.shiftKey) return it.kind === 'tab' ? activate(it) : openItem(it)
      return openItem(it, { enter: true })
    case 'Backspace':
      e.preventDefault()
      return up()
    case 'Delete':
      e.preventDefault()
      return deleteAction()
    case 'F2':
      e.preventDefault()
      return renameAction(it)
    case 'i':
    case 'I':
      return saveSettings({ insp: !S.settings.insp }).then(render)
    case 't':
    case 'T':
      e.preventDefault()
      return tagPrompt(selectedItems())
  }
  if (e.ctrlKey || e.metaKey) {
    switch (e.key.toLowerCase()) {
      case 'a':
        e.preventDefault()
        S.sel = new Set(S.rows.map(r => r.it.key))
        return renderSoon()
      case 'c':
        e.preventDefault()
        return copyUrls(selectedItems())
      case 'x':
        e.preventDefault()
        S.cut = new Set(S.sel)
        toast(`${S.cut.size} cortados: ve a otro panel, carpeta o colección y pulsa Ctrl+V`)
        return renderSoon()
      case 'v':
        e.preventDefault()
        return pasteInto(S.loc)
    }
  }
})

async function renameAction(it) {
  if (!it) return
  if (it.kind === 'col') {
    const c = S.cols.get(it.id)
    const name = await ask('Renombrar colección', c.name)
    if (name) await saveCol({ ...c, name })
  } else if (it.kind === 'tagdir') {
    const to = await ask('Renombrar etiqueta', it.tag, 'Usa / para anidar: trabajo/clientes')
    if (to) await renameTag(it.tag, to)
  } else {
    const f = fichaFor(it.nurl)
    const name = await ask('Nombre propio (solo en Pestañario)', (f && f.alias) || it.title)
    if (name !== null) await editFichas([it], f => (f.alias = name === it.realTitle ? '' : name))
  }
}

async function tagPrompt(items) {
  const data = items.filter(i => i.kind === 'tab' || i.kind === 'ficha')
  if (!data.length) return
  const v = await ask(`Etiquetas para ${data.length} elemento(s)`, '', 'separadas por comas; «-etiqueta» para quitar', true)
  if (!v) return
  const add = []
  const del = []
  for (const raw of v.split(',')) {
    const s = raw.trim()
    if (!s) continue
    if (s.startsWith('-')) del.push(M.cleanTag(s.slice(1)))
    else add.push(M.cleanTag(s))
  }
  await editFichas(data, f => {
    f.tags = [...new Set([...f.tags.filter(t => !del.includes(t)), ...add])].filter(Boolean)
  })
}

// ---------------------------------------------------------------------------
// Ratón: lista / miniaturas

const listClickKey = e => e.target.closest('[data-key]')?.dataset.key

listEl().addEventListener('scroll', () => renderMainSoon(), { passive: true })
const renderMainSoon = (() => {
  let raf = 0
  return () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      renderMain()
    })
  }
})()

listEl().addEventListener('mousedown', e => {
  if (e.button !== 0) return
  const expp = e.target.closest('[data-expp]')
  if (expp) {
    const k = expp.dataset.expp
    if (S.expandedP.has(k)) S.expandedP.delete(k)
    else S.expandedP.add(k)
    e.preventDefault()
    return renderSoon()
  }
  const exp = e.target.closest('[data-exp]')
  if (exp) {
    const id = +exp.dataset.exp
    if (S.expanded.has(id)) S.expanded.delete(id)
    else S.expanded.add(id)
    e.preventDefault()
    return renderSoon()
  }
  const tag = e.target.closest('[data-tag]')
  if (tag) {
    e.preventDefault()
    return go({ t: 'tag', tag: tag.dataset.tag })
  }
  const key = listClickKey(e)
  if (!key) {
    if (!e.ctrlKey && !e.shiftKey) selectOnly(null)
    return
  }
  // Si ya está seleccionado y se va a arrastrar, no deseleccionar el resto
  if (S.sel.has(key) && !e.ctrlKey && !e.shiftKey) {
    S.focus = key
    S.pendingSingle = key
    return
  }
  clickSelect(key, e)
})

listEl().addEventListener('click', e => {
  if (S.pendingSingle && listClickKey(e) === S.pendingSingle && !e.ctrlKey && !e.shiftKey) selectOnly(S.pendingSingle)
  S.pendingSingle = null
})

listEl().addEventListener('dblclick', e => {
  const key = listClickKey(e)
  if (!key || e.target.closest('[data-exp], [data-expp]')) return
  openItem(S.items.get(key), { enter: true })
})

listEl().addEventListener('auxclick', e => {
  if (e.button !== 1) return
  const it = S.items.get(listClickKey(e))
  if (it && it.kind === 'tab') browser.tabs.remove(it.id)
})

listEl().addEventListener('contextmenu', e => {
  e.preventDefault()
  const key = listClickKey(e)
  if (key && !S.sel.has(key)) selectOnly(key)
  if (!key) selectOnly(null)
  showItemMenu(e.clientX, e.clientY, key ? selectedItems() : [])
})

$('#colhead').addEventListener('click', e => {
  const d = e.target.closest('[data-sort]')
  if (!d) return
  const k = d.dataset.sort || 'natural'
  saveSettings({ sort: S.settings.sort === k ? 'natural' : k })
  render()
})

// ---------------------------------------------------------------------------
// Árbol lateral: clics

$('#tree').addEventListener('click', e => {
  const tog = e.target.closest('[data-tog]')
  if (tog) {
    const k = tog.dataset.tog
    const shown = !!tog.closest('.tsec, .tn')?.querySelector('.tw .chev.open')
    S.treeOpen.delete(k)
    S.treeOpen.delete('-' + k)
    if (k.startsWith('x')) {
      if (shown) S.treeOpen.add(k)
    } else if (shown) S.treeOpen.add('-' + k)
    else S.treeOpen.add(k)
    lsSet('treeOpen', [...S.treeOpen])
    return renderTree()
  }
  const act = e.target.closest('[data-act]')
  if (act) {
    e.preventDefault()
    if (act.dataset.act === 'newcol') return newCollection(S.loc.t === 'col' ? S.loc.id : null)
    if (act.dataset.act === 'setup') return openSettings('sidebery')
  }
  const n = e.target.closest('[data-loc]')
  if (n) go(JSON.parse(n.dataset.loc))
})

$('#tree').addEventListener('dblclick', e => {
  const n = e.target.closest('.tn[data-loc]')
  if (!n) return
  const loc = JSON.parse(n.dataset.loc)
  if (loc.t === 'folder') activate(tabItem(loc.id))
})

$('#tree').addEventListener('contextmenu', e => {
  const n = e.target.closest('[data-loc]')
  if (!n) return
  e.preventDefault()
  showLocMenu(e.clientX, e.clientY, JSON.parse(n.dataset.loc))
})

$('#status').addEventListener('click', e => {
  if (e.target.closest('[data-act="setup"]')) openSettings('sidebery')
})

// ---------------------------------------------------------------------------
// Inspector: acciones

document.addEventListener('error', e => {
  const img = e.target
  if (img.tagName === 'IMG' && img.dataset.fallback && img.src !== img.dataset.fallback) img.src = img.dataset.fallback
}, true)

$('#inspector').addEventListener('click', async e => {
  const items = selectedItems()
  const it = items[0]
  const go2 = e.target.closest('[data-goto]')
  if (go2) {
    e.preventDefault()
    const target = S.items.get(go2.dataset.goto)
    if (!target) return
    if (target.kind === 'tab' && target.parent !== -1) go({ t: 'folder', id: target.parent })
    else if (target.kind === 'tab') go({ t: target.pinned ? 'pinned' : 'panel', w: target.win, ...(target.pinned ? {} : { p: target.panel }) })
    else go({ t: 'saved' })
    return selectOnly(target.key)
  }
  const tag = e.target.closest('[data-untag]')
  if (tag) return editFichas([it], f => (f.tags = f.tags.filter(t => t !== tag.dataset.untag)))
  const unlink = e.target.closest('[data-unlink]')
  if (unlink) return editFichas([it], f => (f.links = f.links.filter(u => u !== unlink.dataset.unlink)))
  const uncol = e.target.closest('[data-uncol]')
  if (uncol) return editFichas([it], f => (f.cols = f.cols.filter(c => c !== uncol.dataset.uncol)))
  const gocol = e.target.closest('[data-gocol]')
  if (gocol) return go({ t: 'col', id: gocol.dataset.gocol })
  const gotag = e.target.closest('[data-tag]')
  if (gotag) return go({ t: 'tag', tag: gotag.dataset.tag })
  const a = e.target.closest('[data-act]')
  if (!a) return
  switch (a.dataset.act) {
    case 'activate':
      return activate(it)
    case 'enter':
      return it.kind === 'tab' ? go({ t: 'folder', id: it.id }) : openItem(it)
    case 'discard':
      return discardTabs(items)
    case 'archive':
      return archiveTabs(items)
    case 'close':
      return closeTabs(items)
    case 'reopen':
      return reopen(items)
    case 'reopenpanel':
      return choosePanel(items[0]?.win).then(p => p && reopen(items, p.panel, p.win))
    case 'delficha':
      return deleteFichas(items)
    case 'copyurl':
      return copyUrls(items)
    case 'tocol':
      return chooseCol(items)
    case 'topanel':
      return choosePanel(items.find(i => i.kind === 'tab')?.win).then(p => p && moveTabs(items.filter(i => i.kind === 'tab').map(i => i.id), { win: p.win, panel: p.panel, end: true }))
    case 'color':
      return editFichas([it], f => (f.color = a.dataset.color))
    case 'bulk-color':
      return editFichas(items, f => (f.color = a.dataset.color))
    case 'col-color':
      return saveCol({ ...S.cols.get(it.id), color: a.dataset.color })
    case 'rename':
    case 'renametag':
      return renameAction(it)
    case 'delcol':
      return deleteCol(it.id)
    case 'deltag':
      return deleteTag(it.tag)
    case 'openall':
      return reopen(fichaItemsIn(colDescendants(it.id)).filter(i => i.kind === 'ficha'))
  }
})

$('#inspector').addEventListener('keydown', async e => {
  const a = e.target.dataset.act
  if (e.key !== 'Enter' || !a) return
  const it = selectedItems()[0]
  const v = e.target.value.trim()
  if (a === 'tag' || a === 'bulk-tag') {
    e.preventDefault()
    const t = M.cleanTag(v)
    if (!t) return
    await editFichas(a === 'tag' ? [it] : selectedItems(), f => {
      if (!f.tags.includes(t)) f.tags.push(t)
    })
    $('#inspector [data-act="' + a + '"]')?.focus()
  } else if (a === 'link') {
    e.preventDefault()
    const target = resolveLink(v) || (/^[a-z]+:/.test(v) ? { nurl: M.normUrl(v) } : null)
    if (!target) return toast('No encuentro esa pestaña')
    if (target.nurl === it.nurl) return
    await editFichas([it], f => {
      if (!f.links.includes(target.nurl)) f.links.push(target.nurl)
    })
    // El vínculo es mutuo: la otra también lo guarda
    const other = itemForUrl(target.nurl)
    if (other) await editFichas([other], f => {
      if (!f.links.includes(it.nurl)) f.links.push(it.nurl)
    })
  } else if (a === 'alias') {
    e.preventDefault()
    e.target.blur()
  }
})

$('#inspector').addEventListener('input', e => {
  if (e.target.dataset.act === 'link') fillLinkList(e.target)
  if (e.target.dataset.act === 'note') saveNoteSoon(selectedItems()[0], e.target.value)
})

$('#inspector').addEventListener('change', e => {
  if (e.target.dataset.act === 'alias') {
    const it = selectedItems()[0]
    const v = e.target.value.trim()
    editFichas([it], f => (f.alias = v))
  }
})

const saveNoteSoon = debounce((it, text) => {
  if (!it) return
  editFichas([it], f => (f.note = text))
}, 600)

// ---------------------------------------------------------------------------
// Menús contextuales

function menuHtml(items) {
  return items
    .map((m, i) => {
      if (m === '-') return '<div class="ms"></div>'
      if (m.head) return `<div class="mh">${esc(m.head)}</div>`
      return `<div class="mi${m.dis ? ' dis' : ''}" data-mi="${i}">${m.icon ? `<span>${m.icon}</span>` : ''}<span>${esc(m.label)}</span>${m.sub ? '<span class="k">▸</span>' : m.k ? `<span class="k">${esc(m.k)}</span>` : ''}</div>`
    })
    .join('')
}

function showMenu(x, y, items) {
  hideMenu()
  const el = $('#menu')
  el.innerHTML = menuHtml(items)
  el.hidden = false
  placeMenu(el, x, y)
  el.onclick = e => {
    const mi = e.target.closest('[data-mi]')
    if (!mi) return
    const m = items[+mi.dataset.mi]
    if (m.sub) return
    hideMenu()
    m.run && m.run()
  }
  el.onmouseover = e => {
    const mi = e.target.closest('[data-mi]')
    if (!mi) return
    const m = items[+mi.dataset.mi]
    for (const s of document.querySelectorAll('.submenu')) if (!s.contains(mi)) s.remove()
    el.querySelectorAll('.mi.act').forEach(x => x.classList.remove('act'))
    if (m.sub) {
      mi.classList.add('act')
      const r = mi.getBoundingClientRect()
      const sub = document.createElement('div')
      sub.className = 'submenu'
      const subItems = typeof m.sub === 'function' ? m.sub() : m.sub
      sub.innerHTML = menuHtml(subItems)
      document.body.appendChild(sub)
      placeMenu(sub, r.right - 2, r.top - 4, r.left)
      sub.onclick = ev => {
        const smi = ev.target.closest('[data-mi]')
        if (!smi) return
        hideMenu()
        subItems[+smi.dataset.mi].run()
      }
    }
  }
}

function placeMenu(el, x, y, altX) {
  const w = el.offsetWidth
  const h = el.offsetHeight
  if (x + w > innerWidth) x = altX !== undefined ? altX - w : innerWidth - w - 4
  if (y + h > innerHeight) y = Math.max(4, innerHeight - h - 4)
  el.style.left = x + 'px'
  el.style.top = y + 'px'
}

function hideMenu() {
  $('#menu').hidden = true
  document.querySelectorAll('.submenu').forEach(s => s.remove())
}
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#menu, .submenu')) hideMenu()
})
window.addEventListener('blur', hideMenu)

function panelSubmenu(win, run) {
  const w = win || (S.wins.find(x => x.focused) || S.wins[0])?.id
  const names = S.panelOrder.length ? S.panelOrder : []
  if (!names.length) return [{ label: 'Conecta con Sidebery primero', run: () => openSettings('sidebery') }]
  return names.map(n => {
    const meta = S.panelMeta.get(n) || {}
    return { label: n, icon: `<span class="dot" style="background:${M.colorCss(meta.color) || hashColor(n)}"></span>`, run: () => run(w, n) }
  })
}

function colSubmenu(items) {
  const out = []
  const rec = (parent, depth) => {
    for (const c of colChildren(parent)) {
      out.push({ label: '  '.repeat(depth) + c.name, icon: '📁', run: () => addToCol(items, c.id) })
      rec(c.id, depth + 1)
    }
  }
  rec(null, 0)
  if (out.length) out.push('-')
  out.push({ label: 'Nueva colección…', icon: '＋', run: () => newCollection(null, items) })
  return out
}

function colorSubmenu(items) {
  return ['', ...OWN_COLORS].map(c => ({ label: c || 'Sin color', icon: c ? `<span class="dot" style="background:${c}"></span>` : '○', run: () => editFichas(items, f => (f.color = c)) }))
}

function showItemMenu(x, y, items) {
  const tabs = items.filter(i => i.kind === 'tab')
  const data = items.filter(i => i.kind === 'tab' || i.kind === 'ficha')
  const closed = items.filter(i => i.kind === 'ficha')
  const one = items.length === 1 ? items[0] : null
  const m = []
  if (!items.length) {
    if (S.loc.t === 'col' || S.loc.t === 'cols') m.push({ label: 'Nueva colección aquí…', icon: '＋', run: () => newCollection(S.loc.t === 'col' ? S.loc.id : null) })
    m.push({ label: 'Pegar', k: 'Ctrl+V', dis: !S.cut, run: () => pasteInto(S.loc) })
    m.push({ label: 'Seleccionar todo', k: 'Ctrl+A', run: () => ((S.sel = new Set(S.rows.map(r => r.it.key))), renderSoon()) })
    return showMenu(x, y, m)
  }
  if (one && (one.kind === 'panel' || one.kind === 'pinnedf')) return showLocMenu(x, y, one.kind === 'panel' ? { t: 'panel', w: one.win, p: one.panel } : { t: 'pinned', w: one.win })
  if (one && (one.kind === 'col' || one.kind === 'tagdir')) {
    m.push({ label: 'Abrir', k: 'Intro', run: () => openItem(one) })
    m.push({ label: 'Renombrar…', k: 'F2', run: () => renameAction(one) })
    if (one.kind === 'col') {
      m.push({ label: 'Nueva subcolección…', run: () => newCollection(one.id) })
      m.push({ label: 'Abrir todas las cerradas', run: () => reopen(fichaItemsIn(colDescendants(one.id)).filter(i => i.kind === 'ficha')) })
      m.push('-', { label: 'Eliminar colección', run: () => deleteCol(one.id) })
    } else m.push('-', { label: 'Quitar etiqueta de todas', run: () => deleteTag(one.tag) })
    return showMenu(x, y, m)
  }
  if (tabs.length) {
    m.push({ label: 'Ir a la pestaña', icon: '↗', k: 'Intro', dis: !one, run: () => activate(one) })
    if (one && one.kind === 'tab' && one.kids.length) m.push({ label: 'Abrir como carpeta', icon: '📂', k: 'Ctrl+Intro', run: () => go({ t: 'folder', id: one.id }) })
    m.push({ label: 'Mover a panel', icon: '⇄', sub: () => panelSubmenu(tabs[0].win, (w, p) => moveTabs(tabs.map(t => t.id), { win: w, panel: p, end: true })) })
  }
  if (closed.length) {
    m.push({ label: closed.length > 1 ? `Abrir ${closed.length}` : 'Abrir', icon: '↗', run: () => reopen(closed) })
    m.push({ label: 'Abrir en el panel', icon: '⇄', sub: () => panelSubmenu(null, (w, p) => reopen(closed, p, w)) })
  }
  m.push('-')
  m.push({ label: 'Añadir a colección', icon: '🔗', sub: () => colSubmenu(data) })
  m.push({ label: 'Etiquetas…', icon: '#', k: 'T', run: () => tagPrompt(data) })
  m.push({ label: 'Color', icon: '●', sub: () => colorSubmenu(data) })
  if (one) m.push({ label: 'Nombre propio…', icon: '✎', k: 'F2', run: () => renameAction(one) })
  if (S.loc.t === 'col') m.push({ label: 'Quitar de esta colección', icon: '✕', k: 'Supr', run: () => editFichas(data, f => (f.cols = f.cols.filter(c => c !== S.loc.id))) })
  m.push('-')
  m.push({ label: 'Copiar direcciones', icon: '⧉', k: 'Ctrl+C', run: () => copyUrls(items) })
  if (tabs.length) {
    m.push({ label: 'Cortar (para pegar en otro panel o carpeta)', icon: '✂', k: 'Ctrl+X', run: () => ((S.cut = new Set(tabs.map(t => t.key))), renderSoon()) })
    m.push({ label: 'Recargar', icon: '⟳', run: () => tabs.forEach(t => browser.tabs.reload(t.id)) })
    m.push({ label: 'Dormir (liberar memoria)', icon: '💤', run: () => discardTabs(tabs) })
    m.push('-')
    m.push({ label: 'Archivar y cerrar', icon: '📦', run: () => archiveTabs(tabs) })
    m.push({ label: 'Cerrar', icon: '✕', k: 'Supr', run: () => closeTabs(tabs) })
  }
  if (data.some(i => S.fichas.has(i.nurl))) m.push({ label: 'Borrar ficha (etiquetas, nota…)', icon: '🗑', run: () => deleteFichas(data) })
  showMenu(x, y, m)
}

function showLocMenu(x, y, loc) {
  const m = []
  m.push({ label: 'Abrir', run: () => go(loc) })
  if (S.cut) m.push({ label: 'Pegar aquí', k: 'Ctrl+V', run: () => pasteInto(loc) })
  if (loc.t === 'folder') {
    m.push({ label: 'Ir a la pestaña', run: () => activate(tabItem(loc.id)) })
  }
  if (loc.t === 'panel') {
    const tabs = tabsOfPanel(loc.w, loc.p)
    m.push({ label: `Dormir sus ${tabs.length} pestañas`, run: () => discardTabs(tabs) })
  }
  if (loc.t === 'col') {
    m.push({ label: 'Nueva subcolección…', run: () => newCollection(loc.id) })
    m.push({ label: 'Renombrar…', run: () => renameAction(S.items.get('c:' + loc.id)) })
    m.push({ label: 'Eliminar', run: () => deleteCol(loc.id) })
  }
  if (loc.t === 'tag') {
    m.push({ label: 'Renombrar…', run: () => renameAction(S.items.get('g:' + loc.tag)) })
    m.push({ label: 'Quitar de todas', run: () => deleteTag(loc.tag) })
  }
  showMenu(x, y, m)
}

function choosePanel(win) {
  return new Promise(resolve => {
    const r = $('#btnSettings').getBoundingClientRect()
    showMenu(innerWidth / 2 - 100, r.bottom + 40, [{ head: 'Elige panel' }, ...panelSubmenu(win, (w, p) => resolve({ win: w, panel: p }))])
  })
}

function chooseCol(items) {
  const r = $('#btnSettings').getBoundingClientRect()
  showMenu(innerWidth / 2 - 100, r.bottom + 40, [{ head: 'Añadir a colección' }, ...colSubmenu(items)])
}

// ---------------------------------------------------------------------------
// Arrastrar y soltar

let dragKeys = null
let dropEl = null

function clearDrop() {
  if (dropEl) dropEl.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop')
  dropEl = null
}

document.addEventListener('dragstart', e => {
  const el = e.target.closest('[data-key]')
  if (!el) return
  const key = el.dataset.key
  if (!S.sel.has(key)) {
    S.sel = new Set([key])
    S.focus = key
  }
  dragKeys = [...S.sel]
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData('application/x-pestanario', JSON.stringify(dragKeys))
  const ghost = document.createElement('div')
  ghost.className = 'dragimg'
  ghost.textContent = dragKeys.length > 1 ? `${dragKeys.length} elementos` : S.items.get(key)?.title || ''
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, 10, 10)
  setTimeout(() => ghost.remove(), 0)
})

document.addEventListener('dragend', () => {
  dragKeys = null
  clearDrop()
})

// Qué pasaría al soltar aquí
function dropTarget(e) {
  if (!dragKeys) return null
  const items = dragKeys.map(k => S.items.get(k)).filter(Boolean)
  const locEl = e.target.closest('[data-drop-loc]')
  if (locEl) {
    const loc = JSON.parse(locEl.dataset.dropLoc)
    const t = locTarget(loc)
    if (!t) return null
    if (t.kind === 'into' && dragKeys.includes('t:' + t.id)) return null
    if (t.kind === 'panel' && !items.some(i => i.kind === 'tab' || i.kind === 'ficha')) return null
    return { el: locEl, cls: 'drop', target: t }
  }
  const el = e.target.closest('#list [data-key]')
  if (el) {
    const it = S.items.get(el.dataset.key)
    if (!it || dragKeys.includes(it.key)) return null
    if (it.kind === 'col') return { el, cls: 'drop-into', target: { kind: 'col', id: it.id } }
    if (it.kind === 'panel') return items.some(i => i.kind === 'tab' || i.kind === 'ficha') ? { el, cls: 'drop-into', target: { kind: 'panel', win: it.win, panel: it.panel } } : null
    if (it.kind === 'pinnedf') return null
    if (it.kind === 'tagdir') return { el, cls: 'drop-into', target: { kind: 'tag', tag: it.tag } }
    if (it.kind !== 'tab') return null
    if (!items.some(i => i.kind === 'tab' || i.kind === 'ficha')) return null
    const r = el.getBoundingClientRect()
    const icons = S.settings.view === 'icons'
    const f = icons ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height
    const natural = S.settings.sort === 'natural' && S.query.empty
    if (it.kids.length && f > 0.3 && f < 0.7) return { el, cls: 'drop-into', target: { kind: 'into', id: it.id } }
    if (!natural) return it.kids.length ? { el, cls: 'drop-into', target: { kind: 'into', id: it.id } } : null
    return { el, cls: f < 0.5 ? 'drop-before' : 'drop-after', target: { kind: f < 0.5 ? 'before' : 'after', id: it.id } }
  }
  // Fondo de la lista: soltar en la ubicación actual
  if (e.target.closest('#list')) {
    const t = locTarget(S.loc)
    if (t) return { el: $('#list'), cls: '', target: t }
  }
  return null
}

document.addEventListener('dragover', e => {
  const d = dropTarget(e)
  clearDrop()
  if (!d) {
    if (!dragKeys && e.dataTransfer.types.includes('Files')) e.preventDefault()
    return
  }
  e.preventDefault()
  e.dataTransfer.dropEffect = e.ctrlKey || d.target.kind === 'tag' ? 'copy' : 'move'
  if (d.cls) {
    dropEl = d.el
    d.el.classList.add(d.cls)
  }
})

document.addEventListener('dragleave', e => {
  if (!e.relatedTarget) clearDrop()
})

document.addEventListener('drop', async e => {
  const d = dropTarget(e)
  clearDrop()
  if (!d) {
    // Archivo de Sidebery soltado sobre la página
    const file = e.dataTransfer.files && e.dataTransfer.files[0]
    if (file) {
      e.preventDefault()
      importSidebery(file)
    }
    return
  }
  e.preventDefault()
  const items = dragKeys.map(k => S.items.get(k)).filter(Boolean)
  dragKeys = null
  await dropItems(items, d.target, e.ctrlKey)
})

// ---------------------------------------------------------------------------
// Diálogos

function ask(title, value = '', placeholder = '', withTags = false) {
  return new Promise(resolve => {
    const dlg = $('#dlg')
    dlg.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><input type="text" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" ${withTags ? 'list="askTags"' : ''} autofocus style="width:100%">${withTags ? tagDatalist().replace('taglist', 'askTags') : ''}<div class="foot"><button value="cancel" type="button" data-x>Cancelar</button><button value="ok" class="primary">Aceptar</button></div></form>`
    const input = dlg.querySelector('input')
    dlg.querySelector('[data-x]').onclick = () => dlg.close('cancel')
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null)
    dlg.returnValue = ''
    dlg.showModal()
    input.select()
  })
}

function confirmDlg(text) {
  return new Promise(resolve => {
    const dlg = $('#dlg')
    dlg.innerHTML = `<form method="dialog"><p>${esc(text)}</p><div class="foot"><button value="cancel">Cancelar</button><button value="ok" class="primary" autofocus>Aceptar</button></div></form>`
    dlg.onclose = () => resolve(dlg.returnValue === 'ok')
    dlg.returnValue = ''
    dlg.showModal()
  })
}

async function openSettings(section) {
  const s = S.settings
  const imp = S.sbImport
  const learnedN = Object.keys(S.learned).length
  let titleOk = false
  let winTitle = ''
  try {
    const w = await browser.windows.getLastFocused()
    winTitle = w.title || ''
    titleOk = new RegExp(s.prefaceRe).test(winTitle)
  } catch {}
  const thumbsPerm = await browser.permissions.contains({ origins: ['<all_urls>'] })
  const dlg = $('#dlg')
  dlg.innerHTML = `<h3>Ajustes</h3>
<h4 id="sec-sidebery">Conexión con Sidebery</h4>
<p class="small">Sidebery no tiene una vía para que otras extensiones lean sus datos, y aquí no se modifica. Pestañario los obtiene de tres fuentes que Sidebery ya ofrece:</p>
<ol class="small">
  <li><b>Panel activo, en vivo.</b> En Sidebery: <i>Settings → General</i> → activa <i>«Add preface to the browser window's title if Sidebery sidebar is active»</i> y en <i>«Preface value»</i> escribe <code>⟦%PN⟧ </code>. Cada vez que cambias de panel, Pestañario apunta en qué panel está cada pestaña.<br>
  Estado: ${titleOk ? '<b style="color:#46a758">✓ detectado</b>' : `<b style="color:var(--danger)">✗ no detectado</b> <span class="muted">(título actual: ${esc(winTitle.slice(0, 60))})</span>`}</li>
  <li><b>Recomendado, más rápido:</b> en Sidebery, <i>Settings → Tabs</i> → <i>«Hide native tabs of inactive panels»</i>, y marca aquí: <label><input type="checkbox" id="setHide" ${s.hideInact ? 'checked' : ''}> Sidebery oculta las pestañas de los paneles inactivos</label>. Así aprende el panel entero de golpe, no solo la pestaña activa.</li>
  <li><b>Opcional, colores y títulos que pusiste a las pestañas en Sidebery:</b> en Sidebery, <i>Settings → Snapshots → «Create snapshot»</i> y después <i>Settings → Help → «Export addon data»</i> (todo marcado). Después: <button id="btnImport">Importar archivo de Sidebery…</button> (o suéltalo sobre esta página). Repite cuando cambies colores o paneles.<br>
  ${imp ? `Importado: ${imp.panels.length} paneles, ${imp.tabCount} pestañas, ${new Date(imp.time).toLocaleString()}. <button id="btnForget" class="danger">Olvidar</button>` : '<span class="muted">Nada importado todavía.</span>'}</li>
</ol>
<p class="small muted">Aprendidas en vivo: ${learnedN} pestañas. <button id="btnForgetLearned">Olvidar lo aprendido</button></p>
<div class="row"><label>Patrón del título (avanzado)</label><input type="text" id="setRe" value="${esc(s.prefaceRe)}" style="min-width:160px"></div>

<h4 id="sec-apariencia">Apariencia</h4>
<div class="row"><label>Tema</label><select id="setTheme"><option value="auto">Automático (claro u oscuro según el sistema)</option>${Themes.LIST.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
<div class="row"><label>Color de acento</label><input type="color" id="setAccent" value="${esc(s.accent || '#4f6bed')}"> <button id="btnAccentReset" ${s.accent ? '' : 'disabled'}>El del tema</button></div>
<div class="row"><label>Tamaño del texto</label><input type="range" id="setFont" min="11" max="18" step="1" value="${s.fontSize}"> <span id="fontVal">${s.fontSize}px</span></div>
<div class="row"><label>Densidad de las filas</label><select id="setDensity"><option value="compact">Compacta</option><option value="normal">Normal</option><option value="comfy">Amplia</option></select></div>
<div class="row"><label>Redondeo de esquinas</label><input type="range" id="setRadius" min="0" max="14" step="1" value="${s.radius}"></div>
<div class="row"><label>Al abrir, empezar en</label><select id="setView"><option value="details">Detalles</option><option value="icons">Miniaturas</option><option value="graph">Grafo</option></select></div>
<div class="row"><label>Al pulsar el icono, abrir en</label><select id="setOpen"><option value="tab">Una pestaña</option><option value="window">Una ventana aparte</option></select> <span class="small muted">(clic central en el icono: siempre en ventana)</span></div>

<h4>Miniaturas</h4>
<div class="row"><label><input type="checkbox" id="setThumbs" ${s.thumbs && thumbsPerm ? 'checked' : ''}> Hacer miniaturas de las páginas que visitas</label></div>
<p class="small muted">Se capturan solo al mirar una pestaña (no despierta las dormidas ni gasta en segundo plano) y se guardan pequeñas en tu equipo. Firefox pedirá permiso para «acceder a los datos de todos los sitios»: solo se usa para la captura.</p>
<div class="row"><button id="btnShots">Capturar ahora las pestañas cargadas</button><button id="btnClearShots">Borrar miniaturas</button></div>

<h4>Base de datos</h4>
<p class="small muted">${S.fichas.size} fichas · ${S.cols.size} colecciones · ${S.tagCount.size} etiquetas. Todo se guarda solo en este Firefox.</p>
<div class="row"><button id="btnExport">Exportar copia (JSON)</button><button id="btnImportDb">Importar copia…</button><button id="btnExportMd">Exportar a Markdown (Obsidian)</button></div>

<h4>Atajos</h4>
<p class="small">
<code>Intro</code> o doble clic: abrir la carpeta o ir a la pestaña · <code>Ctrl+Intro</code> ir a la pestaña aunque tenga hijas · <code>*</code> desplegar todo · <code>Retroceso</code> subir · <code>Alt+←/→</code> atrás/adelante ·
<code>→/←</code> desplegar/plegar · <code>Supr</code> cerrar (en colecciones: quitar el acceso directo) · <code>F2</code> renombrar · <code>T</code> etiquetas · <code>I</code> panel de detalles ·
<code>Ctrl+X</code> / <code>Ctrl+V</code> cortar y pegar en otro panel/carpeta/colección · <code>Ctrl+C</code> copiar direcciones · <code>Ctrl+A</code> todo · <code>/</code> o <code>Ctrl+F</code> buscar · <code>Ctrl+1/2/3</code> vistas · <code>Ctrl+B</code> barra lateral · clic central cierra.
Al arrastrar a una colección, <code>Ctrl</code> copia en vez de mover entre colecciones.</p>
<p class="small">Búsqueda: texto, <code>#etiqueta</code>, <code>panel:trabajo</code>, <code>site:youtube</code>, <code>color:red</code>, <code>en:colección</code>, <code>es:abierta|cerrada|dormida|sonando|fijada|ficha|nota</code>; «-» delante niega.</p>
<div class="foot"><button id="btnClose" class="primary">Cerrar</button></div>`
  dlg.querySelector('#setTheme').value = s.theme
  dlg.querySelector('#setDensity').value = s.density
  dlg.querySelector('#setView').value = s.view
  dlg.querySelector('#setView').onchange = e => setView(e.target.value)
  dlg.querySelector('#setAccent').oninput = e => saveSettings({ accent: e.target.value })
  dlg.querySelector('#btnAccentReset').onclick = e => {
    e.target.disabled = true
    saveSettings({ accent: '' })
  }
  dlg.querySelector('#setFont').oninput = e => {
    dlg.querySelector('#fontVal').textContent = e.target.value + 'px'
    saveSettings({ fontSize: +e.target.value })
  }
  dlg.querySelector('#setRadius').oninput = e => saveSettings({ radius: +e.target.value })
  dlg.querySelector('#setOpen').value = s.openMode
  dlg.querySelector('#btnClose').onclick = () => dlg.close()
  dlg.querySelector('#setHide').onchange = e => saveSettings({ hideInact: e.target.checked })
  dlg.querySelector('#setRe').onchange = e => {
    try {
      new RegExp(e.target.value)
      saveSettings({ prefaceRe: e.target.value })
    } catch {
      toast('Patrón no válido')
    }
  }
  dlg.querySelector('#setTheme').onchange = e => saveSettings({ theme: e.target.value })
  dlg.querySelector('#setDensity').onchange = e => saveSettings({ density: e.target.value }).then(render)
  dlg.querySelector('#setOpen').onchange = e => saveSettings({ openMode: e.target.value })
  dlg.querySelector('#btnImport').onclick = () => pickFile(importSidebery)
  dlg.querySelector('#btnForget') && (dlg.querySelector('#btnForget').onclick = async () => {
    await browser.storage.local.remove('sbImport')
    dlg.close()
  })
  dlg.querySelector('#btnForgetLearned').onclick = async () => {
    await browser.storage.local.set({ learned: {} })
    dlg.close()
  }
  dlg.querySelector('#setThumbs').onchange = async e => {
    if (e.target.checked) {
      const ok = await browser.permissions.request({ origins: ['<all_urls>'] })
      e.target.checked = ok
      await saveSettings({ thumbs: ok })
    } else {
      await saveSettings({ thumbs: false })
    }
  }
  dlg.querySelector('#btnShots').onclick = () => captureLoaded()
  dlg.querySelector('#btnClearShots').onclick = async () => {
    await DB.clear('thumbs')
    for (const v of S.thumbs.values()) if (v) URL.revokeObjectURL(v)
    S.thumbs.clear()
    toast('Miniaturas borradas')
    render()
  }
  dlg.querySelector('#btnExport').onclick = exportDb
  dlg.querySelector('#btnImportDb').onclick = () => pickFile(importDb)
  dlg.querySelector('#btnExportMd').onclick = exportMd
  dlg.onclose = null
  if (!dlg.open) dlg.showModal()
  if (section) dlg.querySelector('#sec-' + section)?.scrollIntoView()
}

function pickFile(fn) {
  const input = $('#file')
  input.value = ''
  input.onchange = () => input.files[0] && fn(input.files[0])
  input.click()
}

async function importSidebery(file) {
  try {
    const text = await file.text()
    const data = M.parseSideberyExport(text)
    data.importedAt = Date.now()
    if (!data.tabCount) toast('El archivo trae los nombres y colores de los paneles, pero no qué pestaña va en cada uno (Sidebery no tenía ninguna instantánea). Para los colores de las pestañas: en Sidebery, Settings → Snapshots → «Create snapshot», y vuelve a exportar.', 15000)
    await browser.storage.local.set({ sbImport: data })
    S.sbImport = data
    await refresh()
    const n = await adoptImport()
    toast(`Sidebery: ${data.panels.length} paneles; ${n} pestañas ubicadas. Ya no hace falta volver a importar: a partir de ahora se sigue en vivo.`, 9000)
    if ($('#dlg').open) openSettings('sidebery')
  } catch (e) {
    toast('No es un archivo de Sidebery válido: ' + e.message, 7000)
  }
}

// Lo importado pasa a ser de cada pestaña (viaja con ella y sobrevive a reinicios y a
// cambios de dirección); el árbol se fija en openerTabId, que Pestañario guarda y repone.
async function adoptImport() {
  const imp = S.sbImport
  if (!imp || !imp.tabCount) return 0
  let n = 0
  for (const i of S.info.values()) {
    if (!i.sb || !i.sb.panel) continue
    const old = S.learned[i.id]
    if (!old || old[1] < imp.time) {
      S.learned[i.id] = [i.sb.panel, imp.time]
      browser.sessions.setTabValue(i.id, 'sbp', S.learned[i.id]).catch(() => {})
    }
    n++
    if (i.tab.openerTabId === undefined && i.parent !== -1) browser.tabs.update(i.id, { openerTabId: i.parent }).catch(() => {})
  }
  await browser.storage.local.set({ learned: S.learned })
  return n
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
}

function exportDb() {
  download(`pestanario-${stamp()}.json`, JSON.stringify({ app: 'pestanario', version: 1, fichas: [...S.fichas.values()], cols: [...S.cols.values()] }, null, 1), 'application/json')
}

async function importDb(file) {
  try {
    const data = JSON.parse(await file.text())
    if (data.app !== 'pestanario') throw new Error('no es una copia de Pestañario')
    const fichas = (data.fichas || []).map(f => {
      const old = S.fichas.get(f.url)
      if (!old) return f
      return { ...old, ...f, tags: [...new Set([...(old.tags || []), ...(f.tags || [])])], cols: [...new Set([...(old.cols || []), ...(f.cols || [])])], links: [...new Set([...(old.links || []), ...(f.links || [])])], note: old.note && f.note && old.note !== f.note ? old.note + '\n\n' + f.note : f.note || old.note }
    })
    await DB.putMany('fichas', fichas)
    await DB.putMany('cols', data.cols || [])
    await loadDb()
    bc.postMessage({ type: 'db' })
    buildItems()
    render()
    toast(`Importadas ${fichas.length} fichas y ${(data.cols || []).length} colecciones`)
  } catch (e) {
    toast('No se pudo importar: ' + e.message, 6000)
  }
}

function exportMd() {
  const out = [`# Pestañario · ${new Date().toLocaleString()}`, '']
  const colPath = id => {
    const parts = []
    while (id && S.cols.has(id)) {
      parts.unshift(S.cols.get(id).name)
      id = S.cols.get(id).parent
    }
    return parts.join('/')
  }
  for (const f of [...S.fichas.values()].sort((a, b) => (a.alias || a.title || '').localeCompare(b.alias || b.title || ''))) {
    out.push(`## ${f.alias || f.title || f.url}`, '', f.rawUrl || f.url, '')
    const tags = [...(f.tags || [])].map(t => '#' + t).join(' ')
    if (tags) out.push(tags, '')
    if (f.cols && f.cols.length) out.push('Colecciones: ' + f.cols.map(colPath).filter(Boolean).join(', '), '')
    if (f.links && f.links.length) out.push('Vínculos: ' + f.links.map(u => `[[${S.fichas.get(u)?.alias || S.fichas.get(u)?.title || u}]]`).join(', '), '')
    if (f.note) out.push(f.note, '')
  }
  download(`pestanario-${stamp()}.md`, out.join('\n'), 'text/markdown')
}

async function captureLoaded() {
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    const ok = await browser.permissions.request({ origins: ['<all_urls>'] })
    if (!ok) return
  }
  const tabs = [...S.items.values()].filter(it => it.kind === 'tab' && !it.discarded && /^https?:/.test(it.url))
  let n = 0
  for (const it of tabs) {
    try {
      const t = S.info.get(it.id).tab
      const scale = Math.min(1, 400 / (t.width || 1280))
      const dataUrl = await browser.tabs.captureTab(it.id, { format: 'jpeg', quality: 60, scale })
      const blob = await (await fetch(dataUrl)).blob()
      await DB.put('thumbs', { url: it.nurl, blob, t: Date.now() })
      dropThumb(it.nurl)
      n++
      if (n % 5 === 0) toast(`Miniaturas: ${n}/${tabs.length}`)
    } catch {}
  }
  toast(`${n} miniaturas hechas`)
  renderMain()
}

// ---------------------------------------------------------------------------
// Grafo

function graphData() {
  let base = !S.query.empty ? subtree(S.loc).filter(it => M.matches(it, S.query)) : subtree(S.loc)
  if (S.loc.t === 'all' || S.loc.t === 'saved' || S.loc.t === 'archive' || S.loc.t === 'tags' || S.loc.t === 'cols') {
    base = [...S.items.values()].filter(it => (it.kind === 'tab' || it.kind === 'ficha') && (it.saved || S.loc.t === 'all'))
  }
  base = base.filter(Boolean).slice(0, 700)
  const nodes = new Map()
  const edges = []
  const add = it => {
    if (!nodes.has(it.key)) nodes.set(it.key, { id: it.key, label: it.title, color: it.color || it.sbColor || (S.panelMeta.get(it.panel) ? M.colorCss(S.panelMeta.get(it.panel).color) : '') || hashColor(it.domain || ''), size: it.saved ? 6 : 4, dim: !it.open })
  }
  for (const it of base) add(it)
  for (const it of base) {
    if (it.kind === 'tab' && it.parent !== -1 && nodes.has('t:' + it.parent)) edges.push([it.key, 't:' + it.parent, 'tree'])
    for (const u of it.links || []) {
      const o = itemForUrl(u)
      if (o) {
        add(o)
        edges.push([it.key, o.key, 'link'])
      }
    }
    const f = fichaFor(it.nurl)
    if (f) for (const w of M.wikiLinks(f.note)) {
      const o = resolveLink(w)
      if (o && o.key !== it.key) {
        add(o)
        edges.push([it.key, o.key, 'link'])
      }
    }
    for (const t of it.tags || []) {
      const k = 'g:' + t
      if (!nodes.has(k)) nodes.set(k, { id: k, label: '#' + t, color: 'var(--acc)', size: 3, tag: true })
      edges.push([it.key, k, 'tag'])
    }
  }
  return { nodes: [...nodes.values()], edges, sel: S.sel }
}

// ---------------------------------------------------------------------------
// Barra superior

$('#btnSide').onclick = () => saveSettings({ side: !S.settings.side })
$('#btnBack').onclick = back
$('#btnFwd').onclick = forward
$('#btnUp').onclick = up
$('#btnInspector').onclick = () => saveSettings({ insp: !S.settings.insp }).then(render)
$('#btnSettings').onclick = () => openSettings()
$('#btnWindow').onclick = async () => {
  const cur = await browser.windows.getCurrent()
  const me = await browser.tabs.getCurrent()
  if (cur.type === 'popup') {
    const normal = S.wins.find(w => w.focused) || S.wins[0]
    await browser.tabs.create({ url: SELF, ...(normal ? { windowId: normal.id } : {}) })
    if (normal) browser.windows.update(normal.id, { focused: true })
    window.close()
    return
  }
  const { winBounds } = await browser.storage.local.get('winBounds')
  await browser.windows.create({ url: SELF, type: 'popup', ...(winBounds || { width: 1200, height: 800 }) })
  if (me) browser.tabs.remove(me.id)
}
$('#views').onclick = e => {
  const b = e.target.closest('[data-view]')
  if (b) setView(b.dataset.view)
}
$('#btnExpand').onclick = () => expandAll(true)
$('#btnCollapse').onclick = () => expandAll(false)
$('#sort').onchange = e => saveSettings({ sort: e.target.value }).then(render)
$('#zoom').oninput = e => saveSettings({ zoom: +e.target.value }).then(renderMain)

const onSearch = debounce(() => {
  S.query = M.parseQuery($('#search').value)
  $('#list').scrollTop = 0
  render()
}, 120)
$('#search').addEventListener('input', onSearch)

// Redimensionar barras laterales
for (const sp of document.querySelectorAll('.split')) {
  sp.addEventListener('mousedown', e => {
    e.preventDefault()
    const which = sp.dataset.split
    const startX = e.clientX
    const start = which === 'side' ? S.settings.sideW : S.settings.inspW
    const move = ev => {
      const d = ev.clientX - startX
      const v = Math.max(160, Math.min(700, which === 'side' ? start + d : start - d))
      document.documentElement.style.setProperty(which === 'side' ? '--side-w' : '--insp-w', v + 'px')
      S.settings[which === 'side' ? 'sideW' : 'inspW'] = v
      renderMainSoon()
    }
    const upFn = () => {
      removeEventListener('mousemove', move)
      removeEventListener('mouseup', upFn)
      saveSettings({})
    }
    addEventListener('mousemove', move)
    addEventListener('mouseup', upFn)
  })
}

window.addEventListener('resize', () => {
  renderMainSoon()
  saveWinBounds()
})

// En ventana aparte: recordar tamaño y posición
const saveWinBounds = debounce(async () => {
  const w = await browser.windows.getCurrent()
  if (w.type === 'popup') browser.storage.local.set({ winBounds: { width: w.width, height: w.height, left: w.left, top: w.top } })
}, 500)

// ---------------------------------------------------------------------------
// Cambios de fuera: pestañas, ajustes, otras ventanas del explorador

const TAB_PROPS = ['title', 'url', 'favIconUrl', 'pinned', 'discarded', 'hidden', 'audible', 'mutedInfo']
browser.tabs.onCreated.addListener(scheduleRefresh)
browser.tabs.onRemoved.addListener(scheduleRefresh)
browser.tabs.onMoved.addListener(scheduleRefresh)
browser.tabs.onAttached.addListener(scheduleRefresh)
browser.tabs.onDetached.addListener(scheduleRefresh)
browser.tabs.onActivated.addListener(scheduleRefresh)
browser.tabs.onUpdated.addListener(scheduleRefresh, { properties: TAB_PROPS })
browser.windows.onCreated.addListener(scheduleRefresh)
browser.windows.onRemoved.addListener(scheduleRefresh)
browser.windows.onFocusChanged.addListener(scheduleRefresh)

browser.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return
  if (ch.learned) S.learned = ch.learned.newValue || {}
  if (ch.sbImport) S.sbImport = ch.sbImport.newValue || null
  if (ch.settings) {
    S.settings = { ...DEFAULTS, ...(ch.settings.newValue || {}) }
    applyLook()
  }
  if (ch.learned || ch.sbImport) scheduleRefresh()
})

bc.onmessage = async e => {
  const m = e.data || {}
  if (m.type === 'db') {
    await loadDb()
    buildItems()
    renderSoon()
  }
  if (m.type === 'thumb') {
    dropThumb(m.url)
    if (S.settings.view === 'icons') renderMainSoon()
  }
}

function handleHash() {
  const h = location.hash.slice(1)
  if (h === 'ajustes') return openSettings()
  const m = /^tab=(\d+)/.exec(h)
  if (m) {
    const it = tabItem(+m[1])
    if (it) {
      go(it.parent !== -1 ? { t: 'folder', id: it.parent } : it.pinned ? { t: 'pinned', w: it.win } : { t: 'panel', w: it.win, p: it.panel })
      selectOnly(it.key)
      setTimeout(() => scrollIntoView(rowIndex(it.key)), 50)
    }
  }
}
window.addEventListener('hashchange', handleHash)

// ---------------------------------------------------------------------------
// Inicio

;(async function init() {
  S.treeOpen = new Set(lsGet('treeOpen', []))
  S.loc = lsGet('loc', { t: 'all' })
  await Promise.all([loadSettings(), loadDb(), loadContainers()])
  await refresh()
  // Si la ubicación guardada ya no existe, empezar por el panel actual
  const cur = S.wins.find(w => w.focused) || S.wins[0]
  if (S.loc.w !== undefined && !S.wins.some(w => w.id === S.loc.w) && cur) S.loc = { ...S.loc, w: cur.id }
  if ((S.loc.t === 'folder' && !tabItem(S.loc.id)) || (S.loc.t === 'col' && !S.cols.has(S.loc.id))) S.loc = { t: 'all' }
  render()
  const me = await browser.windows.getCurrent()
  $('#btnWindow').title = me.type === 'popup' ? 'Pasar a una pestaña' : 'Abrir en una ventana aparte'
  handleHash()
  listEl().focus()
})()
