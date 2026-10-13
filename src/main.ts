import './styles.css';
import type {NestingConfig, NestingResult, Placement, ProgressEvent} from './engine/types.ts';
import {readSvgSizeInfo} from './engine/SvgDimensions.ts';
import {consumedSheets} from './sheetUsage.ts';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const file = get<HTMLInputElement>('file'), width = get<HTMLInputElement>('width'), height = get<HTMLInputElement>('height'), gap = get<HTMLInputElement>('gap'), edge = get<HTMLInputElement>('edge');
const artworkWidth = get<HTMLInputElement>('artwork-width'), artworkHeight = get<HTMLInputElement>('artwork-height'), lockAspect = get<HTMLInputElement>('lock-aspect');
const calculate = get<HTMLButtonElement>('calculate'), cancel = get<HTMLButtonElement>('cancel'), status = get<HTMLParagraphElement>('status');
const progress = get<HTMLProgressElement>('progress'), results = get<HTMLElement>('results'), summary = get<HTMLElement>('summary');
const sheetStage = get<HTMLElement>('sheet-stage');
let worker: Worker | null = null, active = 0, current: NestingResult | null = null, config: NestingConfig | null = null;
type FileFormat = 'svg' | 'eps';
type LoadedArtwork = {file: File; format: FileFormat; source: string | ArrayBuffer; aspectRatio: number | null};
let loadedArtwork: LoadedArtwork | null = null, artworkRatio: number | null = null, fileReadId = 0;
const fmt = (value: number, digits = 2) => Number(value.toFixed(digits)).toLocaleString('es-MX', {maximumFractionDigits: digits});
const cmToMm = (value: string) => Number(value) * 10;
const cmValue = (millimeters: number) => String(Number((millimeters / 10).toFixed(4)));
function setStatus(message: string, error = false) { status.textContent = message; status.classList.toggle('error', error); }
function syncArtworkDimension(changed: 'width' | 'height') {
  if (lockAspect.checked && artworkRatio !== null) {
    const source = changed === 'width' ? artworkWidth : artworkHeight;
    const target = changed === 'width' ? artworkHeight : artworkWidth;
    const value = Number(source.value);
    if (!source.value.trim() || !Number.isFinite(value) || value <= 0) target.value = '';
    else target.value = String(Number((changed === 'width' ? value / artworkRatio : value * artworkRatio).toFixed(4)));
  }
  results.hidden = true;
  if (!calculate.disabled) {
    const w = Number(artworkWidth.value), h = Number(artworkHeight.value);
    setStatus(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ?
      `Tamaño físico listo: ${fmt(w, 4)} × ${fmt(h, 4)} cm.` :
      'Completa el ancho y el alto físicos del diseño para calcular el acomodo.');
  }
}
function detectFormat(selected: File): FileFormat | null {
  return /\.eps$/i.test(selected.name) || selected.type === 'application/postscript' ? 'eps' :
    /\.svg$/i.test(selected.name) || selected.type === 'image/svg+xml' ? 'svg' : null;
}
function setArtworkDimensions(widthMm: number | null, heightMm: number | null, aspectRatio: number | null) {
  artworkRatio = aspectRatio;
  artworkWidth.disabled = artworkHeight.disabled = lockAspect.disabled = false;
  artworkWidth.value = widthMm !== null ? cmValue(widthMm) : '';
  artworkHeight.value = heightMm !== null ? cmValue(heightMm) : '';
}
file.onchange = async () => {
  const requestId = ++fileReadId, selected = file.files?.[0];
  results.hidden = true;
  loadedArtwork = null; artworkRatio = null;
  artworkWidth.value = artworkHeight.value = '';
  artworkWidth.disabled = artworkHeight.disabled = lockAspect.disabled = true;
  if (!selected) { setStatus('Carga un SVG con medidas físicas o un EPS con BoundingBox.'); return; }
  const format = detectFormat(selected);
  if (!format) { setStatus('Selecciona un archivo SVG o EPS.', true); return; }
  const limitMb = format === 'eps' ? 16 : 8;
  if (selected.size > limitMb * 1_000_000) { setStatus(`El archivo supera ${limitMb} MB.`, true); return; }
  setStatus('Leyendo las medidas físicas del diseño…');
  try {
    const source = format === 'eps' ? await selected.arrayBuffer() : await selected.text();
    if (requestId !== fileReadId || file.files?.[0] !== selected) return;
    let dimensions: {widthMm: number; heightMm: number} | null, ratio: number | null, inferredDimension: 'width' | 'height' | null = null;
    if (format === 'eps') {
      const {EpsConverter} = await import('./engine/EpsConverter.ts');
      if (requestId !== fileReadId || file.files?.[0] !== selected) return;
      dimensions = EpsConverter.physicalDimensions(source as ArrayBuffer);
      ratio = dimensions.widthMm / dimensions.heightMm;
    } else {
      const size = readSvgSizeInfo(source as string);
      dimensions = size.dimensions; ratio = size.aspectRatio;
      inferredDimension = size.inferredDimension;
    }
    loadedArtwork = {file: selected, format, source, aspectRatio: ratio};
    setArtworkDimensions(dimensions?.widthMm ?? null, dimensions?.heightMm ?? null, ratio);
    if (dimensions) setStatus(`Medidas ${inferredDimension ? 'detectadas y completadas con la proporción del viewBox' : 'detectadas'}: ${fmt(dimensions.widthMm / 10, 4)} × ${fmt(dimensions.heightMm / 10, 4)} cm.`);
    else setStatus('El archivo no declara las dos medidas físicas; puedes asignarlas en los campos de arriba.');
  } catch (error) {
    if (requestId !== fileReadId) return;
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
};
artworkWidth.oninput = () => syncArtworkDimension('width');
artworkHeight.oninput = () => syncArtworkDimension('height');
lockAspect.onchange = () => {
  if (lockAspect.checked) {
    const w = Number(artworkWidth.value), h = Number(artworkHeight.value);
    if (w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h)) artworkRatio = w / h;
  }
  syncArtworkDimension('width');
};
function ringPath(ring: {x: number; y: number}[]) { return ring.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ') + ' Z'; }
function placementPath(placement: Placement) { const visit = (polygon: Placement['polygon']): string => [ringPath(polygon.outer), ...polygon.holes.map(visit)].join(' '); return visit(placement.polygon); }
function render() {
  if (!current || !config || current.error) return;
  const result = current, sheetConfig = config;
  results.hidden = false;
  summary.replaceChildren();
  const consumed = consumedSheets(result);
  const card = document.createElement('div'); card.className = 'metric';
  const title = document.createElement('span'), strong = document.createElement('strong');
  title.textContent = 'Hojas consumidas'; strong.textContent = `${fmt(consumed)} ${consumed === 1 ? 'hoja' : 'hojas'}`;
  card.append(title, strong); summary.append(card);
  const physicalCard = document.createElement('div'); physicalCard.className = 'metric';
  const physicalTitle = document.createElement('span'), physicalCount = document.createElement('strong');
  physicalTitle.textContent = 'Hojas físicas';
  physicalCount.textContent = `${result.sheetCount} ${result.sheetCount === 1 ? 'hoja' : 'hojas'}`;
  physicalCard.append(physicalTitle, physicalCount); summary.append(physicalCard);
  sheetStage.replaceChildren();
  for (const region of result.regions) {
    const selected = result.placements.filter(placement => placement.sheet === region.sheet);
    const sheetCard = document.createElement('article'); sheetCard.className = 'sheet-card';
    const heading = document.createElement('h3'); heading.textContent = `Hoja ${region.sheet + 1} de ${result.sheetCount}`;
    const usage = document.createElement('p'); usage.className = 'sheet-usage';
    usage.textContent = `Franja utilizada: ${region.fraction * 100} %`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${sheetConfig.sheetWidthMm} ${sheetConfig.sheetHeightMm}`);
    svg.setAttribute('width', String(sheetConfig.sheetWidthMm)); svg.setAttribute('height', String(sheetConfig.sheetHeightMm));
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Acomodo vertical de la hoja ${region.sheet + 1}; divisiones a un cuarto, mitad y tres cuartos`);
    const createRect = (x: number, y: number, w: number, h: number, fill: string, stroke = 'none') => {
      const rect = document.createElementNS(svg.namespaceURI, 'rect');
      rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y)); rect.setAttribute('width', String(w)); rect.setAttribute('height', String(h));
      rect.setAttribute('fill', fill); rect.setAttribute('stroke', stroke); svg.append(rect);
    };
    createRect(0, 0, sheetConfig.sheetWidthMm, sheetConfig.sheetHeightMm, '#fff');
    createRect(0, 0, sheetConfig.sheetWidthMm, region.height, '#eff6ff');
    const margin = sheetConfig.edgeMarginMm ?? 20;
    createRect(margin, margin, sheetConfig.sheetWidthMm - 2 * margin, region.height - 2 * margin, 'none', '#64748b');
    selected.forEach((placement, index) => {
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', placementPath(placement)); path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('fill', index % 2 ? '#fb923c' : '#38bdf8'); path.setAttribute('stroke', '#334155');
      path.setAttribute('stroke-width', String(Math.max(0.3, sheetConfig.sheetWidthMm / 1500)));
      const tooltip = document.createElementNS(svg.namespaceURI, 'title'); tooltip.textContent = `${placement.pieceId} · ${placement.rotation}°`; path.append(tooltip); svg.append(path);
    });
    for (const fraction of [0.25, 0.5, 0.75]) {
      const y = sheetConfig.sheetHeightMm * fraction;
      const guide = document.createElementNS(svg.namespaceURI, 'line');
      guide.setAttribute('x1', '0'); guide.setAttribute('x2', String(sheetConfig.sheetWidthMm));
      guide.setAttribute('y1', String(y)); guide.setAttribute('y2', String(y));
      guide.setAttribute('stroke', '#ca8a04'); guide.setAttribute('stroke-opacity', '0.4');
      guide.setAttribute('stroke-width', '1'); guide.setAttribute('vector-effect', 'non-scaling-stroke');
      guide.setAttribute('data-quarter', String(fraction));
      svg.append(guide);
    }
    sheetCard.append(heading, usage, svg); sheetStage.append(sheetCard);
  }
}
function stop() {
  if (worker) { worker.terminate(); worker = null; }
  calculate.disabled = false; cancel.disabled = true; progress.hidden = true; file.disabled = false;
  artworkWidth.disabled = artworkHeight.disabled = lockAspect.disabled = !loadedArtwork;
}
calculate.onclick = async () => {
  const selected = file.files?.[0];
  if (!selected) { setStatus('Selecciona un archivo SVG o EPS.', true); return; }
  const format = detectFormat(selected);
  if (!format) { setStatus('Selecciona un archivo SVG o EPS.', true); return; }
  if (!loadedArtwork || loadedArtwork.file !== selected || loadedArtwork.format !== format) { setStatus('Espera a que termine de leer las medidas del archivo.', true); return; }
  const limitMb = format === 'eps' ? 16 : 8;
  if (selected.size > limitMb * 1_000_000) { setStatus(`El archivo supera ${limitMb} MB.`, true); return; }
  const artworkWidthMm = cmToMm(artworkWidth.value), artworkHeightMm = cmToMm(artworkHeight.value);
  if ([artworkWidth.value, artworkHeight.value].some(value => !value.trim()) || ![artworkWidthMm, artworkHeightMm].every(value => Number.isFinite(value) && value > 0)) { setStatus('Indica un ancho y un alto físicos mayores que cero para el diseño, en cm.', true); return; }
  const sheetWidthMm = cmToMm(width.value), sheetHeightMm = cmToMm(height.value), gapMm = cmToMm(gap.value), edgeMarginMm = cmToMm(edge.value);
  if ([width, height, gap, edge].some(input => !input.value.trim()) || ![sheetWidthMm, sheetHeightMm, gapMm, edgeMarginMm].every(Number.isFinite) || sheetWidthMm <= 2 * edgeMarginMm || sheetHeightMm <= 2 * edgeMarginMm || edgeMarginMm < 0 || gapMm < 0) { setStatus('Indica dimensiones mayores que el doble del margen y separaciones no negativas, en cm.', true); return; }
  stop(); results.hidden = true; current = null;
  config = {sheetWidthMm, sheetHeightMm, gapMm, edgeMarginMm, curveToleranceMm: 0.25, artworkWidthMm, artworkHeightMm};
  const source = loadedArtwork.source, id = ++active;
  worker = new Worker(new URL('./nesting.worker.ts', import.meta.url), {type: 'module'});
  calculate.disabled = true; cancel.disabled = false; progress.hidden = false; progress.value = 0;
  file.disabled = artworkWidth.disabled = artworkHeight.disabled = lockAspect.disabled = true;
  setStatus(`Analizando ${format.toUpperCase()} y calculando acomodo…`);
  const timeout = window.setTimeout(() => { if (worker && id === active) { stop(); setStatus('El cálculo superó 180 segundos. Simplifica el SVG o reduce las piezas.', true); } }, 180_000);
  worker.onmessage = (event: MessageEvent<{id: number; kind: string; result?: NestingResult; progress?: ProgressEvent; message?: string}>) => {
    const message = event.data; if (message.id !== active) return;
    if (message.kind === 'progress' && message.progress) {
      progress.value = Math.min(0.95, message.progress.completed / Math.max(1, message.progress.total));
      if (message.progress.stage === 'repair') setStatus('Revisando giros y espacios entre piezas para reducir el consumo de hoja…');
      if (message.progress.stage === 'repack') setStatus(`Comparando acomodos completos. Mejor consumo: ${fmt(message.progress.bestConsumedSheets ?? message.progress.bestSheetCount)} hojas…`);
      return;
    }
    window.clearTimeout(timeout); stop();
    if (message.kind === 'error') { setStatus(message.message ?? 'No se pudo calcular el acomodo.', true); return; }
    current = message.result ?? null;
    if (!current || current.error) {
      const detail = current?.unplaceable?.orientations.map(item => `${item.rotation}°: ${fmt(item.width)} × ${fmt(item.height)} mm`).join('; ');
      setStatus(`${current?.error ?? 'No se obtuvo un resultado.'}${detail ? ` Orientaciones: ${detail}.` : ''}`, true); return;
    }
    const count = current.placements.length;
    setStatus(current.method === 'fast' ? `Acomodo válido de ${count} piezas con método rápido para archivo complejo.` : current.limited ? `Acomodo válido de ${count} piezas; se alcanzó el límite de cálculo.` : `Acomodo terminado: ${count} piezas.`); render();
  };
  worker.onerror = event => { window.clearTimeout(timeout); stop(); setStatus(event.message || 'Error en el Worker.', true); };
  worker.postMessage({id, source, format, config});
};
cancel.onclick = () => { active++; stop(); setStatus('Cálculo cancelado.'); };
