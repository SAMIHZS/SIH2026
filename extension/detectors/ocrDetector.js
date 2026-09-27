/*
 * Local OCR detector boundary.
 * Authoritative local OCR runtime wrapping Tesseract.js.
 * Operates purely locally within extension contexts (e.g. Offscreen Document).
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
  let activeWorker = null;

  function canLoadRuntime() {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.getURL);
  }

  function isAvailable() {
    const hasGlobalTesseract = (typeof self !== 'undefined' && typeof self.Tesseract !== 'undefined') ||
                               (typeof window !== 'undefined' && typeof window.Tesseract !== 'undefined');
    return hasGlobalTesseract || canLoadRuntime();
  }

  function getTesseractRoot() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL('vendor/tesseract/');
    }
    return '../extension/vendor/tesseract/';
  }

  async function loadRuntime() {
    if (typeof self !== 'undefined' && typeof self.Tesseract !== 'undefined') {
      return self.Tesseract;
    }
    if (typeof window !== 'undefined' && typeof window.Tesseract !== 'undefined') {
      return window.Tesseract;
    }
    if (!canLoadRuntime()) return null;
    if (!runtimePromise) {
      const esmUrl = chrome.runtime.getURL('vendor/tesseract/tesseract.esm.min.js');
      runtimePromise = import(esmUrl)
        .then(module => module.default || module)
        .catch(err => {
          runtimePromise = null;
          console.warn('[SIH][OCR] Failed to import tesseract.esm.min.js:', err?.message);
          return null;
        });
    }
    return runtimePromise;
  }

  async function createWorker(arg1, arg2, arg3) {
    let lang = 'eng';
    let oem = 1;
    let options = {};

    if (typeof arg1 === 'string') {
      lang = arg1;
      if (typeof arg2 === 'number') {
        oem = arg2;
        options = (typeof arg3 === 'object' && arg3 !== null) ? arg3 : {};
      } else if (typeof arg2 === 'object' && arg2 !== null) {
        options = arg2;
      }
    } else if (typeof arg1 === 'object' && arg1 !== null) {
      options = arg1;
      lang = options.language || 'eng';
      oem = options.oem ?? 1;
    }

    const runtime = await loadRuntime();
    if (!runtime?.createWorker) {
      console.warn('[SIH][OCR] Tesseract runtime or createWorker unavailable');
      return null;
    }

    const root = options.root || getTesseractRoot();
    const workerOptions = {
      workerPath: options.workerPath || `${root}worker.min.js`,
      corePath: options.corePath || `${root}core/`,
      langPath: options.langPath || `${root}lang/`,
      workerBlobURL: false,
      cacheMethod: 'none',
      ...options
    };
    delete workerOptions.root;
    delete workerOptions.language;
    delete workerOptions.oem;

    const worker = await runtime.createWorker(lang, oem, workerOptions);
    activeWorker = worker;
    return worker;
  }

  async function getWorker(options) {
    if (activeWorker) return activeWorker;
    if (workerPromise) return workerPromise;
    workerPromise = createWorker(options).catch(err => {
      workerPromise = null;
      throw err;
    });
    return workerPromise;
  }

  async function terminate() {
    if (activeWorker) {
      try {
        await activeWorker.terminate();
      } catch (_) {}
      activeWorker = null;
    }
    workerPromise = null;
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
    if (!isAvailable()) {
      return { available: false, detections: [], text: '', reason: 'OCR runtime is not installed' };
    }
    const initStarted = performance.now();
    let worker;
    try {
      worker = await getWorker(options);
    } catch (err) {
      return {
        available: false,
        detections: [],
        text: '',
        reason: err.message,
        timings: { ocrInitMs: performance.now() - initStarted }
      };
    }
    const ocrInitMs = performance.now() - initStarted;
    if (!worker) {
      return {
        available: false,
        detections: [],
        text: '',
        reason: 'OCR runtime failed to load',
        timings: { ocrInitMs }
      };
    }

    const inferenceStarted = performance.now();
    const result = await worker.recognize(image);
    const ocrMs = performance.now() - inferenceStarted;
    const text = result?.data?.text || '';
    return {
      available: true,
      text,
      detections: classifyText(text, options),
      textLength: text.length,
      timings: { ocrInitMs, ocrMs }
    };
  }

  const SIH_OcrDetector = {
    isAvailable,
    canLoadRuntime,
    loadRuntime,
    createWorker,
    getWorker,
    recognize,
    terminate,
    classifyText
  };

  if (typeof self !== 'undefined') {
    self.SIH_OcrDetector = SIH_OcrDetector;
  }
  if (typeof window !== 'undefined') {
    window.SIH_OcrDetector = SIH_OcrDetector;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SIH_OcrDetector;
  }
})();
