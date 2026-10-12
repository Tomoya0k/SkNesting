import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {SVGPathData} from 'svg-pathdata';
import {cleanRing, filledRings} from './PolygonOperations.ts';
import {EpsConverter} from './EpsConverter.ts';
import type {Piece, Point, Ring} from './types.ts';
import type {Font} from 'opentype.js';

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (matrix: Matrix, point: Point): Point => ({x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5]});
const point = (x: number, y: number): Point => ({x, y});
const lerp = (a: Point, b: Point, t: number): Point => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const distanceToChord = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x, dy = b.y - a.y, divisor = dx * dx + dy * dy;
  const t = divisor ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / divisor)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
function assertSimpleRings(rings: readonly Ring[]): void {
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSegment = (p: Point, a: Point, b: Point) => Math.abs(cross(a, b, p)) <= 1e-8 && p.x >= Math.min(a.x, b.x) - 1e-8 && p.x <= Math.max(a.x, b.x) + 1e-8 && p.y >= Math.min(a.y, b.y) - 1e-8 && p.y <= Math.max(a.y, b.y) + 1e-8;
  const crosses = (a: Point, b: Point, c: Point, d: Point) => {
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    return (abC > 0 && abD < 0 || abC < 0 && abD > 0) && (cdA > 0 && cdB < 0 || cdA < 0 && cdB > 0) || onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
  };
  for (const [ringIndex, ring] of rings.entries()) {
    if (ring.length > 5000) throw new Error('Un contorno supera 5000 vértices; simplifica el SVG.');
    for (let index = 0; index < ring.length; index++) for (let other = index + 2; other < ring.length; other++) {
      if (index === 0 && other === ring.length - 1) continue;
      if (crosses(ring[index], ring[(index + 1) % ring.length], ring[other], ring[(other + 1) % ring.length])) throw new Error(`Autointersección en el contorno ${ringIndex + 1}, aristas ${index + 1} y ${other + 1}.`);
    }
  }
  for (let first = 0; first < rings.length; first++) for (let second = first + 1; second < rings.length; second++) {
    for (let a = 0; a < rings[first].length; a++) for (let b = 0; b < rings[second].length; b++) {
      if (crosses(rings[first][a], rings[first][(a + 1) % rings[first].length], rings[second][b], rings[second][(b + 1) % rings[second].length])) throw new Error('Dos contornos se cruzan o se tocan; corrige el SVG.');
    }
  }
}
function flattenBezier(controls: Point[], tolerance: number, output: Ring, depth = 0): void {
  if (controls.slice(1, -1).every(control => distanceToChord(control, controls[0], controls.at(-1)!) <= tolerance)) { output.push(controls.at(-1)!); return; }
  if (depth >= 24 || output.length >= 50_000) throw new Error('La curva requiere más puntos que el límite de discretización.');
  const left = [controls[0]], right = [controls.at(-1)!];
  let row = controls;
  while (row.length > 1) { row = row.slice(1).map((p, index) => lerp(row[index], p, 0.5)); left.push(row[0]); right.unshift(row.at(-1)!); }
  flattenBezier(left, tolerance, output, depth + 1);
  flattenBezier(right, tolerance, output, depth + 1);
}
function flattenArc(start: Point, end: Point, rxInput: number, ryInput: number, rotation: number, largeArc: number, sweep: number, matrix: Matrix, tolerance: number, output: Ring): void {
  let rx = Math.abs(rxInput), ry = Math.abs(ryInput);
  if (!rx || !ry || start.x === end.x && start.y === end.y) { output.push(apply(matrix, end)); return; }
  const phi = rotation * Math.PI / 180, cosine = Math.cos(phi), sine = Math.sin(phi);
  const halfX = (start.x - end.x) / 2, halfY = (start.y - end.y) / 2;
  const xp = cosine * halfX + sine * halfY, yp = -sine * halfX + cosine * halfY;
  const lambda = xp * xp / (rx * rx) + yp * yp / (ry * ry);
  if (lambda > 1) { const scale = Math.sqrt(lambda); rx *= scale; ry *= scale; }
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp);
  const denominator = rx * rx * yp * yp + ry * ry * xp * xp;
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(numerator / denominator);
  const cxp = factor * rx * yp / ry, cyp = -factor * ry * xp / rx;
  const cx = cosine * cxp - sine * cyp + (start.x + end.x) / 2;
  const cy = sine * cxp + cosine * cyp + (start.y + end.y) / 2;
  const angle = (x: number, y: number) => Math.atan2(y, x);
  const begin = angle((xp - cxp) / rx, (yp - cyp) / ry);
  const ex = (-xp - cxp) / rx, ey = (-yp - cyp) / ry;
  let delta = angle(ex, ey) - begin;
  if (sweep && delta < 0) delta += Math.PI * 2;
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  const operatorBound = Math.hypot(matrix[0], matrix[1], matrix[2], matrix[3]);
  const radiusBound = Math.max(rx, ry) * operatorBound;
  const maximumStep = Math.min(Math.PI / 2, Math.sqrt(8 * tolerance / radiusBound));
  const count = Math.max(1, Math.ceil(Math.abs(delta) / maximumStep));
  if (count > 50_000) throw new Error('El arco requiere más puntos que el límite de discretización.');
  for (let index = 1; index <= count; index++) {
    const angleAt = begin + delta * index / count;
    const x = rx * Math.cos(angleAt), y = ry * Math.sin(angleAt);
    output.push(index === count ? apply(matrix, end) : apply(matrix, point(cx + cosine * x - sine * y, cy + sine * x + cosine * y)));
  }
}
function parseTransform(value: string | undefined): Matrix {
  if (!value) return IDENTITY;
  let result: Matrix = IDENTITY, matched = '', match: RegExpExecArray | null;
  const expression = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  while ((match = expression.exec(value))) {
    matched += match[0];
    const numbers = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (!numbers.every(Number.isFinite)) throw new Error('Transformación SVG inválida.');
    let local: Matrix;
    switch (match[1]) {
      case 'matrix': if (numbers.length !== 6) throw new Error('Matriz SVG inválida.'); local = numbers as Matrix; break;
      case 'translate': if (numbers.length < 1 || numbers.length > 2) throw new Error('Traslación SVG inválida.'); local = [1, 0, 0, 1, numbers[0], numbers[1] ?? 0]; break;
      case 'scale': if (numbers.length < 1 || numbers.length > 2) throw new Error('Escala SVG inválida.'); local = [numbers[0], 0, 0, numbers[1] ?? numbers[0], 0, 0]; break;
      case 'rotate': {
        if (![1, 3].includes(numbers.length)) throw new Error('Rotación SVG inválida.');
        const c = Math.cos(numbers[0] * Math.PI / 180), s = Math.sin(numbers[0] * Math.PI / 180);
        const spin: Matrix = [c, s, -s, c, 0, 0];
        local = numbers.length === 3 ? multiply(multiply([1, 0, 0, 1, numbers[1], numbers[2]], spin), [1, 0, 0, 1, -numbers[1], -numbers[2]]) : spin;
        break;
      }
      case 'skewX': if (numbers.length !== 1) throw new Error('Inclinación SVG inválida.'); local = [1, 0, Math.tan(numbers[0] * Math.PI / 180), 1, 0, 0]; break;
      case 'skewY': if (numbers.length !== 1) throw new Error('Inclinación SVG inválida.'); local = [1, Math.tan(numbers[0] * Math.PI / 180), 0, 1, 0, 0]; break;
      default: throw new Error(`Transformación SVG no soportada: ${match[1]}.`);
    }
    result = multiply(result, local);
  }
  if (matched.replace(/\s/g, '') !== value.replace(/\s/g, '')) throw new Error('Transformación SVG incompleta.');
  return result;
}
function parsePathData(d: string, matrix: Matrix, tolerance: number): {rings: Ring[]; curved: boolean} {
  const commands = new SVGPathData(d).toAbs().normalizeHVZ().normalizeST().commands;
  const rings: Ring[] = [];
  let curved = false;
  let current: Point | null = null, start: Point | null = null, ring: Ring = [];
  const finish = (closed: boolean) => {
    if (ring.length < 2) { ring = []; return; }
    if (!closed && Math.hypot(ring[0].x - ring.at(-1)!.x, ring[0].y - ring.at(-1)!.y) > 1e-6) throw new Error('El SVG contiene un subpath abierto.');
    rings.push(cleanRing(ring)); ring = [];
  };
  for (const command of commands) {
    if (command.type === SVGPathData.MOVE_TO) { finish(false); current = point(command.x, command.y); start = current; ring = [apply(matrix, current)]; continue; }
    if (!current || !start) throw new Error('El path debe comenzar con M.');
    if (command.type === SVGPathData.CLOSE_PATH) { finish(true); current = start; continue; }
    if (command.type === SVGPathData.LINE_TO) { current = point(command.x, command.y); ring.push(apply(matrix, current)); continue; }
    if (command.type === SVGPathData.QUAD_TO) {
      curved = true;
      const end = point(command.x, command.y);
      flattenBezier([apply(matrix, current), apply(matrix, point(command.x1, command.y1)), apply(matrix, end)], tolerance, ring);
      current = end; continue;
    }
    if (command.type === SVGPathData.CURVE_TO) {
      curved = true;
      const end = point(command.x, command.y);
      flattenBezier([apply(matrix, current), apply(matrix, point(command.x1, command.y1)), apply(matrix, point(command.x2, command.y2)), apply(matrix, end)], tolerance, ring);
      current = end; continue;
    }
    if (command.type === SVGPathData.ARC) {
      curved = true;
      const end = point(command.x, command.y);
      flattenArc(current, end, command.rX, command.rY, command.xRot, command.lArcFlag, command.sweepFlag, matrix, tolerance, ring);
      current = end; continue;
    }
    throw new Error('Comando SVG no soportado.');
  }
  finish(false);
  return {rings, curved};
}
function physicalMm(value: string | undefined): number {
  const match = value?.trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|in|pt)$/i);
  if (!match) throw new Error('El SVG debe declarar width y height en mm, cm, in o pt.');
  const factor = {mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72}[match[2].toLowerCase() as 'mm' | 'cm' | 'in' | 'pt'];
  const result = Number(match[1]) * factor;
  if (!Number.isFinite(result) || result <= 0) throw new Error('Dimensión física SVG inválida.');
  return result;
}

