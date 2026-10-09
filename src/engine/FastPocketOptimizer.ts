import {boundaryRings, polygonArea, SCALE, translatePolygon} from './PolygonOperations.ts';
import {finalize, parentFor, rotatePiece, validPosition, type OrientedPiece} from './BottomLeftPlacer.ts';
import {NFPGenerator, WorkLimitError} from './NFPGenerator.ts';
import type {NestingConfig, NestingResult, Piece, Placement, Point, ProgressEvent, Rotation} from './types.ts';

interface Pose {shape: OrientedPiece; x: number; y: number; sheet: number; overlap: number; consumption: number}
const QUARTERS = [0.25, 0.5, 0.75, 1] as const;
const angleOrder = (angles: readonly Rotation[]) => [...angles].sort((a, b) => (a % 45 === 0 ? 0 : 1) - (b % 45 === 0 ? 0 : 1) || a - b);

function features(ring: readonly Point[], limit: number): Point[] {
  if (ring.length <= limit) return [...ring];
  const ranked = ring.map((point, index) => {
    const prev = ring[(index + ring.length - 1) % ring.length], next = ring[(index + 1) % ring.length];
    const ax = point.x - prev.x, ay = point.y - prev.y, bx = next.x - point.x, by = next.y - point.y;
    const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return {point, index, turn: length ? Math.abs(ax * by - ay * bx) / length : 0};
  });
  const chosen = new Set<number>();
  for (let index = 0; index < ring.length; index += Math.max(1, Math.floor(ring.length / 12))) chosen.add(index);
  for (const item of [...ranked].sort((a, b) => b.turn - a.turn || a.index - b.index)) {
    if (chosen.size >= limit) break;
    chosen.add(item.index);
  }
  return [...chosen].sort((a, b) => a - b).map(index => ring[index]);
}

function bboxOverlap(x: number, y: number, shape: OrientedPiece, placed: readonly Placement[]): number {
  let overlap = 0;
  for (const other of placed) {
    const w = Math.max(0, Math.min(x + shape.width, other.x + other.width) - Math.max(x, other.x));
    const h = Math.max(0, Math.min(y + shape.height, other.y + other.height) - Math.max(y, other.y));
    overlap += w * h;
  }
  return overlap;
}

function fractionFor(placed: readonly Placement[], shapes: ReadonlyMap<string, OrientedPiece>, config: NestingConfig): number {
  if (!placed.length) return 0;
  const used = Math.max(...placed.map(item => item.y + item.height + shapes.get(`${item.pieceId}:${item.rotation}`)!.approximationErrorMm));
  return QUARTERS.find(fraction => used + (config.edgeMarginMm ?? 20) <= config.sheetHeightMm * fraction + 1e-7) ?? 1;
}

function better(a: Pose, b: Pose | null): boolean {
  if (!b) return true;
  if (Math.abs(a.consumption - b.consumption) > 1e-7) return a.consumption < b.consumption;
  if (a.sheet !== b.sheet) return a.sheet < b.sheet;
  if (Math.abs(a.overlap - b.overlap) > 1e-5) return a.overlap > b.overlap;
  return a.y < b.y - 1e-7 || Math.abs(a.y - b.y) <= 1e-7 && (a.x < b.x - 1e-7 || Math.abs(a.x - b.x) <= 1e-7 && a.shape.rotation < b.shape.rotation);
}

