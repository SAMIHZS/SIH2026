/*
 * Provider-independent model routing for the privileged MV3 service worker.
 * Content scripts and webpages never receive provider credentials.
 */
(function() {
  'use strict';

  const STORAGE_KEY = 'sihModelConfig';
  const SCREENSHOT_TOGGLE_KEY = 'sihScreenshotEnabled';

  // Providers whose chat() method can accept a base64 image payload.
  // Groq and OpenRouter route text-only models in this build.
  const VISION_PROVIDERS = new Set(['gemini']);
  const DEFAULT_CONFIG = {
    selectedProvider: '',
    selectedModel: '',
    providers: {
      groq: { configured: false, apiKey: '', models: [] },
      openrouter: { configured: false, apiKey: '', models: [] },
      gemini: { configured: false, apiKey: '', models: [] },
      local: { configured: false, models: [] }
    }
  };

  function storageGet() {
    return new Promise(resolve => chrome.storage.local.get([STORAGE_KEY], result => resolve(result[STORAGE_KEY] || DEFAULT_CONFIG)));
  }

  function storageSet(config) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: config }, () => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function mergeConfig(config) {
    return {
      ...DEFAULT_CONFIG,
      ...(config || {}),
      providers: {
        ...DEFAULT_CONFIG.providers,
        ...((config && config.providers) || {})
      }
    };
  }

  function sanitizeUserMessage(message) {
    let sanitized = String(message || '');
    sanitized = sanitized.replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '[USER_EMAIL]');
    sanitized = sanitized.replace(/(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4,}\b/g, '[USER_PHONE]');
    sanitized = sanitized.replace(/\b(?:\d[\s\-]?){13,19}\b/g, '[USER_NUMBER]');
    return sanitized;
  }

  function assertSanitizedContext(context) {
    const contextForTextChecks = { ...(context || {}) };
    if (contextForTextChecks.screenshot) {
      if (typeof contextForTextChecks.screenshot !== 'string' || !contextForTextChecks.screenshot.startsWith('data:image/')) {
        throw new Error('Provider request blocked: screenshot is not a local image data URL');
      }
      // Temporarily replace for text-pattern checks
      contextForTextChecks.screenshot = '[REDACTED_SCREENSHOT]';
    }
    delete contextForTextChecks.visualProvenance;
    delete contextForTextChecks.tabId;
    delete contextForTextChecks.generation;
    const serialized = JSON.stringify(contextForTextChecks);
    if (/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/.test(serialized)) {
      throw new Error('Provider request blocked: raw email detected in context');
    }
    if (/(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4,}\b/.test(serialized)) {
      throw new Error('Provider request blocked: raw phone detected in context');
    }
  }

  function isVisionCapableModel(providerId, modelId) {
    if (!providerId || !modelId) return false;
    if (providerId === 'gemini') {
      const lower = String(modelId).toLowerCase();
      if (lower.includes('embedding') || lower.includes('aqa') || lower.includes('text-only')) {
        return false;
      }
      return lower.includes('gemini');
    }
    return false;
  }

  function getModelCapabilities(providerId, modelId) {
    return {
      text: true,
      vision: isVisionCapableModel(providerId, modelId),
      tools: false
    };
  }

  class ModelManager {
    constructor() {
      this.providers = {
        groq: new self.SIH_GroqProvider.GroqProvider(),
        openrouter: new self.SIH_OpenRouterProvider.OpenRouterProvider(),
        gemini: new self.SIH_GeminiProvider.GeminiProvider(),
        local: new self.SIH_LocalProvider.LocalProvider()
      };
    }

    isVisionCapable(providerId, modelId) {
      return isVisionCapableModel(providerId, modelId);
    }

    getModelCapabilities(providerId, modelId) {
      return getModelCapabilities(providerId, modelId);
    }

    async getConfig() {
      return mergeConfig(await storageGet());
    }

    async getPublicConfig() {
      const config = await this.getConfig();
      const providerId = config.selectedProvider;
      const provider = this.providers[providerId];
      const selectedModel = provider?.normalizeModelId
        ? provider.normalizeModelId(config.selectedModel)
        : config.selectedModel;
      const selectedCapabilities = getModelCapabilities(providerId, selectedModel);
      return {
        selectedProvider: config.selectedProvider,
        selectedModel,
        selectedCapabilities,
        providers: Object.fromEntries(Object.entries(config.providers).map(([id, pConfig]) => [id, {
          configured: Boolean(pConfig.configured),
          available: id !== 'local',
          models: (pConfig.models || []).map(m => {
            const mId = typeof m === 'object' ? m.id : m;
            const mName = typeof m === 'object' ? m.name : m;
            return {
              id: mId,
              name: mName,
              capabilities: getModelCapabilities(id, mId)
            };
          }),
          defaultModel: this.providers[id]?.defaultModel || ''
        }]))
      };
    }

    async saveConfig(partial) {
      const existing = await this.getConfig();
      const config = mergeConfig({ ...existing, ...(partial || {}) });
      if (partial && partial.selectedProvider && partial.selectedProvider !== existing.selectedProvider) {
        // Enforce strict provider/model pairing: clear model if provider changes unless explicitly supplied
        if (!partial.selectedModel) {
          config.selectedModel = '';
        }
      }

      if (partial && partial.providers) {
        config.providers = { ...existing.providers };
        for (const [providerId, providerConfig] of Object.entries(partial.providers)) {
          config.providers[providerId] = {
            ...(existing.providers[providerId] || {}),
            ...providerConfig
          };
        }
      }
      const provider = this.providers[config.selectedProvider];
      if (provider?.normalizeModelId) {
        config.selectedModel = provider.normalizeModelId(config.selectedModel);
      }
      await storageSet(config);
      const persisted = await this.getConfig();
      if (persisted.selectedProvider !== config.selectedProvider || persisted.selectedModel !== config.selectedModel) {
        throw new Error('Configuration was not confirmed in extension storage');
      }
      return config;
    }

    async listModels(providerId) {
      const config = await this.getConfig();
      const provider = this.providers[providerId];
      const providerConfig = config.providers[providerId];
      if (!provider || !providerConfig) throw new Error('Unknown provider');
      if (providerId === 'local') return provider.listModels();
      if (!providerConfig.apiKey) throw new Error(`${provider.name} API key is not configured`);
      const models = await provider.listModels(providerConfig.apiKey);
      await this.saveConfig({ providers: { [providerId]: { ...providerConfig, configured: true, models } } });
      return models;
    }

    async testConnection(providerId) {
      const config = await this.getConfig();
      if (providerId === 'local') return this.providers.local.status();
      const models = await this.listModels(providerId);
      return { available: true, modelCount: models.length };
    }

    async chat(sanitizedContext, userMessage) {
      assertSanitizedContext(sanitizedContext);
      const started = performance.now();
      const config = await this.getConfig();
      const providerId = config.selectedProvider;
      const provider = this.providers[providerId];
      const providerConfig = config.providers[providerId];
      if (!provider || !providerConfig || !providerConfig.configured) {
        throw new Error('No AI provider is configured. Privacy protection remains active.');
      }

      if (providerId === 'local') {
        throw new Error('Local browser inference is not available in this build');
      }

      // ── Provenance assertion if visual data is attached ──
      const visual = sanitizedContext.screenshot;
      if (visual) {
        if (!sanitizedContext.visualProvenance || sanitizedContext.visualProvenance.sanitized !== true) {
          throw new Error('UNTRUSTED_VISUAL_ARTIFACT');
        }
      }

      // ── Screenshot inclusion decision ──
      const screenshotToggle = await new Promise(resolve =>
        chrome.storage.local.get([SCREENSHOT_TOGGLE_KEY], result =>
          resolve(result[SCREENSHOT_TOGGLE_KEY] !== false) // default ON
        )
      );
      const isVisionCapable = this.isVisionCapable(providerId, config.selectedModel);
      const hasScreenshot = Boolean(visual);
      const includeScreenshot = screenshotToggle && isVisionCapable && hasScreenshot;

      // Build the payload: always strip the raw screenshot and internal provenance
      const providerContext = { ...sanitizedContext };
      delete providerContext.screenshot;
      delete providerContext.visualProvenance;

      if (includeScreenshot) {
        // Enforce sanitized PNG format requirement
        if (typeof visual !== 'string' || !visual.startsWith('data:image/png;base64,')) {
          throw new Error('UNTRUSTED_VISUAL_ARTIFACT');
        }
        providerContext.screenshotRedacted = true;
        providerContext.screenshotDataUrl = visual;
      } else {
        providerContext.screenshotRedacted = hasScreenshot; // inform provider that visual data exists locally but was excluded
      }

      if (self.SIH_Logger) {
        self.SIH_Logger.log('MODEL', 'request started', {
          provider: providerId,
          model: config.selectedModel || provider.defaultModel || 'default',
          visionRequested: isVisionCapable && hasScreenshot,
          visionAttached: includeScreenshot,
          generation: sanitizedContext.visualProvenance?.generation || null,
          tabId: sanitizedContext.visualProvenance?.tabId || null,
          imageSanitized: true
        });
        self.SIH_Logger.log('PRIVACY', 'outgoing context approved', {
          text: 'sanitized',
          image: includeScreenshot ? 'sanitized' : 'none',
          rawPII: false
        });
      }

      const rawResponse = await provider.chat(
        providerConfig.apiKey,
        config.selectedModel,
        providerContext,
        sanitizeUserMessage(userMessage)
      );
      return { ...self.SIH_ProviderTypes.normalizeResponse(rawResponse), modelMs: performance.now() - started };
    }
  }

  self.SIH_ModelManager = {
    ModelManager,
    STORAGE_KEY,
    DEFAULT_CONFIG,
    sanitizeUserMessage,
    assertSanitizedContext,
    isVisionCapableModel,
    getModelCapabilities
  };
})();
