import {translatePolygon} from './PolygonOperations.ts';
import type {Placement, PlacementHierarchy} from './types.ts';

export function buildPlacementHierarchy(placements: readonly Placement[]): PlacementHierarchy[] {
  const nodes = new Map(placements.map(placement => [placement.pieceId, {pieceId: placement.pieceId, children: [] as PlacementHierarchy[]}]));
  const roots: PlacementHierarchy[] = [];
  for (const placement of placements) {
    const node = nodes.get(placement.pieceId)!;
    if (!placement.parentPieceId) { roots.push(node); continue; }
    const parent = nodes.get(placement.parentPieceId);
    if (!parent || placement.parentPieceId === placement.pieceId) throw new Error(`Jerarquía de piezas inválida: ${placement.pieceId}.`);
    parent.children.push(node);
  }
  const seen = new Set<string>();
  const visit = (node: PlacementHierarchy) => {
    if (seen.has(node.pieceId)) throw new Error('La jerarquía de piezas contiene un ciclo.');
    seen.add(node.pieceId);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  if (seen.size !== placements.length) throw new Error('La jerarquía de piezas contiene un ciclo.');
  return roots;
}

/** Moves a placed piece and every piece nested within its holes by the same delta. */
export function translatePlacementTree(placements: readonly Placement[], pieceId: string, dx: number, dy: number): Placement[] {
  if (![dx, dy].every(Number.isFinite)) throw new Error('Traslación de piezas inválida.');
  const hierarchy = buildPlacementHierarchy(placements);
  const moved = new Set<string>();
  const mark = (node: PlacementHierarchy): boolean => {
    if (node.pieceId === pieceId) {
      const descendants = (child: PlacementHierarchy) => { moved.add(child.pieceId); child.children.forEach(descendants); };
      descendants(node);
      return true;
    }
    return node.children.some(mark);
  };
  if (!hierarchy.some(mark)) throw new Error(`Pieza desconocida: ${pieceId}.`);
  return placements.map(placement => moved.has(placement.pieceId)
    ? {...placement, x: placement.x + dx, y: placement.y + dy, polygon: translatePolygon(placement.polygon, dx, dy)}
    : placement);
}