/** Improve a valid fast layout by relocating leaf pieces into earlier sheets. */
export function improveFastLayout(
  pieces: readonly Piece[], config: NestingConfig, initial: NestingResult, rotations: readonly Rotation[],
  deadlineMs: number, onProgress?: (progress: ProgressEvent) => void,
): NestingResult {
  if (initial.error || initial.sheetCount < 2 || performance.now() >= deadlineMs) return initial;
  const started = performance.now(), sheetArea = config.sheetWidthMm * config.sheetHeightMm;
  const pieceById = new Map(pieces.map(piece => [piece.id, piece]));
  const shapes = new Map<string, OrientedPiece>();
  const shapeFor = (id: string, angle: number) => {
    const key = `${id}:${angle}`;
    let shape = shapes.get(key);
    if (!shape) { shape = rotatePiece(pieceById.get(id)!, angle); shapes.set(key, shape); }
    return shape;
  };
  for (const placement of initial.placements) shapeFor(placement.pieceId, placement.rotation);
  let current = initial;
  const generator = new NFPGenerator(50_000, 512);
  let nfpAvailable = true;
  const angles = angleOrder(rotations);
  const progress = () => onProgress?.({completed: Math.max(0, performance.now() - started), total: Math.max(1, deadlineMs - started), bestSheetCount: current.sheetCount, stage: 'repair'});
  progress();

  for (let pass = 0; pass < 2 && performance.now() < deadlineMs; pass++) {
    const parents = new Set(current.placements.flatMap(item => item.parentPieceId ? [item.parentPieceId] : []));
    const movable = current.placements.filter(item => item.sheet > 0 && !parents.has(item.pieceId) && polygonArea(item.polygon) <= sheetArea * 0.03)
      .sort((a, b) => b.sheet - a.sheet || polygonArea(a.polygon) - polygonArea(b.polygon) || a.pieceId.localeCompare(b.pieceId));
    let changed = false;
    for (const mobile of movable) {
      if (performance.now() >= deadlineMs) break;
      const sheets = Array.from({length: current.sheetCount}, (_, index) => current.placements.filter(item => item.sheet === index));
      const source = sheets[mobile.sheet];
      const sourceWithout = source.filter(item => item.pieceId !== mobile.pieceId);
      const originalConsumption = current.regions.reduce((sum, region) => sum + region.fraction, 0);
      const sourceFraction = fractionFor(sourceWithout, shapes, config);
      const minimumConsumption = originalConsumption - current.regions[mobile.sheet].fraction + sourceFraction;
      let best: Pose | null = null;
      for (let destination = 0; destination < mobile.sheet && performance.now() < deadlineMs; destination++) {
        const placed = sheets[destination];
        const originalFraction = fractionFor(placed, shapes, config);
        const edge = config.edgeMarginMm ?? 20;
        for (const angle of angles) {
          if (performance.now() >= deadlineMs) break;
          const shape = shapeFor(mobile.pieceId, angle);
          const minX = edge + shape.approximationErrorMm, minY = minX;
          const maxX = config.sheetWidthMm - edge - shape.approximationErrorMm - shape.width;
          const maxY = config.sheetHeightMm - edge - shape.approximationErrorMm - shape.height;
          if (maxX < minX || maxY < minY) { progress(); continue; }
          const angleDeadline = Math.min(deadlineMs, performance.now() + (best ? 250 : 650));
          const seen = new Set<string>();
          const local: {pose: Pose | null} = {pose: null};
          const probe = (x: number, y: number) => {
            if (performance.now() >= angleDeadline || x < minX - 1e-7 || y < minY - 1e-7 || x > maxX + 1e-7 || y > maxY + 1e-7) return;
            const key = `${Math.round(x * 1000)}:${Math.round(y * 1000)}`;
            if (seen.has(key)) return;
            seen.add(key);
            const polygon = translatePolygon(shape.polygon, x, y);
            if (!validPosition(polygon, shape, x, y, placed, shapes, config)) return;
            const targetFraction = fractionFor([...placed, {pieceId: shape.id, sheet: destination, x, y, width: shape.width, height: shape.height, rotation: angle, polygon}], shapes, config);
            const pose: Pose = {shape, x, y, sheet: destination, overlap: bboxOverlap(x, y, shape, placed),
              consumption: originalConsumption - current.regions[mobile.sheet].fraction - originalFraction + sourceFraction + targetFraction};
            if (better(pose, local.pose)) local.pose = pose;
          };
          // NFP boundary vertices are exact contact candidates when both outlines are modest.
          if (nfpAvailable) for (const other of placed) {
            if (performance.now() >= angleDeadline) break;
            const stationary = shapeFor(other.pieceId, other.rotation);
            if (boundaryRings(stationary.polygon).reduce((n, ring) => n + ring.length, 0) > 45 ||
                boundaryRings(shape.polygon).reduce((n, ring) => n + ring.length, 0) > 45) continue;
            try {
              const clearance = config.gapMm + shape.approximationErrorMm + stationary.approximationErrorMm;
              const paths = generator.generate(stationary.polygon, shape.polygon, clearance, stationary.key, shape.key);
              for (const path of paths) for (const point of path) {
                probe(other.x + point.x / SCALE, other.y + point.y / SCALE);
                if (performance.now() >= angleDeadline) break;
              }
            } catch (error) {
              if (!(error instanceof WorkLimitError)) throw error;
              nfpAvailable = false;
              break;
            }
          }
          // Match actual outline features, including the deep corners of open letters.
          const mobileFeatures = features(shape.polygon.outer, 12);
          const contacts: {x: number; y: number; overlap: number}[] = [];
          for (const other of placed) {
            const staticFeatures = features(other.polygon.outer, 48);
            const clearance = config.gapMm + shape.approximationErrorMm + shapeFor(other.pieceId, other.rotation).approximationErrorMm;
            for (const fixed of staticFeatures) for (const moving of mobileFeatures) {
              for (const [dx, dy] of [[clearance, 0], [-clearance, 0], [0, clearance], [0, -clearance]]) {
                const x = fixed.x - moving.x + dx, y = fixed.y - moving.y + dy;
                if (x >= minX && x <= maxX && y >= minY && y <= maxY) contacts.push({x, y, overlap: bboxOverlap(x, y, shape, placed)});
              }
            }
          }
          const buckets = new Map<string, typeof contacts>();
          for (const candidate of contacts) {
            const key = `${Math.floor(candidate.x / (config.sheetWidthMm / 4))}:${Math.floor(candidate.y / (config.sheetHeightMm / 4))}`;
            const entries = buckets.get(key) ?? [];
            entries.push(candidate); buckets.set(key, entries);
          }
          for (const entries of buckets.values()) {
            entries.sort((a, b) => b.overlap - a.overlap || a.y - b.y || a.x - b.x);
            for (const entry of entries.slice(0, 16)) probe(entry.x, entry.y);
            if (performance.now() >= angleDeadline) break;
          }
          // A staggered 20 mm grid finds feasible poses that no pair of vertices implies.
          if (!local.pose || local.pose.overlap < shape.width * shape.height * 1.5) {
            for (const oy of [0, 10]) for (const ox of [0, 10]) {
              for (let y = minY + oy; y <= maxY + 1e-7 && performance.now() < angleDeadline; y += 20) {
                for (let x = minX + ox; x <= maxX + 1e-7 && performance.now() < angleDeadline; x += 20) {
                  probe(x, y);
                }
              }
            }
          }
          if (local.pose) {
            const coarse = local.pose;
            for (const step of [5, 1]) {
              const radius = step === 5 ? 10 : 2;
              for (let dy = -radius; dy <= radius && performance.now() < angleDeadline; dy += step)
                for (let dx = -radius; dx <= radius && performance.now() < angleDeadline; dx += step) probe(coarse.x + dx, coarse.y + dy);
            }
            if (better(local.pose, best)) best = local.pose;
          }
          progress();
        }
        if (best && best.sheet === 0 && best.consumption <= minimumConsumption + 1e-7) break;
      }
      if (!best || best.consumption > originalConsumption + 1e-7) continue;
      const {shape, x, y, sheet} = best;
      const parent = parentFor(shape, x, y, sheets[sheet], shapes, config);
      const moved: Placement = {pieceId: mobile.pieceId, sheet, x, y, width: shape.width, height: shape.height,
        rotation: shape.rotation, polygon: translatePolygon(shape.polygon, x, y), ...parent};
      sheets[mobile.sheet] = sourceWithout;
      sheets[sheet].push(moved);
      const candidate = finalize(sheets.filter(group => group.length), pieces, config);
      const oldWeight = current.placements.reduce((sum, item) => sum + item.sheet * polygonArea(item.polygon), 0);
      const newWeight = candidate.placements.reduce((sum, item) => sum + item.sheet * polygonArea(item.polygon), 0);
      const oldConsumption = current.regions.reduce((sum, region) => sum + region.fraction, 0);
      const newConsumption = candidate.regions.reduce((sum, region) => sum + region.fraction, 0);
      if (newConsumption < oldConsumption - 1e-7 || Math.abs(newConsumption - oldConsumption) <= 1e-7 && newWeight < oldWeight - 1e-7) {
        current = candidate; changed = true; progress();
      }
    }
    if (!changed) break;
  }
  return current;
}
