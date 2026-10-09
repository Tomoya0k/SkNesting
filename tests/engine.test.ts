import assert from 'node:assert/strict';
import test from 'node:test';
import {difference, FillRule} from 'clipper2-ts';
import {GeometryParser} from '../src/engine/GeometryParser.ts';
import {NestingEngine} from '../src/engine/NestingEngine.ts';
import {NFPGenerator} from '../src/engine/NFPGenerator.ts';
import {calculateIFP, fitsInside} from '../src/engine/InnerFitPolygon.ts';
import {baseline, BottomLeftPlacer, finalize, rotatePiece} from '../src/engine/BottomLeftPlacer.ts';
import {improveFastLayout} from '../src/engine/FastPocketOptimizer.ts';
import {translatePlacementTree} from '../src/engine/PlacementTree.ts';
import {SCALE, fromPaths, materialOverlaps, minimumBoundaryDistance, pointInRing, polygonArea, polygonCentroid, toPath, translatePolygon, triangulatePolygon} from '../src/engine/PolygonOperations.ts';
import {consumedSheets} from '../src/sheetUsage.ts';
import type {Fraction, Piece, Placement, Point, Polygon} from '../src/engine/types.ts';

const p = (x: number, y: number): Point => ({x, y});
const rectangle = (width: number, height: number): Polygon => ({outer: [p(0, 0), p(width, 0), p(width, height), p(0, height)], holes: []});
const piece = (id: string, polygon: Polygon): Piece => ({id, polygon, approximationErrorMm: 0});
const defaults = {sheetWidthMm: 100, sheetHeightMm: 100, gapMm: 5, edgeMarginMm: 20, populationSize: 6, generations: 6};
const placed = (item: Piece, sheet: number, x: number, y: number): Placement => {
  const shape = rotatePiece(item, 0);
  return {pieceId: item.id, sheet, x, y, width: shape.width, height: shape.height, rotation: 0, polygon: translatePolygon(shape.polygon, x, y)};
};

test('lee paths y conserva un agujero con evenodd', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path id="O" fill-rule="evenodd" d="M0 0H80V80H0Z M20 20H60V60H20Z"/></svg>';
  const parsed = GeometryParser.parseSvg(source);
  assert.equal(parsed.pieces.length, 1);
  assert.equal(parsed.pieces[0].polygon.holes.length, 1);
  assert.equal(polygonArea(parsed.pieces[0].polygon), 4800);
});

test('clasifica agujeros por el winding de los subpaths con nonzero', () => {
  const root = '<svg width="100mm" height="100mm" viewBox="0 0 100 100">';
  const outer = 'M0 0H80V80H0Z ';
  const opposite = GeometryParser.parseSvg(`${root}<path d="${outer}M20 20V60H60V20Z"/></svg>`).pieces[0].polygon;
  const same = GeometryParser.parseSvg(`${root}<path d="${outer}M20 20H60V60H20Z"/></svg>`).pieces[0].polygon;
  assert.equal(opposite.holes.length, 1);
  assert.equal(polygonArea(opposite), 4800);
  assert.equal(same.holes.length, 0);
  assert.equal(polygonArea(same), 6400);
  const island = GeometryParser.parseSvg(`${root}<path d="${outer}M20 20V60H60V20Z M30 30H50V50H30Z"/></svg>`).pieces;
  assert.equal(island.length, 2);
  assert.equal(island[0].polygon.holes.length, 1);
});

test('triangula por completo una T con hombros inclinados', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="1220mm" height="2440mm" viewBox="0 0 1220 2440"><path d="M703.552 1061.257V1050.029L736.314 1045.876V871.304H728.469C704.988 871.304 688.479 872.329 678.943 874.38L674.79 912.678H660.794V855H861.206V912.678H847.056L842.903 874.38C834.392 872.534 817.576 871.611 792.454 871.611H784.917V1045.876L817.678 1050.029V1061.257Z"/></svg>';
  const polygon = GeometryParser.parseSvg(source).pieces[0].polygon;
  assert.ok(triangulatePolygon(polygon).length > 0);
  assert.ok(Math.abs(polygonArea(polygon) - 14818.02033) < 0.001);
});

test('discretiza Bézier y arcos bajo escala y transformaciones', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 100 100"><g transform="translate(10 5)"><path d="M10 10 Q50 90 90 10 L90 -10 A40 40 0 0 0 10 -10 Z"/></g></svg>';
  const parsed = GeometryParser.parseSvg(source, 0.25);
  assert.equal(parsed.pieces.length, 1);
  assert.ok(parsed.pieces[0].polygon.outer.length > 20);
  assert.ok(Math.min(...parsed.pieces[0].polygon.outer.map(point => point.x)) >= 39.9);
  assert.throws(() => GeometryParser.parseSvg(source.replace('200mm', '200')), /width y height/);
});

