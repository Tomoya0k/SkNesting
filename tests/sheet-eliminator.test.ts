import assert from 'node:assert/strict';
import test from 'node:test';
import {eliminateLastSheet} from '../src/engine/SheetEliminator.ts';
import {finalize, rotatePiece} from '../src/engine/BottomLeftPlacer.ts';
import {materialOverlaps, minimumBoundaryDistance, translatePolygon} from '../src/engine/PolygonOperations.ts';
import type {Piece, Placement, Polygon} from '../src/engine/types.ts';

const polygon = (points: number[][]): Polygon => ({outer: points.map(([x, y]) => ({x, y})), holes: []});
const piece = (id: string, shape: Polygon): Piece => ({id, polygon: shape, approximationErrorMm: 0.25});
const config = {sheetWidthMm: 220, sheetHeightMm: 220, gapMm: 3, edgeMarginMm: 5};
function separate(pieces: Piece[], sheetConfig = config) {
  return finalize(pieces.map((item, sheet) => {
    const shape = rotatePiece(item, 0);
    const placed: Placement = {pieceId: item.id, sheet, x: 6, y: 6, width: shape.width, height: shape.height, rotation: 0, polygon: translatePolygon(shape.polygon, 6, 6)};
    return [placed];
  }), pieces, sheetConfig);
}

test('vacía la última hoja recolocando una pieza grande dentro de una concavidad', () => {
  const l = polygon([[0, 0], [160, 0], [160, 20], [20, 20], [20, 160], [0, 160]]);
  const pieces = [piece('L-1', l), piece('L-2', l)], initial = separate(pieces);
  const snapshot = JSON.stringify(initial);
  const result = eliminateLastSheet(pieces, config, initial, [0, 90, 180, 270], performance.now() + 2_000);
  assert.equal(result.sheetCount, 1);
  assert.equal(result.placements.length, pieces.length);
  assert.equal(materialOverlaps(result.placements[0].polygon, result.placements[1].polygon), false);
  assert.ok(minimumBoundaryDistance(result.placements[0].polygon, result.placements[1].polygon) >= 3.5 - 1e-7);
  assert.equal(JSON.stringify(initial), snapshot);
});

test('descarta la reparación incompleta sin modificar la solución válida', () => {
  const square = polygon([[0, 0], [100, 0], [100, 100], [0, 100]]);
  const pieces = [piece('uno', square), piece('dos', square)];
  const smallSheet = {...config, sheetWidthMm: 120, sheetHeightMm: 120}, initial = separate(pieces, smallSheet);
  const snapshot = JSON.stringify(initial);
  const result = eliminateLastSheet(pieces, smallSheet, initial, [0, 90, 180, 270], performance.now() + 100);
  assert.equal(result, initial);
  assert.equal(JSON.stringify(initial), snapshot);
  assert.equal(result.placements.length, 2);
});
