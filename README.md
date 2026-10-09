# SkNesting

Motor y página local de prueba para acomodar contornos SVG en hojas rectangulares.

## Iniciar

Requiere Node.js 24.14 o posterior. Desde esta carpeta:

```powershell
npm install
npm run dev
```

Abre `http://127.0.0.1:5175/`. Vite escucha únicamente en `127.0.0.1`. Carga un archivo SVG y pulsa **Calcular acomodo**. El archivo se procesa en el navegador mediante un Web Worker; la página no lo sube a ningún servidor.

En la página, ancho, alto, separación y margen se introducen en centímetros; el motor los convierte a milímetros. Cada hoja física se muestra completa; cuando hay varias, se colocan en columnas si el espacio lo permite. El fondo azul claro marca la franja contabilizada y la línea discontinua separa el resto disponible. **Hojas consumidas** suma las franjas usadas de todas las hojas y redondea hacia arriba al siguiente cuarto de hoja; **Hojas físicas** indica cuántas hojas aparecen en el acomodo.

El SVG debe tener `width` y `height` en `mm`, `cm`, `in` o `pt` y un `viewBox` válido. El importador admite `path`, `rect` (también redondeado), `circle`, `ellipse`, `polygon`, `polyline` con relleno y texto sencillo. Convierte el texto a contornos con Tinos o Arimo incorporadas, equivalentes libres de Times New Roman y Arial; la forma puede variar ligeramente si el archivo usó otra fuente. Omite rectángulos blancos que cubren todo el `viewBox` y textos con clase `label`, `annotation` o `caption`, pues los trata como fondo o anotaciones. El parser también admite líneas de path, Bézier cuadráticas y cúbicas, arcos, transformaciones SVG y `fill-rule` (`evenodd` o `nonzero`). Las líneas abiertas y el texto con `tspan` siguen requiriendo contornos cerrados.

## Motor

`GeometryParser.parseSvg(source, toleranceMm)` devuelve piezas con contorno exterior y agujeros en milímetros. `NestingEngine.run(pieces, config)` devuelve una promesa con el resultado; `runSync` usa el mismo núcleo cuando ya se está en un Worker o en Node.

```ts
import {GeometryParser} from './src/engine/GeometryParser.ts';
import {NestingEngine} from './src/engine/NestingEngine.ts';

const {pieces} = GeometryParser.parseSvg(svgText, 0.25);
const result = await NestingEngine.run(pieces, {
  sheetWidthMm: 1220,
  sheetHeightMm: 2440,
  gapMm: 5,
  edgeMarginMm: 20,
});
```

Los resultados incluyen la cantidad de hojas físicas, la fracción horizontal de la última hoja, el área neta expresada como hojas, y las métricas de hoja completa y cuartos compartidos. Son cantidades informativas; no hay precios monetarios.

El motor usa un margen de 20 mm contra los cuatro bordes de cada franja horizontal activa. El gap entre piezas es independiente. Prueba giros en incrementos de 15°. El parser clasifica contornos por winding (`nonzero`) o paridad (`evenodd`) y guarda cada agujero como un polígono del contorno principal. El NFP de formas cóncavas se obtiene uniendo las sumas de Minkowski de sus triángulos, sin convertir toda la forma en una envolvente convexa. Para cada agujero de una pieza ya colocada, el IFP resta del dominio de traslación el NFP del exterior del agujero; la heurística comprueba primero esos puntos. Las colocaciones guardan `parentPieceId`, `parentHoleIndex` y una jerarquía; `translatePlacementTree` traslada una pieza con todas las que contiene. No divide piezas. Solo devuelve `unplaceable` cuando ninguna rotación cabe en la hoja completa.

La curva se aproxima inicialmente con una desviación máxima de 0.25 mm por contorno. Para garantizar la separación respecto de las curvas del SVG, el validador reserva el error de ambas piezas sobre el gap, y reserva el error de cada pieza en el borde. Si una pieza queda demasiado ajustada para certificar su encaje, el Worker repite el cálculo con tolerancias menores. El motor utiliza una rejilla de 0.0001 mm, por lo que sus decisiones numéricas tienen esa resolución. Los resultados son heurísticos: se validan, pero no se garantiza el óptimo global.

La población predeterminada es de 16 cromosomas durante 30 generaciones. Para SVG complejos (más de 40 piezas o 1500 vértices), usa un acomodo rápido como solución inicial. Una pasada adicional intenta trasladar piezas pequeñas sin descendientes desde hojas posteriores a cavidades abiertas y espacios entre piezas de hojas anteriores. Prueba contactos de contornos y NFP cuando el coste lo permite, además de una cuadrícula de 20, 5 y 1 mm; todas las posiciones se validan con los polígonos reales, el margen y la separación. Prioriza reducir las fracciones de hoja consumidas y después adelantar las piezas. Entrega `method: 'fast'` y `limited: true`. El Worker reserva los últimos 10 segundos del límite de 120 segundos del navegador para devolver la mejor solución válida encontrada. El botón **Cancelar** termina el Worker y la interfaz muestra el progreso de la mejora.

## Verificar

```powershell
npm test
npm run typecheck
npm run build
```

La aplicación es independiente de Digital.A y no modifica sus cotizaciones ni sus documentos históricos.
