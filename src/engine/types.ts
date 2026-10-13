export interface Point { x: number; y: number }
export type Ring = Point[];
/** Material contour; hole contours belong to and transform with this polygon. */
export interface Polygon { outer: Ring; holes: Polygon[] }
/** Clockwise rotation in degrees, normalized to [0, 360). */
export type Rotation = number;
export type Fraction = 0.25 | 0.5 | 0.75 | 1;

export interface Piece {
  id: string;
  polygon: Polygon;
  /** Maximum deviation of the flattened contour from its SVG source, in mm. */
  approximationErrorMm: number;
}

export interface NestingConfig {
  sheetWidthMm: number;
  sheetHeightMm: number;
  gapMm: number;
  edgeMarginMm?: number;
  curveToleranceMm?: number;
  /** Physical size assigned to the imported vector artwork, in mm. */
  artworkWidthMm?: number;
  artworkHeightMm?: number;
  rotations?: readonly Rotation[];
  populationSize?: number;
  generations?: number;
  seed?: number;
  maxTrianglePairs?: number;
  maxBooleanOps?: number;
}

export interface Placement {
  pieceId: string;
  /** Piece whose closed hole contains this placement, when applicable. */
  parentPieceId?: string;
  /** Index in the parent's oriented polygon.holes array. */
  parentHoleIndex?: number;
  sheet: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: Rotation;
  polygon: Polygon;
}

export interface PlacementHierarchy {pieceId: string; children: PlacementHierarchy[]}

export interface SheetRegion {
  sheet: number;
  fraction: Fraction;
  width: number;
  height: number;
  usedHeight: number;
  usedWidth: number;
}

export interface UnplaceablePiece {
  pieceId: string;
  reason: string;
  orientations: {rotation: Rotation; width: number; height: number}[];
}

export interface NestingResult {
  placements: Placement[];
  hierarchy: PlacementHierarchy[];
  regions: SheetRegion[];
  sheetCount: number;
  netAreaMm2: number;
  usedMaterialSheets: number;
  fullSheets: number;
  sharedQuarterSheets: number;
  limited: boolean;
  method?: 'fast';
  error: string | null;
  unplaceable?: UnplaceablePiece;
  engineVersion: 'nfp-ga-v1';
}

export interface ProgressEvent { completed: number; total: number; bestSheetCount: number; bestConsumedSheets?: number; stage?: 'repair' | 'repack' }
