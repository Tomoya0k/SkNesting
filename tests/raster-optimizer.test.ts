import assert from 'node:assert/strict';
import test from 'node:test';
import {finalize, rotatePiece} from '../src/engine/BottomLeftPlacer.ts';
import {improveFastLayout} from '../src/engine/FastPocketOptimizer.ts';
import {improveRasterLayout, rasterize} from '../src/engine/RasterOptimizer.ts';
import {materialOverlaps, minimumBoundaryDistance, translatePolygon} from '../src/engine/PolygonOperations.ts';
import type {Piece, Placement, Polygon} from '../src/engine/types.ts';

const polygon = (points: number[][]): Polygon => ({outer: points.map(([x, y]) => ({x, y})), holes: []});
const rectangle = (size: number) => polygon([[0, 0], [size, 0], [size, size], [0, size]]);
const piece = (id: string, shape: Polygon): Piece => ({id, polygon: shape, approximationErrorMm: 0.25});
const config = {sheetWidthMm: 220, sheetHeightMm: 220, gapMm: 3, edgeMarginMm: 5};
function separate(pieces: Piece[], sheetConfig = config) {
  const sheets = pieces.map((item, sheet) => {
    const shape = rotatePiece(item, 0);
    const placement: Placement = {pieceId: item.id, sheet, x: 6, y: 6, width: shape.width, height: shape.height,
      rotation: 0, polygon: translatePolygon(shape.polygon, 6, 6)};
    return [placement];
  });
  return finalize(sheets, pieces, sheetConfig);
}

test('reacomoda dos piezas grandes dentro de sus concavidades y elimina una hoja', () => {
  const l = polygon([[0, 0], [160, 0], [160, 20], [20, 20], [20, 160], [0, 160]]);
  const pieces = [piece('L-1', l), piece('L-2', l)];
  const initial = separate(pieces);
  const result = improveRasterLayout(pieces, config, initial, [0, 90, 180, 270], performance.now() + 5_000);
  assert.equal(result.sheetCount, 1);
  assert.equal(result.placements.length, 2);
  const [a, b] = result.placements;
  assert.equal(materialOverlaps(a.polygon, b.polygon), false);
  assert.ok(minimumBoundaryDistance(a.polygon, b.polygon) >= 3.5 - 1e-7);
  assert.ok(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height);
});

test('conserva los agujeros al recomponer la hoja y reconstruye la relación de anidado', () => {
  const frame = rectangle(160);
  frame.holes.push(polygon([[35, 35], [125, 35], [125, 125], [35, 125]]));
  const pieces = [piece('marco', frame), piece('interior', rectangle(50))];
  const initial = separate(pieces);
  const result = improveRasterLayout(pieces, config, initial, [0, 90, 180, 270], performance.now() + 5_000);
  assert.equal(result.sheetCount, 1);
  assert.equal(result.placements.find(item => item.pieceId === 'interior')!.parentPieceId, 'marco');
  assert.equal(result.hierarchy[0].children[0].pieceId, 'interior');
  assert.equal(materialOverlaps(result.placements[0].polygon, result.placements[1].polygon), false);
});

test('traslada una letra grande a la concavidad abierta de una pieza en una hoja anterior', () => {
  const l = polygon([[0, 0], [130, 0], [130, 20], [20, 20], [20, 130], [0, 130]]);
  const pieces = [piece('L-grande', l), piece('cuadrado-grande', rectangle(80))];
  const initial = separate(pieces);
  const result = improveFastLayout(pieces, config, initial, [0], performance.now() + 5_000, undefined,
    {maxAreaFraction: 1, lastSheetOnly: true, earlierSheetsOnly: true});
  assert.equal(result.sheetCount, 1);
  assert.equal(result.placements.length, 2);
  const a = result.placements.find(item => item.pieceId === 'L-grande')!;
  const b = result.placements.find(item => item.pieceId === 'cuadrado-grande')!;
  assert.equal(b.parentPieceId, undefined);
  assert.ok(b.x >= a.x + 20 && b.y >= a.y + 20);
  assert.equal(materialOverlaps(a.polygon, b.polygon), false);
  assert.ok(minimumBoundaryDistance(a.polygon, b.polygon) >= 3.5 - 1e-7);
});

test('devuelve la solución completa inicial si el presupuesto ya terminó', () => {
  const pieces = [piece('cuadrado', rectangle(50))], initial = separate(pieces);
  assert.equal(improveRasterLayout(pieces, config, initial, [0, 90], performance.now() - 1), initial);
});

test('conserva todas las piezas cuando el plazo vence durante la preparación geométrica', () => {
  const pieces = Array.from({length: 30}, (_, index) => piece(`pieza-${index}`, rectangle(80)));
  const initial = separate(pieces);
  const result = improveRasterLayout(pieces, config, initial, Array.from({length: 24}, (_, index) => index * 15), performance.now() + 2);
  assert.equal(result.error, null);
  assert.equal(result.placements.length, pieces.length);
  assert.equal(new Set(result.placements.map(item => item.pieceId)).size, pieces.length);
  assert.ok(result.regions.reduce((sum, region) => sum + region.fraction, 0) <= initial.regions.reduce((sum, region) => sum + region.fraction, 0));
});

test('la máscara conserva materia delgada que no pasa por el centro de ninguna celda', () => {
  const thin = piece('delgada', polygon([[0, 0], [0.2, 0], [0.2, 20], [0, 20]]));
  thin.approximationErrorMm = 0;
  const mask = rasterize(rotatePiece(thin, 0), 5, 0, performance.now() + 1_000)!;
  for (const x of [0, 0.1, 0.2]) for (const y of [0, 10, 20]) {
    const column = Math.floor(x / 5) - mask.offsetX, row = Math.floor(y / 5) - mask.offsetY;
    assert.ok(mask.bits[row * mask.words + (column >>> 5)] & (1 << (column & 31)), `materia ausente en (${x}, ${y})`);
  }
});
