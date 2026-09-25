/* Lazy MediaPipe Tasks Vision face detector adapter. */
(function() {
  'use strict';

  function configure(options) {
    if (!window.SIH_VisionDetector) return;
    window.SIH_VisionDetector.configureLoader(async () => {
      let vision = options?.vision || window.SIH_MediaPipeVision;
      if (!vision && typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        try {
          vision = await import(chrome.runtime.getURL('vendor/mediapipe/vision_bundle.mjs'));
        } catch (e) {
          // Dynamic import may fail under file:// CORS
        }
      }
      if (!vision && window.FilesetResolver && window.FaceDetector) {
        vision = { FilesetResolver: window.FilesetResolver, FaceDetector: window.FaceDetector };
      }
      if (!vision || !vision.FilesetResolver || !vision.FaceDetector) return null;
      const wasmRoot = options?.wasmRoot || (typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('vendor/mediapipe/wasm')
        : '../extension/vendor/mediapipe/wasm');
      const modelPath = options?.modelPath || (typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('vendor/mediapipe/models/blaze_face_short_range.tflite')
        : '../extension/vendor/mediapipe/models/blaze_face_short_range.tflite');
      const fileset = await vision.FilesetResolver.forVisionTasks(wasmRoot);
      const detector = await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.5
      });
      return {
        detect(image) {
          const result = detector.detect(image);
          return (result.detections || []).map((detection, index) => {
            const box = detection.boundingBox || {};
            return {
              id: `face_${index + 1}`,
              type: 'face',
              confidence: detection.categories?.[0]?.score || 0,
              bbox: {
                x: box.originX || 0,
                y: box.originY || 0,
                width: box.width || 0,
                height: box.height || 0
              }
            };
          });
        }
      };
    });
  }

  if (typeof window !== 'undefined') window.SIH_MediaPipeLoader = { configure };
})();