test('NFP de rectángulos y hueco libre de un marco', () => {
  const generator = new NFPGenerator();
  const square = rectangle(10, 10);
  const nfp = fromPaths(generator.generate(rectangle(20, 20), square, 0, 'a', 'b'));
  assert.equal(nfp.length, 1);
  assert.ok(Math.abs(polygonArea(nfp[0]) - 900) < 0.001);
  const frame: Polygon = {outer: rectangle(60, 60).outer, holes: [{outer: [p(15, 15), p(45, 15), p(45, 45), p(15, 45)], holes: []}]};
  const withHole = fromPaths(generator.generate(frame, square, 0, 'frame', 'b'));
  assert.equal(withHole.length, 1);
  assert.equal(withHole[0].holes.length, 1);
});

test('encaja una pieza dentro del agujero con gap real', () => {
  const frame: Polygon = {outer: rectangle(60, 60).outer, holes: [{outer: [p(15, 15), p(45, 15), p(45, 45), p(15, 45)], holes: []}]};
  const result = NestingEngine.runSync([piece('marco', frame), piece('interior', rectangle(10, 10))], {...defaults, sheetWidthMm: 100, sheetHeightMm: 100, gapMm: 5});
  assert.equal(result.error, null, result.error ?? '');
  assert.equal(result.sheetCount, 1);
  const first = result.placements.find(placement => placement.pieceId === 'marco')!;
  const second = result.placements.find(placement => placement.pieceId === 'interior')!;
  assert.equal(materialOverlaps(first.polygon, second.polygon), false);
  assert.ok(minimumBoundaryDistance(first.polygon, second.polygon) >= 5 - 1e-6);
  assert.ok(second.x >= first.x + 20 && second.x <= first.x + 35);
  assert.equal(second.parentPieceId, first.pieceId);
  assert.deepEqual(result.hierarchy.map(node => [node.pieceId, node.children.map(child => child.pieceId)]), [['marco', ['interior']]]);
  const shifted = translatePlacementTree(result.placements, first.pieceId, 12, 7);
  assert.equal(shifted[0].polygon.holes[0].outer[0].x, first.polygon.holes[0].outer[0].x + 12);
  assert.deepEqual([shifted[1].x, shifted[1].y], [second.x + 12, second.y + 7]);
  const fast = baseline([piece('marco', frame), piece('interior', rectangle(10, 10))], {...defaults, sheetWidthMm: 100, sheetHeightMm: 100, gapMm: 5});
  assert.equal(fast.sheetCount, 1);
  assert.equal(fast.placements[1].parentPieceId, 'marco');
});

test('IFP calcula el área factible y conserva el encaje puntual', () => {
  const container = {...rectangle(30, 30), outer: rectangle(30, 30).outer.map(({x, y}) => p(x + 15, y + 15))};
  const mobile = rectangle(10, 10);
  const ifp = calculateIFP(container, mobile, 5, new NFPGenerator(), 'h30', 'm10');
  assert.equal(ifp.regions.length, 1);
  assert.ok(Math.abs(polygonArea(ifp.regions[0]) - 100) < 0.01);
  assert.ok(ifp.points.some(({x, y}) => x === 20 && y === 20));
  const exact = calculateIFP(rectangle(20, 20), mobile, 5, new NFPGenerator(), 'h20', 'm10');
  assert.deepEqual(exact.points, [p(5, 5)]);
  assert.equal(exact.regions.length, 0);
  const concave: Polygon = {outer: [p(0, 0), p(40, 0), p(40, 10), p(10, 10), p(10, 40), p(0, 40)], holes: []};
  const small = rectangle(5, 5);
  const concaveIfp = calculateIFP(concave, small, 2, new NFPGenerator(), 'concave', 'small');
  assert.ok(concaveIfp.points.some(({x, y}) => x === 2 && y === 2));
  assert.equal(fitsInside(concave, small, 20, 20, 2), false);
});

