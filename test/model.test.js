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

test('assignPanels: deduce por las vecinas', () => {
  const tabs = [1, 2, 3, 4, 5, 6].map(id => ({ id }))
  tabs.unshift({ id: 0, pinned: true })
  const known = new Map([
    [1, { panel: 'A' }],
    [3, { panel: 'A' }],
    [5, { panel: 'B' }],
  ])
  const r = M.assignPanels(tabs, known)
  assert.deepEqual(r.get(2), { panel: 'A', sure: true })
  assert.deepEqual(r.get(4), { panel: 'A', sure: false })
  assert.deepEqual(r.get(6), { panel: 'B', sure: false })
  assert.equal(r.get(0).panel, '')
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
