import {FillRule, difference, union, type Paths64} from 'clipper2-ts';
import {SCALE, boundaryRings, bounds, fromPaths, materialOverlaps, minimumBoundaryDistance, polygonArea, polygonCentroid, signedArea, toPath, translatePaths, translatePolygon} from './PolygonOperations.ts';
import {NFPGenerator, WorkLimitError} from './NFPGenerator.ts';
import {calculateIFP, fitsInside} from './InnerFitPolygon.ts';
import {buildPlacementHierarchy} from './PlacementTree.ts';
import type {Fraction, NestingConfig, NestingResult, Piece, Placement, Point, Polygon, Rotation, SheetRegion} from './types.ts';

export interface Gene { id: string; rotation: Rotation }
export interface OrientedPiece extends Piece { rotation: Rotation; width: number; height: number; key: string }
interface Candidate extends Point {parentPieceId?: string; parentHoleIndex?: number; freeConcave?: boolean}
const FRACTIONS: Fraction[] = [0.25, 0.5, 0.75, 1];
const EMPTY_VERSION = 'nfp-ga-v1' as const;
const rotationGridError = (rotation: Rotation) => rotation % 90 === 0 ? 0 : Math.SQRT2 / (2 * SCALE);
const boundarySize = (polygon: Polygon) => boundaryRings(polygon).reduce((sum, ring) => sum + ring.length, 0);
const byDescendingArea = (a: Piece, b: Piece) => polygonArea(b.polygon) - polygonArea(a.polygon) || a.id.localeCompare(b.id);
/** Compare feasible translations by material growth and pull toward placed mass. */
function gravityRanker(shape: OrientedPiece, placed: readonly Placement[], config: NestingConfig): (a: Candidate, b: Candidate) => number {
  const usedHeight = Math.max(0, ...placed.map(other => other.y + other.height));
  const usedWidth = Math.max(0, ...placed.map(other => other.x + other.width));
  let totalMass = 0, weightedX = 0, weightedY = 0;
  for (const other of placed) {
    const mass = polygonArea(other.polygon);
    const center = polygonCentroid(other.polygon);
    totalMass += mass;
    weightedX += mass * center.x;
    weightedY += mass * center.y;
  }
  const centerX = totalMass ? weightedX / totalMass : 0, centerY = totalMass ? weightedY / totalMass : 0;
  const mobileCenter = polygonCentroid(shape.polygon);
  const diagonal = Math.hypot(config.sheetWidthMm, config.sheetHeightMm);
  const score = (candidate: Candidate) => {
    const heightGrowth = Math.max(0, candidate.y + shape.height - usedHeight) / config.sheetHeightMm;
    const widthGrowth = Math.max(0, candidate.x + shape.width - usedWidth) / config.sheetWidthMm;
    const distance = Math.hypot(candidate.x + mobileCenter.x - centerX, candidate.y + mobileCenter.y - centerY) / diagonal;
    return 2 * heightGrowth + 0.35 * widthGrowth + 0.9 * distance +
      0.1 * candidate.y / config.sheetHeightMm + 0.01 * candidate.x / config.sheetWidthMm -
      (candidate.freeConcave ? 0.03 : 0);
  };
  return (a, b) => score(a) - score(b) || a.y - b.y || a.x - b.x;
}
export function rotatePiece(piece: Piece, rotation: Rotation): OrientedPiece {
  const radians = rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const rotate = ({x, y}: Point): Point => rotation === 0 ? {x, y} : rotation === 90 ? {x: -y, y: x} :
    rotation === 180 ? {x: -x, y: -y} : rotation === 270 ? {x: y, y: -x} :
      {x: x * cosine - y * sine, y: x * sine + y * cosine};
  const outer = piece.polygon.outer.map(rotate), box = bounds(outer);
  const normalize = (polygon: Polygon): Polygon => ({
    outer: polygon.outer.map(point => { const p = rotate(point); return {x: p.x - box.minX, y: p.y - box.minY}; }),
    holes: polygon.holes.map(normalize),
  });
  return {...piece, approximationErrorMm: piece.approximationErrorMm + rotationGridError(rotation), rotation,
    width: box.maxX - box.minX, height: box.maxY - box.minY, polygon: normalize(piece.polygon), key: `${piece.id}:${rotation}`};
}
function rectPath(minX: number, minY: number, maxX: number, maxY: number) {
  return toPath([{x: minX, y: minY}, {x: maxX, y: minY}, {x: maxX, y: maxY}, {x: minX, y: maxY}], true);
}
const quantizedUp = (value: number) => Math.ceil(value * SCALE) / SCALE;
const quantizedDown = (value: number) => Math.floor(value * SCALE) / SCALE;
function regionFor(sheet: number, placed: Placement[], config: Required<Pick<NestingConfig, 'sheetWidthMm' | 'sheetHeightMm' | 'edgeMarginMm'>>, errors: ReadonlyMap<string, number>): SheetRegion {
  const usedHeight = Math.max(0, ...placed.map(piece => piece.y + piece.height));
  const usedWidth = Math.max(0, ...placed.map(piece => piece.x + piece.width));
  const bufferedHeight = Math.max(0, ...placed.map(piece => piece.y + piece.height + (errors.get(piece.pieceId) ?? 0) + rotationGridError(piece.rotation)));
  const fraction = FRACTIONS.find(value => bufferedHeight + config.edgeMarginMm <= config.sheetHeightMm * value + 1e-7) ?? 1;
  return {sheet, fraction, width: config.sheetWidthMm, height: config.sheetHeightMm * fraction, usedHeight, usedWidth};
}
export function finalize(sheets: Placement[][], pieces: readonly Piece[], config: NestingConfig): NestingResult {
  const edgeMarginMm = config.edgeMarginMm ?? 20;
  const ordered = [...sheets].sort((a, b) => {
    const ah = Math.max(0, ...a.map(p => p.y + p.height)), bh = Math.max(0, ...b.map(p => p.y + p.height));
    return bh - ah || a[0].pieceId.localeCompare(b[0].pieceId);
  });
  const placements = ordered.flatMap((sheet, index) => sheet.map(placement => ({...placement, sheet: index})));
  const errors = new Map(pieces.map(piece => [piece.id, piece.approximationErrorMm]));
  const regions = ordered.map((sheet, index) => regionFor(index, sheet, {...config, edgeMarginMm}, errors));
  const netAreaMm2 = pieces.reduce((sum, piece) => sum + polygonArea(piece.polygon), 0);
  const area = config.sheetWidthMm * config.sheetHeightMm;
  return {
    placements, hierarchy: buildPlacementHierarchy(placements), regions, sheetCount: ordered.length, netAreaMm2,
    usedMaterialSheets: netAreaMm2 / area, fullSheets: ordered.length,
    sharedQuarterSheets: Math.max(0, ordered.length - 1) + (regions.at(-1)?.fraction ?? 0),
    limited: false, error: null, engineVersion: EMPTY_VERSION,
  };
}
export function validPosition(candidate: Polygon, shape: OrientedPiece, x: number, y: number, placed: readonly Placement[], shapes: ReadonlyMap<string, OrientedPiece>, config: NestingConfig): boolean {
  const edge = config.edgeMarginMm ?? 20, error = shape.approximationErrorMm;
  if (x < edge + error - 1e-7 || y < edge + error - 1e-7 || x + shape.width > config.sheetWidthMm - edge - error + 1e-7 || y + shape.height > config.sheetHeightMm - edge - error + 1e-7) return false;
  for (const other of placed) {
    const otherShape = shapes.get(`${other.pieceId}:${other.rotation}`)!;
    const clearance = config.gapMm + error + otherShape.approximationErrorMm;
    if (x + shape.width + clearance <= other.x + 1e-7 || other.x + other.width + clearance <= x + 1e-7 ||
      y + shape.height + clearance <= other.y + 1e-7 || other.y + other.height + clearance <= y + 1e-7) continue;
    if (materialOverlaps(candidate, other.polygon)) return false;
    if (clearance > 0 && minimumBoundaryDistance(candidate, other.polygon) + 1e-7 < clearance) return false;
  }
  return true;
}
export function parentFor(shape: OrientedPiece, x: number, y: number, placed: readonly Placement[], shapes: ReadonlyMap<string, OrientedPiece>, config: NestingConfig): Pick<Candidate, 'parentPieceId' | 'parentHoleIndex'> {
  for (const other of placed) {
    const original = shapes.get(`${other.pieceId}:${other.rotation}`)!;
    const clearance = config.gapMm + shape.approximationErrorMm + original.approximationErrorMm;
    for (const [index, hole] of original.polygon.holes.entries()) {
      if (fitsInside(hole, shape.polygon, x - other.x, y - other.y, clearance)) return {parentPieceId: other.pieceId, parentHoleIndex: index};
    }
  }
  return {};
}
function candidates(shape: OrientedPiece, placed: readonly Placement[], shapes: ReadonlyMap<string, OrientedPiece>, config: NestingConfig, generator: NFPGenerator): Candidate[] {
  const edge = config.edgeMarginMm ?? 20, error = shape.approximationErrorMm;
  const minX = quantizedUp(edge + error), minY = quantizedUp(edge + error);
  const maxX = quantizedDown(config.sheetWidthMm - edge - error - shape.width), maxY = quantizedDown(config.sheetHeightMm - edge - error - shape.height);
  if (maxX < minX || maxY < minY) return [];
  const points: Candidate[] = [{x: minX, y: minY}, {x: maxX, y: minY}, {x: minX, y: maxY}, {x: maxX, y: maxY}];
  if (!placed.length) return points;
  const holePoints: Candidate[] = [];
  for (const other of placed) {
    const otherShape = shapes.get(`${other.pieceId}:${other.rotation}`)!;
    const clearance = config.gapMm + error + otherShape.approximationErrorMm;
    for (const [index, hole] of otherShape.polygon.holes.entries()) {
      const holeBox = bounds(hole.outer);
      if (shape.width + 2 * clearance > holeBox.maxX - holeBox.minX + 1e-7 || shape.height + 2 * clearance > holeBox.maxY - holeBox.minY + 1e-7) continue;
      const ifp = calculateIFP(hole, shape.polygon, clearance, generator, `${otherShape.key}:hole:${index}`, shape.key);
      for (const pose of ifp.points) holePoints.push({x: pose.x + other.x, y: pose.y + other.y, parentPieceId: other.pieceId, parentHoleIndex: index});
    }
  }
  const fittingHoles = holePoints.filter(({x, y}) => x >= minX - 1e-7 && x <= maxX + 1e-7 && y >= minY - 1e-7 && y <= maxY + 1e-7 &&
    validPosition(translatePolygon(shape.polygon, x, y), shape, x, y, placed, shapes, config));
  if (fittingHoles.length) return fittingHoles.sort(gravityRanker(shape, placed, config));
  const obstacles: Paths64 = [];
  for (const other of placed) {
    const otherShape = shapes.get(`${other.pieceId}:${other.rotation}`)!;
    const clearance = config.gapMm + error + otherShape.approximationErrorMm;
    const nfp = generator.generate(otherShape.polygon, shape.polygon, clearance, otherShape.key, shape.key);
    const shifted = translatePaths(nfp, other.x, other.y);
    obstacles.push(...shifted);
    for (const path of shifted) for (const vertex of path) points.push({x: vertex.x / SCALE, y: vertex.y / SCALE});
  }
  const forbidden = union(obstacles, FillRule.NonZero);
  const free = difference([rectPath(minX, minY, maxX, maxY)], forbidden, FillRule.NonZero);
  for (const polygon of fromPaths(free)) {
    for (const [ring, isHole] of [[polygon.outer, false], ...polygon.holes.map(hole => [hole.outer, true] as const)] as const) {
      const winding = Math.sign(signedArea(ring));
      for (let index = 0; index < ring.length; index++) {
        const a = ring[(index + ring.length - 1) % ring.length], b = ring[index], c = ring[(index + 1) % ring.length];
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        // A convex obstacle corner is a reflex vertex of the surrounding free area.
        points.push({...b, freeConcave: isHole ? cross * winding > 1e-7 : cross * winding < -1e-7});
      }
    }
  }
  const unique = new Map<string, Candidate>();
  for (const p of points) {
    const x = Math.round(p.x * SCALE) / SCALE, y = Math.round(p.y * SCALE) / SCALE;
    if (x < minX - 1e-7 || y < minY - 1e-7 || x > maxX + 1e-7 || y > maxY + 1e-7) continue;
    const key = `${Math.round(x * SCALE)}:${Math.round(y * SCALE)}`;
    const prior = unique.get(key);
    if (!prior) unique.set(key, {...p, x, y});
    else if (p.freeConcave) prior.freeConcave = true;
  }
  return [...unique.values()].sort(gravityRanker(shape, placed, config));
}
export class BottomLeftPlacer {
  constructor(private readonly config: NestingConfig, private readonly generator: NFPGenerator) {}
  pack(pieces: readonly Piece[], genes: readonly Gene[]): NestingResult {
    const shapes = new Map<string, OrientedPiece>();
    for (const piece of pieces) for (const rotation of this.config.rotations ?? [0, 90, 180, 270]) shapes.set(`${piece.id}:${rotation}`, rotatePiece(piece, rotation));
    const sheets: Placement[][] = [];
    const areas = new Map(pieces.map(piece => [piece.id, polygonArea(piece.polygon)]));
    const orderedGenes = [...genes].sort((a, b) => (areas.get(b.id) ?? 0) - (areas.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    for (const gene of orderedGenes) {
      const shape = shapes.get(`${gene.id}:${gene.rotation}`);
      if (!shape) throw new Error(`Rotación o pieza desconocida: ${gene.id}.`);
      let placed = false;
      for (let sheetIndex = 0; sheetIndex <= sheets.length && !placed; sheetIndex++) {
        const sheet = sheets[sheetIndex] ?? [];
        const poses = candidates(shape, sheet, shapes, this.config, this.generator);
        for (const pose of poses) {
          const {x, y} = pose;
          const polygon = translatePolygon(shape.polygon, x, y);
          if (!validPosition(polygon, shape, x, y, sheet, shapes, this.config)) continue;
          const parent = pose.parentPieceId ? pose : parentFor(shape, x, y, sheet, shapes, this.config);
          const placement: Placement = {pieceId: shape.id, sheet: sheetIndex, x, y, width: shape.width, height: shape.height, rotation: shape.rotation, polygon, ...parent};
          if (sheetIndex === sheets.length) sheets.push([placement]); else sheet.push(placement);
          placed = true; break;
        }
      }
      if (!placed) throw new Error(`No se encontró posición certificada para ${gene.id}.`);
    }
    return finalize(sheets, pieces, this.config);
  }
}
export function baseline(pieces: readonly Piece[], config: NestingConfig): NestingResult {
  const edge = config.edgeMarginMm ?? 20, rotations = config.rotations ?? [0, 90, 180, 270];
  const sheets: Placement[][] = [];
  const shapes = new Map<string, OrientedPiece>();
  for (const piece of pieces) for (const rotation of rotations) shapes.set(`${piece.id}:${rotation}`, rotatePiece(piece, rotation));
  const errorFor = (placement: Placement) => shapes.get(`${placement.pieceId}:${placement.rotation}`)!.approximationErrorMm;
  const holeGenerator = new NFPGenerator(100_000, 2048);
  let ifpBudgetAvailable = true;
  for (const piece of [...pieces].sort(byDescendingArea)) {
    const options = rotations.map(rotation => shapes.get(`${piece.id}:${rotation}`)!);
    const fits = options.filter(shape => shape.width + 2 * (edge + shape.approximationErrorMm) <= config.sheetWidthMm + 1e-7 && shape.height + 2 * (edge + shape.approximationErrorMm) <= config.sheetHeightMm + 1e-7);
    if (!fits.length) {
      const impossible = options.every(shape => shape.width - 2 * piece.approximationErrorMm + 2 * edge > config.sheetWidthMm + 1e-7 || shape.height - 2 * piece.approximationErrorMm + 2 * edge > config.sheetHeightMm + 1e-7);
      return {...finalize([], pieces, config), error: impossible ? `La pieza ${piece.id} no cabe en la hoja completa.` : `No se pudo certificar el encaje de ${piece.id} con esta tolerancia.`, ...(impossible ? {unplaceable: {pieceId: piece.id, reason: 'No cabe en ninguna rotación con el margen exterior.', orientations: options.map(shape => ({rotation: shape.rotation, width: shape.width, height: shape.height}))}} : {})};
    }
    fits.sort((a, b) => a.height - b.height || a.width - b.width || a.rotation - b.rotation);
    let position: {shape: OrientedPiece; x: number; y: number; sheet: number; parentPieceId?: string; parentHoleIndex?: number} | null = null;
    for (let sheetIndex = 0; sheetIndex < sheets.length && !position; sheetIndex++) {
      const placed = sheets[sheetIndex];
      for (const shape of fits) {
        for (const other of placed) {
          const parent = shapes.get(`${other.pieceId}:${other.rotation}`)!;
          const clearance = config.gapMm + shape.approximationErrorMm + parent.approximationErrorMm;
          for (const [holeIndex, hole] of parent.polygon.holes.entries()) {
            const box = bounds(hole.outer);
            if (shape.width + 2 * clearance > box.maxX - box.minX + 1e-7 || shape.height + 2 * clearance > box.maxY - box.minY + 1e-7) continue;
            const left = box.minX + clearance, right = box.maxX - shape.width - clearance;
            const top = box.minY + clearance, bottom = box.maxY - shape.height - clearance;
            for (const localY of [top, (top + bottom) / 2, bottom]) {
              for (const localX of [left, (left + right) / 2, right]) {
                if (!fitsInside(hole, shape.polygon, localX, localY, clearance)) continue;
                const x = other.x + localX, y = other.y + localY;
                if (validPosition(translatePolygon(shape.polygon, x, y), shape, x, y, placed, shapes, config)) {
                  position = {shape, x, y, sheet: sheetIndex, parentPieceId: other.pieceId, parentHoleIndex: holeIndex};
                  break;
                }
              }
              if (position) break;
            }
            if (position) break;
            // Exact IFP remains available for modest outlines. In the fast
            // layout, triangulating a detailed logo against every mobile
            // shape can consume the entire UI time budget.
            const complexity = boundarySize(parent.polygon) + boundarySize(shape.polygon);
            if (complexity > 160) continue;
            if (!ifpBudgetAvailable) continue;
            try {
              const ifp = calculateIFP(hole, shape.polygon, clearance, holeGenerator, `${parent.key}:hole:${holeIndex}`, shape.key);
              for (const point of ifp.points) {
                const x = other.x + point.x, y = other.y + point.y;
                const candidate = translatePolygon(shape.polygon, x, y);
                if (validPosition(candidate, shape, x, y, placed, shapes, config)) {
                  position = {shape, x, y, sheet: sheetIndex, parentPieceId: other.pieceId, parentHoleIndex: holeIndex};
                  break;
                }
              }
            } catch (error) {
              if (!(error instanceof WorkLimitError)) throw error;
              ifpBudgetAvailable = false;
            }
            if (position) break;
          }
          if (position) break;
        }
        if (position) break;
      }
    }
    // Rank every reflex-corner pose before spending time on exact collision
    // checks. This reaches deep pockets even when the parent has many vertices.
    for (let sheetIndex = 0; sheetIndex < sheets.length && !position; sheetIndex++) {
      const placed = sheets[sheetIndex];
      for (const shape of fits) {
        const poses = new Map<string, Candidate>();
        for (const other of placed) {
          const ring = other.polygon.outer, winding = Math.sign(signedArea(ring));
          const clearance = config.gapMm + shape.approximationErrorMm + errorFor(other);
          for (let index = 0; index < ring.length; index++) {
            const a = ring[(index + ring.length - 1) % ring.length], b = ring[index], c = ring[(index + 1) % ring.length];
            const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
            const reflex = cross * winding < -1e-7;
            const edgeLength = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y);
            if (!reflex && (edgeLength <= 1e-7 || cross * winding / edgeLength < 0.25)) continue;
            for (const x of [b.x + clearance, b.x - shape.width - clearance]) {
              for (const y of [b.y + clearance, b.y - shape.height - clearance]) {
                const error = shape.approximationErrorMm;
                if (x < edge + error - 1e-7 || y < edge + error - 1e-7 ||
                    x + shape.width > config.sheetWidthMm - edge - error + 1e-7 ||
                    y + shape.height > config.sheetHeightMm - edge - error + 1e-7) continue;
                const key = `${Math.round(x * SCALE)}:${Math.round(y * SCALE)}`;
                const prior = poses.get(key);
                if (!prior) poses.set(key, {x, y, freeConcave: reflex});
                else if (reflex) prior.freeConcave = true;
              }
            }
          }
        }
        const ranked = [...poses.values()].sort(gravityRanker(shape, placed, config));
        const checks = shape.width * shape.height < config.sheetWidthMm * config.sheetHeightMm * 0.03 ? 12 : 4;
        for (const {x, y} of ranked.slice(0, checks)) {
          const candidate = translatePolygon(shape.polygon, x, y);
          if (!validPosition(candidate, shape, x, y, placed, shapes, config)) continue;
          position = {shape, x, y, sheet: sheetIndex, ...parentFor(shape, x, y, placed, shapes, config)};
          break;
        }
        if (position) break;
      }
    }
    for (let sheetIndex = 0; sheetIndex < sheets.length && !position; sheetIndex++) {
      const placed = sheets[sheetIndex];
      for (const shape of fits) {
        const error = shape.approximationErrorMm;
        const xs = [edge + error, ...placed.map(other => other.x + other.width + config.gapMm + error + errorFor(other))];
        const ys = [edge + error, ...placed.map(other => other.y + other.height + config.gapMm + error + errorFor(other))];
        for (const y of ys) for (const x of xs) {
          if (x + shape.width > config.sheetWidthMm - edge - error + 1e-7 || y + shape.height > config.sheetHeightMm - edge - error + 1e-7) continue;
          const separated = placed.every(other => {
            const clearance = config.gapMm + error + errorFor(other);
            return x + shape.width + clearance <= other.x + 1e-7 || other.x + other.width + clearance <= x + 1e-7 ||
              y + shape.height + clearance <= other.y + 1e-7 || other.y + other.height + clearance <= y + 1e-7;
          });
          if (separated && (!position || y < position.y - 1e-7 || Math.abs(y - position.y) <= 1e-7 && x < position.x - 1e-7)) position = {shape, x, y, sheet: sheetIndex};
        }
      }
    }
    if (!position) position = {shape: fits[0], x: edge + fits[0].approximationErrorMm, y: edge + fits[0].approximationErrorMm, sheet: sheets.length};
    const {shape, x, y, sheet, parentPieceId, parentHoleIndex} = position;
    const placement: Placement = {pieceId: shape.id, sheet, x, y, width: shape.width, height: shape.height, rotation: shape.rotation, polygon: translatePolygon(shape.polygon, x, y), ...(parentPieceId ? {parentPieceId, parentHoleIndex} : {})};
    if (sheet === sheets.length) sheets.push([placement]); else sheets[sheet].push(placement);
  }
  return finalize(sheets, pieces, config);
}
