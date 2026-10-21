// Grafo de vínculos en <canvas>: fuerzas sencillas con rejilla, que se detiene al asentarse.
'use strict'

const Graph = (() => {
  let canvas = null
  let ctx = null
  let nodes = []
  let edges = []
  let byId = new Map()
  let handlers = {}
  let sel = new Set()
  let raf = 0
  let alpha = 0
  let view = { x: 0, y: 0, k: 1 }
  let hover = null
  let drag = null
  let lastKey = ''
  let colors = {}
  const positions = new Map() // se conservan entre redibujados

  function readColors() {
    const cs = getComputedStyle(document.documentElement)
    colors = { fg: cs.getPropertyValue('--fg').trim(), fg2: cs.getPropertyValue('--fg2').trim(), line: cs.getPropertyValue('--line').trim(), acc: cs.getPropertyValue('--acc').trim(), bg: cs.getPropertyValue('--bg').trim() }
  }

  function show(el, data, h) {
    handlers = h
    sel = data.sel
    if (canvas !== el) {
      canvas = el
      ctx = el.getContext('2d')
      bind()
    }
    readColors()
    resize()
    const key = data.nodes.map(n => n.id).join('|') + '#' + data.edges.length
    if (key !== lastKey) {
      lastKey = key
      nodes = data.nodes.map(n => {
        const p = positions.get(n.id)
        return { ...n, x: p ? p.x : (Math.random() - 0.5) * 400, y: p ? p.y : (Math.random() - 0.5) * 400, vx: 0, vy: 0, deg: 0 }
      })
      byId = new Map(nodes.map(n => [n.id, n]))
      edges = data.edges.filter(([a, b]) => byId.has(a) && byId.has(b)).map(([a, b, kind]) => ({ a: byId.get(a), b: byId.get(b), kind }))
      for (const e of edges) {
        e.a.deg++
        e.b.deg++
      }
      kick(1)
    } else draw()
  }

  function hide() {
    cancelAnimationFrame(raf)
    raf = 0
  }

  function resize() {
    const r = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    canvas.width = Math.max(1, r.width * dpr)
    canvas.height = Math.max(1, r.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function kick(a = 0.6) {
    alpha = Math.max(alpha, a)
    if (!raf) raf = requestAnimationFrame(loop)
  }

  function loop() {
    raf = 0
    if (canvas.hidden) return
    step()
    draw()
    if (alpha > 0.015 || drag) raf = requestAnimationFrame(loop)
  }

  function step() {
    const cell = 90
    const grid = new Map()
    for (const n of nodes) {
      const k = Math.floor(n.x / cell) + ',' + Math.floor(n.y / cell)
      let g = grid.get(k)
      if (!g) grid.set(k, (g = []))
      g.push(n)
    }
    // Repulsión entre cercanos
    for (const n of nodes) {
      const cx = Math.floor(n.x / cell)
      const cy = Math.floor(n.y / cell)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const g = grid.get(cx + dx + ',' + (cy + dy))
          if (!g) continue
          for (const m of g) {
            if (m === n) continue
            let x = n.x - m.x
            let y = n.y - m.y
            let d2 = x * x + y * y
            if (d2 > cell * cell) continue
            if (d2 < 0.01) {
              x = Math.random() - 0.5
              y = Math.random() - 0.5
              d2 = 0.5
            }
            const f = (900 / d2) * alpha
            n.vx += x * f * 0.05
            n.vy += y * f * 0.05
          }
        }
    }
    // Muelles en los vínculos
    for (const e of edges) {
      const x = e.b.x - e.a.x
      const y = e.b.y - e.a.y
      const d = Math.sqrt(x * x + y * y) || 1
      const target = e.kind === 'tag' ? 70 : e.kind === 'tree' ? 45 : 60
      const f = ((d - target) / d) * 0.06 * alpha
      const wa = 1 / Math.max(1, e.a.deg)
      const wb = 1 / Math.max(1, e.b.deg)
      e.a.vx += x * f * wb * 2
      e.a.vy += y * f * wb * 2
      e.b.vx -= x * f * wa * 2
      e.b.vy -= y * f * wa * 2
    }
    // Gravedad suave al centro y amortiguación
    for (const n of nodes) {
      n.vx -= n.x * 0.004 * alpha
      n.vy -= n.y * 0.004 * alpha
      if (n === (drag && drag.node)) continue
      n.vx *= 0.6
      n.vy *= 0.6
      n.x += n.vx
      n.y += n.vy
      positions.set(n.id, { x: n.x, y: n.y })
    }
    alpha *= 0.985
  }

  function toScreen(n) {
    const r = canvas.getBoundingClientRect()
    return [r.width / 2 + (n.x + view.x) * view.k, r.height / 2 + (n.y + view.y) * view.k]
  }

  function toWorld(px, py) {
    const r = canvas.getBoundingClientRect()
    return [(px - r.width / 2) / view.k - view.x, (py - r.height / 2) / view.k - view.y]
  }

  function radius(n) {
    return (n.size || 4) + Math.min(8, Math.sqrt(n.deg) * 1.5)
  }

  function draw() {
    const r = canvas.getBoundingClientRect()
    ctx.clearRect(0, 0, r.width, r.height)
    const near = new Set()
    if (hover) {
      near.add(hover)
      for (const e of edges) {
        if (e.a === hover) near.add(e.b)
        if (e.b === hover) near.add(e.a)
      }
    }
    ctx.lineWidth = 1
    for (const e of edges) {
      const [x1, y1] = toScreen(e.a)
      const [x2, y2] = toScreen(e.b)
      const hl = hover && (e.a === hover || e.b === hover)
      ctx.strokeStyle = hl ? colors.acc : colors.line
      ctx.globalAlpha = hover && !hl ? 0.25 : e.kind === 'tree' ? 0.6 : 0.9
      ctx.setLineDash(e.kind === 'tag' ? [3, 3] : [])
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
    }
    ctx.setLineDash([])
    const showLabels = view.k > 0.7 || nodes.length < 80
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    for (const n of nodes) {
      const [x, y] = toScreen(n)
      if (x < -20 || y < -20 || x > r.width + 20 || y > r.height + 20) continue
      const rad = radius(n) * Math.max(0.6, Math.min(1.6, view.k))
      ctx.globalAlpha = hover && !near.has(n) ? 0.2 : n.dim ? 0.55 : 1
      ctx.fillStyle = n.tag ? colors.acc : n.color && !n.color.startsWith('var(') ? n.color : colors.fg2
      ctx.beginPath()
      if (n.tag) ctx.rect(x - rad * 0.7, y - rad * 0.7, rad * 1.4, rad * 1.4)
      else ctx.arc(x, y, rad, 0, Math.PI * 2)
      ctx.fill()
      if (sel.has(n.id)) {
        ctx.strokeStyle = colors.fg
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.lineWidth = 1
      }
      if (showLabels || near.has(n) || sel.has(n.id)) {
        ctx.fillStyle = colors.fg
        const label = n.label.length > 40 ? n.label.slice(0, 38) + '…' : n.label
        ctx.fillText(label, x, y + rad + 12)
      }
    }
    ctx.globalAlpha = 1
  }

  function pick(px, py) {
    let best = null
    let bd = Infinity
    for (const n of nodes) {
      const [x, y] = toScreen(n)
      const d = (x - px) ** 2 + (y - py) ** 2
      const rr = (radius(n) + 4) ** 2
      if (d < rr && d < bd) {
        bd = d
        best = n
      }
    }
    return best
  }

  function pos(e) {
    const r = canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  function bind() {
    canvas.addEventListener('mousedown', e => {
      const [px, py] = pos(e)
      const n = pick(px, py)
      drag = n ? { node: n } : { pan: true, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
      if (n && handlers.onSelect && !n.tag) handlers.onSelect(n.id)
      canvas.style.cursor = 'grabbing'
    })
    addEventListener('mousemove', e => {
      if (!canvas || canvas.hidden) return
      const [px, py] = pos(e)
      if (drag && drag.node) {
        const [wx, wy] = toWorld(px, py)
        drag.node.x = wx
        drag.node.y = wy
        kick(0.3)
      } else if (drag && drag.pan) {
        view.x = drag.vx + (e.clientX - drag.x) / view.k
        view.y = drag.vy + (e.clientY - drag.y) / view.k
        draw()
      } else if (e.target === canvas) {
        const h = pick(px, py)
        if (h !== hover) {
          hover = h
          canvas.title = h ? h.label : ''
          draw()
        }
      }
    })
    addEventListener('mouseup', () => {
      drag = null
      if (canvas) canvas.style.cursor = 'grab'
    })
    canvas.addEventListener('dblclick', e => {
      const n = pick(...pos(e))
      if (n && handlers.onOpen) handlers.onOpen(n.id)
    })
    canvas.addEventListener(
      'wheel',
      e => {
        e.preventDefault()
        const [px, py] = pos(e)
        const [wx, wy] = toWorld(px, py)
        view.k = Math.max(0.15, Math.min(4, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
        const [wx2, wy2] = toWorld(px, py)
        view.x += wx2 - wx
        view.y += wy2 - wy
        draw()
      },
      { passive: false }
    )
    addEventListener('resize', () => {
      if (canvas && !canvas.hidden) {
        resize()
        draw()
      }
    })
  }

  return { show, hide }
})()
