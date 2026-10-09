import type {NestingResult} from './engine/types.ts';

export function consumedSheets(result: Pick<NestingResult, 'sheetCount' | 'regions'>): number {
  if (!result.sheetCount) return 0;
  const used = result.regions.reduce((sum, region) => sum + region.fraction, 0);
  return Math.ceil(used * 4 - 1e-9) / 4;
}