type Style = Record<string, string>;
export interface SvgFonts {serif: Font; serifBold: Font; sans: Font; sansBold: Font; gothic?: Font}
const declarations = (source: string): Style => Object.fromEntries(source.split(';').map(part => {
  const colon = part.indexOf(':');
  return colon < 0 ? [] : [part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()];
}).filter(part => part.length === 2));
const number = (value: string | undefined, label: string, fallback = 0): number => {
  if (value === undefined) return fallback;
  const result = Number(value.trim().replace(/px$/i, ''));
  if (!Number.isFinite(result)) throw new Error(`${label} SVG inválido.`);
  return result;
};
function shapePath(tag: string, attrs: Record<string, string>): string | null {
  if (tag === 'rect') {
    const x = number(attrs.x, 'x'), y = number(attrs.y, 'y');
    const w = number(attrs.width, 'width'), h = number(attrs.height, 'height');
    if (w <= 0 || h <= 0) return null;
    let rx = number(attrs.rx, 'rx', attrs.ry === undefined ? 0 : number(attrs.ry, 'ry'));
    let ry = number(attrs.ry, 'ry', rx);
    if (rx < 0 || ry < 0) throw new Error('Radio de rectángulo SVG inválido.');
    rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
    if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
    return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = number(attrs.cx, 'cx'), cy = number(attrs.cy, 'cy');
    const rx = number(tag === 'circle' ? attrs.r : attrs.rx, 'radio horizontal');
    const ry = number(tag === 'circle' ? attrs.r : attrs.ry, 'radio vertical');
    if (rx <= 0 || ry <= 0) return null;
    return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}Z`;
  }
  if (tag === 'polygon' || tag === 'polyline') {
    const source = attrs.points ?? '';
    const tokens = source.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
    if (source.replace(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, '').replace(/[\s,]/g, '') || tokens.length % 2 || tokens.length < 6) throw new Error(`Puntos de ${tag} SVG inválidos.`);
    const pairs: string[] = [];
    for (let index = 0; index < tokens.length; index += 2) pairs.push(`${tokens[index]} ${tokens[index + 1]}`);
    return `M${pairs.join('L')}Z`;
  }
  return null;
}
function textPath(value: string, attrs: Record<string, string>, style: Style, fonts?: SvgFonts): string {
  if (!fonts) throw new Error('No se pudieron cargar las fuentes para convertir el texto SVG.');
  const family = style['font-family'] ?? 'sans-serif';
  const serif = /times|georgia|serif/i.test(family) && !/sans-serif/i.test(family);
  const bold = /bold|[6-9]00/.test(style['font-weight'] ?? '400');
  const font = /unifrakturcook|old english text|cloister black/i.test(family) && fonts.gothic ? fonts.gothic :
    serif ? (bold ? fonts.serifBold : fonts.serif) : (bold ? fonts.sansBold : fonts.sans);
  const size = number(style['font-size'], 'Tamaño de texto', 16);
  if (size <= 0 || size > 10_000) throw new Error('Tamaño de texto SVG inválido.');
  const anchor = style['text-anchor'] ?? 'start';
  if (!['start', 'middle', 'end'].includes(anchor)) throw new Error(`Anclaje de texto SVG no soportado: ${anchor}.`);
  const advance = font.getAdvanceWidth(value, size);
  const x = number(attrs.x, 'x de texto') + number(attrs.dx, 'dx de texto') - (anchor === 'middle' ? advance / 2 : anchor === 'end' ? advance : 0);
  const y = number(attrs.y, 'y de texto') + number(attrs.dy, 'dy de texto');
  const d = font.getPath(value, x, y, size).toPathData(6);
  return d ? `${d.replace(/M/g, 'ZM').slice(1)}Z` : '';
}

export interface ParsedSvg { widthMm: number; heightMm: number; pieces: Piece[] }
export class GeometryParser {
  static parseEps(source: ArrayBuffer, toleranceMm = 0.25): ParsedSvg {
    return GeometryParser.parseSvg(EpsConverter.toSvg(source), toleranceMm);
  }

  static parseSvg(source: string, toleranceMm = 0.25, fonts?: SvgFonts): ParsedSvg {
    if (!Number.isFinite(toleranceMm) || toleranceMm <= 0 || toleranceMm > 5) throw new Error('La tolerancia debe estar entre 0 y 5 mm.');
    if (source.length > 8_000_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SVG demasiado grande o con entidades no admitidas.');
    const valid = XMLValidator.validate(source);
    if (valid !== true) throw new Error('El archivo SVG no es XML válido.');
    const parsed = new XMLParser({preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false}).parse(source) as Record<string, unknown>[];
    const root = parsed.find(entry => Object.keys(entry).some(key => key.replace(/^.*:/, '') === 'svg'));
    if (!root) throw new Error('El archivo no contiene un elemento svg.');
    const rootAttrs = (root[':@'] ?? {}) as Record<string, string>;
    const widthMm = physicalMm(rootAttrs.width), heightMm = physicalMm(rootAttrs.height);
    const view = rootAttrs.viewBox?.trim().split(/[\s,]+/).map(Number);
    if (!view || view.length !== 4 || !view.every(Number.isFinite) || view[2] <= 0 || view[3] <= 0) throw new Error('El SVG necesita un viewBox válido.');
    const physical: Matrix = [widthMm / view[2], 0, 0, heightMm / view[3], -view[0] * widthMm / view[2], -view[1] * heightMm / view[3]];
    const pieces: Piece[] = [], names = new Map<string, number>();
    const classStyles = new Map<string, Style>();
    const collectStyles = (nodes: Record<string, unknown>[]) => {
      for (const node of nodes) for (const [key, value] of Object.entries(node)) {
        if (key.replace(/^.*:/, '') === 'style' && Array.isArray(value)) {
          const css = value.map(item => (item as Record<string, unknown>)['#text'] ?? '').join('');
          for (const match of String(css).matchAll(/\.([\w-]+)\s*\{([^{}]*)\}/g)) classStyles.set(match[1], {...classStyles.get(match[1]), ...declarations(match[2])});
        } else if (Array.isArray(value)) collectStyles(value as Record<string, unknown>[]);
      }
    };
    const rootKey = Object.keys(root).find(key => key.replace(/^.*:/, '') === 'svg')!;
    const rootNodes = root[rootKey] as Record<string, unknown>[];
    collectStyles(rootNodes);
    const visit = (nodes: Record<string, unknown>[], parentMatrix: Matrix, inheritedRule: 'evenodd' | 'nonzero', inheritedStyle: Style, hidden: boolean, depth: number) => {
      for (const node of nodes) {
        const key = Object.keys(node).find(candidate => candidate !== ':@' && candidate !== '#text' && candidate !== '#comment');
        if (!key) continue;
        const tag = key.replace(/^.*:/, ''), attrs = (node[':@'] ?? {}) as Record<string, string>;
        if (['defs', 'metadata', 'title', 'desc', 'style'].includes(tag)) continue;
        if (['script', 'foreignObject', 'image', 'use', 'clipPath', 'mask'].includes(tag)) throw new Error(`Elemento SVG no soportado: ${tag}.`);
        const style: Style = {...inheritedStyle};
        for (const name of ['fill', 'fill-rule', 'display', 'visibility', 'opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline']) if (attrs[name] !== undefined) style[name] = attrs[name];
        for (const name of (attrs.class ?? '').split(/\s+/).filter(Boolean)) Object.assign(style, classStyles.get(name));
        Object.assign(style, declarations(attrs.style ?? ''));
        const opacity = number(style.opacity, 'Opacidad', 1);
        const invis = hidden || style.display === 'none' || style.visibility === 'hidden' || opacity <= 0;
        const rule = (style['fill-rule'] ?? inheritedRule) as string;
        if (rule !== 'evenodd' && rule !== 'nonzero') throw new Error('Regla de relleno SVG no soportada.');
        const matrix = multiply(parentMatrix, parseTransform(attrs.transform));
        const drawable = ['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'text'].includes(tag);
        if (drawable && !invis && style.fill !== 'none') {
          const background = tag === 'rect' && depth === 0 && /^(white|#fff(?:fff)?)$/i.test(style.fill ?? '') &&
            number(attrs.x, 'x') === view[0] && number(attrs.y, 'y') === view[1] &&
            number(attrs.width, 'width') === view[2] && number(attrs.height, 'height') === view[3] && rootNodes.length > 1;
          const annotation = tag === 'text' && /(?:^|\s)(?:label|annotation|caption)(?:\s|$)/i.test(attrs.class ?? '');
          if (background || annotation) continue;
          const content = tag === 'text' ? (node[key] as Record<string, unknown>[]).map(child => String(child['#text'] ?? '')).join('').trim() : '';
          if (tag === 'text' && (node[key] as Record<string, unknown>[]).some(child => Object.keys(child).some(name => name.replace(/^.*:/, '') === 'tspan'))) throw new Error('El texto con tspan necesita convertirse a contornos antes de cargarlo.');
          const d = tag === 'path' ? attrs.d : tag === 'text' ? (content ? textPath(content, attrs, style, fonts) : null) : shapePath(tag, attrs);
          if (tag === 'path' && !d) throw new Error('Un path SVG no tiene atributo d.');
          if (!d) continue;
          let geometry: ReturnType<typeof parsePathData>;
          try { geometry = parsePathData(d, matrix, toleranceMm); }
          catch (error) { throw new Error(`Elemento ${attrs.id ?? `${tag} ${pieces.length + 1}`}: ${error instanceof Error ? error.message : String(error)}`); }
          const {rings, curved} = geometry;
          if (!rings.length) continue;
          assertSimpleRings(rings);
          const polygons = filledRings(rings, tag === 'text' ? 'evenodd' : rule);
          if (!polygons.length) throw new Error(`El elemento ${attrs.id ?? tag} no contiene materia válida.`);
          const rounded = rings.some(ring => ring.some(({x, y}) => Math.abs(x * 10_000 - Math.round(x * 10_000)) > 1e-7 || Math.abs(y * 10_000 - Math.round(y * 10_000)) > 1e-7));
          const approximationErrorMm = (curved ? toleranceMm : 0) + (rounded ? Math.SQRT2 / 20_000 : 0);
          const base = attrs.id || `pieza-${pieces.length + 1}`;
          const occurrence = (names.get(base) ?? 0) + 1; names.set(base, occurrence);
          polygons.forEach((polygon, index) => pieces.push({id: `${base}${occurrence > 1 ? `-${occurrence}` : ''}${polygons.length > 1 ? `-${index + 1}` : ''}`, polygon, approximationErrorMm}));
        } else if (tag === 'line' && !invis && style.stroke !== undefined && style.stroke !== 'none' &&
          number(style['stroke-width'], 'Ancho de trazo', 1) > 0 && number(style['stroke-opacity'], 'Opacidad de trazo', 1) > 0) {
          throw new Error('Una línea SVG no encierra material; conviértela en un contorno cerrado.');
        }
        if (!drawable && Array.isArray(node[key])) visit(node[key] as Record<string, unknown>[], matrix, rule, style, invis, depth + 1);
      }
    };
    visit(rootNodes, multiply(physical, parseTransform(rootAttrs.transform)), 'nonzero', {}, false, 0);
    if (!pieces.length) throw new Error('El SVG no contiene figuras sólidas cerradas.');
    return {widthMm, heightMm, pieces};
  }
}
