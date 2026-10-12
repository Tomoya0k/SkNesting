import opentype from 'opentype.js';
import tinosUrl from '@fontsource/tinos/files/tinos-latin-400-normal.woff?url';
import tinosBoldUrl from '@fontsource/tinos/files/tinos-latin-700-normal.woff?url';
import arimoUrl from '@fontsource/arimo/files/arimo-latin-400-normal.woff?url';
import arimoBoldUrl from '@fontsource/arimo/files/arimo-latin-700-normal.woff?url';
import gothicUrl from '@fontsource/unifrakturcook/files/unifrakturcook-latin-700-normal.woff?url';
import {GeometryParser, type SvgFonts} from './engine/GeometryParser.ts';
import {EpsConverter} from './engine/EpsConverter.ts';
import {NestingEngine} from './engine/NestingEngine.ts';
import type {NestingConfig, NestingResult, ProgressEvent} from './engine/types.ts';

type Request = {id: number; source: string | ArrayBuffer; format: 'svg' | 'eps'; config: NestingConfig};
type Reply = {id: number; kind: 'progress'; progress: ProgressEvent} | {id: number; kind: 'result'; result: NestingResult} | {id: number; kind: 'error'; message: string};
const send = (reply: Reply) => self.postMessage(reply);
let fontsPromise: Promise<SvgFonts> | null = null;
function loadFonts(): Promise<SvgFonts> {
  fontsPromise ??= Promise.all([tinosUrl, tinosBoldUrl, arimoUrl, arimoBoldUrl, gothicUrl].map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('No se pudieron cargar las fuentes SVG.');
    return opentype.parse(await response.arrayBuffer());
  })).then(([serif, serifBold, sans, sansBold, gothic]) => ({serif, serifBold, sans, sansBold, gothic}));
  return fontsPromise;
}
self.onmessage = async (event: MessageEvent<Request>) => {
  const {id, source, format, config} = event.data;
  const deadlineMs = performance.now() + 110_000;
  try {
    const svg = format === 'eps' ? EpsConverter.toSvg(source as ArrayBuffer) : source as string;
    const fonts = /<text(?:\s|>)/i.test(svg) ? await loadFonts() : undefined;
    let result: NestingResult | null = null;
    for (let tolerance = config.curveToleranceMm ?? 0.25, retry = 0; retry < 5; retry++, tolerance /= 2) {
      const parsed = GeometryParser.parseSvg(svg, tolerance, fonts);
      result = NestingEngine.runSync(parsed.pieces, {...config, curveToleranceMm: tolerance}, progress => send({id, kind: 'progress', progress}), deadlineMs);
      if (!result.error?.includes('No se pudo certificar el encaje')) break;
    }
    send({id, kind: 'result', result: result!});
  } catch (error) { send({id, kind: 'error', message: error instanceof Error ? error.message : String(error)}); }
};
