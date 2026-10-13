import {FromPS, type PsGraphicsState, type PsPath, type PsWriter} from '../vendor/udoc/FromPS.js';

type Box = [number, number, number, number];
const PT_TO_MM = 25.4 / 72;
const numberPattern = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';

function postScriptData(input: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(input);
  if (bytes.length >= 12 && bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const header = new DataView(input), offset = header.getUint32(4, true), length = header.getUint32(8, true);
    if (!length || offset < 12 || offset + length > bytes.length) throw new Error('La cabecera binaria del EPS está dañada.');
    return input.slice(offset, offset + length);
  }
  return input;
}

function readBounds(source: string): Box {
  const line = source.split(/\r?\n/).find(value => value.startsWith('%!')) ?? '';
  if (!/^%!PS(?:-Adobe)?\b/.test(line)) throw new Error('El archivo no contiene un encabezado PostScript/EPS válido.');
  const boundsFor = (label: string) => {
    const directives = [...source.matchAll(new RegExp(`^%%${label}:\\s*([^\\r\\n]*)`, 'gm'))];
    const numeric = new RegExp(`^(${numberPattern})\\s+(${numberPattern})\\s+(${numberPattern})\\s+(${numberPattern})(?:\\s|$)`);
    const first = directives[0]?.[1]?.trim() ?? '';
    const chosen = first === '(atend)' ? directives.at(-1)?.[1]?.trim() ?? '' : first;
    const match = numeric.exec(chosen);
    return match ? match.slice(1, 5).map(Number) as Box : null;
  };
  const bounds = boundsFor('HiResBoundingBox') ?? boundsFor('BoundingBox');
  if (!bounds || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1])
    throw new Error('El EPS necesita un %%BoundingBox válido para conocer sus medidas físicas.');
  if ((bounds[2] - bounds[0]) * PT_TO_MM > 100_000 || (bounds[3] - bounds[1]) * PT_TO_MM > 100_000)
    throw new Error('Las dimensiones físicas del EPS son demasiado grandes.');
  return bounds;
}

function safeClip(clip: PsPath | null, bounds: Box): boolean {
  if (!clip || !/^MLLLL?Z$/.test(clip.cmds.join(''))) return false;
  const vertices = new Set<string>();
  for (let index = 0; index < clip.crds.length; index += 2) {
    const x = clip.crds[index], y = clip.crds[index + 1];
    if (![bounds[0], bounds[2]].some(value => Math.abs(x - value) < 1e-6) ||
        ![bounds[1], bounds[3]].some(value => Math.abs(y - value) < 1e-6)) return false;
    vertices.add(`${Math.round(x * 1e6)}:${Math.round(y * 1e6)}`);
  }
  return vertices.size === 4;
}

function svgPath(path: PsPath, bounds: Box): string {
  const result: string[] = [];
  let index = 0, open = false;
  const coordinate = (): string => {
    const x = path.crds[index++] - bounds[0], y = bounds[3] - path.crds[index++];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('El EPS contiene coordenadas no finitas.');
    return `${x} ${y}`;
  };
  for (const command of path.cmds) {
    if (command === 'M') { if (open) result.push('Z'); result.push(`M${coordinate()}`); open = true; }
    else if (command === 'L') { if (!open) throw new Error('El EPS contiene un trazado incompleto.'); result.push(`L${coordinate()}`); }
    else if (command === 'C') { if (!open) throw new Error('El EPS contiene una curva incompleta.'); result.push(`C${coordinate()} ${coordinate()} ${coordinate()}`); }
    else if (command === 'Z') { if (open) result.push('Z'); open = false; }
    else throw new Error(`Comando vectorial EPS no compatible: ${command}.`);
  }
  if (open) result.push('Z'); // PostScript fill implicitly closes every subpath.
  if (index !== path.crds.length) throw new Error('El EPS contiene un trazado incompleto.');
  return result.join(' ');
}

/** Turns a vector EPS into SVG paths in physical PostScript-point units. */
export class EpsConverter {
  static physicalDimensions(input: ArrayBuffer): {widthMm: number; heightMm: number} {
    if (input.byteLength > 16_000_000) throw new Error('El EPS supera 16 MB.');
    const source = new TextDecoder('latin1').decode(postScriptData(input));
    const bounds = readBounds(source);
    return {widthMm: (bounds[2] - bounds[0]) * PT_TO_MM, heightMm: (bounds[3] - bounds[1]) * PT_TO_MM};
  }

  static toSvg(input: ArrayBuffer): string {
    if (input.byteLength > 16_000_000) throw new Error('El EPS supera 16 MB.');
    const postScript = postScriptData(input);
    const source = new TextDecoder('latin1').decode(postScript);
    const bounds = readBounds(source), paths: string[] = [];
    let pageCount = 0, lastFilledPath: string | null = null;
    const writer: PsWriter = {
      StartPage() { if (++pageCount > 1) throw new Error('El EPS contiene varias páginas; exporta una sola pieza gráfica.'); },
      ShowPage() {}, Done() {},
      Fill(state: PsGraphicsState, evenOdd: boolean) {
        if (!safeClip(state.cpth, bounds)) throw new Error('El EPS usa un recorte de contorno que todavía no se puede convertir con seguridad.');
        const d = svgPath(state.pth, bounds);
        lastFilledPath = JSON.stringify(state.pth);
        if (d) paths.push(`<path id="pieza-${paths.length + 1}" fill-rule="${evenOdd ? 'evenodd' : 'nonzero'}" d="${d}"/>`);
      },
      Stroke(state: PsGraphicsState) {
        // A painted outline over the exact filled path is decoration, not a new cut piece.
        if (lastFilledPath === JSON.stringify(state.pth)) return;
        throw new Error('El EPS contiene trazos sin contorno cerrado; conviértelos a formas antes de cargarlo.');
      },
      PutText() { throw new Error('El EPS contiene texto editable; conviértelo a contornos antes de cargarlo.'); },
      PutImage() { throw new Error('El EPS contiene imágenes raster; se necesitan contornos vectoriales para el acomodo.'); },
    };
    try { FromPS.Parse(postScript, writer, bounds); }
    catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('No se pudo interpretar el EPS. Exporta un EPS vectorial estándar o un SVG.');
    }
    if (!paths.length) throw new Error('El EPS no contiene figuras vectoriales rellenas.');
    const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}pt" height="${height}pt" viewBox="0 0 ${width} ${height}">${paths.join('')}</svg>`;
  }
}
