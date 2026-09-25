/**
 * Local screenshot redaction helper.
 * Raw screenshot pixels are processed in the content context and never returned
 * to a provider without local masking.
 */
(function() {
  'use strict';

  function toViewportRect(rect) {
    if (!rect || typeof rect !== 'object') {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    // COORDINATE FIX: Rects are viewport-relative (domDetector uses getBoundingClientRect
    // without scrollX/Y addition). Do NOT subtract scroll here — that was the double-offset bug.
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      width: Math.max(0, Number.isFinite(width) ? width : 0),
      height: Math.max(0, Number.isFinite(height) ? height : 0)
    };
  }


  function redactImage(dataUrl, rects) {
    return new Promise((resolve, reject) => {
      if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        reject(new Error('Invalid image data URL provided for redaction'));
        return;
      }
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || 1;
        canvas.height = image.naturalHeight || 1;
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Canvas 2D context unavailable'));
          return;
        }

        context.drawImage(image, 0, 0);
        const scaleX = canvas.width / Math.max(1, typeof window !== 'undefined' ? window.innerWidth : canvas.width);
        const scaleY = canvas.height / Math.max(1, typeof window !== 'undefined' ? window.innerHeight : canvas.height);
        for (const rawRect of Array.isArray(rects) ? rects : []) {
          const viewportRect = toViewportRect(rawRect);
          if (viewportRect.width <= 0 || viewportRect.height <= 0) continue;
          context.fillStyle = '#111827';
          const drawX = Math.max(0, viewportRect.x * scaleX);
          const drawY = Math.max(0, viewportRect.y * scaleY);
          const drawWidth = Math.max(0, Math.min(canvas.width - drawX, viewportRect.width * scaleX));
          const drawHeight = Math.max(0, Math.min(canvas.height - drawY, viewportRect.height * scaleY));
          if (drawWidth > 0 && drawHeight > 0) {
            context.fillRect(drawX, drawY, drawWidth, drawHeight);
          }
        }
        const resultUrl = canvas.toDataURL('image/png');
        // Release canvas backing store and image memory
        canvas.width = 0;
        canvas.height = 0;
        image.src = '';
        resolve(resultUrl);
      };
      image.onerror = () => reject(new Error('Screenshot image could not be decoded'));
      image.src = dataUrl;
    });
  }

  if (typeof window !== 'undefined') {
    window.SIH_Redactor = { redactImage, toViewportRect };
  }
})();
