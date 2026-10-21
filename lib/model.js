// Lógica pura (sin APIs del navegador): datos de Sidebery, paneles, árbol, búsqueda y enlaces.
// Se usa en la extensión y en las pruebas de Node.
(function (root) {
  'use strict'

  // Colores con nombre de Sidebery (src/defaults.ts → RGB_COLORS).
  const SB_COLORS = {
    blue: '#37adff',
    turquoise: '#00c79a',
    cyan: '#00c79a',
    green: '#51cd00',
    yellow: '#ffcb00',
    orange: '#ff9f00',
    red: '#ff613d',
    pink: '#ff4bda',
    purple: '#af51f5',
    toolbar: '#686868',
    gray: '#686868',
  }

  function colorCss(c) {
    if (!c) return ''
    return SB_COLORS[c] || c
  }

  const SB_PANEL_TABS = 2 // E.PanelType.tabs
  const UNCHANGED = -1 // E.SnapStoreMode.Unchanged
  const NO_PANEL = ''

  // ---------------------------------------------------------------------------
  // Direcciones

  const TRACKING_RE = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igsh|igshid|_hsenc|_hsmi|yclid)$/i

  // Direcciones internas de Sidebery: …/sidebery/url.html#… (pestaña que no pudo cargar)
  // y …/sidebery/group.html#… (pestaña de grupo).
  function sideberyPage(url) {
    if (!url || !url.startsWith('moz-extension://')) return ''
    if (url.includes('/sidebery/url.html')) return 'url'
    if (url.includes('/sidebery/group.html')) return 'group'
    return ''
  }

  function hashPrefix(url) {
    const i = url.indexOf('#')
    if (i < 0) return ''
    let h = url.slice(i + 1)
    const ch = h.indexOf('~!')
    if (ch >= 0) h = h.slice(0, ch)
    const id = h.search(/:id:|%3Aid%3A/)
    if (id >= 0) h = h.slice(0, id)
    return h
  }

  function decodeB64Utf8(s) {
    const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary')
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }

  // Devuelve la dirección real (equivale a Utils.restoreUrl de Sidebery).
  function restoreUrl(url) {
    const kind = sideberyPage(url)
    if (kind === 'url') {
      const info = hashPrefix(url)
      try {
        if (info.startsWith('_')) return JSON.parse(decodeB64Utf8(info.slice(1))).url || url
        if (info.startsWith('%5B')) return JSON.parse(decodeURIComponent(info))[0] || url
        return info || url
      } catch {
        return url
      }
    }
    if (kind === 'group') {
      const ch = url.indexOf('~!')
      return ch >= 0 ? url.slice(0, ch) : url
    }
    return url
  }

  function groupName(url) {
    try {
      return decodeURIComponent(hashPrefix(url))
    } catch {
      return hashPrefix(url)
    }
  }

  // Clave de ficha: la misma página aunque cambien parámetros de rastreo o la barra final.
  function normUrl(raw) {
    const url = restoreUrl(raw || '')
    if (sideberyPage(url) === 'group') return 'sidebery-group:' + groupName(url)
    let u
    try {
      u = new URL(url)
    } catch {
      return url
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
    for (const k of [...u.searchParams.keys()]) if (TRACKING_RE.test(k)) u.searchParams.delete(k)
    if (u.hostname.startsWith('www.')) u.hostname = u.hostname.slice(4)
    let s = u.protocol === 'http:' ? 'https:' + u.href.slice(5) : u.href
    if (u.pathname.length > 1 && u.pathname.endsWith('/') && !u.search && !u.hash) s = s.slice(0, -1)
    if (u.pathname === '/' && !u.search && !u.hash && s.endsWith('/')) s = s.slice(0, -1)
    return s
  }

  function domainOf(url) {
    try {
      const u = new URL(restoreUrl(url))
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '')
      return u.protocol.replace(':', '')
    } catch {
      return ''
    }
  }

  // ---------------------------------------------------------------------------
  // Importar datos de Sidebery (copia de seguridad o instantánea exportada)

  function normalizeSnapshots(list) {
    let prev = null
    const out = []
    for (const s of list) {
      if (!s || !Array.isArray(s.tabs)) continue
      const n = {
        id: s.id,
        time: s.time,
        containers: s.containers === UNCHANGED ? prev && prev.containers : s.containers,
        sidebar: s.sidebar === UNCHANGED ? prev && prev.sidebar : s.sidebar,
        tabs: s.tabs.map((win, wi) =>
          (win || []).map((panel, pi) =>
            (panel || []).map((tab, ti) => (tab === UNCHANGED ? prev && prev.tabs[wi] && prev.tabs[wi][pi] && prev.tabs[wi][pi][ti] : tab))
          )
        ),
      }
      out.push(n)
      prev = n
    }
    return out
  }

  // Acepta: instantánea exportada (JSON), copia de seguridad completa de Sidebery
  // (Ajustes → Ayuda → Exportar) o una lista de instantáneas.
  // Devuelve { time, panels: [{id, name, color, icon}], windows: [[tab…]] }.
  function parseSideberyExport(data) {
    if (typeof data === 'string') data = JSON.parse(data)
    if (!data || typeof data !== 'object') throw new Error('No es un archivo de Sidebery')

    let snap = null
    if (Array.isArray(data)) {
      const n = normalizeSnapshots(data)
      snap = n[n.length - 1]
    } else if (Array.isArray(data.tabs) && data.sidebar) {
      snap = normalizeSnapshots([data])[0]
    } else if (Array.isArray(data.snapshots) && data.snapshots.length) {
      const n = normalizeSnapshots(data.snapshots)
      snap = n[n.length - 1]
    }

    const sidebar = (data.sidebar && data.sidebar.panels && data.sidebar) || (snap && snap.sidebar)
    if (!sidebar || !sidebar.panels) throw new Error('El archivo no contiene paneles de Sidebery')

    const order = Array.isArray(sidebar.nav) ? sidebar.nav : Object.keys(sidebar.panels)
    const panels = []
    for (const id of order) {
      const p = sidebar.panels[id]
      if (!p || p.type !== SB_PANEL_TABS) continue
      panels.push({ id: String(p.id), name: p.name || 'Panel', color: p.color || 'toolbar', icon: p.iconIMG || '' })
    }
    const nameById = Object.fromEntries(panels.map(p => [p.id, p.name]))

    const windows = []
    if (snap) {
      for (const win of snap.tabs) {
        const flat = []
        for (const group of win || []) {
          for (const t of group || []) {
            if (!t || !t.url) continue
            flat.push({
              url: restoreUrl(t.url),
              title: t.title || '',
              panel: nameById[String(t.panelId)] || NO_PANEL,
              lvl: t.lvl || 0,
              pinned: !!t.pinned,
              color: t.customColor || '',
              customTitle: t.customTitle || '',
            })
          }
        }
        windows.push(flat)
      }
    }

    return {
      time: (snap && snap.time) || Date.now(),
      panels,
      windows,
      tabCount: windows.reduce((a, w) => a + w.length, 0),
    }
  }

  // Empareja las pestañas abiertas de una ventana con la ventana importada que más se parece,
  // y cada pestaña con su entrada por dirección (en orden). Devuelve Map(tabId → entrada).
  function matchImport(liveTabs, imported) {
    const res = new Map()
    if (!imported || !imported.windows || !imported.windows.length) return res
    const liveKeys = liveTabs.map(t => normUrl(t.url))
    const liveSet = new Set(liveKeys)
    let best = null
    let bestScore = 0
    for (const w of imported.windows) {
      let score = 0
      for (const e of w) if (liveSet.has(normUrl(e.url))) score++
      if (score > bestScore) {
        bestScore = score
        best = w
      }
    }
    if (!best) return res
    const queues = new Map()
    for (const e of best) {
      const k = normUrl(e.url)
      let q = queues.get(k)
      if (!q) queues.set(k, (q = []))
      q.push(e)
    }
    liveTabs.forEach((t, i) => {
      const q = queues.get(liveKeys[i])
      if (q && q.length) res.set(t.id, q.shift())
    })
    return res
  }

  // ---------------------------------------------------------------------------
  // Paneles: Sidebery mantiene las pestañas de cada panel juntas y en el orden de los paneles.
  // known: Map(tabId → {panel, time}) con lo que se sabe (aprendido o importado).
  // Las que no se saben se deducen por sus vecinas. Devuelve Map(tabId → {panel, sure}).
  function assignPanels(tabs, known) {
    const out = new Map()
    const normal = []
    for (const t of tabs) {
      const k = known.get(t.id)
      if (t.pinned) out.set(t.id, { panel: (k && k.panel) || NO_PANEL, sure: !!k })
      else normal.push(t)
    }
    const val = normal.map(t => {
      const k = known.get(t.id)
      return k && k.panel ? k.panel : null
    })
    const prev = new Array(normal.length)
    let last = null
    for (let i = 0; i < normal.length; i++) {
      if (val[i] !== null) last = val[i]
      prev[i] = last
    }
    let next = null
    for (let i = normal.length - 1; i >= 0; i--) {
      if (val[i] !== null) {
        next = val[i]
        out.set(normal[i].id, { panel: val[i], sure: true })
        continue
      }
      const p = prev[i]
      const panel = p !== null ? p : next !== null ? next : NO_PANEL
      out.set(normal[i].id, { panel, sure: p !== null && p === next })
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // Árbol: el mismo cálculo que Tabs.updateTabsTree de Sidebery, a partir de openerTabId
  // (Sidebery lo mantiene igual al padre; una pestaña raíz se apunta a sí misma).
  // Devuelve Map(tabId → {parent, lvl}).
  function computeTree(tabs, panelOf) {
    const byId = new Map()
    const idx = new Map()
    tabs.forEach((t, i) => {
      byId.set(t.id, t)
      idx.set(t.id, i)
    })
    const node = new Map()
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i]
      if (t.pinned) {
        node.set(t.id, { parent: -1, lvl: 0 })
        continue
      }
      const pid = t.openerTabId !== undefined && t.openerTabId !== t.id ? t.openerTabId : -1
      let p = byId.get(pid)
      if (p && (p.pinned || idx.get(p.id) >= i)) p = undefined
      if (p && panelOf(p) === panelOf(t)) {
        const lvl = node.get(p.id).lvl + 1
        node.set(t.id, { parent: p.id, lvl })
        const prev = tabs[i - 1]
        if (prev && prev.id !== p.id && node.get(prev.id).lvl < lvl) {
          for (let j = i - 1; j >= 0; j--) {
            const back = tabs[j]
            if (back.id === p.id) break
            if (panelOf(back) !== panelOf(t)) break
            node.set(back.id, { parent: p.id, lvl })
          }
        }
      } else {
        node.set(t.id, { parent: -1, lvl: 0 })
      }
    }
    return node
  }

  // ---------------------------------------------------------------------------
  // Mover sin romper Sidebery. Con browser.tabs.move(id, {index: f}) la pestaña acaba en f, y
  // Sidebery la pone en el panel de la pestaña que ocupaba f antes de mover. Planifica uno o
  // dos movimientos para que esa pestaña sea siempre del panel de destino.
  // list: [{id, panel}] en orden; where: {after: id} o {before: id}. Devuelve [índices].
  function planMove(list, tabId, where) {
    const pos = id => list.findIndex(x => x.id === id)
    const t = pos(tabId)
    const anchorId = where.after !== undefined ? where.after : where.before
    const a = pos(anchorId)
    if (t < 0 || a < 0 || anchorId === tabId) return []
    const panel = list[a].panel
    if (where.after !== undefined) {
      if (t < a) return [a]
      const f = a + 1
      if (f === t && list[t].panel === panel) return []
      if (f !== t && list[f] && list[f].panel === panel) return [f]
      return [a, a + 1]
    }
    if (t > a) return [a]
    const f = a - 1
    if (f === t && list[t].panel === panel) return []
    if (f !== t && list[f] && list[f].panel === panel) return [f]
    return [a, a - 1]
  }

  function applyMove(list, from, to) {
    const [x] = list.splice(from, 1)
    list.splice(to, 0, x)
  }

  // ---------------------------------------------------------------------------
  // Búsqueda: texto libre y filtros  #etiqueta  tag:  panel:  site:  color:  en:  es:abierta|cerrada|dormida|sonando|fijada|ficha|nota
  // Un «-» delante niega. Las comillas agrupan.
  const KEYS = { tag: 'tag', etiqueta: 'tag', panel: 'panel', site: 'site', web: 'site', color: 'color', en: 'col', in: 'col', es: 'is', is: 'is' }

  function parseQuery(q) {
    const tokens = (q || '').match(/-?(?:\w+:)?"[^"]*"|\S+/g) || []
    const terms = []
    const filters = []
    for (let tok of tokens) {
      let neg = false
      if (tok.startsWith('-') && tok.length > 1) {
        neg = true
        tok = tok.slice(1)
      }
      if (tok.startsWith('#') && tok.length > 1) {
        filters.push({ key: 'tag', val: tok.slice(1).toLowerCase(), neg })
        continue
      }
      const m = /^(\w+):(.*)$/.exec(tok)
      if (m && KEYS[m[1].toLowerCase()]) {
        filters.push({ key: KEYS[m[1].toLowerCase()], val: m[2].replace(/"/g, '').toLowerCase(), neg })
        continue
      }
      const word = tok.replace(/"/g, '').toLowerCase()
      if (word) terms.push({ val: word, neg })
    }
    return { terms, filters, empty: !terms.length && !filters.length }
  }

  // item: {title, url, domain, tags[], panel, color, colorName, cols[], note, open, discarded, audible, pinned, saved}
  function matches(item, query) {
    if (query.empty) return true
    const hay = (item._hay ||= [item.title, item.customTitle, item.url, item.note, (item.tags || []).join(' ')].join('\n').toLowerCase())
    for (const t of query.terms) if (hay.includes(t.val) === t.neg) return false
    for (const f of query.filters) {
      let ok
      const v = f.val
      switch (f.key) {
        case 'tag':
          ok = (item.tags || []).some(x => {
            x = x.toLowerCase()
            return x === v || x.startsWith(v + '/')
          })
          break
        case 'panel':
          ok = (item.panel || '').toLowerCase().includes(v)
          break
        case 'site':
          ok = (item.domain || '').includes(v)
          break
        case 'color':
          ok = [item.color, item.colorName, item.sbColor].some(c => c && c.toLowerCase().includes(v))
          break
        case 'col':
          ok = (item.cols || []).some(c => c.toLowerCase().includes(v))
          break
        case 'is':
          ok =
            (v.startsWith('abiert') || v === 'open') ? item.open :
            (v.startsWith('cerrad') || v === 'closed') ? !item.open :
            (v.startsWith('dormid') || v === 'discarded') ? item.discarded :
            (v.startsWith('sonand') || v === 'audible') ? item.audible :
            (v.startsWith('fijad') || v === 'pinned') ? item.pinned :
            v === 'ficha' || v === 'saved' ? item.saved :
            v === 'nota' || v === 'note' ? !!item.note :
            false
          break
        default:
          ok = true
      }
      if (ok === f.neg) return false
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // Notas al estilo Obsidian: [[enlace]] o [[enlace|texto]], y #etiquetas/anidadas.
  function wikiLinks(text) {
    const out = []
    if (!text) return out
    const re = /\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g
    let m
    while ((m = re.exec(text))) out.push(m[1].trim())
    return out
  }

  function noteTags(text) {
    const out = new Set()
    if (!text) return []
    const re = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu
    let m
    while ((m = re.exec(text))) out.add(m[2].replace(/\/+$/, ''))
    return [...out]
  }

  function cleanTag(t) {
    return String(t || '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '-')
      .replace(/\/{2,}/g, '/')
      .replace(/^\/|\/$/g, '')
  }

  const api = {
    SB_COLORS,
    NO_PANEL,
    colorCss,
    sideberyPage,
    restoreUrl,
    groupName,
    normUrl,
    domainOf,
    normalizeSnapshots,
    parseSideberyExport,
    matchImport,
    assignPanels,
    computeTree,
    planMove,
    applyMove,
    parseQuery,
    matches,
    wikiLinks,
    noteTags,
    cleanTag,
  }
  root.Model = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
