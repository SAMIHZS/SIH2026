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
    const serialized = JSON.stringify(contextForTextChecks);
    if (/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/.test(serialized)) {
      throw new Error('Provider request blocked: raw email detected in context');
    }
    if (/(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4,}\b/.test(serialized)) {
      throw new Error('Provider request blocked: raw phone detected in context');
    }
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
      return {
        selectedProvider: config.selectedProvider,
        selectedModel,
        providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
          configured: Boolean(provider.configured),
          models: provider.models || [],
          defaultModel: this.providers[id]?.defaultModel || ''
        }]))
      };
    }

    async saveConfig(partial) {
      const existing = await this.getConfig();
      const config = mergeConfig({ ...existing, ...(partial || {}) });
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

      // ── Screenshot inclusion decision ──────────────────────────────────────
      // Read the user's screenshot-sharing toggle from storage.
      const screenshotToggle = await new Promise(resolve =>
        chrome.storage.local.get([SCREENSHOT_TOGGLE_KEY], result =>
          resolve(result[SCREENSHOT_TOGGLE_KEY] !== false) // default ON
        )
      );
      const providerSupportsVision = VISION_PROVIDERS.has(providerId);
      const hasScreenshot = Boolean(sanitizedContext.screenshot);
      const includeScreenshot = screenshotToggle && providerSupportsVision && hasScreenshot;

      // Build the payload: always strip the raw screenshot first, then optionally reattach
      const providerContext = { ...sanitizedContext };
      delete providerContext.screenshot; // default: strip

      if (includeScreenshot) {
        // Double-check: value must still be a local data URL (assertSanitizedContext already verified)
        providerContext.screenshotRedacted = true;
        providerContext.screenshotDataUrl = sanitizedContext.screenshot;
      } else {
        providerContext.screenshotRedacted = hasScreenshot; // inform provider that visual data was captured but not forwarded
      }

      // Emit payload diagnostics (structured format per spec requirement)
      console.group('[PROVIDER]');
      console.info('Provider:', providerId.toUpperCase());
      console.info('Model:', config.selectedModel || provider.defaultModel || 'default');
      console.info('Vision supported:', providerSupportsVision ? 'TRUE' : 'FALSE');
      console.info('Screenshot sharing:', screenshotToggle ? 'ON' : 'OFF');
      console.info('Sanitized image attached:', includeScreenshot ? 'TRUE' : 'FALSE');
      if (includeScreenshot) {
        console.info('Screenshot sanitized: TRUE');
        console.info('Screenshot bytes:', sanitizedContext.screenshot.length);
      } else {
        console.info('Screenshot reason:', !screenshotToggle ? 'TOGGLE OFF' : !providerSupportsVision ? 'PROVIDER UNSUPPORTED' : 'NO SCREENSHOT');
      }
      console.info('API request constructed: YES');
      console.groupEnd();


      const rawResponse = await provider.chat(
        providerConfig.apiKey,
        config.selectedModel,
        providerContext,
        sanitizeUserMessage(userMessage)
      );
      return { ...self.SIH_ProviderTypes.normalizeResponse(rawResponse), modelMs: performance.now() - started };
    }
  }

  self.SIH_ModelManager = { ModelManager, STORAGE_KEY, DEFAULT_CONFIG, sanitizeUserMessage, assertSanitizedContext };
})();
