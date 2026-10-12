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
4. **Mejora el resultado.** Con hasta 40 piezas y 1500 vértices, compara acomodos mediante una búsqueda genética de 16 individuos y 30 generaciones por defecto. Para archivos mayores, conserva un primer acomodo válido y vuelve a colocar **todas las piezas**, incluidas las letras grandes, con giros cada `15°`. Usa máscaras de ocupación del material sobre rejillas de `10` y `5 mm`: las concavidades y los agujeros quedan libres. Compara doce arranques con distintas preferencias de orientación y anchura, y afina los seis mejores. Las máscaras incluyen una reserva para la separación y el error de discretización; cada colocación se comprueba además contra los contornos reales. Se elige el menor consumo en cuartos de hoja y después el menor número de hojas físicas.

La búsqueda de acomodos completos dispone de hasta `60 s`. Después, una pasada de hasta `30 s` recoloca piezas pequeñas sin otras anidadas dentro, usando contactos entre contornos, NFP y una cuadrícula de `20`, `5` y `1 mm`. Conserva el mejor acomodo completo si vence el presupuesto. El navegador mantiene un límite global de `180 s` y el Worker usa como máximo `170 s`. El resultado es heurístico: la separación se valida, pero no se garantiza el acomodo óptimo.

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

Para comparar un archivo vectorial con el acomodo inicial y comprobar sus márgenes, separación y número de piezas:

```sh
node --experimental-transform-types scripts/compare-layouts.mjs "archivo.eps" 1220 3050 3 50
```

Los cuatro valores corresponden al ancho, alto, separación y margen, en milímetros. La comparación de `MEDICAL COUNTRY.eps` redujo el consumo de `3.75` a `3` hojas y las hojas físicas de `4` a `3`. Con `Ciudad_Maderas_80cm_con_figuras_prueba.svg`, en hoja de `1800 × 2400 mm`, separación de `5 mm` y margen de `20 mm`, el consumo bajó de `3` a `2.5` hojas; conserva tres hojas físicas.
