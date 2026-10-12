import {GeneticOptimizer} from './GeneticOptimizer.ts';
import {baseline} from './BottomLeftPlacer.ts';
import {improveFastLayout} from './FastPocketOptimizer.ts';
import {improveRasterLayout} from './RasterOptimizer.ts';
import {boundaryRings, cleanRing, polygonArea, triangulatePolygon} from './PolygonOperations.ts';
import type {NestingConfig, NestingResult, Piece, ProgressEvent, Rotation} from './types.ts';

const empty = (error: string): NestingResult => ({placements: [], hierarchy: [], regions: [], sheetCount: 0, netAreaMm2: 0, usedMaterialSheets: 0, fullSheets: 0, sharedQuarterSheets: 0, limited: false, error, engineVersion: 'nfp-ga-v1'});
const FAST_REPAIR_BUDGET_MS = 30_000;
const REPACK_BUDGET_MS = 60_000;
function fastScore(result: NestingResult, pieces: readonly Piece[], sheetArea: number): number[] {
  const areaById = new Map(pieces.map(piece => [piece.id, polygonArea(piece.polygon)]));
  const largeDiagonalArea = result.placements.reduce((sum, item) =>
    item.rotation % 90 !== 0 && (areaById.get(item.pieceId) ?? 0) > sheetArea * 0.03
      ? sum + (areaById.get(item.pieceId) ?? 0) : sum, 0);
  return [
    result.sheetCount,
    result.regions.reduce((sum, region) => sum + region.fraction, 0),
    largeDiagonalArea,
    result.regions.reduce((sum, region) => sum + region.usedHeight, 0),
    result.regions.reduce((sum, region) => sum + region.usedWidth, 0),
  ];
}
function betterFastLayout(candidate: NestingResult, current: NestingResult, pieces: readonly Piece[], sheetArea: number): boolean {
  if (candidate.error) return false;
  if (current.error) return true;
  const a = fastScore(candidate, pieces, sheetArea), b = fastScore(current, pieces, sheetArea);
  for (let index = 0; index < a.length; index++) if (Math.abs(a[index] - b[index]) > 1e-7) return a[index] < b[index];
  return false;
}
export class NestingEngine {
  static runSync(pieces: readonly Piece[], config: NestingConfig, onProgress?: (progress: ProgressEvent) => void, deadlineMs = performance.now() + 170_000): NestingResult {
    try {
      const width = config.sheetWidthMm, height = config.sheetHeightMm, edge = config.edgeMarginMm ?? 20;
      if (![width, height, edge, config.gapMm].every(Number.isFinite) || width <= 2 * edge || height <= 2 * edge || edge < 0 || config.gapMm < 0) throw new Error('Dimensiones de hoja, margen o separación inválidos.');
      if (!pieces.length || pieces.length > 100) throw new Error('Carga entre 1 y 100 piezas.');
      if (new Set(pieces.map(piece => piece.id)).size !== pieces.length) throw new Error('Cada pieza necesita un ID único.');
      const rotations: readonly Rotation[] = config.rotations ?? Array.from({length: 24}, (_, index) => index * 15);
      if (!rotations.length || rotations.some(rotation => !Number.isFinite(rotation) || rotation < 0 || rotation >= 360) || new Set(rotations).size !== rotations.length) throw new Error('Lista de rotaciones inválida.');
      if (![config.populationSize ?? 16, config.generations ?? 30, config.maxTrianglePairs ?? 500_000, config.maxBooleanOps ?? 4096].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Presupuesto genético o geométrico inválido.');
      for (const piece of pieces) {
        if (!piece.id || !Number.isFinite(piece.approximationErrorMm) || piece.approximationErrorMm < 0) throw new Error(`Datos inválidos de la pieza ${piece.id}.`);
        boundaryRings(piece.polygon).forEach(cleanRing);
        if (polygonArea(piece.polygon) <= 0) throw new Error(`La pieza ${piece.id} no contiene materia.`);
        triangulatePolygon(piece.polygon);
      }
      const vertices = pieces.reduce((count, piece) => count + boundaryRings(piece.polygon).reduce((sum, ring) => sum + ring.length, 0), 0);
      if (pieces.length > 40 || vertices > 1_500) {
        const fastRotations = rotations.length > 6 ? rotations.filter(rotation => [0, 45, 90, 135, 180, 270].includes(rotation)) : rotations;
        const trialRotations = fastRotations.length ? fastRotations : rotations;
        const rightAngleRotations = trialRotations.filter(rotation => rotation % 90 === 0);
        let result = baseline(pieces, {...config, edgeMarginMm: edge, rotations: trialRotations});
        const areas = new Map(pieces.map(piece => [piece.id, polygonArea(piece.polygon)]));
        const largeDiagonal = result.placements.some(item => item.rotation % 90 !== 0 &&
          (areas.get(item.pieceId) ?? 0) > width * height * 0.03);
        if (rightAngleRotations.length && rightAngleRotations.length < trialRotations.length &&
            (result.error || (largeDiagonal && performance.now() < deadlineMs - FAST_REPAIR_BUDGET_MS))) {
          const upright = baseline(pieces, {...config, edgeMarginMm: edge, rotations: rightAngleRotations});
          if (betterFastLayout(upright, result, pieces, width * height)) result = upright;
        }
        if (result.error) return result;
        const repackDeadline = Math.min(deadlineMs - Math.min(15_000, Math.max(0, deadlineMs - performance.now()) / 4), performance.now() + REPACK_BUDGET_MS);
        try { result = improveRasterLayout(pieces, {...config, edgeMarginMm: edge}, result, rotations, repackDeadline, onProgress); }
        catch { /* Keep the complete certified layout if repacking fails. */ }
        let improved = result;
        const repairDeadline = Math.min(deadlineMs, performance.now() + FAST_REPAIR_BUDGET_MS);
        try { improved = improveFastLayout(pieces, {...config, edgeMarginMm: edge}, result, rotations, repairDeadline, onProgress); }
        catch { /* The certified initial layout remains usable if refinement fails. */ }
        return {...improved, limited: true, method: 'fast'};
      }
      return new GeneticOptimizer({...config, edgeMarginMm: edge, rotations}).optimize(pieces, onProgress);
    } catch (error) { return empty(error instanceof Error ? error.message : String(error)); }
  }
  static async run(pieces: readonly Piece[], config: NestingConfig, onProgress?: (progress: ProgressEvent) => void): Promise<NestingResult> {
    return NestingEngine.runSync(pieces, config, onProgress);
  }
}
