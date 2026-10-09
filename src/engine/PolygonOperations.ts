import {ClipType, EndType, FillRule, JoinType, PolyTree64, booleanOpWithPolyTree, difference, inflatePaths, intersect, union, xor, type Path64, type Paths64, type Point64} from 'clipper2-ts';
import earcut from 'earcut';
import type {Point, Polygon, Ring} from './types.ts';

export const SCALE = 10_000;
const EPS = 1e-7;

export function signedArea(ring: readonly Point[]): number {
  return ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}
export function polygonArea(polygon: Polygon): number {
  return Math.abs(signedArea(polygon.outer)) - polygon.holes.reduce((sum, hole) => sum + polygonArea(hole), 0);
}
/** Area-weighted centroid of material, subtracting each nested void. */
export function polygonCentroid(polygon: Polygon): Point {
  const ring = polygon.outer;
  let twiceArea = 0, momentX = 0, momentY = 0;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index], b = ring[(index + 1) % ring.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    momentX += (a.x + b.x) * cross;
    momentY += (a.y + b.y) * cross;
  }
  const outerArea = Math.abs(twiceArea) / 2;
  let weightedX = outerArea * momentX / (3 * twiceArea);
  let weightedY = outerArea * momentY / (3 * twiceArea);
  let materialArea = outerArea;
  for (const hole of polygon.holes) {
    const area = polygonArea(hole), center = polygonCentroid(hole);
    materialArea -= area;
    weightedX -= area * center.x;
    weightedY -= area * center.y;
  }
  if (materialArea <= EPS) throw new Error('La pieza no contiene materia para calcular su centroide.');
  return {x: weightedX / materialArea, y: weightedY / materialArea};
}
export function boundaryRings(polygon: Polygon): Ring[] {
  return [polygon.outer, ...polygon.holes.flatMap(boundaryRings)];
}
export function bounds(ring: readonly Point[]) {
  return {
    minX: Math.min(...ring.map(point => point.x)),
    minY: Math.min(...ring.map(point => point.y)),
    maxX: Math.max(...ring.map(point => point.x)),
    maxY: Math.max(...ring.map(point => point.y)),
  };
}
export function cleanRing(ring: Ring): Ring {
  const result: Ring = [];
  for (const point of ring) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('El contorno contiene coordenadas no finitas.');
    if (!result.length || Math.hypot(point.x - result.at(-1)!.x, point.y - result.at(-1)!.y) > EPS) result.push({...point});
  }
  if (result.length > 1 && Math.hypot(result[0].x - result.at(-1)!.x, result[0].y - result.at(-1)!.y) <= EPS) result.pop();
  if (result.length < 3 || Math.abs(signedArea(result)) <= EPS) throw new Error('El contorno no encierra una región válida.');
  return result;
}
function integer(value: number): number {
  const result = Math.round(value * SCALE);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 1e12) throw new Error('La geometría supera el rango numérico admitido.');
  return result;
}
export function toPath(ring: readonly Point[], positive: boolean): Path64 {
  const ordered = (signedArea(ring) > 0) === positive ? ring : [...ring].reverse();
  return ordered.map(({x, y}) => ({x: integer(x), y: integer(y)}));
}
export function toPaths(polygons: readonly Polygon[]): Paths64 {
  const paths: Paths64 = [];
  const append = (polygon: Polygon, positive: boolean) => {
    paths.push(toPath(polygon.outer, positive));
    polygon.holes.forEach(hole => append(hole, !positive));
  };
  polygons.forEach(polygon => append(polygon, true));
  return paths;
}
export function fromPath(path: Path64): Ring { return path.map(({x, y}) => ({x: x / SCALE, y: y / SCALE})); }
export function normalize(polygons: readonly Polygon[]): Polygon[] {
  return fromPaths(union(toPaths(polygons), FillRule.NonZero));
}
export function fromPaths(paths: Paths64): Polygon[] {
  if (!paths.length) return [];
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Union, paths, null, tree, FillRule.NonZero);
  return treeToPolygons(tree);
}
export function filledRings(rings: readonly Ring[], rule: 'evenodd' | 'nonzero'): Polygon[] {
  // Shoelace sign gives each contour's winding contribution. Containment gives
  // the cumulative winding at each depth; a boundary is kept only when the
  // SVG fill state changes across it.
  const contours = rings.map(ring => ({ring: cleanRing(ring), area: signedArea(ring), parent: -1, depth: 1, winding: 0, outer: false, hole: false}));
  const ordered = contours.map((_, index) => index).sort((a, b) => Math.abs(contours[b].area) - Math.abs(contours[a].area));
  for (const [position, index] of ordered.entries()) {
    const contour = contours[index];
    contour.parent = ordered.slice(0, position).reverse().find(candidate => pointInRing(contour.ring[0], contours[candidate].ring)) ?? -1;
    const parent = contour.parent < 0 ? null : contours[contour.parent];
    contour.depth = (parent?.depth ?? 0) + 1;
    const outsideWinding = parent?.winding ?? 0;
    contour.winding = outsideWinding + Math.sign(contour.area);
    const outsideFilled = rule === 'evenodd' ? (contour.depth - 1) % 2 === 1 : outsideWinding !== 0;
    const insideFilled = rule === 'evenodd' ? contour.depth % 2 === 1 : contour.winding !== 0;
    contour.outer = !outsideFilled && insideFilled;
    contour.hole = outsideFilled && !insideFilled;
  }
  const result: Polygon[] = [], byContour = new Map<number, Polygon>();
  for (const index of ordered) if (contours[index].outer) {
    const polygon: Polygon = {outer: contours[index].ring, holes: []};
    byContour.set(index, polygon); result.push(polygon);
  }
  for (const index of ordered) if (contours[index].hole) {
    let parent = contours[index].parent;
    while (parent >= 0 && !byContour.has(parent)) parent = contours[parent].parent;
    if (parent < 0) throw new Error('Agujero SVG sin contorno exterior.');
    byContour.get(parent)!.holes.push({outer: contours[index].ring, holes: []});
  }
  return normalize(result);
}
function treeToPolygons(tree: PolyTree64): Polygon[] {
  const polygons: Polygon[] = [];
  const visit = (node: PolyTree64 | ReturnType<PolyTree64['child']>) => {
    if (node.poly && !node.isHole) {
      polygons.push({outer: fromPath(node.poly), holes: Array.from({length: node.count}, (_, index) => node.child(index)).filter(child => child.isHole && child.poly).map(child => ({outer: fromPath(child.poly!), holes: []}))});
    }
    for (let index = 0; index < node.count; index++) visit(node.child(index));
  };
  visit(tree);
  return polygons;
}
export function polygonUnion(polygons: readonly Polygon[]): Polygon[] { return fromPaths(union(toPaths(polygons), FillRule.NonZero)); }
export function polygonIntersection(a: readonly Polygon[], b: readonly Polygon[]): Polygon[] { return fromPaths(intersect(toPaths(a), toPaths(b), FillRule.NonZero)); }
export function polygonDifference(a: readonly Polygon[], b: readonly Polygon[]): Polygon[] { return fromPaths(difference(toPaths(a), toPaths(b), FillRule.NonZero)); }
export function polygonOffset(polygons: readonly Polygon[], distanceMm: number): Polygon[] {
  if (!Number.isFinite(distanceMm)) throw new Error('Offset inválido.');
  return fromPaths(inflatePaths(toPaths(polygons), Math.ceil(distanceMm * SCALE), JoinType.Round, EndType.Polygon, 2, 0.01 * SCALE));
}
export function triangulatePolygon(polygon: Polygon): Path64[] {
  const source = [toPath(polygon.outer, true), ...polygon.holes.map(hole => toPath(hole.outer, false))];
  const coordinates: number[] = [], vertices: Point64[] = [], holeIndices: number[] = [];
  for (const [index, path] of source.entries()) {
    if (index) holeIndices.push(vertices.length);
    for (const vertex of path) {
      vertices.push(vertex);
      coordinates.push(vertex.x, vertex.y);
    }
  }
  const indices = earcut(coordinates, holeIndices, 2);
  const solution: Path64[] = [];
  for (let index = 0; index < indices.length; index += 3) {
    solution.push([vertices[indices[index]], vertices[indices[index + 1]], vertices[indices[index + 2]]]);
  }
  if (!solution.length) throw new Error('No se pudo triangular la pieza.');
  if (xor(source, union(solution, FillRule.NonZero), FillRule.NonZero).length) throw new Error('La triangulación no reconstruye la pieza.');
  return solution;
}
export function translatePaths(paths: Paths64, x: number, y: number): Paths64 {
  const dx = integer(x), dy = integer(y);
  return paths.map(path => path.map(point => ({x: point.x + dx, y: point.y + dy})));
}
export function translatePolygon(polygon: Polygon, x: number, y: number): Polygon {
  const move = (ring: Ring) => ring.map(point => ({x: point.x + x, y: point.y + y}));
  return {outer: move(polygon.outer), holes: polygon.holes.map(hole => translatePolygon(hole, x, y))};
}
export function pointInRing(point: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index], b = ring[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (u: Point, v: Point) => u.x * v.y - u.y * v.x;
  const ab = {x: b.x - a.x, y: b.y - a.y}, cd = {x: d.x - c.x, y: d.y - c.y}, ac = {x: c.x - a.x, y: c.y - a.y};
  const denominator = cross(ab, cd);
  if (Math.abs(denominator) > EPS) {
    const t = cross(ac, cd) / denominator, u = cross(ac, ab) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
export function minimumBoundaryDistance(a: Polygon, b: Polygon): number {
  let distance = Infinity;
  for (const first of boundaryRings(a)) for (const second of boundaryRings(b)) {
    for (let i = 0; i < first.length; i++) for (let j = 0; j < second.length; j++) {
      distance = Math.min(distance, segmentDistance(first[i], first[(i + 1) % first.length], second[j], second[(j + 1) % second.length]));
    }
  }
  return distance;
}
export function materialOverlaps(a: Polygon, b: Polygon): boolean {
  return polygonIntersection([a], [b]).some(polygon => polygonArea(polygon) > 1 / (SCALE * SCALE));
}
export function convexHull(points: Point64[]): Path64 {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point64, a: Point64, b: Point64) => BigInt(a.x - o.x) * BigInt(b.y - o.y) - BigInt(a.y - o.y) * BigInt(b.x - o.x);
  const lower: Point64[] = [], upper: Point64[] = [];
  for (const point of sorted) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0n) lower.pop(); lower.push(point); }
  for (const point of sorted.reverse()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0n) upper.pop(); upper.push(point); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
