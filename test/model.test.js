const test = require('node:test')
const assert = require('node:assert/strict')
const M = require('../lib/model.js')

const SB = 'moz-extension://0d6e5e0e-4b0c-4d5a-9a52-1f2e3d4c5b6a'

test('normUrl: misma página aunque cambie el rastreo, www o la barra final', () => {
  assert.equal(M.normUrl('http://www.ejemplo.com/a/?utm_source=x'), 'https://ejemplo.com/a')
  assert.equal(M.normUrl('https://ejemplo.com/a'), 'https://ejemplo.com/a')
  assert.equal(M.normUrl('https://ejemplo.com/'), 'https://ejemplo.com')
  assert.equal(M.normUrl('https://ejemplo.com/?q=1&fbclid=2'), 'https://ejemplo.com/?q=1')
  assert.notEqual(M.normUrl('https://ejemplo.com/a#x'), M.normUrl('https://ejemplo.com/a#y'))
})

test('restoreUrl: páginas de espera y de grupo de Sidebery', () => {
  const raw = `${SB}/sidebery/url.html#https://ejemplo.com/x:id:abc`
  assert.equal(M.restoreUrl(raw), 'https://ejemplo.com/x')
  const json = `${SB}/sidebery/url.html#${encodeURIComponent(JSON.stringify(['about:config', 'Config']))}`
  assert.equal(M.restoreUrl(json), 'about:config')
  const b64 = `${SB}/sidebery/url.html#_${Buffer.from(JSON.stringify({ url: 'https://ñ.es/' })).toString('base64')}`
  assert.equal(M.restoreUrl(b64), 'https://ñ.es/')
  const grp = `${SB}/sidebery/group.html#Mi%20grupo:id:x1~!abcdefghijkl!ch!~`
  assert.equal(M.sideberyPage(grp), 'group')
  assert.equal(M.groupName(grp), 'Mi grupo')
  assert.equal(M.normUrl(grp), 'sidebery-group:Mi grupo')
})

const backup = {
  ver: '5.6.2',
  sidebar: {
    nav: ['p1', 'sp', 'p2', 'bk'],
    panels: {
      p1: { id: 'p1', type: 2, name: 'Trabajo', color: 'blue' },
      p2: { id: 'p2', type: 2, name: 'Ocio', color: 'red' },
      bk: { id: 'bk', type: 1, name: 'Marcadores' },
    },
  },
  snapshots: [
    {
      id: 's1',
      time: 100,
      containers: {},
      sidebar: { nav: [], panels: {} },
      tabs: [[[{ url: 'https://a.com', title: 'A', panelId: 'p1' }, { url: 'https://b.com', title: 'B', panelId: 'p1', lvl: 1, customColor: 'green' }], [{ url: 'https://c.com', title: 'C', panelId: 'p2' }]]],
    },
    { id: 's2', time: 200, containers: -1, sidebar: -1, tabs: [[[-1, { url: 'https://b2.com', title: 'B2', panelId: 'p1', lvl: 1, customColor: 'green' }], [-1]]] },
  ],
}

test('parseSideberyExport: copia de seguridad con instantáneas incrementales', () => {
  const r = M.parseSideberyExport(JSON.stringify(backup))
  assert.deepEqual(
    r.panels.map(p => p.name),
    ['Trabajo', 'Ocio']
  )
  assert.equal(r.time, 200)
  assert.deepEqual(
    r.windows[0].map(t => [t.url, t.panel, t.lvl, t.color]),
    [
      ['https://a.com', 'Trabajo', 0, ''],
      ['https://b2.com', 'Trabajo', 1, 'green'],
      ['https://c.com', 'Ocio', 0, ''],
    ]
  )
})

test('parseSideberyExport: instantánea exportada sola', () => {
  const snap = { id: 'x', time: 5, containers: {}, sidebar: backup.sidebar, tabs: backup.snapshots[0].tabs }
  const r = M.parseSideberyExport(snap)
  assert.equal(r.tabCount, 3)
  assert.throws(() => M.parseSideberyExport({ foo: 1 }))
})

test('matchImport: por dirección y en orden, aunque haya repetidas', () => {
  const imp = { windows: [[{ url: 'https://a.com', panel: 'X' }, { url: 'https://a.com/', panel: 'Y' }, { url: 'https://z.com', panel: 'Z' }]] }
  const live = [
    { id: 1, url: 'https://a.com' },
    { id: 2, url: 'https://a.com' },
    { id: 3, url: 'https://q.com' },
  ]
  const m = M.matchImport(live, imp)
  assert.equal(m.get(1).panel, 'X')
  assert.equal(m.get(2).panel, 'Y')
  assert.equal(m.has(3), false)
})

