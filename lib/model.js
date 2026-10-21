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
    let all = []
    if (Array.isArray(data)) all = normalizeSnapshots(data)
    else if (Array.isArray(data.tabs) && data.sidebar) all = normalizeSnapshots([data])
    else if (Array.isArray(data.snapshots) && data.snapshots.length) all = normalizeSnapshots(data.snapshots)
    // La más reciente (por fecha, no por posición en el archivo)
    for (const n of all) if (!snap || (n.time || 0) >= (snap.time || 0)) snap = n
    // Diagnóstico: pestañas por instantánea y entradas que no se pudieron reconstruir
    const count = n => {
      let ok = 0
      let lost = 0
      for (const w of n.tabs || []) for (const g of w || []) for (const t of g || []) t && t.url ? ok++ : lost++
      return { ok, lost }
    }
    const snapshots = all.map(n => ({ time: n.time, wins: (n.tabs || []).length, ...count(n) }))

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
      snapshots,
      lost: snap ? count(snap).lost : 0,
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
  // known: Map(tabId → {panel}) con lo que se sabe (aprendido o importado); order: nombres de
  // panel en orden (si se conocen). Lo que no se sabe se deduce por las vecinas; lo que no se
  // puede deducir queda sin panel. Devuelve Map(tabId → {panel, sure}).
  function assignPanels(tabs, known, order = []) {
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

    // Un panel ocupa un solo tramo: los tramos sueltos de un panel que ya tiene otro mayor
    // son datos viejos (la pestaña se movió después) y pasan al panel que los rodea.
    // Se corrige de uno en uno, empezando por el tramo más pequeño y con el dato más viejo.
    const timeOf = i => (known.get(normal[i].id) || {}).time || 0
    for (let guard = 0; guard < 1000; guard++) {
      const runs = []
      for (let i = 0; i < val.length; i++) {
        if (val[i] === null) continue
        const last = runs[runs.length - 1]
        if (last && last.panel === val[i]) {
          last.end = i
          last.count++
          last.time = Math.max(last.time, timeOf(i))
        } else runs.push({ panel: val[i], start: i, end: i, count: 1, time: timeOf(i) })
      }
      const best = new Map()
      for (const r of runs) {
        const b = best.get(r.panel)
        if (!b || r.count > b.count || (r.count === b.count && r.time > b.time)) best.set(r.panel, r)
      }
      let worst = -1
      runs.forEach((r, k) => {
        if (best.get(r.panel) === r) return
        const w = runs[worst]
        if (worst < 0 || r.count < w.count || (r.count === w.count && r.time < w.time)) worst = k
      })
      if (worst < 0) break
      const r = runs[worst]
      const prevRun = runs[worst - 1]
      const nextRun = runs[worst + 1]
      const target = prevRun && nextRun && prevRun.panel === nextRun.panel ? prevRun.panel : prevRun ? prevRun.panel : nextRun.panel
      for (let j = r.start; j <= r.end; j++) if (val[j] !== null) val[j] = target
    }

    const rank = name => order.indexOf(name)
    const lastRank = order.length - 1
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
      let r
      if (p !== null && p === next) r = { panel: p, sure: true }
      else if (p !== null && next !== null) r = { panel: p, sure: false }
      // Antes de la primera o después de la última conocida: solo si se sabe el orden de paneles
      else if (p !== null) r = order.length ? { panel: p, sure: rank(p) === lastRank } : { panel: NO_PANEL, sure: false }
      else if (next !== null) r = order.length ? { panel: next, sure: rank(next) === 0 } : { panel: NO_PANEL, sure: false }
      else r = { panel: NO_PANEL, sure: false }
      out.set(normal[i].id, r)
    }
    return out
  }

  // Padres a partir de los niveles importados de Sidebery (para cuando Firefox ha olvidado
  // openerTabId, p. ej. tras reiniciar). lvlOf(t) → nivel o undefined. Devuelve Map(id → padre).
  function parentsFromLevels(tabs, lvlOf, panelOf) {
    const res = new Map()
    let stack = []
    let panel
    for (const t of tabs) {
      if (t.pinned) continue
      if (panelOf(t) !== panel) {
        stack = []
        panel = panelOf(t)
      }
      const lvl = lvlOf(t)
      if (lvl === undefined) continue
      while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop()
      const top = stack[stack.length - 1]
      if (lvl > 0 && top && top.lvl === lvl - 1) res.set(t.id, top.id)
      stack.push({ id: t.id, lvl })
    }
    return res
  }

  // ---------------------------------------------------------------------------
  // Árbol: el mismo cálculo que Tabs.updateTabsTree de Sidebery, a partir de openerTabId
  // (Sidebery lo mantiene igual al padre; una pestaña raíz se apunta a sí misma).
  // Devuelve Map(tabId → {parent, lvl}).
  function computeTree(tabs, panelOf, hint) {
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
      let pid = t.openerTabId !== undefined && t.openerTabId !== t.id && byId.has(t.openerTabId) ? t.openerTabId : -1
      if (pid === -1 && hint && hint.has(t.id) && t.openerTabId === undefined) pid = hint.get(t.id)
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

  // ---------------------------------------------------------------------------
  // Vista previa de vídeos de YouTube (imagen pública de i.ytimg.com, sin capturar nada)
  function youtubeId(raw) {
    let u
    try {
      u = new URL(restoreUrl(raw || ''))
    } catch {
      return ''
    }
    const host = u.hostname.replace(/^(www|m|music)\./, '')
    let id = ''
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0]
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v') || ''
      else {
        const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)
        if (m) id = m[2]
      }
    }
    return /^[\w-]{11}$/.test(id) ? id : ''
  }

  function youtubeThumb(id, big) {
    if (!id) return ''
    return big ? `https://i.ytimg.com/vi/${id}/hq720.jpg` : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
  }

  // ---------------------------------------------------------------------------
  // Simulador de Sidebery y planificador de movimientos seguros.
  // Cada vez que otra extensión mueve una pestaña, Sidebery recalcula todo el árbol con la regla
  // de computeTree: una pestaña separada de su madre la pierde, o hace que su madre «adopte»
  // todo lo que quedó en medio. Por eso no basta con mover pestaña a pestaña: se prueban varias
  // secuencias en memoria y solo se usa una que acabe exactamente en el estado pedido.
  // Estado: [{id, panel, parent, pinned}] en orden; parent es el que Sidebery tiene (-1 = raíz).

  function sbSettle(list) {
    const pan = new Map(list.map(x => [x.id, x.panel]))
    const node = computeTree(list.map(x => ({ id: x.id, pinned: x.pinned, openerTabId: x.parent === -1 ? x.id : x.parent })), t => pan.get(t.id))
    for (const x of list) x.parent = node.get(x.id).parent
  }

  // Un movimiento tal como lo hacen Firefox (índice final) y Sidebery (panel de la que ocupaba el sitio)
  function sbMove(list, id, to) {
    const from = list.findIndex(x => x.id === id)
    if (from < 0 || from === to) return
    const dst = list[to]
    const [t] = list.splice(from, 1)
    list.splice(to, 0, t)
    if (!t.pinned && dst && !dst.pinned) t.panel = dst.panel
    sbSettle(list)
  }

  const cloneState = list => list.map(x => ({ ...x }))

  function sameState(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id || a[i].parent !== b[i].parent) return false
      if (!a[i].pinned && a[i].panel !== b[i].panel) return false
    }
    return true
  }

  // Ordenación por selección hacia el orden pedido (de izquierda a derecha o al revés)
  function sortMoves(cur, des, rtl) {
    const ids = cur.map(x => x.id)
    const target = des.map(x => x.id)
    const moves = []
    const step = k => {
      if (ids[k] === target[k]) return
      const j = ids.indexOf(target[k])
      ids.splice(j, 1)
      ids.splice(k, 0, target[k])
      moves.push([target[k], k])
    }
    if (rtl) for (let k = ids.length - 1; k >= 0; k--) step(k)
    else for (let k = 0; k < ids.length; k++) step(k)
    return moves
  }

  function rootOf(list, id) {
    const byId = new Map(list.map(x => [x.id, x]))
    let t = byId.get(id)
    while (t && t.parent !== -1 && byId.has(t.parent)) t = byId.get(t.parent)
    return t
  }

  // Estado deseado al mover: ids (con sus hijas) a target = {panelEnd: panel} | {into: id} |
  // {after: id} | {before: id}. Devuelve {desired, tops} o {error}.
  function arrangeMove(state, ids, target) {
    const byId = new Map(state.map(x => [x.id, x]))
    const kids = new Map()
    for (const x of state) if (x.parent !== -1) {
      if (!kids.has(x.parent)) kids.set(x.parent, [])
      kids.get(x.parent).push(x.id)
    }
    const moving = new Set()
    const add = id => {
      const x = byId.get(id)
      if (!x || x.pinned || moving.has(id)) return
      moving.add(id)
      for (const k of kids.get(id) || []) add(k)
    }
    for (const id of ids) add(id)
    if (!moving.size) return { error: 'nothing' }
    const anchorId = target.into ?? target.after ?? target.before
    if (anchorId !== undefined && moving.has(anchorId)) return { error: 'self' }

    const rest = state.filter(x => !moving.has(x.id)).map(x => ({ ...x }))
    const ri = id => rest.findIndex(x => x.id === id)
    const lastDesc = id => {
      let i = ri(id)
      const isIn = new Set([id])
      for (let j = i + 1; j < rest.length; j++) {
        if (isIn.has(rest[j].parent)) {
          isIn.add(rest[j].id)
          i = j
        } else break
      }
      return i
    }
    let ins
    let panel
    let parent
    if (target.panelEnd !== undefined) {
      panel = target.panelEnd
      ins = -1
      rest.forEach((x, i) => {
        if (!x.pinned && x.panel === panel) ins = i + 1
      })
      if (ins < 0) return { error: 'empty' }
      parent = -1
    } else {
      const a = byId.get(anchorId)
      if (!a || a.pinned) return { error: 'anchor' }
      panel = a.panel
      if (target.into !== undefined) {
        ins = lastDesc(anchorId) + 1
        parent = anchorId
      } else if (target.after !== undefined) {
        ins = lastDesc(anchorId) + 1
        parent = a.parent
      } else {
        ins = ri(anchorId)
        parent = a.parent
      }
    }
    const tops = []
    const block = []
    for (const x of state) {
      if (!moving.has(x.id)) continue
      const isTop = !moving.has(x.parent)
      const c = { ...x, panel }
      if (isTop) {
        c.parent = parent
        tops.push({ id: x.id, parent })
      }
      block.push(c)
    }
    const desired = rest.slice(0, ins).concat(block, rest.slice(ins))
    return { desired, tops }
  }

  // Busca una secuencia segura para pasar de state a desired. Devuelve {moves} o null.
  function planArrangement(state, desired, tops = []) {
    if (sameState(state, desired)) return { moves: [] }
    const pre = {
      detach(list, moves) {
        for (const t of tops) {
          const x = list.find(y => y.id === t.id)
          if (!x || x.parent === -1) continue
          const r = rootOf(list, x.id)
          if (!r || r.id === x.id) continue
          const to = list.indexOf(r)
          moves.push([x.id, to])
          sbMove(list, x.id, to)
        }
      },
      // Entrar en el panel de destino por un extremo (primera o última pestaña del panel):
      // allí no hay madres que la adopten por error
      enter(list, moves) {
        for (const d of desired) {
          const x = list.find(y => y.id === d.id)
          if (!x || x.pinned || x.panel === d.panel) continue
          const idx = list.map((y, i) => (!y.pinned && y.panel === d.panel ? i : -1)).filter(i => i >= 0)
          if (!idx.length) continue
          const i = list.indexOf(x)
          const to = i < idx[0] ? idx[idx.length - 1] : idx[0]
          moves.push([x.id, to])
          sbMove(list, x.id, to)
        }
      },
      adopt(list, moves) {
        for (const t of tops) {
          if (t.parent === -1) continue
          const x = list.find(y => y.id === t.id)
          if (!x || x.parent === t.parent) continue
          const p = list.findIndex(y => y.id === t.parent)
          const i = list.indexOf(x)
          const to = i < p ? p : p + 1
          moves.push([x.id, to])
          sbMove(list, x.id, to)
        }
      },
    }
    // «Directo»: solo se mueven las pestañas que cambian, cada una tras la anterior, con
    // planMove para que Sidebery les dé el panel de destino.
    const changed = new Set(desired.filter(x => {
      const o = state.find(y => y.id === x.id)
      return o.panel !== x.panel || o.parent !== x.parent
    }).map(x => x.id))
    const direct = (list, moves) => {
      let prev = null
      for (let i = 0; i < desired.length; i++) {
        const d = desired[i]
        if (!changed.has(d.id)) {
          prev = null
          continue
        }
        let where
        if (prev !== null) where = { after: prev }
        else {
          const before = desired[i - 1]
          const after = desired.slice(i + 1).find(x => !changed.has(x.id))
          where = before && !before.pinned && before.panel === d.panel ? { after: before.id } : after ? { before: after.id } : { after: before.id }
        }
        const view = list.map(x => ({ id: x.id, panel: x.panel }))
        for (const to of planMove(view, d.id, where)) {
          moves.push([d.id, to])
          sbMove(list, d.id, to)
          const from = view.findIndex(x => x.id === d.id)
          applyMove(view, from, to)
        }
        prev = d.id
      }
    }
    // «Paso a paso»: en cada paso, el movimiento (desde la izquierda o la derecha, moviendo la
    // pestaña que falta o la que sobra) que más acerca al objetivo sin estropear nada que ya
    // estuviera bien.
    const want = new Map(desired.map(x => [x.id, x]))
    const okSet = l => new Set(l.filter(x => want.get(x.id).parent === x.parent && (x.pinned || want.get(x.id).panel === x.panel)).map(x => x.id))
    const score = l => {
      let h = 0
      for (let i = 0; i < l.length; i++) {
        const w = want.get(l[i].id)
        if (desired[i].id !== l[i].id) h++
        if (w.parent !== l[i].parent) h += 2
        if (!l[i].pinned && w.panel !== l[i].panel) h += 2
      }
      return h
    }
    const greedy = (list, moves) => {
      for (let guard = 0; guard < list.length * 3; guard++) {
        if (sameState(list, desired)) return
        const ids = list.map(x => x.id)
        const first = ids.findIndex((id, i) => id !== desired[i].id)
        let last = -1
        for (let i = ids.length - 1; i >= 0; i--) if (ids[i] !== desired[i].id) {
          last = i
          break
        }
        const cands = []
        const place = id => {
          // Mover id justo detrás de la que le precede en el objetivo (o delante de la que le sigue)
          const di = desired.findIndex(x => x.id === id)
          const from = ids.indexOf(id)
          if (di > 0) {
            const p = ids.indexOf(desired[di - 1].id)
            cands.push([id, from < p ? p : p + 1])
          }
          if (di < desired.length - 1) {
            const n = ids.indexOf(desired[di + 1].id)
            cands.push([id, from < n ? n - 1 : n])
          }
        }
        if (first >= 0) {
          cands.push([desired[first].id, first])
          place(ids[first])
        }
        if (last >= 0) {
          cands.push([desired[last].id, last])
          place(ids[last])
        }
        // Las que tienen mal la madre o el panel aunque estén en su sitio
        for (const x of list) {
          const w = want.get(x.id)
          if (w.parent !== x.parent || (!x.pinned && w.panel !== x.panel)) place(x.id)
        }
        const okBefore = okSet(list)
        const h0 = score(list)
        let pick = null
        for (const [id, to] of cands) {
          if (to < 0 || to >= list.length || ids.indexOf(id) === to) continue
          const c = cloneState(list)
          sbMove(c, id, to)
          const okAfter = okSet(c)
          let regress = false
          for (const k of okBefore) if (k !== id && !okAfter.has(k)) regress = true
          if (regress) continue
          const h = score(c)
          if (h < h0 && (!pick || h < pick.h)) pick = { id, to, h, c }
        }
        if (!pick) return
        moves.push([pick.id, pick.to])
        list.splice(0, list.length, ...pick.c)
      }
    }

    const combos = [[], ['detach'], ['adopt'], ['detach', 'adopt'], ['enter'], ['enter', 'adopt'], ['detach', 'enter', 'adopt']]
    let best = null
    for (const combo of combos) {
      for (const how of ['ltr', 'rtl', 'direct', 'greedy']) {
        const list = cloneState(state)
        const moves = []
        for (const c of combo) pre[c](list, moves)
        if (how === 'direct') direct(list, moves)
        if (how === 'greedy') greedy(list, moves)
        for (const [id, to] of sortMoves(list, desired, how === 'rtl')) {
          moves.push([id, to])
          sbMove(list, id, to)
        }
        if (sameState(list, desired) && (!best || moves.length < best.moves.length)) best = { moves }
      }
    }
    return best
  }

  // Último recurso: búsqueda guiada (haz) sobre la simulación, moviendo también las hermanas
  // del destino. Solo se usa cuando las estrategias rápidas no encuentran secuencia.
  function beamPlan(state, desired, movable, maxDepth = 8, width = 80, deadline = Infinity) {
    const ids = new Set(movable)
    const want = new Map(desired.map(x => [x.id, x]))
    const marks = new Set(ids)
    for (const x of desired) if (ids.has(x.id) && x.parent !== -1) marks.add(x.parent)
    // Posiciones a probar: junto a las pestañas implicadas
    const spots = l => {
      const out = new Set()
      l.forEach((x, i) => {
        if (marks.has(x.id)) for (const k of [i - 1, i, i + 1]) if (k >= 0 && k < l.length) out.add(k)
      })
      return out
    }
    const heur = l => {
      let h = 0
      for (let i = 0; i < l.length; i++) {
        const x = l[i]
        const w = want.get(x.id)
        if (desired[i].id !== x.id) h++
        if (x.parent !== w.parent) h += 2
        if (!x.pinned && x.panel !== w.panel) h += 2
      }
      return h
    }
    const key = l => l.map(x => x.id + ':' + x.parent + ':' + x.panel).join(',')
    const seen = new Set([key(state)])
    let beam = [{ list: state, moves: [] }]
    for (let d = 0; d < maxDepth; d++) {
      const cand = []
      for (const node of beam) {
        if (Date.now() > deadline) return null
        for (const id of ids) {
          const from = node.list.findIndex(x => x.id === id)
          for (const to of spots(node.list)) {
            if (to === from) continue
            const c = cloneState(node.list)
            sbMove(c, id, to)
            const k = key(c)
            if (seen.has(k)) continue
            seen.add(k)
            const moves = [...node.moves, [id, to]]
            if (sameState(c, desired)) return { moves }
            cand.push({ list: c, moves, h: heur(c) })
          }
        }
      }
      cand.sort((x, y) => x.h - y.h)
      beam = cand.slice(0, width)
      if (!beam.length) break
    }
    return null
  }

  // Movimiento completo: primero todo a la vez; si no hay secuencia segura, de una en una
  // (cada una detrás de la anterior). Devuelve {moves, desired} o {error}.
  function planMoveOp(fullState, ids, target) {
    const full = arrangeMove(fullState, ids, target)
    if (full.error) return full
    // Solo cuentan los paneles de origen y destino: los demás no cambian
    const before = new Map(fullState.map(x => [x.id, x.panel]))
    const involved = new Set()
    for (const x of full.desired) if (x.panel !== before.get(x.id) || full.tops.some(t => t.id === x.id)) {
      involved.add(x.panel)
      involved.add(before.get(x.id))
    }
    for (const x of full.desired) if (full.tops.some(t => t.id === x.id)) involved.add(x.panel)
    const state = fullState.filter(x => !x.pinned && involved.has(x.panel))
    const res = planCompressed(state, full, ids, target)
    if (res.error) return { ...res, desired: full.desired }
    // Índices → «ocupante» (la pestaña cuyo sitio toma), válido también en la lista completa
    const list = cloneState(state)
    const moves = []
    for (const [id, to] of res.moves) {
      if (list.findIndex(x => x.id === id) === to) continue
      moves.push([id, list[to].id])
      sbMove(list, id, to)
    }
    return { moves, desired: full.desired }
  }

  // Aplica movimientos [id, ocupante] (como hará la extensión con browser.tabs.move)
  function applyPlan(list, moves) {
    for (const [id, occ] of moves) sbMove(list, id, list.findIndex(x => x.id === occ))
  }

  function planCompressed(state, full, ids, target) {
    const r = arrangeMove(state, ids, target)
    if (r.error) return r
    // Imposible desde fuera: una carpeta con hijas que cambia de panel (Sidebery suelta las hijas
    // en cuanto quedan en otro panel que su madre, y solo cambia de panel la pestaña movida)
    const panelOf = new Map(state.map(x => [x.id, x.panel]))
    const newPanel = new Map(r.desired.map(x => [x.id, x.panel]))
    if (r.desired.some(x => x.parent !== -1 && panelOf.get(x.id) !== newPanel.get(x.id) && panelOf.get(x.parent) !== undefined && r.desired.find(y => y.id === x.parent) && state.find(y => y.id === x.id).parent === x.parent)) {
      return { error: 'folder-panel' }
    }
    const joint = planArrangement(state, r.desired, r.tops)
    if (joint) return { moves: joint.moves }
    // Búsqueda: lo que se mueve (con sus hijas), su madre antigua, la nueva, las hijas de la nueva
    // y las vecinas del destino
    const movable = new Set()
    const desc = id => {
      for (const y of state) if (y.parent === id && !movable.has(y.id)) {
        movable.add(y.id)
        desc(y.id)
      }
    }
    for (const t of r.tops) {
      const x = state.find(y => y.id === t.id)
      movable.add(t.id)
      desc(t.id)
      if (x.parent !== -1) movable.add(x.parent)
      if (t.parent !== -1) {
        movable.add(t.parent)
        for (const y of state) if (y.parent === t.parent) movable.add(y.id)
      }
      const di = r.desired.findIndex(y => y.id === t.id)
      for (const k of [di - 1, di + 1]) if (r.desired[k]) movable.add(r.desired[k].id)
    }
    if (movable.size <= 16) {
      const b = beamPlan(state, r.desired, [...movable], 8, 80, Date.now() + 1500)
      if (b) return { moves: b.moves }
    }
    if (r.tops.length < 2) return { error: 'unsafe' }
    let cur = cloneState(state)
    const moves = []
    let tgt = target
    for (const t of r.tops) {
      const ri = arrangeMove(cur, [t.id], tgt)
      if (ri.error) return { error: ri.error }
      const p = planArrangement(cur, ri.desired, ri.tops)
      if (!p) return { error: 'unsafe' }
      for (const [id, to] of p.moves) {
        moves.push([id, to])
        sbMove(cur, id, to)
      }
      if (target.into === undefined && target.panelEnd === undefined) tgt = { after: t.id }
    }
    if (!sameState(cur, r.desired)) return { error: 'unsafe' }
    return { moves }
  }

  // Volver a un estado anterior (deshacer). Devuelve {moves} (como planMoveOp) o {error}.
  function planRestore(fullState, desiredFull) {
    const cur = new Map(fullState.map(x => [x.id, x]))
    const want = new Map(desiredFull.map(x => [x.id, x]))
    if (cur.size !== want.size || [...cur.keys()].some(id => !want.has(id))) return { error: 'changed' }
    const involved = new Set()
    desiredFull.forEach((d, i) => {
      const c = cur.get(d.id)
      if (c.pinned) return
      if (c.parent !== d.parent || c.panel !== d.panel || fullState[i].id !== d.id) {
        involved.add(c.panel)
        involved.add(d.panel)
      }
    })
    if (!involved.size) return { moves: [] }
    const state = fullState.filter(x => !x.pinned && involved.has(x.panel))
    const desired = desiredFull.filter(x => !x.pinned && involved.has(x.panel))
    if (state.length !== desired.length) return { error: 'changed' }
    const tops = desired.filter(d => cur.get(d.id).parent !== d.parent || cur.get(d.id).panel !== d.panel).map(d => ({ id: d.id, parent: d.parent }))
    let plan = planArrangement(state, desired, tops)
    if (!plan) {
      const movable = new Set(tops.map(t => t.id))
      for (const t of tops) {
        if (t.parent !== -1) movable.add(t.parent)
        const p = cur.get(t.id).parent
        if (p !== -1) movable.add(p)
      }
      desired.forEach((d, i) => {
        if (state[i].id !== d.id) movable.add(d.id)
      })
      if (movable.size <= 16) plan = beamPlan(state, desired, [...movable], 8, 80, Date.now() + 1500)
    }
    if (!plan) return { error: 'unsafe' }
    const list = cloneState(state)
    const moves = []
    for (const [id, to] of plan.moves) {
      if (list.findIndex(x => x.id === id) === to) continue
      moves.push([id, list[to].id])
      sbMove(list, id, to)
    }
    return { moves }
  }

  const api = {
    planRestore,
    planMoveOp,
    applyPlan,
    sbSettle,
    sbMove,
    sameState,
    arrangeMove,
    planArrangement,
    youtubeId,
    youtubeThumb,
    parentsFromLevels,
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
