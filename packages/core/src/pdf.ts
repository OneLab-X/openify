/**
 * A tiny PDF 1.4 writer for invoices: A4 pages, the standard Helvetica and Helvetica-Bold fonts
 * (WinAnsi encoding, no embedding), text, lines and filled rectangles. Hand-rolled instead of a
 * PDF library (DECISIONS.md D-047): invoices only need text and rules, and this stays dependency
 * free. Coordinates are points from the top-left (converted to PDF's bottom-left origin).
 */
export const A4 = { width: 595.28, height: 841.89 } as const;

// Helvetica advance widths (1/1000 em) for code points 32–126 (Adobe AFM).
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667,
  556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500,
  500, 500, 334, 260, 334, 584,
];
// Helvetica-Bold differs mostly in lowercase/punctuation; same digits (556), so numbers align.
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722,
  611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556,
  556, 500, 389, 280, 389, 584,
];

/** Characters outside ASCII that WinAnsi has; everything else becomes "?". */
const WIN_ANSI: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "×": 0xd7, "°": 0xb0, "©": 0xa9, "®": 0xae, "·": 0xb7 };

export type Font = "regular" | "bold";

function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.replace(/₹/g, "Rs.").normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c <= 126) out.push(c);
    else if (WIN_ANSI[ch]) out.push(WIN_ANSI[ch]);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else out.push(63);
  }
  return out;
}

export function textWidth(text: string, size: number, font: Font = "regular"): number {
  const table = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  return (encode(text).reduce((w, c) => w + (c >= 32 && c <= 126 ? table[c - 32]! : 556), 0) * size) / 1000;
}

/** Splits text into lines that fit `width`. */
export function wrap(text: string, size: number, width: number, font: Font = "regular"): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, font) <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

function pdfString(text: string): string {
  return `(${encode(text)
    .map((c) => (c === 40 || c === 41 || c === 92 ? `\\${String.fromCharCode(c)}` : c < 32 || c > 126 ? `\\${c.toString(8).padStart(3, "0")}` : String.fromCharCode(c)))
    .join("")})`;
}

export class PdfDocument {
  private pages: string[][] = [];
  private ops: string[] = [];

  constructor(private readonly meta: { title: string; author?: string }) {
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
  }

  text(x: number, y: number, text: string, opts: { size?: number; font?: Font; align?: "left" | "right" | "center"; color?: [number, number, number] } = {}) {
    const size = opts.size ?? 9;
    const font = opts.font ?? "regular";
    const w = textWidth(text, size, font);
    const left = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    const [r, g, b] = opts.color ?? [0, 0, 0];
    this.ops.push(`BT ${num(r)} ${num(g)} ${num(b)} rg /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${num(left)} ${num(A4.height - y)} Td ${pdfString(text)} Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, gray = 0) {
    this.ops.push(`${num(gray)} G ${num(width)} w ${num(x1)} ${num(A4.height - y1)} m ${num(x2)} ${num(A4.height - y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, fillGray: number) {
    this.ops.push(`${num(fillGray)} g ${num(x)} ${num(A4.height - y - h)} ${num(w)} ${num(h)} re f 0 g`);
  }

  /** Serialises to bytes (latin1: every content byte is < 256). */
  toBuffer(): Buffer {
    const objects: string[] = [];
    // push() returns the new length, which is the 1-based object number.
    const add = (body: string) => objects.push(body);
    const catalog = add("");
    const pagesObj = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    const info = add(`<< /Title ${pdfString(this.meta.title)} /Producer (Shopkit)${this.meta.author ? ` /Author ${pdfString(this.meta.author)}` : ""} >>`);

    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}
