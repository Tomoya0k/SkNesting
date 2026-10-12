import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import opentype from 'opentype.js';
import {GeometryParser} from '../src/engine/GeometryParser.ts';
import {baseline, rotatePiece} from '../src/engine/BottomLeftPlacer.ts';
import {improveRasterLayout} from '../src/engine/RasterOptimizer.ts';
import {NestingEngine} from '../src/engine/NestingEngine.ts';
import {materialOverlaps, minimumBoundaryDistance, polygonArea} from '../src/engine/PolygonOperations.ts';
import {consumedSheets} from '../src/sheetUsage.ts';

const file = process.argv[2];
if (!file) throw new Error('Indica un SVG o EPS y, opcionalmente, ancho, alto, separación y margen en mm.');
const bytes = readFileSync(file);
const isEps = /\.eps$/i.test(file), svg = isEps ? '' : bytes.toString('utf8');
let fonts;
if (/\.svg$/i.test(file) && /<text(?:\s|>)/i.test(svg)) {
  const font = name => {
    const data = readFileSync(new URL(`../node_modules/@fontsource/${name}`, import.meta.url));
    return opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  };
  fonts = {serif: font('tinos/files/tinos-latin-400-normal.woff'), serifBold: font('tinos/files/tinos-latin-700-normal.woff'),
    sans: font('arimo/files/arimo-latin-400-normal.woff'), sansBold: font('arimo/files/arimo-latin-700-normal.woff'), gothic: font('unifrakturcook/files/unifrakturcook-latin-700-normal.woff')};
}
const parsed = isEps ? GeometryParser.parseEps(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) : GeometryParser.parseSvg(svg, 0.25, fonts);
const config = {sheetWidthMm: Number(process.argv[3] ?? 1220), sheetHeightMm: Number(process.argv[4] ?? 3050), gapMm: Number(process.argv[5] ?? 3), edgeMarginMm: Number(process.argv[6] ?? 50)};
const started = performance.now();
const initial = baseline(parsed.pieces, {...config, rotations: [0, 90, 180, 270]});
console.log(JSON.stringify({file, phase: 'baseline', pieces: parsed.pieces.length, used: consumedSheets(initial), physical: initial.sheetCount, seconds: (performance.now() - started) / 1000}));
const begin = performance.now();
const progress = item => { if (item.stage === 'repack') console.log(JSON.stringify({phase: 'trial', ms: Math.round(item.completed), physical: item.bestSheetCount, used: item.bestConsumedSheets})); };
const deadline = begin + Number(process.env.BUDGET ?? 170000);
const result = process.env.ENGINE ? NestingEngine.runSync(parsed.pieces, config, progress, deadline) :
  improveRasterLayout(parsed.pieces, config, initial, Array.from({length: 24}, (_, index) => index * 15), deadline, progress);
assert.equal(result.error, null);
assert.ok(consumedSheets(result) <= consumedSheets(initial));
if (process.env.TARGET_USAGE) assert.ok(consumedSheets(result) <= Number(process.env.TARGET_USAGE), `Consumo: ${consumedSheets(result)} hojas`);
assert.equal(result.placements.length, parsed.pieces.length);
assert.equal(new Set(result.placements.map(item => item.pieceId)).size, parsed.pieces.length);
const shapes = new Map(result.placements.map(item => [item.pieceId, rotatePiece(parsed.pieces.find(piece => piece.id === item.pieceId), item.rotation)]));
let checkedPairs = 0;
for (const a of result.placements) {
  const error = shapes.get(a.pieceId).approximationErrorMm;
  assert.ok(a.x >= config.edgeMarginMm + error - 1e-7 && a.y >= config.edgeMarginMm + error - 1e-7);
  assert.ok(a.x + a.width <= config.sheetWidthMm - config.edgeMarginMm - error + 1e-7 && a.y + a.height <= config.sheetHeightMm - config.edgeMarginMm - error + 1e-7);
  for (const b of result.placements) {
    if (a.pieceId >= b.pieceId || a.sheet !== b.sheet) continue;
    const clearance = config.gapMm + error + shapes.get(b.pieceId).approximationErrorMm;
    if (a.x + a.width + clearance <= b.x || b.x + b.width + clearance <= a.x || a.y + a.height + clearance <= b.y || b.y + b.height + clearance <= a.y) continue;
    checkedPairs++;
    assert.equal(materialOverlaps(a.polygon, b.polygon), false, `${a.pieceId}, ${b.pieceId}`);
    assert.ok(minimumBoundaryDistance(a.polygon, b.polygon) + 1e-7 >= clearance, `${a.pieceId}, ${b.pieceId}`);
  }
}
console.log(JSON.stringify({file, phase: 'result', pieces: result.placements.length, used: consumedSheets(result), physical: result.sheetCount, fractions: result.regions.map(region => region.fraction), seconds: (performance.now() - begin) / 1000, areaSheets: result.netAreaMm2 / (config.sheetWidthMm * config.sheetHeightMm), checkedPairs, largeRotations: result.placements.filter(item => polygonArea(item.polygon) > config.sheetWidthMm * config.sheetHeightMm * 0.03).map(item => [item.pieceId, item.rotation])}));
if (process.env.OUTPUT) writeFileSync(process.env.OUTPUT, JSON.stringify(result));