test('NFP cóncavo conserva la cavidad abierta de una U', () => {
  const u: Polygon = {outer: [p(0, 0), p(10, 0), p(10, 60), p(50, 60), p(50, 0), p(60, 0), p(60, 70), p(0, 70)], holes: []};
  const small = rectangle(10, 10);
  const nfp = fromPaths(new NFPGenerator().generate(u, small, 5, 'u', 'small'));
  const forbidden = (point: Point) => nfp.some(polygon => pointInRing(point, polygon.outer) && !polygon.holes.some(hole => pointInRing(point, hole.outer)));
  assert.equal(forbidden(p(20, 20)), false);
  assert.equal(forbidden(p(5, 20)), true);
  const result = baseline([piece('U', u), piece('small', small)], {sheetWidthMm: 100, sheetHeightMm: 110, gapMm: 5, edgeMarginMm: 20, rotations: [0]});
  assert.equal(result.sheetCount, 1);
  assert.equal(result.error, null);
  assert.equal(materialOverlaps(result.placements[0].polygon, result.placements[1].polygon), false);
  assert.ok(minimumBoundaryDistance(result.placements[0].polygon, result.placements[1].polygon) >= 5 - 1e-7);
  const c: Polygon = {outer: [p(0, 0), p(70, 0), p(70, 15), p(15, 15), p(15, 55), p(70, 55), p(70, 70), p(0, 70)], holes: []};
  const inC = baseline([piece('C', c), piece('small', small)], {sheetWidthMm: 110, sheetHeightMm: 110, gapMm: 5, edgeMarginMm: 20, rotations: [0]});
  assert.equal(inC.sheetCount, 1);
  assert.equal(materialOverlaps(inC.placements[0].polygon, inC.placements[1].polygon), false);
});

test('recoloca una pieza en una cavidad abierta con pared inclinada', () => {
  const c = piece('letra-inclinada', {outer: [p(0, 0), p(120, 0), p(120, 20), p(50, 20), p(20, 50), p(50, 80), p(120, 80), p(120, 100), p(0, 100)], holes: []});
  const small = piece('pequeña', rectangle(20, 20));
  const parts = [c, small], config = {sheetWidthMm: 160, sheetHeightMm: 140, gapMm: 5, edgeMarginMm: 10};
  const initial = finalize([[placed(c, 0, 10, 10)], [placed(small, 1, 10, 10)]], parts, config);
  const result = improveFastLayout(parts, config, initial, [0], performance.now() + 4_000);
  assert.equal(result.sheetCount, 1);
  const first = result.placements.find(item => item.pieceId === c.id)!;
  const second = result.placements.find(item => item.pieceId === small.id)!;
  assert.equal(second.sheet, first.sheet);
  assert.equal(materialOverlaps(first.polygon, second.polygon), false);
  assert.ok(minimumBoundaryDistance(first.polygon, second.polygon) >= 5 - 1e-7);
});

test('conserva el acomodo inicial cuando se agota el tiempo de mejora', () => {
  const large = piece('grande', rectangle(60, 60)), small = piece('pequeña', rectangle(10, 10));
  const parts = [large, small], config = {sheetWidthMm: 100, sheetHeightMm: 100, gapMm: 5, edgeMarginMm: 10};
  const initial = finalize([[placed(large, 0, 10, 10)], [placed(small, 1, 10, 10)]], parts, config);
  assert.deepEqual(improveFastLayout(parts, config, initial, [0], performance.now() - 1), initial);
});

test('encaja entre dos contornos inclinados aunque sus cajas se superpongan', () => {
  const left = piece('trazo-izquierdo', {outer: [p(0, 0), p(10, 0), p(100, 100), p(90, 100)], holes: []});
  const right = piece('trazo-derecho', {outer: [p(60, 0), p(70, 0), p(160, 100), p(150, 100)], holes: []});
  const small = piece('entre-letras', rectangle(20, 20));
  const parts = [left, right, small], config = {sheetWidthMm: 220, sheetHeightMm: 140, gapMm: 5, edgeMarginMm: 10};
  const initial = finalize([[placed(left, 0, 10, 10), placed(right, 0, 90, 10)], [placed(small, 1, 10, 10)]], parts, config);
  const result = improveFastLayout(parts, config, initial, [0], performance.now() + 4_000);
  assert.equal(result.sheetCount, 1);
  const mobile = result.placements.find(item => item.pieceId === small.id)!;
  for (const other of result.placements.filter(item => item.pieceId !== small.id)) {
    assert.equal(materialOverlaps(mobile.polygon, other.polygon), false);
    assert.ok(minimumBoundaryDistance(mobile.polygon, other.polygon) >= 5 - 1e-7);
  }
  assert.ok(mobile.x < 110 && mobile.x + mobile.width > 90, JSON.stringify({x: mobile.x, y: mobile.y}));
});

