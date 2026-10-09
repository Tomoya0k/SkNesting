import {EndType, FillRule, JoinType, inflatePaths, union, type Path64, type Paths64} from 'clipper2-ts';
import {SCALE, convexHull, triangulatePolygon} from './PolygonOperations.ts';
import type {Polygon} from './types.ts';

export class WorkLimitError extends Error { constructor(message: string) { super(message); this.name = 'WorkLimitError'; } }

export class NFPGenerator {
  private trianglePairs = 0;
  private booleanOps = 0;
  private cache = new Map<string, Paths64>();
  private triangles = new Map<string, Path64[]>();
  constructor(private readonly maxTrianglePairs = 500_000, private readonly maxBooleanOps = 4096) {}

  private union(paths: Paths64): Paths64 {
    this.booleanOps++;
    if (this.booleanOps > this.maxBooleanOps) throw new WorkLimitError('Se alcanzó el presupuesto de operaciones geométricas.');
    return union(paths, FillRule.NonZero);
  }
  private triangulation(key: string, polygon: Polygon): Path64[] {
    let value = this.triangles.get(key);
    if (!value) { value = triangulatePolygon(polygon); this.triangles.set(key, value); }
    return value;
  }
  /** Forbidden translations of mobile relative to static, including clearance. */
  generate(staticPolygon: Polygon, mobilePolygon: Polygon, clearanceMm: number, staticKey: string, mobileKey: string): Paths64 {
    const key = `${staticKey}|${mobileKey}|${Math.ceil(clearanceMm * SCALE)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const first = this.triangulation(staticKey, staticPolygon), second = this.triangulation(mobileKey, mobilePolygon);
    const count = first.length * second.length;
    if (count > 100_000 || this.trianglePairs + count > this.maxTrianglePairs) throw new WorkLimitError('La pieza requiere más pares de triángulos que el presupuesto.');
    this.trianglePairs += count;
    const batches: Paths64[] = [];
    let batch: Paths64 = [];
    for (const a of first) for (const b of second) {
      // Minkowski sum of two convex triangles is exactly the hull of their
      // pairwise vertex differences. Unioning every pair restores concavities
      // and the free islands inside holes; no hull of the whole piece is used.
      batch.push(convexHull(a.flatMap(pa => b.map(pb => ({x: pa.x - pb.x, y: pa.y - pb.y})))));
      if (batch.length >= 128) { batches.push(this.union(batch)); batch = []; }
    }
    if (batch.length) batches.push(this.union(batch));
    while (batches.length > 1) {
      const next: Paths64[] = [];
      for (let index = 0; index < batches.length; index += 2) next.push(index + 1 < batches.length ? this.union([...batches[index], ...batches[index + 1]]) : batches[index]);
      batches.splice(0, batches.length, ...next);
    }
    let result = batches[0] ?? [];
    if (clearanceMm > 0) {
      result = inflatePaths(result, Math.ceil(clearanceMm * SCALE), JoinType.Round, EndType.Polygon, 2, 0.005 * SCALE);
      result = this.union(result);
    }
    this.cache.set(key, result);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}
