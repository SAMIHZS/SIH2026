/*
 * Local OCR detector boundary.
 * The detector can classify OCR output immediately; the OCR runtime is lazy and
 * optional until a browser-compatible OCR bundle is installed.
 */
(function() {
  'use strict';

  const PATTERNS = [
    { type: 'email', pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, confidence: 0.88 },
    { type: 'phone', pattern: /(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4,}\b/g, confidence: 0.78 },
    { type: 'ssn', pattern: /\b\d{3}[\-\s]\d{2}[\-\s]\d{4}\b/g, confidence: 0.82 },
    { type: 'card', pattern: /\b(?:\d[\s\-]?){13,19}\b/g, confidence: 0.72 }
  ];

  let runtimePromise = null;
  let workerPromise = null;

  function canLoadRuntime() {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.getURL);
  }

  function isAvailable() {
    return typeof self.Tesseract !== 'undefined' || canLoadRuntime();
  }

  function getTesseractRoot() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL('vendor/tesseract/');
    }
    return '../extension/vendor/tesseract/';
  }

  async function loadRuntime() {
    if (typeof self.Tesseract !== 'undefined') return self.Tesseract;
    if (!canLoadRuntime()) return null;
    if (!runtimePromise) {
      runtimePromise = import(chrome.runtime.getURL('vendor/tesseract/tesseract.esm.min.js'))
        .then(module => module.default || module)
        .catch(() => null);
    }
    return runtimePromise;
  }

  async function getWorker(options) {
    if (workerPromise) return workerPromise;
    const runtime = await loadRuntime();
    if (!runtime?.createWorker) return null;
    const root = options?.root || getTesseractRoot();
    workerPromise = runtime.createWorker(options?.language || 'eng', 1, {
      workerPath: options?.workerPath || `${root}worker.min.js`,
      corePath: options?.corePath || `${root}core/`,
      langPath: options?.langPath || `${root}lang/`,
      cacheMethod: 'none'
    }).catch(() => null);
    return workerPromise;
  }

  function classifyText(text, options) {
    const detections = [];
    const input = String(text || '');
    const rect = options?.bbox;
    for (const config of PATTERNS) {
      config.pattern.lastIndex = 0;
      let match;
      while ((match = config.pattern.exec(input)) !== null) {
        detections.push({
          id: `ocr_${detections.length + 1}`,
          elementId: options?.elementId,
          type: config.type,
          value: match[0],
          source: 'ocr',
          confidence: config.confidence,
          ...(rect ? { rect: { ...rect }, bbox: { ...rect } } : {})
        });
      }
    }
    return detections;
  }

  async function recognize(image, options) {
    if (!canLoadRuntime() && typeof self.Tesseract === 'undefined') {
      return { available: false, detections: [], reason: 'OCR runtime is not installed' };
    }
    const initStarted = performance.now();
    const worker = await getWorker(options);
    const ocrInitMs = performance.now() - initStarted;
    if (!worker) return { available: false, detections: [], reason: 'OCR runtime failed to load', timings: { ocrInitMs } };
    const inferenceStarted = performance.now();
    const result = await worker.recognize(image);
    const ocrMs = performance.now() - inferenceStarted;
    const text = result?.data?.text || '';
    return { available: true, detections: classifyText(text, options), textLength: text.length, timings: { ocrInitMs, ocrMs } };
  }

  if (typeof self !== 'undefined') self.SIH_OcrDetector = { isAvailable, canLoadRuntime, loadRuntime, classifyText, recognize };
})();