test('ordena por área y elige la cavidad abierta aun cuando cabe fuera de la C', () => {
  const c: Polygon = {outer: [p(0, 0), p(70, 0), p(70, 15), p(15, 15), p(15, 55), p(70, 55), p(70, 70), p(0, 70)], holes: []};
  const parts = [piece('pequeña', rectangle(10, 10)), piece('C', c)];
  const config = {sheetWidthMm: 160, sheetHeightMm: 120, gapMm: 5, edgeMarginMm: 10, rotations: [0] as const};
  const exact = new BottomLeftPlacer(config, new NFPGenerator()).pack(parts, [{id: 'pequeña', rotation: 0}, {id: 'C', rotation: 0}]);
  const fast = baseline(parts, config);
  const optimized = NestingEngine.runSync(parts, {...config, populationSize: 4, generations: 3});
  for (const result of [exact, fast, optimized]) {
    assert.deepEqual(result.placements.map(placement => placement.pieceId), ['C', 'pequeña']);
    const [large, small] = result.placements;
    assert.ok(small.x >= large.x + 20 && small.x + small.width <= large.x + 70);
    assert.ok(small.y >= large.y + 20 && small.y + small.height <= large.y + 50);
    assert.equal(materialOverlaps(large.polygon, small.polygon), false);
  }
});

test('Clipper conserva una boca de C con holgura de décimas de micra', () => {
  assert.equal(SCALE, 10_000);
  const c: Polygon = {outer: [p(0, 0), p(40, 0), p(40, 10), p(10, 10), p(10, 12.0006), p(40, 12.0006), p(40, 22.0006), p(0, 22.0006)], holes: []};
  const nfpPaths = new NFPGenerator().generate(c, rectangle(2, 2), 0.0002, 'C-fina', 'movil');
  const nfp = fromPaths(nfpPaths);
  const forbidden = (point: Point) => nfp.some(polygon => pointInRing(point, polygon.outer) && !polygon.holes.some(hole => pointInRing(point, hole.outer)));
  assert.equal(forbidden(p(20, 10.0001)), true);
  assert.equal(forbidden(p(20, 10.0003)), false);
  assert.equal(forbidden(p(20, 10.0004)), true);
  const domain = toPath([p(-3, -3), p(50, -3), p(50, 30), p(-3, 30)], true);
  const free = fromPaths(difference([domain], nfpPaths, FillRule.NonZero));
  assert.equal(free.length, 1);
  assert.ok(free.some(region => pointInRing(p(20, 10.0003), region.outer)));
});

test('la gravedad usa el centroide de materia y descuenta agujeros', () => {
  const frame: Polygon = {outer: rectangle(10, 10).outer, holes: [{outer: [p(6, 6), p(8, 6), p(8, 8), p(6, 8)], holes: []}]};
  const center = polygonCentroid(frame);
  assert.ok(Math.abs(center.x - 472 / 96) < 1e-10);
  assert.ok(Math.abs(center.y - 472 / 96) < 1e-10);
});

test('conserva un encaje exacto en un agujero que se reduce a un punto', () => {
  const frame: Polygon = {outer: rectangle(60, 60).outer, holes: [{outer: [p(20, 20), p(40, 20), p(40, 40), p(20, 40)], holes: []}]};
  const result = NestingEngine.runSync([piece('marco', frame), piece('interior', rectangle(10, 10))], defaults);
  assert.equal(result.error, null);
  assert.equal(result.sheetCount, 1);
  const first = result.placements.find(placement => placement.pieceId === 'marco')!;
  const second = result.placements.find(placement => placement.pieceId === 'interior')!;
  assert.deepEqual([second.x - first.x, second.y - first.y], [25, 25]);
});

test('usa el cuarto horizontal con región útil de 1180 × 570 mm', () => {
  const result = NestingEngine.runSync([piece('exacta', rectangle(1180, 570))], {sheetWidthMm: 1220, sheetHeightMm: 2440, gapMm: 5});
  assert.equal(result.error, null);
  assert.equal(result.regions[0].fraction, 0.25);
  assert.deepEqual([result.placements[0].x, result.placements[0].y], [20, 20]);
  assert.equal(result.regions[0].height - 40, 570);
});

test('una línea SVG exacta mantiene la franja de un cuarto sin reserva de curva', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="1180mm" height="570mm" viewBox="0 0 1180 570"><path d="M0 0H1180V570H0Z"/></svg>';
  const parsed = GeometryParser.parseSvg(source);
  assert.equal(parsed.pieces[0].approximationErrorMm, 0);
  const result = NestingEngine.runSync(parsed.pieces, {sheetWidthMm: 1220, sheetHeightMm: 2440, gapMm: 5});
  assert.equal(result.regions[0]?.fraction, 0.25);
});

