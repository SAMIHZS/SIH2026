/* Shared provider contracts for the privileged Model Manager. */
(function() {
  'use strict';

  function textResponse(content, meta) {
    return { type: 'text', message: String(content || ''), ...(meta || {}) };
  }

  function actionResponse(action, meta) {
    return { type: 'action', action, ...(meta || {}) };
  }

  function normalizeResponse(value) {
    if (!value || typeof value !== 'object') throw new Error('Provider returned an invalid response');
    if (value.type === 'text' && typeof value.message === 'string' && value.message.trim()) return textResponse(value.message);
    if (value.type === 'text' && typeof value.content === 'string' && value.content.trim()) return textResponse(value.content);
    if (value.type === 'action' && value.action && typeof value.action === 'object') {
      const action = value.action;
      const actionName = action.action || action.type;
      if (!['click', 'type', 'scroll'].includes(actionName)) throw new Error('Provider returned a disallowed action');
      return actionResponse({
        action: actionName,
        target: typeof action.target === 'string' ? action.target : '',
        ...(action.value !== undefined ? { value: String(action.value) } : action.text !== undefined ? { value: String(action.text) } : {}),
        ...(action.amount !== undefined ? { value: String(action.amount) } : {}),
        ...(action.riskLevel ? { riskLevel: String(action.riskLevel) } : {})
      });
    }
    throw new Error('Provider returned an unsupported response shape');
  }

  if (typeof self !== 'undefined') {
    self.SIH_ProviderTypes = { textResponse, actionResponse, normalizeResponse };
  }
})();
