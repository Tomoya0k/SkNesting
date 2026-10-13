import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import opentype from 'opentype.js';
import {GeometryParser, type SvgFonts} from '../src/engine/GeometryParser.ts';
import {NestingEngine} from '../src/engine/NestingEngine.ts';
import {rotatePiece} from '../src/engine/BottomLeftPlacer.ts';
import {materialOverlaps, minimumBoundaryDistance, polygonArea} from '../src/engine/PolygonOperations.ts';
import {readSvgSizeInfo} from '../src/engine/SvgDimensions.ts';
import {consumedSheets} from '../src/sheetUsage.ts';

async function font(path: string) {
  const bytes = await readFile(new URL(path, import.meta.url));
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

test('importa el SVG de letras y figuras y entrega un acomodo completo', async () => {
  const fonts: SvgFonts = {
    serif: await font('../node_modules/@fontsource/tinos/files/tinos-latin-400-normal.woff'),
    serifBold: await font('../node_modules/@fontsource/tinos/files/tinos-latin-700-normal.woff'),
    sans: await font('../node_modules/@fontsource/arimo/files/arimo-latin-400-normal.woff'),
    sansBold: await font('../node_modules/@fontsource/arimo/files/arimo-latin-700-normal.woff'),
  };
  const source = await readFile(new URL('./fixtures/nesting_stress_test_letras_figuras.svg', import.meta.url), 'utf8');
  const {pieces} = GeometryParser.parseSvg(source, 0.25, fonts);
  assert.equal(pieces.length, 64);
  assert.ok(pieces.some(piece => piece.polygon.holes.length));
  const result = NestingEngine.runSync(pieces, {sheetWidthMm: 1800, sheetHeightMm: 2400, gapMm: 5, edgeMarginMm: 20}, undefined, performance.now() + 30_000);
  assert.equal(result.error, null);
  assert.equal(result.placements.length, pieces.length);
  assert.equal(result.limited, true);
  assert.equal(result.method, 'fast');
});

test('convierte rectángulos redondeados, círculos, elipses y polígonos', () => {
  const source = '<svg width="200mm" height="100mm" viewBox="0 0 200 100"><rect id="fondo" width="200" height="100" fill="white"/><rect id="redondo" x="2" y="2" width="20" height="10" rx="5"/><circle id="circulo" cx="40" cy="10" r="8"/><ellipse id="elipse" cx="70" cy="10" rx="12" ry="5"/><polygon id="triangulo" points="90,2 100,20 80,20"/></svg>';
  const {pieces} = GeometryParser.parseSvg(source);
  assert.deepEqual(pieces.map(piece => piece.id), ['redondo', 'circulo', 'elipse', 'triangulo']);
  assert.ok(pieces.slice(0, 3).every(piece => piece.approximationErrorMm >= 0.25));
});

test('lee dimensiones físicas declaradas y conserva la proporción del viewBox', () => {
  const declared = readSvgSizeInfo('<svg width="20cm" height="100mm" viewBox="0 0 400 200"/>');
  assert.deepEqual(declared.dimensions, {widthMm: 200, heightMm: 100});
  assert.equal(declared.aspectRatio, 2);
  const partial = readSvgSizeInfo('<svg width="20cm" viewBox="0 0 400 200"/>');
  assert.deepEqual(partial.dimensions, {widthMm: 200, heightMm: 100});
  assert.equal(partial.inferredDimension, 'height');
  const unspecified = readSvgSizeInfo('<svg viewBox="10 20 400 200"/>');
  assert.equal(unspecified.dimensions, null);
  assert.equal(unspecified.aspectRatio, 2);
});

test('permite asignar medidas físicas a un SVG sin width/height y escala el arte completo', () => {
  const source = '<svg viewBox="0 0 100 50"><rect x="10" y="5" width="80" height="40"/></svg>';
  assert.throws(() => GeometryParser.parseSvg(source), /width y height/);
  const parsed = GeometryParser.parseSvg(source, 0.25, undefined, {widthMm: 200, heightMm: 100});
  assert.equal(parsed.widthMm, 200);
  assert.equal(parsed.heightMm, 100);
  assert.equal(Math.max(...parsed.pieces[0].polygon.outer.map(point => point.x)), 180);
  assert.equal(Math.max(...parsed.pieces[0].polygon.outer.map(point => point.y)), 90);
});

test('acomoda el SVG complejo de Ciudad Maderas sin agotar el cálculo', async () => {
  const source = await readFile(new URL('./fixtures/Ciudad_Maderas_80cm_con_figuras_prueba.svg', import.meta.url), 'utf8');
  const {pieces} = GeometryParser.parseSvg(source);
  assert.equal(pieces.length, 53);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.polygon.holes.length, 0), 14);
  const result = NestingEngine.runSync(pieces, {sheetWidthMm: 1800, sheetHeightMm: 2400, gapMm: 5, edgeMarginMm: 20}, undefined, performance.now() + 100_000);
  assert.equal(result.error, null);
  assert.equal(result.placements.length, pieces.length);
  assert.equal(result.method, 'fast');
  assert.ok(result.placements.some(placement => placement.rotation % 90 !== 0));
  assert.ok(consumedSheets(result) <= 2.5, `consumo: ${consumedSheets(result)} hojas`);
  const sheetArea = 1800 * 2400;
  assert.ok(result.placements.some(small => !small.parentPieceId && polygonArea(small.polygon) <= sheetArea * 0.03 &&
    result.placements.some(large => large.sheet === small.sheet && polygonArea(large.polygon) > sheetArea * 0.03 &&
      small.x < large.x + large.width && small.x + small.width > large.x &&
      small.y < large.y + large.height && small.y + small.height > large.y)), 'debe ocupar una concavidad abierta entre contornos grandes');
  const shapes = new Map(result.placements.map(placement => {
    const original = pieces.find(piece => piece.id === placement.pieceId)!;
    return [placement.pieceId, rotatePiece(original, placement.rotation)] as const;
  }));
  for (let i = 0; i < result.placements.length; i++) for (let j = i + 1; j < result.placements.length; j++) {
    const a = result.placements[i], b = result.placements[j];
    if (a.sheet !== b.sheet) continue;
    const clearance = 5 + shapes.get(a.pieceId)!.approximationErrorMm + shapes.get(b.pieceId)!.approximationErrorMm;
    if (a.x + a.width + clearance <= b.x || b.x + b.width + clearance <= a.x ||
        a.y + a.height + clearance <= b.y || b.y + b.height + clearance <= a.y) continue;
    assert.equal(materialOverlaps(a.polygon, b.polygon), false, `${a.pieceId} y ${b.pieceId} se superponen`);
    assert.ok(minimumBoundaryDistance(a.polygon, b.polygon) + 1e-7 >= clearance, `${a.pieceId} y ${b.pieceId} no tienen separación suficiente`);
  }
});

