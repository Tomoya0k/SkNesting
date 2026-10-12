import './styles.css';
import type {NestingConfig, NestingResult, Placement, ProgressEvent} from './engine/types.ts';
import {consumedSheets} from './sheetUsage.ts';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const file = get<HTMLInputElement>('file'), width = get<HTMLInputElement>('width'), height = get<HTMLInputElement>('height'), gap = get<HTMLInputElement>('gap'), edge = get<HTMLInputElement>('edge');
const calculate = get<HTMLButtonElement>('calculate'), cancel = get<HTMLButtonElement>('cancel'), status = get<HTMLParagraphElement>('status');
const progress = get<HTMLProgressElement>('progress'), results = get<HTMLElement>('results'), summary = get<HTMLElement>('summary');
const sheetStage = get<HTMLElement>('sheet-stage');
let worker: Worker | null = null, active = 0, current: NestingResult | null = null, config: NestingConfig | null = null;
const fmt = (value: number, digits = 2) => Number(value.toFixed(digits)).toLocaleString('es-MX', {maximumFractionDigits: digits});
const cmToMm = (value: string) => Number(value) * 10;
function setStatus(message: string, error = false) { status.textContent = message; status.classList.toggle('error', error); }
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
function stop() { if (worker) { worker.terminate(); worker = null; } calculate.disabled = false; cancel.disabled = true; progress.hidden = true; }
calculate.onclick = async () => {
  const selected = file.files?.[0];
  if (!selected) { setStatus('Selecciona un archivo SVG o EPS.', true); return; }
  const format = /\.eps$/i.test(selected.name) || selected.type === 'application/postscript' ? 'eps' : /\.svg$/i.test(selected.name) || selected.type === 'image/svg+xml' ? 'svg' : null;
  if (!format) { setStatus('Selecciona un archivo SVG o EPS.', true); return; }
  const limitMb = format === 'eps' ? 16 : 8;
  if (selected.size > limitMb * 1_000_000) { setStatus(`El archivo supera ${limitMb} MB.`, true); return; }
  const sheetWidthMm = cmToMm(width.value), sheetHeightMm = cmToMm(height.value), gapMm = cmToMm(gap.value), edgeMarginMm = cmToMm(edge.value);
  if ([width, height, gap, edge].some(input => !input.value.trim()) || ![sheetWidthMm, sheetHeightMm, gapMm, edgeMarginMm].every(Number.isFinite) || sheetWidthMm <= 2 * edgeMarginMm || sheetHeightMm <= 2 * edgeMarginMm || edgeMarginMm < 0 || gapMm < 0) { setStatus('Indica dimensiones mayores que el doble del margen y separaciones no negativas, en cm.', true); return; }
  stop(); results.hidden = true; current = null;
  config = {sheetWidthMm, sheetHeightMm, gapMm, edgeMarginMm, curveToleranceMm: 0.25};
  const source = format === 'eps' ? await selected.arrayBuffer() : await selected.text(), id = ++active;
  worker = new Worker(new URL('./nesting.worker.ts', import.meta.url), {type: 'module'});
  calculate.disabled = true; cancel.disabled = false; progress.hidden = false; progress.value = 0;
  setStatus(`Analizando ${format.toUpperCase()} y calculando acomodo…`);
  const timeout = window.setTimeout(() => { if (worker && id === active) { stop(); setStatus('El cálculo superó 180 segundos. Simplifica el SVG o reduce las piezas.', true); } }, 180_000);
  worker.onmessage = (event: MessageEvent<{id: number; kind: string; result?: NestingResult; progress?: ProgressEvent; message?: string}>) => {
    const message = event.data; if (message.id !== active) return;
    if (message.kind === 'progress' && message.progress) {
      progress.value = Math.min(0.95, message.progress.completed / Math.max(1, message.progress.total));
      if (message.progress.stage === 'repair') setStatus('Revisando giros y espacios entre piezas para reducir el consumo de hoja…');
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
