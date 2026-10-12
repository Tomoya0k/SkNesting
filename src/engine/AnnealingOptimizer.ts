import {rasterize, type Mask} from './RasterOptimizer.ts';
import {finalize, parentFor, rotatePiece, validPosition, type OrientedPiece} from './BottomLeftPlacer.ts';
import {polygonArea, translatePolygon} from './PolygonOperations.ts';
import type {NestingConfig, NestingResult, Piece, Placement, ProgressEvent, Rotation} from './types.ts';

interface CellMask extends Mask {pixels: Uint32Array}
interface Pose {mask: CellMask; x: number; y: number; sheet: number}
export interface AnnealingSeed {pieceId: string; rotation: number; x: number; y: number; sheet: number}
export interface AnnealingOptions {step?: number; seed?: number; initialTemperature?: number; start?: readonly AnnealingSeed[];
  onImprovement?: (state: {energy: number; iterations: number; seconds: number}) => void;
  onCheckpoint?: (state: {certified: false; energy: number; step: number; poses: AnnealingSeed[]}) => void}

function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value += 0x6d2b79f5; let x = value; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}

/** Jointly optimize a fixed number of sheets; publish only a complete certified layout. */
export function annealFewerSheets(pieces: readonly Piece[], config: NestingConfig, initial: NestingResult,
  rotations: readonly Rotation[], deadlineMs: number, onProgress?: (progress: ProgressEvent) => void,
  options: AnnealingOptions = {}): NestingResult {
  if (initial.error || initial.sheetCount < 2 || performance.now() >= deadlineMs) return initial;
  const started = performance.now(), edge = config.edgeMarginMm ?? 20, step = options.step ?? 5, target = initial.sheetCount - 1;
  const width = Math.floor((config.sheetWidthMm - 2 * edge) / step), height = Math.floor((config.sheetHeightMm - 2 * edge) / step), boardSize = width * height;
  if (pieces.reduce((sum, piece) => sum + polygonArea(piece.polygon), 0) > target * boardSize * step * step) return initial;
  const counts = new Uint8Array(target * boardSize), rng = random(options.seed ?? config.seed ?? 20261012);
  const pieceById = new Map(pieces.map(piece => [piece.id, piece])), shapes = new Map<string, OrientedPiece>(), cache = new Map<string, CellMask | null>();
  const maskFor = (id: string, angle: number): CellMask | null => {
    const key = `${id}:${angle}`;
    if (cache.has(key)) return cache.get(key)!;
    if (performance.now() >= deadlineMs) return null;
    const shape = rotatePiece(pieceById.get(id)!, angle); shapes.set(key, shape);
    if (shape.width > width * step || shape.height > height * step) { cache.set(key, null); return null; }
    const mask = rasterize(shape, step, config.gapMm, deadlineMs);
    if (!mask || mask.width > width || mask.height > height) { cache.set(key, null); return null; }
    const pixels: number[] = [];
    for (const row of mask.rows) for (let word = 0; word < mask.words; word++) {
      let value = mask.bits[row * mask.words + word];
      while (value) { const bit = 31 - Math.clz32(value & -value); pixels.push(row * width + word * 32 + bit); value &= value - 1; }
    }
    const result = {...mask, pixels: Uint32Array.from(pixels)}; cache.set(key, result); return result;
  };
  const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, Math.round(value)));
  let energy = 0;
  const update = (pose: Pose, delta: number) => {
    const base = pose.sheet * boardSize + pose.y * width + pose.x;
    for (const offset of pose.mask.pixels) {
      const index = base + offset, count = counts[index];
      if (delta > 0) { if (count) energy++; counts[index] = count + 1; }
      else { if (count > 1) energy--; counts[index] = count - 1; }
    }
  };
  const cost = (pose: Pose, limit: number): number => {
    const base = pose.sheet * boardSize + pose.y * width + pose.x;
    let result = 0;
    for (const offset of pose.mask.pixels) if (counts[base + offset] && ++result > limit) break;
    return result;
  };
  const original = new Map(initial.placements.map(item => [item.pieceId, item]));
  const seeds = options.start ? new Map(options.start.map(item => [item.pieceId, item])) : null;
  if (seeds && (seeds.size !== pieces.length || pieces.some(piece => !seeds.has(piece.id)))) return initial;
  const poses: Pose[] = [];
  const pending: number[] = [];
  for (const piece of pieces) {
    const item = original.get(piece.id)!;
    const seed = seeds?.get(piece.id);
    if (seed && (!rotations.includes(seed.rotation) || ![seed.x, seed.y].every(Number.isFinite) || !Number.isSafeInteger(seed.sheet) || seed.sheet < 0 || seed.sheet >= target)) return initial;
    const mask = maskFor(piece.id, seed?.rotation ?? item.rotation);
    if (!mask) return initial;
    const pose = {mask, x: clamp(((seed?.x ?? item.x) - edge) / step + mask.offsetX, width - mask.width),
      y: clamp(((seed?.y ?? item.y) - edge) / step + mask.offsetY, height - mask.height), sheet: seed?.sheet ?? Math.min(target - 1, item.sheet)};
    poses.push(pose);
    if (seed || item.sheet < target) update(pose, 1); else pending.push(poses.length - 1);
  }
  for (const index of pending) {
    let best: Pose | null = null, bestCost = Infinity;
    for (const angle of rotations) {
      const mask = maskFor(pieces[index].id, angle);
      if (!mask) continue;
      for (let sheet = 0; sheet < target; sheet++) for (let y = 0; y <= height - mask.height && performance.now() < deadlineMs; y += 4)
        for (let x = 0; x <= width - mask.width; x += 4) {
          const pose = {mask, x, y, sheet}, value = cost(pose, bestCost);
          if (value < bestCost) { best = pose; bestCost = value; }
        }
    }
    if (!best || performance.now() >= deadlineMs) return initial;
    const center = best;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const pose = {...center, x: clamp(center.x + dx, width - center.mask.width), y: clamp(center.y + dy, height - center.mask.height)};
      const value = cost(pose, bestCost);
      if (value < bestCost) { best = pose; bestCost = value; }
    }
    poses[index] = best; update(best, 1);
  }
  const certify = (candidatePoses: readonly Pose[] = poses): NestingResult | null => {
    const boards: Placement[][] = Array.from({length: target}, () => []);
    for (const pose of candidatePoses) {
      const shape = pose.mask.shape, x = edge + (pose.x - pose.mask.offsetX) * step, y = edge + (pose.y - pose.mask.offsetY) * step;
      const polygon = translatePolygon(shape.polygon, x, y), board = boards[pose.sheet];
      if (!validPosition(polygon, shape, x, y, board, shapes, config)) return null;
      board.push({pieceId: shape.id, sheet: pose.sheet, x, y, width: shape.width, height: shape.height, rotation: shape.rotation, polygon});
    }
    for (const board of boards) for (const item of board) {
      const shape = shapes.get(`${item.pieceId}:${item.rotation}`)!;
      Object.assign(item, parentFor(shape, item.x, item.y, board.filter(other => other !== item), shapes, config));
    }
    return finalize(boards.filter(board => board.length), pieces, config);
  };
  let bestEnergy = energy, bestPoses = poses.map(pose => ({...pose})), iterations = 0, weights: {index: number; value: number}[] = [], totalWeight = 0;
  const initialTemperature = options.initialTemperature ?? Math.max(2, Math.min(100, energy / pieces.length));
  let lastCheck = -Infinity, lastProgress = -Infinity, lastCheckpoint = -Infinity, checkedEnergy = Infinity;
  const checkpoint = () => options.onCheckpoint?.({certified: false, energy: bestEnergy, step, poses: bestPoses.map(pose => ({pieceId: pose.mask.shape.id,
    rotation: pose.mask.shape.rotation, sheet: pose.sheet, x: edge + (pose.x - pose.mask.offsetX) * step, y: edge + (pose.y - pose.mask.offsetY) * step}))});
  options.onImprovement?.({energy, iterations, seconds: (performance.now() - started) / 1000});
  while (performance.now() < deadlineMs) {
    const now = performance.now();
    if (bestEnergy <= Math.max(64, boardSize * target * 0.01) && bestEnergy < checkedEnergy && now - lastCheck > 500) {
      lastCheck = now;
      checkedEnergy = bestEnergy;
      const result = certify(bestPoses);
      if (result) return result;
    }
    if (now - lastCheckpoint > 5_000) { lastCheckpoint = now; checkpoint(); }
    if (now - lastProgress > 500) { lastProgress = now; onProgress?.({completed: now - started, total: deadlineMs - started, bestSheetCount: initial.sheetCount,
      bestConsumedSheets: initial.regions.reduce((sum, region) => sum + region.fraction, 0), stage: 'repack'}); }
    if (iterations % 512 === 0) {
      weights = []; totalWeight = 0;
      for (let index = 0; index < poses.length; index++) {
        const pose = poses[index], base = pose.sheet * boardSize + pose.y * width + pose.x;
        let value = 0;
        for (const offset of pose.mask.pixels) if (counts[base + offset] > 1) value++;
        if (value) { weights.push({index, value}); totalWeight += value; }
      }
    }
    let index = Math.floor(rng() * poses.length);
    if (weights.length && rng() < 0.85) {
      let choice = rng() * totalWeight;
      for (const item of weights) { choice -= item.value; if (choice <= 0) { index = item.index; break; } }
    }
    const old = poses[index], oldEnergy = energy, temperature = Math.max(1, initialTemperature * Math.pow(0.002, (iterations % 25_000) / 25_000));
    let mask = old.mask;
    const mode = rng();
    if (mode > 0.55) {
      const current = Math.max(0, rotations.indexOf(old.mask.shape.rotation));
      const angle = mode < 0.8 ? rotations[(current + (rng() < 0.5 ? 1 : rotations.length - 1)) % rotations.length] : rotations[Math.floor(rng() * rotations.length)];
      const option = maskFor(pieces[index].id, angle);
      if (!option) { iterations++; continue; }
      mask = option;
    }
    const radius = temperature > 10 ? 8 : 2;
    let proposed: Pose = {mask, sheet: old.sheet,
      x: clamp(old.x + (old.mask.width - mask.width) / 2 + (rng() * 2 - 1) * radius, width - mask.width),
      y: clamp(old.y + (old.mask.height - mask.height) / 2 + (rng() * 2 - 1) * radius, height - mask.height)};
    update(old, -1);
    if (mode > 0.8) {
      proposed = old;
      let bestCost = oldEnergy - energy;
      for (let sample = 0; sample < 24; sample++) {
        const pose = {mask, sheet: Math.floor(rng() * target), x: Math.floor(rng() * (width - mask.width + 1)), y: Math.floor(rng() * (height - mask.height + 1))};
        const value = cost(pose, bestCost);
        if (value < bestCost || value === bestCost && rng() < 0.5) { bestCost = value; proposed = pose; }
      }
    }
    update(proposed, 1);
    if (energy <= oldEnergy || rng() < Math.exp((oldEnergy - energy) / temperature)) poses[index] = proposed;
    else { update(proposed, -1); update(old, 1); }
    iterations++;
    if (energy < bestEnergy) {
      bestEnergy = energy; bestPoses = poses.map(pose => ({...pose}));
      options.onImprovement?.({energy, iterations, seconds: (performance.now() - started) / 1000});
    }
    if (iterations % 25_000 === 0) {
      counts.fill(0); energy = 0;
      for (let i = 0; i < poses.length; i++) { poses[i] = {...bestPoses[i]}; update(poses[i], 1); }
    }
  }
  checkpoint();
  return certify(bestPoses) ?? initial;
}
