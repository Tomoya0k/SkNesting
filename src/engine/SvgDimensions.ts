import {XMLParser, XMLValidator} from 'fast-xml-parser';

export interface PhysicalDimensions {widthMm: number; heightMm: number}

export interface SvgSizeInfo {
  dimensions: PhysicalDimensions | null;
  /** Width divided by height, from physical units when available or the viewBox otherwise. */
  aspectRatio: number | null;
  inferredDimension: 'width' | 'height' | null;
}

export function tryPhysicalMm(value: string | undefined): number | null {
  const match = value?.trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|in|pt)$/i);
  if (!match) return null;
  const factor = {mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72}[match[2].toLowerCase() as 'mm' | 'cm' | 'in' | 'pt'];
  const result = Number(match[1]) * factor;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function physicalMm(value: string | undefined): number {
  const result = tryPhysicalMm(value);
  if (result === null) {
    if (value?.trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|in|pt)$/i)) throw new Error('Dimensión física SVG inválida.');
    throw new Error('El SVG debe declarar width y height en mm, cm, in o pt.');
  }
  return result;
}

export function readSvgSizeInfo(source: string): SvgSizeInfo {
  if (source.length > 8_000_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SVG demasiado grande o con entidades no admitidas.');
  if (XMLValidator.validate(source) !== true) throw new Error('El archivo SVG no es XML válido.');
  const parsed = new XMLParser({preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false}).parse(source) as Record<string, unknown>[];
  const root = parsed.find(entry => Object.keys(entry).some(key => key.replace(/^.*:/, '') === 'svg'));
  if (!root) throw new Error('El archivo no contiene un elemento svg.');
  const attrs = (root[':@'] ?? {}) as Record<string, string>;
  const widthMm = tryPhysicalMm(attrs.width), heightMm = tryPhysicalMm(attrs.height);
  const view = attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
  const viewRatio = view && view.length === 4 && view.every(Number.isFinite) && view[2] > 0 && view[3] > 0 ? view[2] / view[3] : null;
  const aspectRatio = widthMm !== null && heightMm !== null ? widthMm / heightMm : viewRatio;
  const inferredDimension = widthMm !== null && heightMm === null && aspectRatio !== null ? 'height' :
    widthMm === null && heightMm !== null && aspectRatio !== null ? 'width' : null;
  let dimensions: PhysicalDimensions | null = null;
  if (widthMm !== null && heightMm !== null) dimensions = {widthMm, heightMm};
  else if (widthMm !== null && inferredDimension === 'height' && aspectRatio !== null) dimensions = {widthMm, heightMm: widthMm / aspectRatio};
  else if (heightMm !== null && inferredDimension === 'width' && aspectRatio !== null) dimensions = {widthMm: heightMm * aspectRatio, heightMm};
  return {
    dimensions,
    aspectRatio,
    inferredDimension,
  };
}
