import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {GeometryParser} from '../src/engine/GeometryParser.ts';
import {EpsConverter} from '../src/engine/EpsConverter.ts';
import {NestingEngine} from '../src/engine/NestingEngine.ts';

const source = () => readFile(new URL('./fixtures/two-shapes.eps', import.meta.url));
const buffer = (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

test('importa EPS vectorial con medidas, varias piezas y agujero cerrado', async () => {
  const eps = buffer(await source());
  const size = EpsConverter.physicalDimensions(eps);
  assert.ok(Math.abs(size.widthMm - 200 * 25.4 / 72) < 1e-10);
  assert.ok(Math.abs(size.heightMm - 100 * 25.4 / 72) < 1e-10);
  const parsed = GeometryParser.parseEps(eps);
  assert.ok(Math.abs(parsed.widthMm - 200 * 25.4 / 72) < 1e-8);
  assert.ok(Math.abs(parsed.heightMm - 100 * 25.4 / 72) < 1e-8);
  assert.equal(parsed.pieces.length, 2);
  assert.equal(parsed.pieces[1].polygon.holes.length, 1);
  assert.ok(parsed.pieces[0].polygon.outer.some(point => Math.abs(point.x - 10 * 25.4 / 72) < 1e-4));
  const result = NestingEngine.runSync(parsed.pieces, {sheetWidthMm: 100, sheetHeightMm: 100, gapMm: 5, edgeMarginMm: 2});
  assert.ok(!result.error);
  assert.equal(result.placements.length, 2);
});

test('escala el EPS a las dimensiones físicas elegidas en la interfaz', async () => {
  const parsed = GeometryParser.parseEps(buffer(await source()), 0.25, {widthMm: 400, heightMm: 200});
  assert.equal(parsed.widthMm, 400);
  assert.equal(parsed.heightMm, 200);
  assert.ok(Math.max(...parsed.pieces[0].polygon.outer.map(point => point.x)) > 100);
});

test('extrae el bloque PostScript de un EPS con previsualización binaria', async () => {
  const eps = await source();
  const wrapped = new Uint8Array(12 + eps.length + 4);
  wrapped.set([0xc5, 0xd0, 0xd3, 0xc6]);
  new DataView(wrapped.buffer).setUint32(4, 12, true);
  new DataView(wrapped.buffer).setUint32(8, eps.length, true);
  wrapped.set(eps, 12);
  assert.equal(GeometryParser.parseEps(wrapped.buffer).pieces.length, 2);
});

test('rechaza EPS sin escala física o con trazos abiertos', () => {
  const encode = (value: string) => new TextEncoder().encode(value).buffer;
  assert.throws(() => EpsConverter.toSvg(encode('%!PS-Adobe-3.0 EPSF-3.0\nnewpath 0 0 moveto 10 0 lineto stroke')),
    /BoundingBox/);
  assert.throws(() => GeometryParser.parseEps(encode('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\nnewpath 0 0 moveto 10 0 lineto stroke')),
    /trazos sin contorno/);
});

test('respeta el BoundingBox principal y omite el trazo decorativo del mismo contorno', () => {
  const eps = `%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: -20 -10 180 90\n%%EndComments\nnewpath 0 0 moveto 60 0 lineto 60 40 lineto 0 40 lineto closepath gsave fill grestore stroke\n%%BoundingBox: 0 0 612 792\n`;
  const parsed = GeometryParser.parseEps(new TextEncoder().encode(eps).buffer);
  assert.ok(Math.abs(parsed.widthMm - 200 * 25.4 / 72) < 1e-8);
  assert.equal(parsed.pieces.length, 1);
});
