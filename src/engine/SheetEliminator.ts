import {compareMaterial, fits, paint, rasterize, type Board, type Mask} from './RasterOptimizer.ts';
import {finalize, parentFor, rotatePiece, validPosition, type OrientedPiece} from './BottomLeftPlacer.ts';
import {polygonArea, translatePolygon} from './PolygonOperations.ts';
import type {NestingConfig, NestingResult, Piece, Placement, ProgressEvent, Rotation} from './types.ts';

interface Pose {mask: Mask; x: number; y: number; sheet: number; score: number}
export interface EliminationTrial {removed: string[]; packed: number; total: number; packedArea: number; queueArea: number; targetPacked: number; gridStep: number; variation: number; failedPiece?: string}
export interface EliminationOptions {gridSteps?: readonly number[]; onTrial?: (trial: EliminationTrial) => void}

function paintFixed(mask: Mask, board: Board, words: number, height: number) {
  const x = mask.offsetX, y = mask.offsetY, shift = x & 31, wordX = Math.floor(x / 32);
  for (const row of mask.rows) {
    if (row + y < 0 || row + y >= height) continue;
    for (let word = 0; word < mask.words; word++) {
      const value = mask.bits[row * mask.words + word], column = wordX + word;
      if (column >= 0 && column < words) board.bits[(row + y) * words + column] |= value << shift;
      if (shift && column + 1 >= 0 && column + 1 < words) board.bits[(row + y) * words + column + 1] |= value >>> (32 - shift);
    }
  }
}

