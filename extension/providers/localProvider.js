/* Honest local inference capability boundary for Phase 2. */
(function() {
  'use strict';

  class LocalProvider {
    constructor() {
      this.id = 'local';
      this.name = 'Local Model';
      this.defaultModel = '';
    }

    normalizeModelId(model) {
      return String(model || '').trim();
    }

    async status() {
      return {
        available: false,
        reason: 'No browser-local inference runtime is bundled in this Phase 2 build.'
      };
    }

    async listModels() {
      return [];
    }

    async chat() {
      throw new Error('Local browser inference is not available in this build');
    }
  }

  if (typeof self !== 'undefined') self.SIH_LocalProvider = { LocalProvider };
})();
