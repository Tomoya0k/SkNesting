# SkNesting

Acomoda piezas vectoriales en hojas rectangulares. La aplicación funciona en el navegador y procesa los archivos localmente, sin subirlos a un servidor.

## Uso local

Requiere Node.js 24.14 o posterior.

```sh
npm ci
npm run dev
```

Abre `http://127.0.0.1:5175/`, carga un SVG o EPS con medidas físicas y define el tamaño de hoja, la separación entre piezas y el margen exterior. Los campos de la interfaz están en centímetros; el motor trabaja en milímetros. **Cancelar** detiene el Worker sin cerrar la página.

El resultado muestra cada hoja completa. **Hojas físicas** es el número de hojas utilizadas; **Hojas consumidas** suma la franja ocupada de cada una en cuartos de hoja. Una hoja con piezas solo en su primer cuarto cuenta como `0.25` hojas consumidas.

## Cómo acomoda las piezas

1. **Lee la geometría.** Convierte el archivo a polígonos en milímetros. Conserva los agujeros de cada pieza según `fill-rule` y la orientación de los subtrazados. Las curvas se aproximan inicialmente con una tolerancia de `0.25 mm`.
2. **Busca posiciones.** Ordena las piezas por área y prueba giros cada `15°`. Para calcular los NFP, triangula los contornos y une las sumas de Minkowski de los pares de triángulos con Clipper. Así conserva concavidades abiertas. Para los agujeros cerrados calcula un IFP; para los demás espacios evalúa contactos entre contornos y vértices del área libre.
3. **Comprueba cada colocación.** Valida contra los polígonos reales, el margen y la separación solicitada. Suma al espacio exigido el error de aproximación de las curvas. Las operaciones de Clipper usan una rejilla de `0.0001 mm`.
4. **Mejora el resultado.** Con hasta 40 piezas y 1500 vértices, compara acomodos mediante una búsqueda genética de 16 individuos y 30 generaciones por defecto. Prioriza menos hojas, menor franja de la última hoja y después menor altura y anchura usadas. En archivos mayores construye un acomodo rápido con seis ángulos (`0°`, `45°`, `90°`, `135°`, `180°` y `270°`). Si una pieza grande queda en diagonal, compara también un acomodo con giros rectos; decide por hojas físicas, franja consumida y orientación de las piezas grandes. La mejora considera giros cada `15°` al recolocar piezas pequeñas en su hoja o en hojas anteriores. Genera candidatos con contactos entre contornos, vértices del NFP si ambos contornos tienen hasta 45 vértices y una cuadrícula de `20`, `5` y `1 mm`. Solo acepta movimientos que reduzcan el consumo, adelanten material o compacten la hoja sin empeorar la otra dimensión.

La mejora del modo rápido se limita a piezas sin otras anidadas dentro y con un área no mayor al `3 %` de la hoja; dispone de hasta `30 s` después de elegir el acomodo inicial. El navegador conserva un límite global de `180 s` y el Worker reserva `10 s` para devolver el mejor acomodo válido que haya encontrado. El resultado es heurístico: la separación se valida, pero no se garantiza el acomodo óptimo.

## Archivos admitidos

- **SVG:** requiere `viewBox` y dimensiones físicas (`mm`, `cm`, `in` o `pt`). Admite `path`, `rect`, `circle`, `ellipse`, `polygon`, `polyline` rellena, transformaciones y texto sencillo con las fuentes Tinos, Arimo o UnifrakturCook incluidas. Las líneas abiertas y el texto con `tspan` deben convertirse a contornos cerrados.
- **EPS:** requiere `%%BoundingBox` o `%%HiResBoundingBox` y geometría vectorial rellena. Admite curvas, transformaciones y agujeros. No procesa como piezas los trazos abiertos, texto editable, imágenes raster ni recortes complejos; conviene convertirlos a contornos antes de importarlos.

El importador omite los fondos blancos que cubren el `viewBox` y los textos marcados como `label`, `annotation` o `caption`. La lectura de EPS incorpora [UDOC.js](https://github.com/NineBitsLLC/UDOC.js) bajo licencia MIT; su licencia está en `src/vendor/udoc/LICENSE`.

## Uso desde código

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

Para EPS, usa `GeometryParser.parseEps(arrayBuffer, 0.25)`. `result.placements` contiene posición, giro, hoja y relación con el agujero contenedor; `result.regions` contiene la fracción y dimensiones usadas por hoja. El motor acepta de 1 a 100 piezas. `NestingEngine.runSync` usa el mismo núcleo cuando ya se ejecuta dentro de un Worker o desde Node.

## Verificación

```sh
npm test
npm run typecheck
npm run build
```
