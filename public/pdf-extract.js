// pdf-extract.js
// Client-side only, per the spec's "nothing is uploaded to the server"
// rule — this is the ingestion step.
//
// pdf.js and its Worker script are vendored locally (public/vendor/) rather
// than loaded from a CDN at runtime — this used to load both from
// jsDelivr, which broke PDF import specifically on iOS Safari. pdf.js
// needs to spin up a Worker to parse in a background thread, and
// cross-origin Worker/module-worker loading is a long-standing source of
// browser-specific failures — WebKit (Safari's engine) has repeatedly been
// named in pdf.js's own issue tracker for exactly this ("Setting up fake
// worker failed", worker not loading on Safari/iOS). Vendoring means the
// worker loads same-origin, same as the rest of the app, and removes a
// runtime dependency on an external CDN being reachable at all — which
// also matters for the app's offline-first design (idb and ts-fsrs were
// vendored for the same reason; see public/vendor/*.LICENSE.txt).
//
// Not pre-cached in sw.js's SHELL_ASSETS on purpose: these two files are
// ~1.7MB together, and most installs may never import a PDF. The service
// worker's generic same-origin fetch handler opportunistically caches any
// same-origin asset the first time it's actually requested, so this still
// gets cached for offline reuse after first use — just not forced on
// everyone at install time.

let pdfjsLibPromise = null;

async function loadPdfjs() {
  if (pdfjsLibPromise) return pdfjsLibPromise;

  // The import() specifier is relative to this module's own URL, which is
  // well-defined and unambiguous. workerSrc is different: pdf.js uses this
  // string internally to construct `new Worker(...)`, and different pdf.js
  // versions have resolved a relative workerSrc against different bases
  // (the page URL vs. pdf.js's own module URL) — using a relative path
  // here risked resolving to /vendor/vendor/pdf.worker.min.mjs in some
  // cases. An absolute, site-root path sidesteps that ambiguity entirely.
  pdfjsLibPromise = import('./vendor/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
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

  // getDocument() returns a PDFDocumentLoadingTask, not the document itself
  // — destroy() lives on the loading task, NOT on the PDFDocumentProxy that
  // `.promise` resolves to. Keep the task around so cleanup can call the
  // right object; calling `.destroy()` on the resolved document throws
  // "destroy is not a function".
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

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

  await loadingTask.destroy();

  return pageTexts.join('\n\n');
}

/**
 * Validates a File before attempting extraction — cheap check to give a
 * clear error instead of pdf.js throwing something cryptic on a non-PDF.
 */
export function isPdfFile(file) {
  return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
}
