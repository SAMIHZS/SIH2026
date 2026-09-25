/** Settings page backed by the existing privileged Model Manager messages. */
document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('providerSelect');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const modelSelect = document.getElementById('modelSelect');
  const modelInput = document.getElementById('modelInput');
  const discoverModelsButton = document.getElementById('discoverModels');
  const saveProviderButton = document.getElementById('saveProvider');
  const testProviderButton = document.getElementById('testProvider');
  const connectionStatus = document.getElementById('connectionStatus');
  const privacySettingsStatus = document.getElementById('privacySettingsStatus');
  const themeToggle = document.getElementById('themeToggle');
  const themeLightBtn = document.getElementById('themeLightBtn');
  const themeDarkBtn = document.getElementById('themeDarkBtn');
  let publicConfig = null;

  loadConfig();
  window.SIH_Theme?.getStoredTheme(theme => {
    themeToggle.checked = theme === 'dark';
    updateSegmentedToggle(theme);
  });

  themeToggle.addEventListener('change', () => {
    const t = themeToggle.checked ? 'dark' : 'light';
    window.SIH_Theme?.setTheme(t);
    updateSegmentedToggle(t);
  });

  function updateSegmentedToggle(theme) {
    if (!themeLightBtn || !themeDarkBtn) return;
    const isDark = theme === 'dark';
    themeLightBtn.classList.toggle('active', !isDark);
    themeDarkBtn.classList.toggle('active', isDark);
    themeLightBtn.setAttribute('aria-pressed', String(!isDark));
    themeDarkBtn.setAttribute('aria-pressed', String(isDark));
  }

  if (themeLightBtn) {
    themeLightBtn.addEventListener('click', () => {
      themeToggle.checked = false;
      window.SIH_Theme?.setTheme('light');
      updateSegmentedToggle('light');
    });
  }

  if (themeDarkBtn) {
    themeDarkBtn.addEventListener('click', () => {
      themeToggle.checked = true;
      window.SIH_Theme?.setTheme('dark');
      updateSegmentedToggle('dark');
    });
  }
  chrome.runtime.sendMessage({ type: 'GET_PRIVACY_STATE' }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    privacySettingsStatus.textContent = response.enabled ? 'Active' : 'Disabled';
    privacySettingsStatus.className = response.enabled ? 'status-chip status-chip-green' : 'status-chip status-chip-coral';
  });

  providerSelect.addEventListener('change', () => {
    renderProviderState();
    updatePrivacyNote();
    if (providerSelect.value === 'local') {
      setStatus('Local inference reports availability honestly from the extension runtime.', 'neutral');
    } else {
      setStatus('', 'neutral');
    }
  });

  modelSelect.addEventListener('change', () => {
    if (modelSelect.value) modelInput.value = modelSelect.value;
  });

  discoverModelsButton.addEventListener('click', () => {
    const providerId = providerSelect.value;
    if (!providerId || providerId === 'local') {
      setStatus('Local model discovery is unavailable until a browser-local runtime is installed.', 'neutral');
      return;
    }
    setStatus('Discovering models…', 'neutral');
    chrome.runtime.sendMessage({ type: 'MODEL_LIST_MODELS', providerId }, (response) => {
      if (chrome.runtime.lastError || response?.error) {
        setStatus(response?.error || 'Model discovery failed.', 'error');
        return;
      }
      publicConfig.providers[providerId].models = response.models || [];
      renderProviderState();
      setStatus(`${response.models?.length || 0} models available.`, 'success');
    });
  });

  saveProviderButton.addEventListener('click', () => {
    const providerId = providerSelect.value;
    if (!providerId) {
      setStatus('Choose a provider first.', 'error');
      return;
    }
    const apiKey = apiKeyInput.value.trim();
    if (providerId !== 'local' && !apiKey && !publicConfig.providers[providerId]?.configured) {
      setStatus('Enter an API key before saving this provider.', 'error');
      return;
    }
    const model = modelInput.value.trim() || getDefaultModel(providerId);
    saveProviderButton.textContent = 'Saving...';
    saveProviderButton.disabled = true;
    const providerConfig = {
      configured: providerId === 'local' || Boolean(apiKey) || Boolean(publicConfig.providers[providerId]?.configured),
      ...(apiKey ? { apiKey } : {})
    };
    chrome.runtime.sendMessage({
      type: 'MODEL_SAVE_CONFIG',
      config: {
        selectedProvider: providerId,
        selectedModel: model,
        providers: { [providerId]: providerConfig }
      }
    }, (response) => {
      if (chrome.runtime.lastError || response?.error) {
        saveProviderButton.textContent = 'Save configuration';
        saveProviderButton.disabled = false;
        setStatus(response?.error || chrome.runtime.lastError?.message || 'Configuration could not be saved.', 'error');
        return;
      }
      apiKeyInput.value = '';
      loadConfig();
      saveProviderButton.textContent = 'Save configuration';
      saveProviderButton.disabled = false;
      setStatus('Configuration saved. The API key remains masked.', 'success');
    });
  });

  testProviderButton.addEventListener('click', () => {
    const providerId = providerSelect.value;
    if (!providerId) return setStatus('Choose a provider first.', 'error');
    setStatus('Testing connection…', 'neutral');
    chrome.runtime.sendMessage({ type: 'MODEL_TEST_CONNECTION', providerId }, (response) => {
      if (chrome.runtime.lastError || !response?.available) {
        setStatus(response?.error || response?.reason || 'Provider unavailable.', 'error');
        return;
      }
      setStatus(`Connected. ${response.modelCount || 0} models available.`, 'success');
      if (providerId !== 'local') discoverModelsButton.click();
    });
  });

  function loadConfig() {
    chrome.runtime.sendMessage({ type: 'MODEL_GET_CONFIG' }, (config) => {
      if (chrome.runtime.lastError || !config) {
        setStatus('Settings could not be loaded.', 'error');
        return;
      }
      publicConfig = config;
      providerSelect.value = config.selectedProvider || '';
      renderProviderState();
      updatePrivacyNote();
      if (!config.selectedProvider) setStatus('Not configured', 'neutral');
    });
  }

  function renderProviderState() {
    if (!publicConfig) return;
    const providerId = providerSelect.value;
    const provider = publicConfig.providers?.[providerId] || { models: [] };
    const models = provider.models || [];
    modelSelect.replaceChildren();
    if (models.length) {
      modelSelect.hidden = false;
      for (const model of models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name || model.id;
        modelSelect.appendChild(option);
      }
      modelSelect.value = publicConfig.selectedModel || models[0].id;
      modelInput.value = modelSelect.value;
    } else {
      modelSelect.hidden = true;
      modelInput.value = publicConfig.selectedModel || getDefaultModel(providerId);
    }
    apiKeyInput.value = '';
    apiKeyInput.placeholder = provider.configured ? 'Key saved — enter a new key to replace it' : 'Stored in extension storage';
    discoverModelsButton.disabled = !providerId || providerId === 'local';
  }

  function getDefaultModel(providerId) {
    return publicConfig?.providers?.[providerId]?.defaultModel || '';
  }

  /** Provider display names for the privacy-note label. */
  const PROVIDER_DISPLAY_NAMES = {
    groq: 'Groq',
    openrouter: 'OpenRouter',
    gemini: 'Google Gemini',
    local: 'Local Model'
  };

  /**
   * Update the .privacy-note span dynamically from publicConfig.
   * Reflects the actual configured provider instead of a static string.
   */
  function updatePrivacyNote() {
    const noteEl = document.getElementById('privacyNoteText') || document.querySelector('.privacy-note');
    if (!noteEl) return;
    const pid = publicConfig?.selectedProvider;
    const provider = publicConfig?.providers?.[pid];
    if (pid && provider?.configured) {
      const displayName = PROVIDER_DISPLAY_NAMES[pid] || pid;
      noteEl.textContent = `${displayName} configured \u00b7 Local sanitization remains active`;
    } else {
      noteEl.textContent = 'No provider configured \u00b7 Local sanitization active';
    }
  }

  function setStatus(message, kind) {
    connectionStatus.textContent = message;
    connectionStatus.className = `connection-status ${kind}`;
  }
});
