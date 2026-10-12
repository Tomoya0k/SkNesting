import {compareMaterial, fits, orderPieces, paint, rasterize, type Board, type Mask, type RasterOrdering} from './RasterOptimizer.ts';
import {finalize, parentFor, rotatePiece, validPosition, type OrientedPiece} from './BottomLeftPlacer.ts';
import {translatePolygon} from './PolygonOperations.ts';
import type {NestingConfig, NestingResult, Piece, ProgressEvent, Rotation} from './types.ts';

interface State {boards: Board[]; cost: number}
interface Pose {mask: Mask; x: number; y: number; sheet: number; cost: number}
export interface BeamOptions {width?: number; step?: number; orders?: readonly RasterOrdering[]; weights?: readonly number[];
  onAttempt?: (attempt: {order: RasterOrdering; weight: number; packed: number; total: number; failedPiece?: string}) => void}

function signature(boards: Board[]): string {
  let first = 2166136261, second = 5381;
  for (const board of boards) for (const value of board.bits) {
    first = Math.imul(first ^ value, 16777619); second = Math.imul(second, 33) ^ value;
  }
  return `${first >>> 0}:${second >>> 0}`;
}

/** Keep alternative partial layouts until a complete layout fits fewer sheets. */
export function searchFewerSheets(pieces: readonly Piece[], config: NestingConfig, initial: NestingResult,
  rotations: readonly Rotation[], deadlineMs: number, onProgress?: (progress: ProgressEvent) => void, options: BeamOptions = {}): NestingResult {
  if (initial.error || initial.sheetCount < 2 || performance.now() >= deadlineMs) return initial;
  const started = performance.now(), step = options.step ?? 5, beamWidth = options.width ?? 8;
  const edge = config.edgeMarginMm ?? 20, width = Math.floor((config.sheetWidthMm - 2 * edge) / step), height = Math.floor((config.sheetHeightMm - 2 * edge) / step);
  const words = Math.ceil(width / 32), target = initial.sheetCount - 1;
  const shapes = new Map<string, OrientedPiece>(), masks = new Map<string, Mask[]>();
  const lookahead = new Map<string, boolean>();
  const masksFor = (piece: Piece) => {
    let result = masks.get(piece.id);
    if (result) return result;
    result = [];
    for (const angle of rotations) {
      if (performance.now() >= deadlineMs) break;
      const shape = rotatePiece(piece, angle); shapes.set(shape.key, shape);
      if (shape.width > width * step || shape.height > height * step) continue;
      const mask = rasterize(shape, step, config.gapMm, deadlineMs);
      if (!mask) break;
      if (mask.width <= width && mask.height <= height) result.push(mask);
    }
    masks.set(piece.id, result);
    return result;
  };
  const canPlace = (piece: Piece, boards: Board[]): boolean => {
    for (const mask of masksFor(piece)) for (const board of boards) {
      if (!board.placements.length) return true;
      const maxX = width - mask.width, maxY = height - mask.height;
      for (let y = 0; y <= maxY; y++) {
        if ((y & 15) === 0 && performance.now() >= deadlineMs) return false;
        for (let x = 0; x <= maxX; x++) if (fits(mask, board, x, y, words)) return true;
      }
    }
    return false;
  };
  for (const order of options.orders ?? ['bounds', 'perimeter', 'area', 'rigidity']) {
    const queue = orderPieces(pieces, config, order);
    for (const weight of options.weights ?? [0.35, 1.2, 0]) {
      if (performance.now() >= deadlineMs) return initial;
      let states: State[] = [{cost: 0, boards: Array.from({length: target}, () => ({bits: new Uint32Array(words * height), placements: [], height: 0}))}];
      let packed = 0, failedPiece: string | undefined;
      for (const [pieceIndex, piece] of queue.entries()) {
        if (performance.now() >= deadlineMs) break;
        const candidates: State[] = [];
        for (const state of states) {
          if (performance.now() >= deadlineMs) break;
          const poses: Pose[] = [];
          for (let sheet = 0; sheet < target; sheet++) {
            const board = state.boards[sheet];
            if (!board.placements.length && state.boards.slice(0, sheet).some(other => !other.placements.length)) continue;
            for (const mask of masksFor(piece)) {
              if (performance.now() >= deadlineMs) break;
              const maxX = width - mask.width, maxY = height - mask.height;
              for (const [bottom, right] of [[false, false], [false, true], [true, false], [true, true]]) {
                let found = false;
                for (let iy = 0; iy <= maxY && !found; iy++) {
                  if ((iy & 15) === 0 && performance.now() >= deadlineMs) break;
                  const y = bottom ? maxY - iy : iy;
                  for (let ix = 0; ix <= maxX; ix++) {
                    const x = right ? maxX - ix : ix;
                    if (!fits(mask, board, x, y, words)) continue;
                    const totalHeight = state.boards.reduce((sum, other, index) => sum + (index === sheet ? Math.max(other.height, y + mask.height) : other.height), 0);
                    const cost = totalHeight + mask.width * weight + y * 0.03 + x * 0.01;
                    poses.push({mask, x, y, sheet, cost}); found = true; break;
                  }
                }
                // An exhaustive first scan with no fit proves that changing
                // scan direction cannot find a position in this same mask.
                if (!found) break;
              }
            }
          }
          poses.sort((a, b) => a.cost - b.cost);
          const unique = new Set<string>();
          let accepted = 0;
          for (const pose of poses) {
            if (performance.now() >= deadlineMs || accepted >= beamWidth) break;
            const {mask, x, y, sheet} = pose, shape = mask.shape;
            const px = edge + (x - mask.offsetX) * step, py = edge + (y - mask.offsetY) * step;
            const polygon = translatePolygon(shape.polygon, px, py);
            const board = state.boards[sheet];
            const updated: Board = {bits: board.bits.slice(), height: board.height, placements: [...board.placements,
              {pieceId: piece.id, sheet, x: px, y: py, width: shape.width, height: shape.height, rotation: shape.rotation, polygon}]};
            paint(mask, updated, x, y, words);
            const boards = state.boards.map((other, index) => index === sheet ? updated : other), key = signature(boards);
            if (unique.has(key)) continue;
            unique.add(key); accepted++; candidates.push({boards, cost: pose.cost});
          }
        }
        candidates.sort((a, b) => a.cost - b.cost);
        const unique = new Set<string>();
        const families = new Map<number, State[]>();
        const nextPiece = queue[pieceIndex + 1];
        for (const candidate of candidates) {
          const key = signature(candidate.boards);
          if (unique.has(key)) continue;
          unique.add(key);
          if (nextPiece) {
            const checkKey = `${nextPiece.id}:${key}`;
            let feasible = lookahead.get(checkKey);
            if (feasible === undefined) { feasible = canPlace(nextPiece, candidate.boards); lookahead.set(checkKey, feasible); }
            if (!feasible) continue;
          }
          const rotation = candidate.boards[0].placements[0].rotation;
          const family = families.get(rotation) ?? [];
          family.push(candidate); families.set(rotation, family);
        }
        states = [];
        // Retain different anchor orientations; tiny raster changes in a
        // rotated circle must not crowd every other anchor out of the beam.
        for (let rank = 0; states.length < beamWidth; rank++) {
          const layer = [...families.values()].flatMap(family => family[rank] ? [family[rank]] : []).sort((a, b) => a.cost - b.cost);
          if (!layer.length) break;
          states.push(...layer.slice(0, beamWidth - states.length));
        }
        if (!states.length) { packed = pieceIndex + (candidates.length ? 1 : 0); failedPiece = candidates.length && nextPiece ? nextPiece.id : piece.id; break; }
        packed++;
      }
      if (packed === pieces.length) for (const state of states) {
        const boards = state.boards.map(board => ({...board, placements: board.placements.map(item => ({...item}))}));
        let valid = true;
        for (const board of boards) {
          const placed = [];
          for (const item of board.placements) {
            const shape = shapes.get(`${item.pieceId}:${item.rotation}`)!;
            if (!validPosition(item.polygon, shape, item.x, item.y, placed, shapes, config)) { valid = false; break; }
            placed.push(item);
          }
          if (!valid) break;
        }
        if (!valid) continue;
        for (const board of boards) for (const item of board.placements) {
          const shape = shapes.get(`${item.pieceId}:${item.rotation}`)!;
          Object.assign(item, parentFor(shape, item.x, item.y, board.placements.filter(other => other !== item), shapes, config));
        }
        const candidate = finalize(boards.map(board => board.placements).filter(group => group.length), pieces, config);
        if (compareMaterial(candidate, initial) < 0) return candidate;
      }
      options.onAttempt?.({order, weight, packed, total: pieces.length, failedPiece});
      onProgress?.({completed: performance.now() - started, total: Math.max(1, deadlineMs - started), bestSheetCount: initial.sheetCount,
        bestConsumedSheets: initial.regions.reduce((sum, region) => sum + region.fraction, 0), stage: 'repack'});
    }
  }
  return initial;
}
