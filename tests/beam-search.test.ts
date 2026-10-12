import assert from 'node:assert/strict';
import test from 'node:test';
import {baseline} from '../src/engine/BottomLeftPlacer.ts';
import {searchFewerSheets} from '../src/engine/BeamSearch.ts';
import {materialOverlaps, minimumBoundaryDistance} from '../src/engine/PolygonOperations.ts';
import type {Piece} from '../src/engine/types.ts';

const rectangle = (id: string, width: number, height: number): Piece => ({id, approximationErrorMm: 0.25,
  polygon: {outer: [{x: 0, y: 0}, {x: width, y: 0}, {x: width, y: height}, {x: 0, y: height}], holes: []}});

test('conserva un giro inicial alternativo y evita la hoja que abre el acomodo voraz', () => {
  const pieces = [rectangle('grande', 80, 55), rectangle('mediana', 60, 40), rectangle('ultima', 65, 32)];
  const config = {sheetWidthMm: 150, sheetHeightMm: 100, gapMm: 3, edgeMarginMm: 5, rotations: [0, 90]};
  const initial = baseline(pieces, config), snapshot = JSON.stringify(initial);
  assert.equal(initial.sheetCount, 2);
  const result = searchFewerSheets(pieces, config, initial, config.rotations, performance.now() + 2_000,
    undefined, {step: 1, width: 8, orders: ['area'], weights: [0.35]});
  assert.equal(result.sheetCount, 1);
  assert.equal(result.placements.length, 3);
  assert.equal(result.placements.find(item => item.pieceId === 'grande')!.rotation, 90);
  assert.equal(JSON.stringify(initial), snapshot);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    assert.equal(materialOverlaps(result.placements[i].polygon, result.placements[j].polygon), false);
    assert.ok(minimumBoundaryDistance(result.placements[i].polygon, result.placements[j].polygon) >= 3.5 - 1e-7);
  }
});

test('conserva la solución completa si vence el presupuesto de búsqueda', () => {
  const pieces = [rectangle('uno', 80, 55), rectangle('dos', 60, 40), rectangle('tres', 65, 32)];
  const config = {sheetWidthMm: 150, sheetHeightMm: 100, gapMm: 3, edgeMarginMm: 5, rotations: [0, 90]};
  const initial = baseline(pieces, config);
  const result = searchFewerSheets(pieces, config, initial, config.rotations, performance.now() + 1);
  assert.equal(result, initial);
  assert.equal(result.placements.length, pieces.length);
});
