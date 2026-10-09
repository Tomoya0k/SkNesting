import {FillRule, difference, union, type Paths64} from 'clipper2-ts';
import {NFPGenerator} from './NFPGenerator.ts';
import {SCALE, boundaryRings, bounds, fromPaths, minimumBoundaryDistance, polygonArea, polygonDifference, toPath, translatePolygon} from './PolygonOperations.ts';
import type {Point, Polygon} from './types.ts';

export interface InnerFitResult {
  /** Feasible translation region for the mobile polygon, in container coordinates. */
  regions: Polygon[];
  /** Region vertices, plus valid zero-area fits such as an exact point fit. */
  points: Point[];
}

function rectangle(minX: number, minY: number, maxX: number, maxY: number): Polygon {
  return {outer: [{x: minX, y: minY}, {x: maxX, y: minY}, {x: maxX, y: maxY}, {x: minX, y: maxY}], holes: []};
}

export function fitsInside(container: Polygon, mobile: Polygon, x: number, y: number, clearanceMm: number): boolean {
  const placed = translatePolygon(mobile, x, y);
  const outside = polygonDifference([placed], [container]);
  if (outside.some(polygon => polygonArea(polygon) > 1 / (SCALE * SCALE))) return false;
  return clearanceMm <= 0 || minimumBoundaryDistance(placed, container) + 1e-7 >= clearanceMm;
}

/**
 * IFP = D \ ((E \ H) ⊕ (-M)), where H is the hole, M is the mobile material,
 * D is its bounding translation domain, and E encloses every M translated by D.
 * The NFP of the complement removes translations that intersect material outside H.
 * All boolean/Minkowski work is on Clipper's 0.0001 mm integer grid.
 */
export function calculateIFP(container: Polygon, mobile: Polygon, clearanceMm: number, generator: NFPGenerator, containerKey: string, mobileKey: string): InnerFitResult {
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0) throw new Error('Separación IFP inválida.');
  const holeBox = bounds(container.outer), mobileBox = bounds(mobile.outer);
  const minX = holeBox.minX - mobileBox.minX, maxX = holeBox.maxX - mobileBox.maxX;
  const minY = holeBox.minY - mobileBox.minY, maxY = holeBox.maxY - mobileBox.maxY;
  if (maxX < minX - 1e-7 || maxY < minY - 1e-7) return {regions: [], points: []};

  const pad = Math.max(mobileBox.maxX - mobileBox.minX, mobileBox.maxY - mobileBox.minY) + clearanceMm + 1;
  const enclosure = rectangle(holeBox.minX - pad, holeBox.minY - pad, holeBox.maxX + pad, holeBox.maxY + pad);
  const outside = polygonDifference([enclosure], [container]);
  const forbidden: Paths64 = [];
  outside.forEach((polygon, index) => forbidden.push(...generator.generate(polygon, mobile, clearanceMm, `${containerKey}:outside:${index}`, mobileKey)));
  const merged = forbidden.length ? union(forbidden, FillRule.NonZero) : [];
  const domain: Paths64 = maxX > minX + 1e-7 && maxY > minY + 1e-7 ? [toPath(rectangle(minX, minY, maxX, maxY).outer, true)] : [];
  const regions = domain.length ? fromPaths(difference(domain, merged, FillRule.NonZero)) : [];
  const proposed: Point[] = [];
  for (const region of regions) for (const ring of boundaryRings(region)) proposed.push(...ring);
  const xs = [minX, maxX, minX + clearanceMm, maxX - clearanceMm, (minX + maxX) / 2];
  const ys = [minY, maxY, minY + clearanceMm, maxY - clearanceMm, (minY + maxY) / 2];
  for (const x of xs) for (const y of ys) proposed.push({x, y});
  const points = new Map<string, Point>();
  for (const candidate of proposed) {
    const x = Math.round(candidate.x * SCALE) / SCALE, y = Math.round(candidate.y * SCALE) / SCALE;
    if (fitsInside(container, mobile, x, y, clearanceMm)) points.set(`${Math.round(x * SCALE)}:${Math.round(y * SCALE)}`, {x, y});
  }
  return {regions, points: [...points.values()].sort((a, b) => a.y - b.y || a.x - b.x)};
}