/** Destroy and repair neighborhoods while forbidding creation of the final sheet. */
export function eliminateLastSheet(pieces: readonly Piece[], config: NestingConfig, initial: NestingResult,
  rotations: readonly Rotation[], deadlineMs: number, onProgress?: (progress: ProgressEvent) => void,
  optionsConfig: EliminationOptions = {}): NestingResult {
  if (initial.error || initial.sheetCount < 2 || performance.now() >= deadlineMs) return initial;
  const started = performance.now(), targetSheets = initial.sheetCount - 1;
  const pieceById = new Map(pieces.map(piece => [piece.id, piece]));
  const areas = new Map(pieces.map(piece => [piece.id, polygonArea(piece.polygon)]));
  const smallLimit = config.sheetWidthMm * config.sheetHeightMm * 0.03;
  const targets = new Set(initial.placements.filter(item => item.sheet === targetSheets).map(item => item.pieceId));
  const baseRemoved = new Set(initial.placements.filter(item => item.sheet === targetSheets || areas.get(item.pieceId)! <= smallLimit).map(item => item.pieceId));
  const stationary = initial.placements.filter(item => !baseRemoved.has(item.pieceId))
    .sort((a, b) => b.width * b.height - a.width * a.height || a.pieceId.localeCompare(b.pieceId));
  const neighborhoods: string[][] = [[]];
  const overlap = (a: Placement, b: Placement) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  for (const anchor of stationary) {
    const neighbors = stationary.filter(item => item !== anchor && item.sheet === anchor.sheet && overlap(anchor, item) > 0)
      .sort((a, b) => overlap(anchor, b) - overlap(anchor, a));
    for (const count of [1, 2, 3]) if (neighbors.length >= count)
      neighborhoods.push([anchor.pieceId, ...neighbors.slice(0, count).map(item => item.pieceId)]);
  }
  for (const item of stationary) neighborhoods.push([item.pieceId]);
  for (let i = 0; i < stationary.length; i++) for (let j = i + 1; j < stationary.length; j++)
    neighborhoods.push([stationary[i].pieceId, stationary[j].pieceId]);
  const shapes = new Map<string, OrientedPiece>();
  const shapeFor = (id: string, angle: Rotation) => {
    const key = `${id}:${angle}`;
    let shape = shapes.get(key);
    if (!shape) { shape = rotatePiece(pieceById.get(id)!, angle); shapes.set(key, shape); }
    return shape;
  };
  let best = initial;
  for (const step of optionsConfig.gridSteps ?? [10, 5]) {
    const width = Math.floor(config.sheetWidthMm / step), height = Math.floor(config.sheetHeightMm / step), words = Math.ceil(width / 32);
    const options = new Map<string, Mask[]>(), fixedMasks = new Map<string, Mask>();
    for (const item of initial.placements) {
      if (performance.now() >= deadlineMs) return best;
      const shape = shapeFor(item.pieceId, item.rotation);
      const mask = rasterize({...shape, polygon: item.polygon}, step, config.gapMm, deadlineMs);
      if (!mask) return best;
      fixedMasks.set(item.pieceId, mask);
    }
    const masksFor = (id: string): Mask[] => {
      let result = options.get(id);
      if (result) return result;
      result = [];
      for (const angle of rotations) {
        if (performance.now() >= deadlineMs) break;
        const shape = shapeFor(id, angle);
        if (shape.width > config.sheetWidthMm || shape.height > config.sheetHeightMm) continue;
        const mask = rasterize(shape, step, config.gapMm, deadlineMs);
        if (!mask) break;
        if (mask.width <= width && mask.height <= height) result.push(mask);
      }
      options.set(id, result);
      return result;
    };
    for (const neighborhood of neighborhoods) {
      if (performance.now() >= deadlineMs) return best;
      const removed = new Set([...baseRemoved, ...neighborhood]);
      // A displaced parent brings every descendant back into the repair queue.
      for (let changed = true; changed;) {
        changed = false;
        for (const item of initial.placements) if (item.parentPieceId && removed.has(item.parentPieceId) && !removed.has(item.pieceId)) {
          removed.add(item.pieceId); changed = true;
        }
      }
      const queued = pieces.filter(piece => removed.has(piece.id));
      for (let trial = 0; trial < 8 && performance.now() < deadlineMs; trial++) {
        const queue = [...queued].sort((a, b) => (trial < 4 ? 0 : Number(b.id === neighborhood[0]) - Number(a.id === neighborhood[0])) ||
          Number(targets.has(b.id)) - Number(targets.has(a.id)) || areas.get(b.id)! - areas.get(a.id)! || a.id.localeCompare(b.id));
        const boards: Board[] = Array.from({length: targetSheets}, (_, sheet) => {
          const placements = initial.placements.filter(item => item.sheet === sheet && !removed.has(item.pieceId));
          const board: Board = {placements: placements.map(item => ({...item})), bits: new Uint32Array(words * height), height: Math.ceil(Math.max(0, ...placements.map(item => item.y + item.height)) / step)};
          for (const item of placements) paintFixed(fixedMasks.get(item.pieceId)!, board, words, height);
          return board;
        });
        let complete = true, packed = 0, packedArea = 0, targetPacked = 0, failedPiece: string | undefined;
        for (const piece of queue) {
          let chosen: Pose | null = null;
          for (let sheet = 0; sheet < boards.length && performance.now() < deadlineMs; sheet++) {
            const board = boards[sheet];
            for (const mask of masksFor(piece.id)) {
              const edge = config.edgeMarginMm ?? 20, error = mask.shape.approximationErrorMm;
              const minX = Math.max(0, Math.ceil((edge + error) / step) + mask.offsetX);
              const minY = Math.max(0, Math.ceil((edge + error) / step) + mask.offsetY);
              const maxX = Math.min(width - mask.width, Math.floor((config.sheetWidthMm - edge - error - mask.shape.width) / step) + mask.offsetX);
              const maxY = Math.min(height - mask.height, Math.floor((config.sheetHeightMm - edge - error - mask.shape.height) / step) + mask.offsetY);
              let found = false;
              for (let y = minY; y <= maxY && !found; y++) {
                if ((y & 15) === 0 && performance.now() >= deadlineMs) break;
                for (let ix = minX; ix <= maxX; ix++) {
                  const x = trial % 2 ? maxX - ix + minX : ix;
                  if (!fits(mask, board, x, y, words)) continue;
                  const score = Math.max(board.height, y + mask.height) + mask.width * [0, 0.35, 0.65, 1.2][Math.floor(trial / 2)] + y * 0.05 + sheet * 0.01;
                  if (!chosen || score < chosen.score) chosen = {mask, x, y, sheet, score};
                  found = true; break;
                }
              }
            }
          }
          if (!chosen || performance.now() >= deadlineMs) { complete = false; failedPiece = piece.id; break; }
          const {mask, x, y, sheet} = chosen, shape = mask.shape;
          const px = (x - mask.offsetX) * step, py = (y - mask.offsetY) * step;
          const polygon = translatePolygon(shape.polygon, px, py);
          if (!validPosition(polygon, shape, px, py, boards[sheet].placements, shapes, config)) { complete = false; failedPiece = piece.id; break; }
          boards[sheet].placements.push({pieceId: piece.id, sheet, x: px, y: py, width: shape.width, height: shape.height, rotation: shape.rotation, polygon});
          paint(mask, boards[sheet], x, y, words); packed++; packedArea += areas.get(piece.id)!;
          if (targets.has(piece.id)) targetPacked++;
        }
        if (complete) {
          for (const board of boards) for (const item of board.placements) {
            const shape = shapeFor(item.pieceId, item.rotation);
            const {parentPieceId, parentHoleIndex, ...placement} = item;
            Object.assign(item, {...placement, parentPieceId: undefined, parentHoleIndex: undefined}, parentFor(shape, item.x, item.y, board.placements.filter(other => other !== item), shapes, config));
          }
          const candidate = finalize(boards.map(board => board.placements).filter(group => group.length), pieces, config);
          if (compareMaterial(candidate, best) < 0) return candidate;
        }
        onProgress?.({completed: performance.now() - started, total: Math.max(1, deadlineMs - started), bestSheetCount: best.sheetCount, bestConsumedSheets: best.regions.reduce((sum, region) => sum + region.fraction, 0), stage: 'repack'});
        optionsConfig.onTrial?.({removed: neighborhood, packed, total: queue.length, packedArea, queueArea: queue.reduce((sum, piece) => sum + areas.get(piece.id)!, 0), targetPacked, gridStep: step, variation: trial, failedPiece});
      }
    }
  }
  return best;
}
