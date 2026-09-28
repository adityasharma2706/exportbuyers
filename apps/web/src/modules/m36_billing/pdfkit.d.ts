/**
 * M36 — local ambient declaration for `pdfkit`.
 *
 * pdfkit is a classic CommonJS package (a `main` field, no `exports` map and no shipped
 * `.d.ts`/`typings` field). Rather than adding `@types/pdfkit` as a second, independently
 * versioned source of truth for a surface this module barely touches, this declares exactly the
 * chainable subset invoice PDF rendering (pdf.ts) actually calls — mirroring M28's
 * js-yaml.d.ts precedent of a narrow, accurate local ambient module for a dependency whose own
 * typing story does not fit this workspace's `moduleResolution: "bundler"`/`"NodeNext"` setup.
 */
declare module 'pdfkit' {
  interface PDFDocumentOptions {
    size?: string | [number, number];
    margin?: number;
    margins?: { top: number; bottom: number; left: number; right: number };
    bufferPages?: boolean;
  }

  interface PDFTextOptions {
    align?: 'left' | 'center' | 'right' | 'justify';
    continued?: boolean;
    underline?: boolean;
  }

  class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    fontSize(size: number): this;
    font(name: string): this;
    fillColor(color: string): this;
    text(text: string, options?: PDFTextOptions): this;
    text(text: string, x: number, y: number, options?: PDFTextOptions): this;
    moveDown(lines?: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(color?: string): this;
    strokeColor(color: string): this;
    lineWidth(width: number): this;
    end(): void;
    readonly y: number;
    readonly page: { width: number; height: number; margins: { top: number; bottom: number; left: number; right: number } };
  }

  export default PDFDocument;
}
