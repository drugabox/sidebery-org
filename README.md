# Pestañario: explorador y base de datos de pestañas, junto a Sidebery

Un **explorador de archivos para tus pestañas**: los paneles de Sidebery son las carpetas principales, las pestañas con hijas son subcarpetas (2.º, 3.º, 4.º nivel…), y puedes reorganizarlas arrastrando, cortando y pegando. Encima, una **base de datos al estilo Obsidian**: etiquetas anidadas, notas en Markdown con `[[enlaces]]`, vínculos entre pestañas, colecciones que funcionan como accesos directos (symlinks), archivo de pestañas cerradas y un grafo.

**Sidebery no se modifica.** Pestañario es una extensión aparte: Sidebery se sigue actualizando con normalidad y, si algún día cambia, se adapta Pestañario.

---

## Qué se sincroniza con Sidebery y qué no

Sidebery no ofrece ninguna vía para que otra extensión lea o cambie sus datos (lo comprobé en su código, v5.6.x). Pestañario usa lo que Firefox y Sidebery ya exponen:

| | Sidebery → Pestañario | Pestañario → Sidebery |
|---|---|---|
| **Orden de las pestañas** | ✅ en vivo | ✅ en vivo |
| **Panel de cada pestaña** | ⚠️ se aprende al abrir cada panel en Sidebery; después se mantiene solo por posición | ✅ en vivo: al mover aquí, Sidebery la cambia de panel |
| **Árbol (padres e hijas)** | ✅ en vivo (Sidebery lo refleja en Firefox) | ✅ al soltar entre hijas o sobre una carpeta, queda dentro; Pestañario calcula el árbol igual que Sidebery |
| **Nombre, color, icono y orden de los paneles** | 🔄 al importar el archivo de Sidebery | ❌ (se cambian en Sidebery) |
| **Colores y títulos propios de las pestañas** | 🔄 al importar el archivo de Sidebery | ❌ Pestañario tiene sus propios colores y nombres |
| **Cerrar, dormir, recargar, abrir** | ✅ | ✅ |
| **Etiquetas, notas, vínculos, colecciones** | — | — (son de Pestañario; Sidebery no tiene nada así) |

Dos límites que pone Sidebery:
- **No se puede meter una pestaña desde fuera en un panel vacío** (Sidebery decide el panel por la posición). Abre una pestaña en ese panel desde Sidebery y luego ya puedes arrastrar.
- **Los colores de pestaña de Sidebery no se pueden cambiar desde fuera.** Por eso Pestañario tiene su propio «color propio».

Si Sidebery añadiera algún día una API para otras extensiones, se podría sincronizar todo directamente.

## Conectar con Sidebery

En Pestañario: ⚙ → *Conexión con Sidebery*, que muestra si está funcionando. Sidebery está en inglés, así que sus opciones aparecen con su nombre original:

1. **Imprescindible.** Sidebery → *Settings → General* → activa *«Add preface to the browser window's title if Sidebery sidebar is active»* y en *«Preface value»* escribe `⟦%PN⟧ ` (mejor con el espacio final). El título de la ventana empezará por el nombre del panel activo.
2. **Recomendado:** Sidebery → *Settings → Tabs* → *«Hide native tabs of inactive panels»*, y en Pestañario marca la casilla equivalente (⚙). Así, cada vez que abres un panel en Sidebery, Pestañario aprende el panel entero al instante, sin hacer nada más. Sin esta opción solo aprende la pestaña activa.
3. **Importar una sola vez** (para ubicar de golpe todas las pestañas, con sus colores y títulos de Sidebery): en Sidebery, *Settings → Snapshots → «Create snapshot»* y después *Settings → Help → «Export addon data»*; suelta el archivo sobre Pestañario. Cada pestaña se queda con su panel y su árbol (viajan con ella y sobreviven a reinicios), así que no hace falta repetirlo. A partir de ahí todo se sigue en vivo: mover, cerrar, abrir, carpetas y paneles nuevos (estos últimos, al abrirlos en Sidebery). Solo los colores que cambies después en Sidebery no se actualizan.

Las pestañas que aún no se pueden ubicar aparecen en «Sin identificar»; las deducidas por posición llevan un «?».

**Árbol tras reiniciar Firefox:** Firefox olvida qué pestaña es hija de cuál. Pestañario lo guarda en los datos de sesión de cada pestaña y lo repone al arrancar.

