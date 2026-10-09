import {baseline, BottomLeftPlacer, rotatePiece, type Gene} from './BottomLeftPlacer.ts';
import {NFPGenerator, WorkLimitError} from './NFPGenerator.ts';
import {polygonArea} from './PolygonOperations.ts';
import type {NestingConfig, NestingResult, Piece, ProgressEvent, Rotation} from './types.ts';

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function score(result: NestingResult): number[] {
  return [result.sheetCount, result.regions.at(-1)?.fraction ?? 0, result.regions.reduce((sum, region) => sum + region.usedHeight, 0), result.regions.reduce((sum, region) => sum + region.usedWidth, 0)];
}
function compare(a: NestingResult, b: NestingResult): number {
  const first = score(a), second = score(b);
  for (let index = 0; index < first.length; index++) if (Math.abs(first[index] - second[index]) > 1e-7) return first[index] - second[index];
  return 0;
}
interface Individual { genes: Gene[]; result: NestingResult }
export class GeneticOptimizer {
  constructor(private readonly config: NestingConfig) {}
  optimize(pieces: readonly Piece[], onProgress?: (progress: ProgressEvent) => void): NestingResult {
    let best = baseline(pieces, this.config);
    if (best.error || !pieces.length) return best;
    const rotations = this.config.rotations ?? [0, 90, 180, 270];
    if (pieces.length <= 12) {
      // A coherent orientation can pack a whole word in one row. Greedy
      // per-piece height minimization misses this, even when every glyph fits.
      for (const rotation of rotations.filter(angle => angle % 45 === 0)) {
        const uniform = baseline(pieces, {...this.config, rotations: [rotation]});
        if (!uniform.error && compare(uniform, best) < 0) best = uniform;
      }
    }
    const viable = new Map(pieces.map(piece => [piece.id, rotations.filter(rotation => {
      const shape = rotatePiece(piece, rotation), edge = this.config.edgeMarginMm ?? 20;
      return shape.width + 2 * (edge + shape.approximationErrorMm) <= this.config.sheetWidthMm + 1e-7 && shape.height + 2 * (edge + shape.approximationErrorMm) <= this.config.sheetHeightMm + 1e-7;
    })]));
    const generator = new NFPGenerator(this.config.maxTrianglePairs, this.config.maxBooleanOps);
    const placer = new BottomLeftPlacer(this.config, generator);
    const populationSize = this.config.populationSize ?? 16, generations = this.config.generations ?? 30;
    const seed = this.config.seed ?? pieces.reduce((sum, piece) => { for (const char of piece.id) sum = Math.imul(sum ^ char.charCodeAt(0), 16777619); return sum; }, 2166136261);
    const random = randomGenerator(seed);
    const selectRotation = (id: string): Rotation => { const options = viable.get(id)!; return options[Math.floor(random() * options.length)]; };
    const byArea = [...pieces].sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon) || a.id.localeCompare(b.id));
    const seedOrder = (index: number): Gene[] => {
      return byArea.map(piece => ({id: piece.id, rotation: index === 0 ? viable.get(piece.id)![0] : selectRotation(piece.id)}));
    };
    const evaluate = (genes: Gene[]): Individual | null => {
      try {
        const result = placer.pack(pieces, genes);
        if (compare(result, best) < 0) best = result;
        return {genes, result};
      } catch (error) {
        if (error instanceof WorkLimitError) throw error;
        if (error instanceof Error && error.message.startsWith('No se encontró posición certificada')) return null;
        throw error;
      }
    };
    const tournament = (population: Individual[]) => {
      let winner = population[Math.floor(random() * population.length)];
      for (let index = 0; index < 2; index++) { const challenger = population[Math.floor(random() * population.length)]; if (compare(challenger.result, winner.result) < 0) winner = challenger; }
      return winner;
    };
    const crossover = (first: Gene[], second: Gene[]): Gene[] => {
      if (first.length < 2) return first.map(gene => ({...gene}));
      const a = Math.floor(random() * first.length), b = Math.floor(random() * first.length), lo = Math.min(a, b), hi = Math.max(a, b);
      const result: (Gene | null)[] = Array(first.length).fill(null), seen = new Set<string>();
      for (let index = lo; index <= hi; index++) { result[index] = {...first[index]}; seen.add(first[index].id); }
      let cursor = (hi + 1) % first.length;
      for (let index = 0; index < second.length; index++) {
        const gene = second[(hi + 1 + index) % second.length];
        if (seen.has(gene.id)) continue;
        while (result[cursor]) cursor = (cursor + 1) % result.length;
        result[cursor] = {...gene}; cursor = (cursor + 1) % result.length;
      }
      return result as Gene[];
    };
    const mutate = (genes: Gene[]) => {
      if (random() < 0.55) { const index = Math.floor(random() * genes.length); genes[index].rotation = selectRotation(genes[index].id); }
    };
    let completed = 0;
    try {
      let population: Individual[] = [];
      for (let index = 0; index < populationSize; index++) { const individual = evaluate(seedOrder(index)); if (individual) population.push(individual); completed++; onProgress?.({completed, total: populationSize * generations, bestSheetCount: best.sheetCount}); }
      for (let generation = 1; generation < generations && population.length; generation++) {
        population.sort((a, b) => compare(a.result, b.result));
        const next: Individual[] = [population[0]];
        while (next.length < populationSize) {
          const genes = crossover(tournament(population).genes, tournament(population).genes);
          mutate(genes);
          const individual = evaluate(genes);
          if (individual) next.push(individual);
          completed++; onProgress?.({completed, total: populationSize * generations, bestSheetCount: best.sheetCount});
          if (!individual && completed > populationSize * generations * 2) break;
        }
        population = next;
      }
    } catch (error) {
      if (error instanceof WorkLimitError) return {...best, limited: true};
      throw error;
    }
    return best;
  }
}
