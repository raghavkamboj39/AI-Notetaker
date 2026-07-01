const fs = require("fs");
const AdmZip = require("adm-zip");

/**
 * Extract plain text from a PDF file.
 *
 * pdf-parse v2 rewrote its API as a PDFParse class instead of the old
 * v1 single-function export. We pass the file as a Buffer via the
 * `data` option (as opposed to `url`, which is for remote PDFs) and
 * call getText() to get { text, ... }.
 */
async function extractFromPDF(filePath) {
  const { PDFParse } = require("pdf-parse");
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return (result.text || "").trim();
}

/**
 * Extract plain text from a Word (.docx) file.
 */
async function extractFromDOCX(filePath) {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  return (result.value || "").trim();
}

/**
 * Extract plain text from an Excel (.xlsx / .xls) file.
 * Reads every sheet and renders each row as tab-separated values,
 * prefixed with the sheet name so context isn't lost across sheets.
 */
function extractFromXLSX(filePath) {
  const XLSX = require("xlsx");
  const workbook = XLSX.readFile(filePath);
  const parts = [];

  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: "\t" });
    if (csv && csv.trim()) {
      parts.push(`## Sheet: ${sheetName}\n\n${csv.trim()}`);
    }
  });

  return parts.join("\n\n---\n\n").trim();
}

/**
 * Extract plain text from a PowerPoint (.pptx) file.
 *
 * A .pptx is a zip archive containing one XML file per slide under
 * ppt/slides/slideN.xml. Each slide's visible text lives inside <a:t>
 * tags (DrawingML text runs). We don't need a full OOXML parser — just
 * walking every slideN.xml in order and pulling <a:t>...</a:t> contents
 * gives us the slide text in reading order, which is all the notes
 * pipeline needs.
 */
function extractFromPPTX(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  // Collect slide entries and sort numerically (slide1, slide2, ... slide10)
  // so a plain string sort doesn't put slide10 before slide2.
  const slideEntries = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)\.xml/)[1], 10);
      const numB = parseInt(b.entryName.match(/slide(\d+)\.xml/)[1], 10);
      return numA - numB;
    });

  if (slideEntries.length === 0) {
    return "";
  }

  const slideTexts = slideEntries.map((entry, idx) => {
    const xml = entry.getData().toString("utf8");
    const matches = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)];
    const text = matches.map(m => decodeXmlEntities(m[1])).join(" ").trim();
    return text ? `## Slide ${idx + 1}\n\n${text}` : `## Slide ${idx + 1}\n\n(no text)`;
  });

  return slideTexts.join("\n\n---\n\n").trim();
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Convenience dispatcher: given a file path and its original filename,
 * pick the right extractor based on extension and return plain text.
 * Throws if the extension isn't supported — callers should check
 * isSupportedDocument() first if they want to branch before calling.
 */
async function extractTextFromDocument(filePath, originalName) {
  const ext = (originalName.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();

  switch (ext) {
    case "pdf":
      return await extractFromPDF(filePath);
    case "docx":
      return await extractFromDOCX(filePath);
    case "pptx":
      return extractFromPPTX(filePath);
    case "xlsx":
    case "xls":
      return extractFromXLSX(filePath);
    default:
      throw new Error(`Unsupported document type: .${ext}`);
  }
}

function isSupportedDocument(originalName) {
  return /\.(pdf|docx|pptx|xlsx|xls)$/i.test(originalName);
}

module.exports = {
  extractFromPDF,
  extractFromDOCX,
  extractFromXLSX,
  extractFromPPTX,
  extractTextFromDocument,
  isSupportedDocument,
};