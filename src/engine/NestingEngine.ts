import {GeneticOptimizer} from './GeneticOptimizer.ts';
import {baseline} from './BottomLeftPlacer.ts';
import {improveFastLayout} from './FastPocketOptimizer.ts';
import {boundaryRings, cleanRing, polygonArea, triangulatePolygon} from './PolygonOperations.ts';
import type {NestingConfig, NestingResult, Piece, ProgressEvent, Rotation} from './types.ts';

const empty = (error: string): NestingResult => ({placements: [], hierarchy: [], regions: [], sheetCount: 0, netAreaMm2: 0, usedMaterialSheets: 0, fullSheets: 0, sharedQuarterSheets: 0, limited: false, error, engineVersion: 'nfp-ga-v1'});
export class NestingEngine {
  static runSync(pieces: readonly Piece[], config: NestingConfig, onProgress?: (progress: ProgressEvent) => void, deadlineMs = performance.now() + 110_000): NestingResult {
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
        const result = baseline(pieces, {...config, edgeMarginMm: edge, rotations: fastRotations.length ? fastRotations : rotations});
        if (result.error) return result;
        let improved = result;
        try { improved = improveFastLayout(pieces, {...config, edgeMarginMm: edge}, result, rotations, deadlineMs, onProgress); }
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
