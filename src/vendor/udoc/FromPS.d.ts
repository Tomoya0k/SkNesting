export interface PsPath {cmds: string[]; crds: number[]}
export interface PsGraphicsState {
  pth: PsPath;
  cpth: PsPath | null;
  colr: number[];
}
export interface PsWriter {
  StartPage(x0: number, y0: number, x1: number, y1: number): void;
  ShowPage(): void;
  Done(): void;
  Fill(state: PsGraphicsState, evenOdd: boolean): void;
  Stroke(state: PsGraphicsState): void;
  PutText(state: PsGraphicsState, text: string, width: number): void;
  PutImage(state: PsGraphicsState, image: Uint8Array, width: number, height: number, mask?: Uint8Array): void;
}
export const FromPS: {Parse(buffer: ArrayBuffer, writer: PsWriter, bounds?: number[]): void};