## Instalación y actualizaciones automáticas

Funciona igual que `duplicados-firefox`:

1. **Una sola vez, añade los secretos de Mozilla a este repositorio** (son por repositorio, no se heredan): *Settings → Secrets and variables → Actions → New repository secret*: `AMO_JWT_ISSUER` y `AMO_JWT_SECRET`, con los mismos valores que en `duplicados-firefox` (o nuevos desde https://addons.mozilla.org/developers/addon/api/key/).
2. Lleva los cambios a `main`. Cada cambio en `main` lanza `.github/workflows/publicar.yml`: pasa las pruebas y el validador de Mozilla, pone la versión (`0.1.<número de ejecución>`), la firma como «no listada» y la publica en *Releases* con `updates.json`.
3. Descarga **[pestanario.xpi](https://github.com/drugabox/sidebery-org/releases/latest/download/pestanario.xpi)**, arrástralo a Firefox y acepta.

Firefox consulta `updates.json` una vez al día y se actualiza solo (`about:addons` → ⚙ → *Buscar actualizaciones* para forzarlo). Para probar sin firmar: `about:debugging#/runtime/this-firefox` → *Cargar complemento temporal* → `manifest.json`.

## Uso

- **Abrir:** botón de la barra o `Alt+Mayús+E`. Clic central en el botón (o ⧉ dentro) → ventana aparte redimensionable, que recuerda tamaño y posición. Clic derecho en una pestaña → *Ver en Pestañario*.
- **Como un explorador de archivos:** *Todos los paneles* muestra cada panel de Sidebery como una carpeta de su color, y las pestañas con hijas también son carpetas. Doble clic o `Intro` abre una carpeta o va a la pestaña; `Ctrl+Intro` va a la pestaña aunque tenga hijas. En *Detalles*, las carpetas se despliegan con ▸ (o `→`/`←`), y ⊞/⊟ despliegan o pliegan todo.
- **Vistas:** *Detalles* (tabla con árbol desplegable), *Miniaturas* (cuadrícula con tamaño ajustable; los vídeos de YouTube muestran su vista previa) y *Grafo* (vínculos, etiquetas y árbol; arrastra, haz zoom con la rueda, doble clic abre).
- **Barra lateral:** paneles de Sidebery con sus carpetas, Fijadas, Colecciones, Etiquetas (anidadas con `/`), Fichas y Archivo.
- **Reorganizar:** arrastra pestañas a un panel, a una carpeta (quedan al final), entre dos filas, a las migas de pan o a una colección o etiqueta. En la barra lateral, sobre una carpeta: arriba la deja antes, en el centro dentro y abajo después. También se pueden arrastrar las carpetas del árbol. Las hijas viajan con su madre, como en Sidebery. También `Ctrl+X` y `Ctrl+V`. **`Ctrl+Z` deshace** (mover, cerrar, archivar, etiquetas, colecciones…). La ✕ de cada pestaña la cierra.
- **Movimientos seguros:** Sidebery recalcula su árbol cada vez que otra extensión mueve una pestaña, y pasos intermedios mal ordenados le hacen meter pestañas dentro de otras o soltarlas. Antes de mover nada, Pestañario simula con la misma regla de Sidebery varias formas de hacerlo y solo ejecuta una que termine exactamente en lo pedido, sin tocar ninguna otra pestaña. Si no encuentra ninguna, no mueve nada y lo dice. Un caso nunca es posible desde fuera: llevar una carpeta con pestañas dentro a otro panel (Sidebery suelta sus hijas). Ese hazlo en Sidebery.
- **Base de datos:** una pestaña pasa a ser **ficha** cuando le pones etiquetas, nota, color, nombre propio, un vínculo o una colección. Las fichas sobreviven al cierre: *Archivar* guarda y cierra; desde *Archivo* se reabren, incluso en el panel que elijas.
- **Colecciones = accesos directos:** una pestaña puede estar en varias colecciones a la vez sin moverse de su panel. Arrastrar entre colecciones mueve; con `Ctrl`, copia. `Supr` dentro de una colección solo quita el acceso directo.
- **Notas:** Markdown; `[[Título o dirección]]` enlaza otra pestaña y `#etiqueta` añade etiquetas. El panel de detalles muestra vínculos, menciones y quién la enlaza.
- **Búsqueda** (busca dentro de la carpeta actual y sus subcarpetas): texto, `#etiqueta`, `panel:trabajo`, `site:youtube`, `color:red`, `en:colección`, `es:abierta|cerrada|dormida|sonando|fijada|ficha|nota`. Con `-` delante se niega.
- **Copia:** ⚙ → exportar o importar JSON, o exportar a Markdown para Obsidian.
- **Apariencia** (⚙): los mismos 22 temas que `duplicados-firefox` (Catppuccin, Dracula, Nord, Gruvbox…), color de acento, tamaño del texto, densidad de las filas y redondeo. El circulito de cada pestaña indica su estado: relleno = cargada, vacío = dormida, discontinuo = cerrada.

### Atajos

`Intro`/doble clic abrir la carpeta o ir a la pestaña · `Ctrl+Intro` ir a la pestaña · `*` desplegar todo · `Retroceso` subir · `Alt+←/→` atrás y adelante · `→/←` desplegar y plegar · `Supr` cerrar · `Ctrl+Z` deshacer · `F2` renombrar · `T` etiquetar · `I` panel de detalles · `Ctrl+C` copiar direcciones · `Ctrl+X/V` mover · `Ctrl+A` todo · `/` o `Ctrl+F` buscar · `Ctrl+1/2/3` vistas · `Ctrl+B` barra lateral · clic central cierra.

## Rendimiento

- Sin dependencias ni frameworks; nada se compila.
- El segundo plano es una página de eventos: solo despierta al cambiar de pestaña o de panel, y no hace nada más.
- Las listas y cuadrículas solo dibujan lo que se ve. Con 3.000 pestañas: recarga completa en unos 55 ms, repintado en 7 ms y unos 6 ms por fotograma al desplazarse.
- YouTube: la tarjeta muestra solo la vista previa, el título y el canal. El canal se pide una vez a YouTube (oEmbed) y se guarda; si Firefox lo bloquea, la barra de estado ofrece «Ver canales de YouTube: permitir» (permiso solo para youtube.com).
- Vista previa de YouTube: es la imagen pública del vídeo (`i.ytimg.com`). No captura nada ni despierta la pestaña, y funciona también con las dormidas y las cerradas.
- Las capturas de otras webs son opcionales: se capturan solo de la pestaña que miras (nunca despiertan pestañas dormidas), se guardan pequeñas y se cargan a medida que aparecen.
- El grafo deja de calcular en cuanto se asienta.

## Desarrollo

```
manifest.json         Manifiesto (Firefox 128+)
background.js         Abre el explorador, aprende paneles, miniaturas
lib/model.js          Lógica pura: datos de Sidebery, paneles, árbol, movimientos, búsqueda, notas
lib/db.js             IndexedDB: fichas, colecciones, miniaturas
lib/themes.js         Temas (las paletas de duplicados-firefox)
explorer/             El explorador (pestaña o ventana)
test/                 Pruebas (incluye todos los casos de movimiento contra la regla de Sidebery)
```

```bash
npm test        # pruebas (Node 18+)
npm run lint    # validador de Mozilla
npm run start   # Firefox de pruebas con la extensión cargada
```

**Si una versión nueva de Sidebery rompe algo**, lo más probable es que haya cambiado una de estas tres cosas, que están aisladas en `lib/model.js`:
- el formato de exportación (`parseSideberyExport`);
- cómo decide el panel de una pestaña movida desde fuera (`planMove`, según `onTabMoved` en `src/services/tabs.fg.handlers.ts` de Sidebery);
- cómo calcula el árbol (`computeTree`, según `updateTabsTree` en `src/services/tabs.fg.ts`).

### Permisos

| Permiso | Uso |
|---|---|
| `tabs` | Ver, mover, activar y cerrar pestañas; leer el título de la ventana (panel activo de Sidebery) |
| `sessions` | Recordar el panel aprendido de cada pestaña aunque reinicies Firefox |
| `storage`, `unlimitedStorage` | Ajustes y base de datos local |
| `menus` | «Ver en Pestañario» en el menú de las pestañas |
| `contextualIdentities`, `cookies` | Nombre y color del contenedor |
| `<all_urls>` (opcional) | Solo para las miniaturas, si las activas |

No se envía nada a ningún sitio: todo ocurre dentro de tu Firefox.