test('assignPanels: deduce por las vecinas, sin inventar', () => {
  const tabs = [1, 2, 3, 4, 5, 6].map(id => ({ id }))
  tabs.unshift({ id: 0, pinned: true })
  const known = new Map([
    [1, { panel: 'A' }],
    [3, { panel: 'A' }],
    [5, { panel: 'B' }],
  ])
  const r = M.assignPanels(tabs, known, ['A', 'B'])
  assert.deepEqual(r.get(2), { panel: 'A', sure: true })
  assert.deepEqual(r.get(4), { panel: 'A', sure: false })
  assert.deepEqual(r.get(6), { panel: 'B', sure: true })
  assert.equal(r.get(0).panel, '')
  // Sin conocer el orden de paneles, lo de fuera de lo conocido queda sin panel
  const r2 = M.assignPanels(tabs, new Map([[3, { panel: 'A' }]]))
  assert.deepEqual([1, 2, 3, 4].map(id => r2.get(id).panel), ['', '', 'A', ''])
})

test('assignPanels: una pestaña movida con dato viejo toma el panel que la rodea', () => {
  const tabs = [1, 2, 3, 4, 5, 6, 7].map(id => ({ id }))
  const known = new Map([1, 2, 3].map(id => [id, { panel: 'A', time: 10 }]).concat([4, 6, 7].map(id => [id, { panel: 'B', time: 10 }]), [[5, { panel: 'A', time: 1 }]]))
  const r = M.assignPanels(tabs, known, ['A', 'B'])
  assert.equal(r.get(5).panel, 'B')
})

test('parentsFromLevels: árbol desde los niveles importados', () => {
  const tabs = [1, 2, 3, 4, 5, 6].map(id => ({ id }))
  const lvl = { 1: 0, 2: 1, 3: 2, 4: 1, 5: 0, 6: 1 }
  const panel = { 1: 'A', 2: 'A', 3: 'A', 4: 'A', 5: 'A', 6: 'B' }
  const p = M.parentsFromLevels(tabs, t => lvl[t.id], t => panel[t.id])
  assert.deepEqual([...p.entries()], [[2, 1], [3, 2], [4, 1]])
  // computeTree lo usa cuando Firefox no tiene openerTabId
  const n = M.computeTree(tabs, t => panel[t.id], p)
  assert.deepEqual(n.get(3), { parent: 2, lvl: 2 })
  assert.deepEqual(n.get(4), { parent: 1, lvl: 1 })
})

