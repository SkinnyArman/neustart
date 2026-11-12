// A small .xlsx writer: one sheet, text cells, a coloured header row that
// stays put when scrolling, a filter on every column, and optional colours
// per cell. No library: an .xlsx is a zip of a few XML files, written here
// uncompressed (a few kB for a tracker).

export interface Sheet {
  name: string;
  head: { title: string; fill: string; width: number }[];   // fill: "RRGGBB", a soft colour with dark bold text
  rows: string[][];
  cellFill?: (row: number, col: number, value: string) => string | undefined;   // a cell's background, or none
}

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const colName = (i: number) => { let s = ""; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

export function xlsx(sheet: Sheet): Uint8Array {
  // styles: 0 plain, then one bold header style per header colour, then one per body colour
  const headFills = sheet.head.map((h) => h.fill.toUpperCase());
  const bodyFills: string[] = [];
  const body = sheet.rows.map((r, ri) => r.map((v, ci) => {
    const f = sheet.cellFill?.(ri, ci, v)?.toUpperCase();
    if (f && !bodyFills.includes(f)) bodyFills.push(f);
    return f;
  }));
  const fills = [...headFills, ...bodyFills];
  const fillXml = `<fills count="${fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    fills.map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join("") + `</fills>`;
  const border = `<borders count="2"><border/><border><left style="thin"><color rgb="FFD0D0D0"/></left><right style="thin"><color rgb="FFD0D0D0"/></right>` +
    `<top style="thin"><color rgb="FFD0D0D0"/></top><bottom style="thin"><color rgb="FFD0D0D0"/></bottom></border></borders>`;
  const xf = (font: number, fill: number) => `<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><color rgb="FF222222"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/></font></fonts>
${fillXml}${border}
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${fills.length + 1}">${xf(0, 0)}${headFills.map((_, i) => xf(1, i + 2)).join("")}${bodyFills.map((_, i) => xf(0, headFills.length + i + 2)).join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const styleOf = (fill?: string) => (fill ? headFills.length + bodyFills.indexOf(fill) + 1 : 0);
  const cell = (ref: string, v: string, s: number) => `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
  const last = colName(sheet.head.length - 1);
  const rowsXml = [
    `<row r="1" ht="22" customHeight="1">${sheet.head.map((h, i) => cell(`${colName(i)}1`, h.title, i + 1)).join("")}</row>`,
    ...sheet.rows.map((r, ri) => `<row r="${ri + 2}">${r.map((v, ci) => cell(`${colName(ci)}${ri + 2}`, v, styleOf(body[ri][ci]))).join("")}</row>`),
  ].join("");
  const ws = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${sheet.head.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${h.width}" customWidth="1"/>`).join("")}</cols>
<sheetData>${rowsXml}</sheetData>
<autoFilter ref="A1:${last}${sheet.rows.length + 1}"/>
</worksheet>`;
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${x(sheet.name.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${x(sheet.name.slice(0, 31))}'!$A$1:$${last}$${sheet.rows.length + 1}</definedName></definedNames></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", styles],
    ["xl/worksheets/sheet1.xml", ws],
  ];
  return zip(files.map(([n, s]) => [n, new TextEncoder().encode(s)]));
}

// ---------------------------------------------------------------- zip, stored (no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const v of b) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = new TextEncoder().encode(name), crc = crc32(data);
    const local = new Uint8Array(30 + n.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const cen = new Uint8Array(46 + n.length), cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true); cen.set(n, 46);
    parts.push(local, data); central.push(cen);
    offset += local.length + data.length;
  }
  const size = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let p = 0;
  for (const c of [...parts, ...central, end]) { out.set(c, p); p += c.length; }
  return out;
}