test('reserva error de curva en gap y borde de franja', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M0 0Q10 -5 20 0V20H0Z"/></svg>';
  const parsed = GeometryParser.parseSvg(source);
  assert.ok(parsed.pieces[0].approximationErrorMm >= 0.25 && parsed.pieces[0].approximationErrorMm < 0.251);
  const result = NestingEngine.runSync(parsed.pieces, {...defaults, sheetHeightMm: 160});
  assert.equal(result.error, null);
  assert.ok(result.placements[0].x >= 20.25);
  assert.ok(result.placements[0].y >= 20.25);
});

test('prueba cuatro rotaciones antes de declarar una pieza imposible', () => {
  const fits = NestingEngine.runSync([piece('giro', rectangle(65, 40))], {...defaults, sheetWidthMm: 90, sheetHeightMm: 110, rotations: [0, 90, 180, 270]});
  assert.equal(fits.error, null);
  assert.ok([90, 270].includes(fits.placements[0].rotation));
  const failed = NestingEngine.runSync([piece('grande', rectangle(100, 100))], {...defaults, rotations: [0, 90, 180, 270]});
  assert.equal(failed.sheetCount, 0);
  assert.equal(failed.unplaceable?.orientations.length, 4);
});

test('admite ángulos intermedios cuando los giros ortogonales no caben', () => {
  const angle = Math.PI / 6, cosine = Math.cos(angle), sine = Math.sin(angle);
  const slanted: Polygon = {outer: [p(0, 0), p(100 * cosine, 100 * sine), p(100 * cosine - 10 * sine, 100 * sine + 10 * cosine), p(-10 * sine, 10 * cosine)], holes: []};
  const config = {sheetWidthMm: 120, sheetHeightMm: 22, gapMm: 0, edgeMarginMm: 5};
  const orthogonal = NestingEngine.runSync([piece('sesgada', slanted)], {...config, rotations: [0, 90, 180, 270]});
  assert.match(orthogonal.error ?? '', /no cabe/);
  const free = NestingEngine.runSync([piece('sesgada', slanted)], config);
  assert.equal(free.error, null);
  assert.ok(![0, 90, 180, 270].includes(free.placements[0].rotation));
});

test('mismo resultado con iguales entradas y sin geometría parcial', () => {
  const pieces = [piece('a', rectangle(20, 20)), piece('b', rectangle(20, 20)), piece('c', rectangle(20, 20))];
  const first = NestingEngine.runSync(pieces, defaults), second = NestingEngine.runSync(pieces, defaults);
  assert.deepEqual(first, second);
  assert.equal(first.placements.length, pieces.length);
  assert.equal(first.regions.at(-1)?.fraction, 1);
});

test('conserva un acomodo compacto cuando se agota el presupuesto geométrico', () => {
  const pieces = ['a', 'b', 'c', 'd'].map(id => piece(id, rectangle(20, 20)));
  const result = NestingEngine.runSync(pieces, {...defaults, maxTrianglePairs: 1});
  assert.equal(result.error, null);
  assert.equal(result.limited, true);
  assert.equal(result.sheetCount, 1);
  assert.equal(result.placements.length, 4);
  for (let index = 0; index < result.placements.length; index++) {
    for (let other = index + 1; other < result.placements.length; other++) {
      assert.ok(minimumBoundaryDistance(result.placements[index].polygon, result.placements[other].polygon) >= 5 - 1e-7);
    }
  }
});

test('reporta las hojas consumidas en incrementos de un cuarto', () => {
  const usage = (sheetCount: number, fraction: Fraction) => consumedSheets({sheetCount, regions: [{sheet: sheetCount - 1, fraction, width: 100, height: 100 * fraction, usedHeight: 0, usedWidth: 0}]});
  assert.equal(usage(1, 0.25), 0.25);
  assert.equal(usage(1, 0.5), 0.5);
  assert.equal(usage(1, 0.75), 0.75);
  assert.equal(usage(1, 1), 1);
  assert.equal(consumedSheets({sheetCount: 2, regions: [
    {sheet: 0, fraction: 0.25, width: 100, height: 25, usedHeight: 20, usedWidth: 100},
    {sheet: 1, fraction: 0.25, width: 100, height: 25, usedHeight: 20, usedWidth: 100},
  ]}), 0.5);
  assert.equal(consumedSheets({sheetCount: 2, regions: [
    {sheet: 0, fraction: 1, width: 100, height: 100, usedHeight: 100, usedWidth: 100},
    {sheet: 1, fraction: 0.25, width: 100, height: 25, usedHeight: 20, usedWidth: 100},
  ]}), 1.25);
});