test('youtubeId: vídeos, shorts y enlaces cortos', () => {
  assert.equal(M.youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), 'dQw4w9WgXcQ')
  assert.equal(M.youtubeId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ')
  assert.equal(M.youtubeId('https://m.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(M.youtubeId('https://www.youtube.com/@canal/videos'), '')
  assert.equal(M.youtubeId('https://www.youtube.com/playlist?list=PL1'), '')
})

test('computeTree: como Sidebery (padre antes y en el mismo panel; adopta huecos)', () => {
  const P = { 1: 'A', 2: 'A', 3: 'A', 4: 'A', 5: 'B', 6: 'B' }
  const tabs = [
    { id: 1, openerTabId: 1 },
    { id: 2, openerTabId: 1 },
    { id: 3 }, // sin padre entre hijos de 1 → adoptada
    { id: 4, openerTabId: 1 },
    { id: 5, openerTabId: 4 }, // padre en otro panel → raíz
    { id: 6, openerTabId: 9 },
  ]
  const n = M.computeTree(tabs, t => P[t.id])
  assert.deepEqual(n.get(2), { parent: 1, lvl: 1 })
  assert.deepEqual(n.get(3), { parent: 1, lvl: 1 })
  assert.deepEqual(n.get(4), { parent: 1, lvl: 1 })
  assert.deepEqual(n.get(5), { parent: -1, lvl: 0 })
  assert.deepEqual(n.get(6), { parent: -1, lvl: 0 })
})

// Simula Firefox + Sidebery: tras cada movimiento, la pestaña toma el panel de la que
// ocupaba el índice de destino antes de mover.
function simulate(list, tabId, where) {
  const l = list.map(x => ({ ...x }))
  for (const f of M.planMove(l, tabId, where)) {
    const from = l.findIndex(x => x.id === tabId)
    if (from === f) continue
    const dstPanel = l[f].panel
    M.applyMove(l, from, f)
    l[f].panel = dstPanel
  }
  return l
}

test('planMove: siempre acaba en el panel y la posición pedidos', () => {
  const base = [
    { id: 1, panel: 'A' },
    { id: 2, panel: 'A' },
    { id: 3, panel: 'B' },
    { id: 4, panel: 'B' },
    { id: 5, panel: 'C' },
  ]
  const cases = []
  for (const t of base) for (const a of base) if (t.id !== a.id) cases.push([t.id, { after: a.id }], [t.id, { before: a.id }])
  for (const [id, where] of cases) {
    const r = simulate(base, id, where)
    const anchor = where.after ?? where.before
    const ia = r.findIndex(x => x.id === anchor)
    const it = r.findIndex(x => x.id === id)
    assert.equal(it, where.after !== undefined ? ia + 1 : ia - 1, `${id} ${JSON.stringify(where)} posición`)
    assert.equal(r[it].panel, r[ia].panel, `${id} ${JSON.stringify(where)} panel`)
    assert.equal(r.length, base.length)
  }
})

test('parseQuery y matches', () => {
  const item = { title: 'Receta de pan', url: 'https://cocina.es/pan', domain: 'cocina.es', tags: ['cocina/pan', 'leer'], panel: 'Casa', open: true, cols: ['Recetas'] }
  const ok = q => M.matches({ ...item }, M.parseQuery(q))
  assert.ok(ok('pan'))
  assert.ok(ok('#cocina'))
  assert.ok(ok('tag:cocina/pan site:cocina panel:casa es:abierta en:recetas'))
  assert.ok(!ok('#cocin'))
  assert.ok(!ok('-#leer'))
  assert.ok(!ok('es:cerrada'))
  assert.ok(ok('"receta de"'))
})

test('notas: [[enlaces]] y #etiquetas', () => {
  const n = 'Ver [[Receta de pan]] y [[https://x.com|X]]. #cocina/pan #leer, no#esto'
  assert.deepEqual(M.wikiLinks(n), ['Receta de pan', 'https://x.com'])
  assert.deepEqual(M.noteTags(n), ['cocina/pan', 'leer'])
  assert.equal(M.cleanTag(' #mi tag/ '), 'mi-tag')
})

test('computeTree: soltar sobre una carpeta (justo detrás de ella) la deja dentro', () => {
  const panelOf = () => 'A'
  // 9 venía de otro sitio (raíz) y se coloca entre 1 y su primera hija 2
  const tabs = [{ id: 1, openerTabId: 1 }, { id: 9, openerTabId: 9 }, { id: 2, openerTabId: 1 }, { id: 3, openerTabId: 3 }]
  const n = M.computeTree(tabs, panelOf)
  assert.deepEqual(n.get(9), { parent: 1, lvl: 1 })
  assert.deepEqual(n.get(3), { parent: -1, lvl: 0 })
})

// ---------------------------------------------------------------------------
// Planificador de movimientos seguros (simula a Sidebery)

// Construye un estado a partir de líneas «panel:nivel:id»
function st(spec) {
  const list = []
  const stack = []
  for (const s of spec.trim().split(/\s+/)) {
    const [panel, lvl, id] = s.split(':')
    const L = +lvl
    while (stack.length > L) stack.pop()
    const parent = L ? stack[L - 1] : -1
    list.push({ id: +id, panel, parent, pinned: false })
    stack[L] = +id
    stack.length = L + 1
  }
  return list
}

function runPlan(state, ids, target) {
  const r = M.arrangeMove(state, ids, target)
  assert.ok(!r.error, r.error)
  const plan = M.planMoveOp(state, ids, target)
  assert.ok(!plan.error, 'no encuentra una secuencia segura')
  const list = state.map(x => ({ ...x }))
  M.applyPlan(list, plan.moves)
  assert.ok(M.sameState(list, r.desired), 'el resultado no es el pedido')
  return { list, plan }
}

const show = l => l.map(x => `${x.panel}${x.id}${x.parent === -1 ? '' : '<' + x.parent}`).join(' ')

test('mover pestaña a pestaña sin planificar rompe el árbol de Sidebery', () => {
  // Carpeta 1 (con 2 y su hija 3) hacia atrás, delante de 5: lo ingenuo adopta lo de en medio
  const s = st('A:0:5 A:0:6 A:0:1 A:1:2 A:2:3')
  const naive = s.map(x => ({ ...x }))
  for (const [id, to] of [[1, 0], [2, 1], [3, 2]]) M.sbMove(naive, id, to)
  // tras mover la 1 delante, la 2 queda separada de su madre y la 5 y la 6 acaban dentro de la 1
  assert.notEqual(show(naive), 'A1 A2<1 A3<2 A5 A6')
  const { list } = runPlan(s, [1], { before: 5 })
  assert.equal(show(list), 'A1 A2<1 A3<2 A5 A6')
})

test('varias carpetas dentro de otra: al final y conservando sus árboles', () => {
  const s = st('A:0:1 A:1:2 A:0:10 A:1:11 A:2:12 A:0:20 A:1:21 A:0:30')
  const { list } = runPlan(s, [10, 20], { into: 1 })
  assert.equal(show(list), 'A1 A2<1 A10<1 A11<10 A12<11 A20<1 A21<20 A30')
})

test('a otro panel: las pestañas sí; las carpetas con hijas se niegan (Sidebery las desharía)', () => {
  const s = st('A:0:1 A:1:2 A:2:3 A:0:4 B:0:5 B:1:6 B:0:7 C:0:8')
  assert.equal(show(runPlan(s, [4], { panelEnd: 'B' }).list), 'A1 A2<1 A3<2 B5 B6<5 B7 B4 C8')
  assert.equal(show(runPlan(s, [7, 8], { before: 1 }).list), 'A7 A8 A1 A2<1 A3<2 A4 B5 B6<5')
  assert.equal(show(runPlan(s, [8], { into: 5 }).list), 'A1 A2<1 A3<2 A4 B5 B6<5 B8<5 B7')
  assert.equal(M.planMoveOp(s, [1], { panelEnd: 'B' }).error, 'folder-panel')
})

test('una hija suelta a la raíz y una raíz dentro de una carpeta (al final)', () => {
  const s = st('A:0:1 A:1:2 A:1:3 A:0:4 A:0:5')
  assert.equal(show(runPlan(s, [2], { after: 5 }).list), 'A1 A3<1 A4 A5 A2')
  assert.equal(show(runPlan(s, [5], { into: 1 }).list), 'A1 A2<1 A3<1 A5<1 A4')
  assert.equal(show(runPlan(s, [4], { before: 3 }).list), 'A1 A2<1 A4<1 A3<1 A5')
})

test('miles de movimientos al azar: o acaba exactamente como se pidió o no se mueve nada', () => {
  let seed = 7
  const rnd = n => ((seed = (seed * 1103515245 + 12345) % 2147483648), Math.floor(seed / 65536) % n)
  let ok = 0
  let refused = 0
  for (let round = 0; round < 3000; round++) {
    const parts = []
    let id = 1
    for (const p of ['A', 'B', 'C']) {
      let lvl = 0
      const n = 1 + rnd(7)
      for (let i = 0; i < n; i++) {
        parts.push(`${p}:${lvl}:${id++}`)
        lvl = rnd(3) === 0 ? 0 : Math.min(lvl + rnd(2), 3)
        if (rnd(2)) lvl = Math.max(0, lvl - rnd(3))
      }
    }
    const s = st(parts.join(' '))
    const pick = () => s[rnd(s.length)].id
    const ids = [pick()]
    if (rnd(2)) ids.push(pick())
    const kinds = ['panelEnd', 'into', 'after', 'before']
    const k = kinds[rnd(4)]
    const target = k === 'panelEnd' ? { panelEnd: ['A', 'B', 'C'][rnd(3)] } : { [k]: pick() }
    if (k === 'into' && !s.some(x => x.parent === target.into)) continue
    const r = M.arrangeMove(s, ids, target)
    if (r.error) continue
    const plan = M.planMoveOp(s, ids, target)
    if (plan.error) {
      const byId = new Map(s.map(x => [x.id, x]))
      const panel = r.desired.find(x => x.id === r.tops[0].id).panel
      const folderToOtherPanel = r.tops.some(t => byId.get(t.id).panel !== panel && s.some(x => x.parent === t.id))
      assert.ok(folderToOtherPanel, `ronda ${round}: rechazado sin motivo: ${show(s)} | ${JSON.stringify(ids)} ${JSON.stringify(target)} → ${show(r.desired)}`)
      refused++
      continue
    }
    const list = s.map(x => ({ ...x }))
    M.applyPlan(list, plan.moves)
    assert.ok(M.sameState(list, r.desired), `ronda ${round}`)
    ok++
  }
  console.log(`    planificados: ${ok}, rechazados (carpetas con hijas a otro panel): ${refused}`)
  assert.ok(ok > refused * 4)
})

test('deshacer: vuelve exactamente al estado anterior', () => {
  const s = st('A:0:1 A:1:2 A:2:3 A:0:4 A:0:5 A:1:6 A:0:7 B:0:8')
  for (const [ids, target] of [[[1], { into: 5 }], [[4], { panelEnd: 'B' }], [[5], { before: 1 }]]) {
    const { list } = runPlan(s, ids, target)
    const back = M.planRestore(list, s)
    assert.ok(!back.error, back.error)
    M.applyPlan(list, back.moves)
    assert.equal(show(list), show(s))
  }
})

// Copia de minimizeSnapshot de Sidebery (src/services/snapshots.ts) para generar archivos reales
function sbMinimize(snapshots, snapshot) {
  const U = -1
  for (let i = snapshots.length; i--;) {
    const n = snapshots[i]
    if (!n || !n.containers) break
    if (n.containers === U) continue
    if (JSON.stringify(n.containers) === JSON.stringify(snapshot.containers)) snapshot.containers = U
    break
  }
  for (let i = snapshots.length; i--;) {
    const n = snapshots[i]
    if (!n || !n.sidebar) break
    if (n.sidebar === U) continue
    if (JSON.stringify(n.sidebar) === JSON.stringify(snapshot.sidebar)) snapshot.sidebar = U
    break
  }
  per_win: for (let wi = 0; wi < snapshot.tabs.length; wi++) {
    const win = snapshot.tabs[wi]
    if (!win) break
    per_panel: for (let gi = 0; gi < win.length; gi++) {
      const tabs = win[gi]
      if (!tabs) break per_win
      per_tab: for (let ti = 0; ti < tabs.length; ti++) {
        const tab = tabs[ti]
        if (!tab) break per_win
        if (tab === U) continue
        for (let i = snapshots.length; i--;) {
          const n = snapshots[i]
          if (!n) break per_win
          const winN = n.tabs[wi]
          if (!winN) break per_win
          const panelN = winN[gi]
          if (!panelN) break per_panel
          const tabN = panelN[ti]
          if (!tabN) break per_tab
          if (tabN === U) continue
          if (tab.url === tabN.url && tab.title === tabN.title && tab.panelId === tabN.panelId && tab.lvl === tabN.lvl && tab.customColor === tabN.customColor) tabs[ti] = U
          break
        }
      }
    }
  }
}

test('instantáneas comprimidas de Sidebery: se reconstruyen todas las pestañas', () => {
  const sidebar = { nav: ['a', 'b'], panels: { a: { id: 'a', type: 2, name: 'A' }, b: { id: 'b', type: 2, name: 'B' } } }
  const mk = (n, extra) => ({
    id: 's' + n,
    time: 1000 * n,
    containers: {},
    sidebar: JSON.parse(JSON.stringify(sidebar)),
    tabs: [
      [
        Array.from({ length: 300 + extra }, (_, i) => ({ url: `https://a.com/${i}`, title: 'A' + i, panelId: 'a', lvl: i % 3 ? 1 : 0, customColor: i === 5 ? 'red' : undefined })),
        Array.from({ length: 200 }, (_, i) => ({ url: `https://b.com/${i}`, title: 'B' + i, panelId: 'b' })),
      ],
      [Array.from({ length: 50 + extra }, (_, i) => ({ url: `https://c.com/${i}`, title: 'C' + i, panelId: 'a' }))],
    ],
  })
  const stored = []
  for (let n = 1; n <= 4; n++) {
    const snap = mk(n, n * 10)
    sbMinimize(stored, snap)
    stored.push(snap)
  }
  const unchanged = stored[3].tabs.flat(2).filter(t => t === -1).length
  assert.ok(unchanged > 500, 'la última está comprimida')
  const r = M.parseSideberyExport({ sidebar, snapshots: stored })
  assert.equal(r.lost, 0)
  assert.equal(r.tabCount, 340 + 200 + 90)
  assert.equal(r.windows[0].find(t => t.url === 'https://a.com/5').color, 'red')
  assert.equal(r.snapshots.length, 4)
})

test('dentro de una carpeta: primera o última', () => {
  const s = st('A:0:1 A:1:2 A:1:3 A:0:10 A:1:11 A:0:20 A:0:30')
  assert.equal(show(runPlan(s, [10, 20], { into: 1, first: true }).list), 'A1 A10<1 A11<10 A20<1 A2<1 A3<1 A30')
  assert.equal(show(runPlan(s, [10, 20], { into: 1 }).list), 'A1 A2<1 A3<1 A10<1 A11<10 A20<1 A30')
  assert.equal(show(runPlan(s, [30], { into: 1, first: true }).list), 'A1 A30<1 A2<1 A3<1 A10 A11<10 A20')
})