test('ignora la guía invisible y conserva las posiciones de SAINT gótico', async () => {
  const fonts: SvgFonts = {
    serif: await font('../node_modules/@fontsource/tinos/files/tinos-latin-400-normal.woff'),
    serifBold: await font('../node_modules/@fontsource/tinos/files/tinos-latin-700-normal.woff'),
    sans: await font('../node_modules/@fontsource/arimo/files/arimo-latin-400-normal.woff'),
    sansBold: await font('../node_modules/@fontsource/arimo/files/arimo-latin-700-normal.woff'),
    gothic: await font('../node_modules/@fontsource/unifrakturcook/files/unifrakturcook-latin-700-normal.woff'),
  };
  const source = await readFile(new URL('./fixtures/SAINT_gotico_50cm.svg', import.meta.url), 'utf8');
  const {pieces} = GeometryParser.parseSvg(source, 0.25, fonts);
  assert.equal(pieces.length, 5);
  const leftEdges = pieces.map(piece => Math.min(...piece.polygon.outer.map(point => point.x)));
  assert.ok(leftEdges.every((left, index) => index === 0 || left > leftEdges[index - 1]));
  const result = NestingEngine.runSync(pieces, {sheetWidthMm: 1800, sheetHeightMm: 2400, gapMm: 5, edgeMarginMm: 20});
  assert.equal(result.error, null);
  assert.equal(result.placements.length, 5);
  assert.equal(result.sheetCount, 1);
  assert.equal(result.regions[0].fraction, 0.25);
});
