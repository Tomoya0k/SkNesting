import {EndType, JoinType, inflatePaths} from 'clipper2-ts';
import {finalize, parentFor, rotatePiece, validPosition, type OrientedPiece} from './BottomLeftPlacer.ts';
import {SCALE, bounds, convexHull, polygonArea, toPaths, translatePolygon} from './PolygonOperations.ts';
import type {NestingConfig, NestingResult, Piece, Placement, ProgressEvent, Rotation} from './types.ts';

export interface Mask {shape: OrientedPiece; width: number; height: number; offsetX: number; offsetY: number; words: number; bits: Uint32Array; rows: number[]}
export interface Board {bits: Uint32Array; placements: Placement[]; height: number}
interface Pose {mask: Mask; x: number; y: number; height: number; score: number}

export function rasterize(shape: OrientedPiece, step: number, gap: number, deadlineMs: number): Mask | null {
  // Cover every cell touched by material expanded by half the required gap.
  // Boundary supercover removes the extra half-cell-diagonal inflation used
  // by center-only sampling, while retaining a conservative occupied mask.
  const buffer = gap / 2 + shape.approximationErrorMm + 0.051;
  const paths = inflatePaths(toPaths([shape.polygon]), Math.ceil(buffer * SCALE), JoinType.Round, EndType.Polygon, 2, 0.05 * SCALE);
  const points = paths.flat();
  const offsetX = Math.floor(Math.min(...points.map(point => point.x)) / SCALE / step);
  const offsetY = Math.floor(Math.min(...points.map(point => point.y)) / SCALE / step);
  const width = Math.ceil(Math.max(...points.map(point => point.x)) / SCALE / step) - offsetX;
  const height = Math.ceil(Math.max(...points.map(point => point.y)) / SCALE / step) - offsetY;
  const words = Math.ceil(width / 32), bits = new Uint32Array(words * height);
  const weights: number[] = [];
  for (let row = 0; row < height; row++) {
    if ((row & 15) === 0 && performance.now() >= deadlineMs) return null;
    const y = (row + offsetY + 0.5) * step * SCALE;
    const crossings: {x: number; delta: number}[] = [];
    for (const path of paths) for (let index = 0; index < path.length; index++) {
      const a = path[index], b = path[(index + 1) % path.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y))
        crossings.push({x: (a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)) / SCALE / step - offsetX, delta: b.y > a.y ? 1 : -1});
    }
    crossings.sort((a, b) => a.x - b.x);
    let winding = 0, weight = 0;
    for (let index = 0; index + 1 < crossings.length; index++) {
      winding += crossings[index].delta;
      if (!winding) continue;
      const left = Math.max(0, Math.ceil(crossings[index].x - 0.5));
      const right = Math.min(width - 1, Math.floor(crossings[index + 1].x - 0.5));
      for (let x = left; x <= right; x++) bits[row * words + (x >>> 5)] |= 1 << (x & 31);
      weight += Math.max(0, right - left + 1);
    }
    weights.push(weight);
  }
  for (const path of paths) for (let index = 0; index < path.length; index++) {
    if ((index & 31) === 0 && performance.now() >= deadlineMs) return null;
    const a = path[index], b = path[(index + 1) % path.length], dy = b.y - a.y;
    const first = Math.max(0, Math.floor(Math.min(a.y, b.y) / SCALE / step) - offsetY);
    const last = Math.min(height - 1, Math.floor(Math.max(a.y, b.y) / SCALE / step) - offsetY);
    for (let row = first; row <= last; row++) {
      const low = (row + offsetY) * step * SCALE, high = low + step * SCALE;
      let begin = 0, end = 1;
      if (dy) { const t0 = (low - a.y) / dy, t1 = (high - a.y) / dy; begin = Math.max(0, Math.min(t0, t1)); end = Math.min(1, Math.max(t0, t1)); }
      if (begin > end) continue;
      const x0 = a.x + (b.x - a.x) * begin, x1 = a.x + (b.x - a.x) * end;
      const left = Math.max(0, Math.floor(Math.min(x0, x1) / SCALE / step) - offsetX);
      const right = Math.min(width - 1, Math.floor(Math.max(x0, x1) / SCALE / step) - offsetX);
      for (let x = left; x <= right; x++) bits[row * words + (x >>> 5)] |= 1 << (x & 31);
    }
  }
  for (let row = 0; row < height; row++) {
    weights[row] = 0;
    for (let word = 0; word < words; word++) {
      let value = bits[row * words + word];
      value -= (value >>> 1) & 0x55555555;
      value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
      weights[row] += Math.imul((value + (value >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
    }
  }
  const rows = Array.from({length: height}, (_, index) => index).filter(row => weights[row])
    .sort((a, b) => weights[b] - weights[a] || a - b);
  return {shape, width, height, offsetX, offsetY, words, bits, rows};
}

export function fits(mask: Mask, board: Board, x: number, y: number, words: number): boolean {
  const shift = x & 31, wordX = x >>> 5;
  for (const row of mask.rows) {
    const from = row * mask.words, to = (row + y) * words + wordX;
    for (let word = 0; word < mask.words; word++) {
      const value = mask.bits[from + word];
      if (board.bits[to + word] & (value << shift)) return false;
      if (shift && board.bits[to + word + 1] & (value >>> (32 - shift))) return false;
    }
  }
  return true;
}
export function paint(mask: Mask, board: Board, x: number, y: number, words: number) {
  const shift = x & 31, wordX = x >>> 5;
  for (const row of mask.rows) {
    const from = row * mask.words, to = (row + y) * words + wordX;
    for (let word = 0; word < mask.words; word++) {
      const value = mask.bits[from + word];
      board.bits[to + word] |= value << shift;
      if (shift && value >>> (32 - shift)) board.bits[to + word + 1] |= value >>> (32 - shift);
    }
  }
  board.height = Math.max(board.height, y + mask.height);
}

export function compareMaterial(a: NestingResult, b: NestingResult): number {
  if (a.error || b.error) return a.error && b.error ? 0 : a.error ? 1 : -1;
  const scores = (result: NestingResult) => [
    result.regions.reduce((sum, region) => sum + region.fraction, 0), result.sheetCount,
    result.regions.reduce((sum, region) => sum + region.usedHeight, 0),
    result.regions.reduce((sum, region) => sum + region.usedWidth, 0),
  ];
  const first = scores(a), second = scores(b);
  for (let index = 0; index < first.length; index++) if (Math.abs(first[index] - second[index]) > 1e-7) return first[index] - second[index];
  return 0;
}

export type RasterOrdering = 'area' | 'perimeter' | 'bounds' | 'rigidity';
export function orderPieces(pieces: readonly Piece[], config: NestingConfig, ordering: RasterOrdering = 'area'): Piece[] {
  const areas = new Map(pieces.map(piece => [piece.id, polygonArea(piece.polygon)]));
  const size = new Map(pieces.map(piece => {
    if (ordering === 'area') return [piece.id, areas.get(piece.id)!] as const;
    if (ordering === 'bounds') { const box = bounds(piece.polygon.outer); return [piece.id, (box.maxX - box.minX) * (box.maxY - box.minY)] as const; }
    const hull = convexHull(toPaths([piece.polygon])[0]);
    if (ordering === 'rigidity') {
      const box = bounds(piece.polygon.outer), longest = Math.max(box.maxX - box.minX, box.maxY - box.minY);
      if (longest > Math.min(config.sheetWidthMm, config.sheetHeightMm) * 0.75) return [piece.id, longest] as const;
      let minWidth = Infinity;
      for (let index = 0; index < hull.length; index++) {
        const a = hull[index], b = hull[(index + 1) % hull.length], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
        let width = 0;
        for (const p of hull) width = Math.max(width, Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / length / SCALE);
        minWidth = Math.min(minWidth, width);
      }
      const hullArea = Math.abs(hull.reduce((sum, p, index) => {const q = hull[(index + 1) % hull.length]; return sum + p.x * q.y - q.x * p.y;}, 0)) / (2 * SCALE * SCALE);
      return [piece.id, minWidth * polygonArea({outer: piece.polygon.outer, holes: []}) / hullArea] as const;
    }
    return [piece.id, hull.reduce((sum, point, index) => sum + Math.hypot(point.x - hull[(index + 1) % hull.length].x, point.y - hull[(index + 1) % hull.length].y) / SCALE, 0)] as const;
  }));
  const smallLimit = config.sheetWidthMm * config.sheetHeightMm * 0.03;
  return [...pieces].sort((a, b) => Number(areas.get(b.id)! > smallLimit) - Number(areas.get(a.id)! > smallLimit) ||
    size.get(b.id)! - size.get(a.id)! || a.id.localeCompare(b.id));
}

/** Repack all pieces using conservative material masks, then certify real contours. */
export function improveRasterLayout(pieces: readonly Piece[], config: NestingConfig, initial: NestingResult,
  rotations: readonly Rotation[], deadlineMs: number, onProgress?: (progress: ProgressEvent) => void,
  ordering: RasterOrdering = 'area'): NestingResult {
  let best = initial;
  const edge = config.edgeMarginMm ?? 20, started = performance.now(), ordered = orderPieces(pieces, config, ordering);
  const trials: {trial: number; result: NestingResult}[] = [];
  // Coarse masks make global orientation trials cheap; a finer pass recovers
  // narrow spaces. Both passes retain the best certified complete solution.
  const longestSide = Math.max(config.sheetWidthMm - 2 * edge, config.sheetHeightMm - 2 * edge);
  let level = 0;
  for (const step of [Math.max(10, longestSide / 1024), Math.max(5, longestSide / 2048)]) {
    const coarse = level++ === 0;
    if (performance.now() >= deadlineMs) break;
    const width = Math.floor((config.sheetWidthMm - 2 * edge) / step), height = Math.floor((config.sheetHeightMm - 2 * edge) / step);
    const words = Math.ceil(width / 32);
    const masks = new Map<string, Mask[]>(), shapes = new Map<string, OrientedPiece>();
    for (const piece of pieces) {
      if (performance.now() >= deadlineMs) return best;
      const options: Mask[] = [];
      for (const angle of rotations) {
        if (performance.now() >= deadlineMs) return best;
        const shape = rotatePiece(piece, angle);
        shapes.set(shape.key, shape);
        if (shape.width > width * step || shape.height > height * step) continue;
        const mask = rasterize(shape, step, config.gapMm, deadlineMs);
        if (!mask) return best;
        if (mask.width <= width && mask.height <= height) options.push(mask);
      }
      masks.set(piece.id, options);
    }
    if (ordered.some(piece => !masks.get(piece.id)!.length)) continue;
    const trialOrder = coarse ? Array.from({length: 12}, (_, index) => index) : [...trials].sort((a, b) => compareMaterial(a.result, b.result)).slice(0, 6).map(item => item.trial);
    for (const trial of trialOrder) {
      if (performance.now() >= deadlineMs) break;
      const boards: Board[] = [];
      let complete = true;
      for (const piece of ordered) {
        if (performance.now() >= deadlineMs) { complete = false; break; }
        const options = masks.get(piece.id)!;
        const fromRight = trial % 2 !== 0;
        let chosen: Pose | null = null, destination = 0;
        for (; destination <= boards.length; destination++) {
          const board = boards[destination] ?? {bits: new Uint32Array(words * height), placements: [], height: 0};
          for (const mask of options) {
            const maxX = width - mask.width, maxY = height - mask.height;
            let pose: Pose | null = null;
            for (let y = 0; y <= maxY && !pose; y++) {
              if ((y & 15) === 0 && performance.now() >= deadlineMs) { complete = false; break; }
              for (let ix = 0; ix <= maxX; ix++) {
                const x = fromRight ? maxX - ix : ix;
                if (!fits(mask, board, x, y, words)) continue;
                const nextHeight = Math.max(board.height, y + mask.height);
                // Trials vary the price of width and orientation, while always
                // placing large material first. This avoids a single greedy
                // orientation deciding the complete layout.
                const widthWeight = [0, 0.15, 0.35, 0.65, 1.2, 2][Math.floor(trial / 2)];
                const score = nextHeight + mask.width * widthWeight + y * 0.02 +
                  (mask.shape.rotation % 90 ? 0.1 : 0);
                pose = {mask, x, y, height: nextHeight, score};
                break;
              }
            }
            if (!complete) break;
            if (pose && (!chosen || pose.score < chosen.score - 1e-7)) chosen = pose;
          }
          if (!complete) break;
          if (!chosen) continue;
          if (destination === boards.length) boards.push(board);
          const {mask, x, y} = chosen, shape = mask.shape;
          const px = edge + (x - mask.offsetX) * step, py = edge + (y - mask.offsetY) * step;
          const polygon = translatePolygon(shape.polygon, px, py);
          if (!validPosition(polygon, shape, px, py, board.placements, shapes, config)) { complete = false; break; }
          board.placements.push({pieceId: piece.id, sheet: destination, x: px, y: py, width: shape.width, height: shape.height, rotation: shape.rotation, polygon});
          paint(mask, board, x, y, words);
          break;
        }
        if (!chosen || !complete) { complete = false; break; }
      }
      if (complete) {
        for (const board of boards) for (const placement of board.placements) {
          const shape = shapes.get(`${placement.pieceId}:${placement.rotation}`)!;
          Object.assign(placement, parentFor(shape, placement.x, placement.y, board.placements.filter(other => other !== placement), shapes, config));
        }
        const candidate = finalize(boards.map(board => board.placements), pieces, config);
        if (compareMaterial(candidate, best) < 0) best = candidate;
        if (coarse) trials.push({trial, result: candidate});
      }
      onProgress?.({completed: performance.now() - started, total: Math.max(1, deadlineMs - started), bestSheetCount: best.sheetCount,
        bestConsumedSheets: best.regions.reduce((sum, region) => sum + region.fraction, 0), stage: 'repack'});
    }
  }
  return best;
}
