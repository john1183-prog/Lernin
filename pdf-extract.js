// pdf-extract.js
// Client-side only, per the spec's "nothing is uploaded to the server"
// rule — this is the ingestion step. Loaded from jsDelivr (auto-serves the
// npm `pdfjs-dist` package), pinned to a specific version so a pdf.js
// release doesn't silently change behavior under you.
//
// VERIFIED just now: pdfjs-dist's current published version is 6.1.200
// (checked against npm directly, not recalled from training — pdf.js
// versions move fast enough that I didn't trust my own memory here).
// Bump PDFJS_VERSION deliberately, not accidentally, when you want a newer
// build — don't switch to an unpinned "latest" URL.

const PDFJS_VERSION = '6.1.200';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

let pdfjsLibPromise = null;

async function loadPdfjs() {
  if (pdfjsLibPromise) return pdfjsLibPromise;

  pdfjsLibPromise = import(/* @vite-ignore */ `${PDFJS_BASE}/pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
    return lib;
  });

  return pdfjsLibPromise;
}

/**
 * Extracts plain text from a PDF File object, page by page, entirely
 * client-side. Returns one joined string — chunk_text() on the backend
 * handles splitting it back up for the LLM call.
 *
 * @param {File} file
 * @param {(progress: {page: number, totalPages: number}) => void} [onProgress]
 * @returns {Promise<string>}
 */
export async function extractTextFromPdf(file, onProgress) {
  const pdfjsLib = await loadPdfjs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageTexts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(' ');
    pageTexts.push(pageText);

    if (onProgress) onProgress({ page: pageNum, totalPages: pdf.numPages });

    // Release page resources as we go — matters on a phone-class device
    // working through a long PDF.
    page.cleanup();
  }

  await pdf.destroy();

  return pageTexts.join('\n\n');
}

/**
 * Validates a File before attempting extraction — cheap check to give a
 * clear error instead of pdf.js throwing something cryptic on a non-PDF.
 */
export function isPdfFile(file) {
  return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
}
