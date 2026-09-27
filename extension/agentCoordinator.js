/**
 * AgentCoordinator — SIH26171 Phase 8
 *
 * Implements safe, bounded, multi-step agent planning and transaction execution.
 *
 * Invariants:
 * 1. Hard step limit (MAX_STEPS = 5). Model cannot increase or disable it.
 * 2. Hard transaction timeout (MAX_TRANSACTION_TIME_MS = 30000).
 * 3. At most ONE executable browser action per step. Batch execution is strictly forbidden.
 * 4. Re-observe after every action: DOM, ElementRegistry, generation, and bounded visual/OCR context.
 * 5. Generation safety: Stale generation or navigation terminates the transaction.
 * 6. Action confirmation: Confirms real effect (DOM transition, input value, scroll offset).
 * 7. Loop detection: Repeated identical actions without state change trigger LOOP_DETECTED.
 * 8. Concurrency policy: One active transaction per tab; concurrent attempts on same tab are rejected.
 * 9. Bounded history: Metadata-only, max 10 entries (0 raw OCR, 0 DOM dumps, 0 screenshots).
 * 10. Model never receives direct browser execution privileges.
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.SIH_AgentCoordinator = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Central Limits & Constants ──
  const MAX_STEPS = 5;
  const MAX_TRANSACTION_TIME_MS = 30000;
  const PAGE_SETTLE_TIMEOUT_MS = 3000;
  const MAX_HISTORY_ENTRIES = 10;
  const MAX_RETRIES_PER_ACTION = 1;

  const ALLOWED_ACTIONS = ['click', 'type', 'scroll'];

  const STATUS = {
    PLANNING: 'PLANNING',
    OBSERVING: 'OBSERVING',
    GROUNDING: 'GROUNDING',
    VALIDATING: 'VALIDATING',
    EXECUTING: 'EXECUTING',
    WAITING_FOR_PAGE: 'WAITING_FOR_PAGE',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    STALE: 'STALE'
  };

  const ERROR_CODES = {
    TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
    STALE_GENERATION: 'STALE_GENERATION',
    WRONG_TAB: 'WRONG_TAB',
    ELEMENT_NOT_INTERACTABLE: 'ELEMENT_NOT_INTERACTABLE',
    ACTION_REJECTED: 'ACTION_REJECTED',
    PAGE_CHANGED: 'PAGE_CHANGED',
    EXECUTION_FAILED: 'EXECUTION_FAILED',
    MAX_STEPS_REACHED: 'MAX_STEPS_REACHED',
    TRANSACTION_TIMEOUT: 'TRANSACTION_TIMEOUT',
    TRANSACTION_ACTIVE: 'TRANSACTION_ACTIVE',
    LOOP_DETECTED: 'LOOP_DETECTED',
    PROVIDER_FAILED: 'PROVIDER_FAILED',
    USER_CANCELLED: 'USER_CANCELLED',
    TAB_CLOSED: 'TAB_CLOSED',
    MULTIPLE_ACTIONS_FORBIDDEN: 'MULTIPLE_ACTIONS_FORBIDDEN',
    INVALID_MODEL_OUTPUT: 'INVALID_MODEL_OUTPUT',
    UNSUPPORTED_ACTION_TYPE: 'UNSUPPORTED_ACTION_TYPE',
    OVERSIZED_MODEL_RESPONSE: 'OVERSIZED_MODEL_RESPONSE',
    AUTH_FAILED: 'AUTH_FAILED',
    RATE_LIMITED: 'RATE_LIMITED',
    NETWORK_FAILED: 'NETWORK_FAILED',
    TIMEOUT: 'TIMEOUT'
  };

  // Active transactions keyed by tabId
  const activeTransactionsByTab = new Map();
  // All transactions by transactionId
  const allTransactions = new Map();

  let nextTxSeq = 1;

  /**
   * Classify provider errors safely and scrub any potential credential leaks.
   */
  function classifyProviderError(err) {
    if (!err) return { code: ERROR_CODES.PROVIDER_FAILED, message: 'Provider request failed' };

    let msg = typeof err === 'string' ? err : (err.message || 'Provider request failed');
    // Scrub potential keys/tokens from error messages
    msg = msg.replace(/AIzaSy[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
    msg = msg.replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
    msg = msg.replace(/gsk_[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
    msg = msg.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, '[REDACTED_AUTH]');
    msg = msg.replace(/key=[A-Za-z0-9._\-]+/gi, 'key=[REDACTED]');

    const lower = msg.toLowerCase();
    let code = ERROR_CODES.PROVIDER_FAILED;

    if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
      code = ERROR_CODES.AUTH_FAILED;
    } else if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
      code = ERROR_CODES.RATE_LIMITED;
    } else if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborterror')) {
      code = ERROR_CODES.TIMEOUT;
    } else if (lower.includes('fetch') || lower.includes('network') || lower.includes('offline') || lower.includes('econnrefused')) {
      code = ERROR_CODES.NETWORK_FAILED;
    }

    return { code, message: msg };
  }

  /**
   * Create a new agent transaction for a given tab.
   *
   * @param {object} params
   * @param {number} params.tabId
   * @param {number} params.generation
   * @param {string} [params.requestId]
   * @param {string} params.goal
   * @param {number} [params.maxSteps] - Cannot exceed MAX_STEPS (5)
   * @returns {{ success: boolean, transaction?: object, error?: string }}
   */
  function createTransaction(params) {
    if (!params || typeof params !== 'object') {
      return { success: false, error: 'INVALID_PARAMS' };
    }

    const tabId = params.tabId;
    if (typeof tabId !== 'number' || tabId <= 0) {
      return { success: false, error: 'INVALID_TAB_ID' };
    }

    const generation = params.generation;
    if (typeof generation !== 'number' || generation < 1) {
      return { success: false, error: 'INVALID_GENERATION' };
    }

    // Enforce same-tab concurrency policy
    const existing = activeTransactionsByTab.get(tabId);
    if (existing && isTransactionActive(existing)) {
      return {
        success: false,
        error: ERROR_CODES.TRANSACTION_ACTIVE,
        activeTransactionId: existing.transactionId
      };
    }

    const txId = `tx_${Date.now()}_${nextTxSeq++}`;
    const reqId = params.requestId || `req_${Date.now()}`;
    const goal = typeof params.goal === 'string' ? params.goal.trim() : '';

    // Hard step limit enforcement (model or caller cannot increase above MAX_STEPS)
    let requestedMax = typeof params.maxSteps === 'number' ? params.maxSteps : MAX_STEPS;
    const authoritativeMaxSteps = Math.min(MAX_STEPS, Math.max(1, requestedMax));

    const transaction = {
      transactionId: txId,
      tabId,
      generation,
      requestId: reqId,
      goal,
      stepIndex: 0,
      maxSteps: authoritativeMaxSteps,
      status: STATUS.PLANNING,
      startTime: Date.now(),
      history: [],
      retryCounts: new Map(), // actionKey -> count
      timers: new Set(),      // Active managed timer IDs
      error: null,
      finalMessage: null,
      _finalized: false
    };

    activeTransactionsByTab.set(tabId, transaction);
    allTransactions.set(txId, transaction);

    return { success: true, transaction };
  }

  /**
   * Deterministically clean up and finalize a transaction.
   */
  function cleanupTransaction(txId, terminalStatus, errorReason) {
    const tx = allTransactions.get(txId);
    if (!tx) return null;

    if (terminalStatus && [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, STATUS.STALE].includes(terminalStatus)) {
      tx.status = terminalStatus;
    }
    if (errorReason && !tx.error) {
      tx.error = errorReason;
    }

    tx._finalized = true;

    // Clear and release all managed timers
    if (tx.timers) {
      for (const tId of tx.timers) {
        try { clearTimeout(tId); } catch (_) {}
      }
      tx.timers.clear();
    }

    // Clear retry counts
    if (tx.retryCounts) {
      tx.retryCounts.clear();
    }

    // Remove from active transactions mapping
    activeTransactionsByTab.delete(tx.tabId);
    return tx;
  }

  /**
   * Register a managed timer associated with a transaction.
   */
  function registerManagedTimer(tx, callback, delayMs) {
    if (!tx || tx._finalized) return () => {};

    let timerId;
    const cancel = () => {
      if (timerId) {
        clearTimeout(timerId);
        if (tx.timers) tx.timers.delete(timerId);
      }
    };

    timerId = setTimeout(() => {
      if (tx.timers) tx.timers.delete(timerId);
      if (!tx._finalized) {
        callback();
      }
    }, delayMs);

    if (tx.timers) tx.timers.add(timerId);
    return cancel;
  }

  function isTransactionActive(tx) {
    if (!tx) return false;
    return ![STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, STATUS.STALE].includes(tx.status);
  }

  function getActiveTransaction(tabId) {
    const tx = activeTransactionsByTab.get(tabId);
    return isTransactionActive(tx) ? tx : null;
  }

  function getTransaction(txId) {
    return allTransactions.get(txId) || null;
  }

  /**
   * Cancel an active transaction safely.
   */
  function cancelTransaction(txId, reason) {
    const tx = allTransactions.get(txId);
    if (!tx || !isTransactionActive(tx)) return false;

    cleanupTransaction(txId, STATUS.CANCELLED, reason || ERROR_CODES.USER_CANCELLED);
    return true;
  }

  /**
   * Tab close handler — immediately terminates transaction and cleans up.
   */
  function handleTabClosed(tabId) {
    const tx = activeTransactionsByTab.get(tabId);
    if (tx && isTransactionActive(tx)) {
      cleanupTransaction(tx.transactionId, STATUS.FAILED, ERROR_CODES.TAB_CLOSED);
      return true;
    }
    activeTransactionsByTab.delete(tabId);
    return false;
  }

  /**
   * Navigation handler — immediately invalidates transaction if generation changes.
   */
  function handleNavigation(tabId, newGeneration) {
    const tx = activeTransactionsByTab.get(tabId);
    if (tx && isTransactionActive(tx)) {
      if (tx.generation !== newGeneration) {
        cleanupTransaction(tx.transactionId, STATUS.STALE, ERROR_CODES.PAGE_CHANGED);
        return true;
      }
    }
    return false;
  }

  /**
   * Loop detection: checks if an identical action was repeatedly performed without progress.
   */
  function detectLoop(history, proposedAction, beforeStateSummary) {
    if (!Array.isArray(history) || history.length < 2) return false;

    const actionType = (proposedAction.type || proposedAction.action || '').toLowerCase();
    const target = proposedAction.elementId || proposedAction.target || '';

    // Check last 2 history items
    const recent = history.slice(-2);
    const repeated = recent.every(h =>
      h.actionType === actionType &&
      h.target === target &&
      h.effectObserved === false
    );

    return repeated;
  }

  /**
   * Confirms whether an action actually caused the intended DOM/page transition.
   */
  function confirmActionEffect(actionType, beforeState, afterState) {
    if (!beforeState || !afterState) {
      return { confirmed: false, detail: 'MISSING_OBSERVATION_STATE' };
    }

    // 1. Navigation or URL change confirmed
    if (beforeState.url && afterState.url && beforeState.url !== afterState.url) {
      return { confirmed: true, detail: 'URL_CHANGED' };
    }

    // 2. Generation advanced confirmed
    if (typeof beforeState.generation === 'number' && typeof afterState.generation === 'number') {
      if (afterState.generation > beforeState.generation) {
        return { confirmed: true, detail: 'GENERATION_ADVANCED' };
      }
    }

    const type = (actionType || '').toLowerCase();

    if (type === 'click') {
      // DOM elements count changed
      if (beforeState.elementCount !== afterState.elementCount) {
        return { confirmed: true, detail: 'DOM_STRUCTURE_CHANGED' };
      }
      // Text or content changed
      if (beforeState.domHash !== afterState.domHash) {
        return { confirmed: true, detail: 'DOM_CONTENT_CHANGED' };
      }
      return { confirmed: false, detail: 'NO_OBSERVABLE_EFFECT' };
    }

    if (type === 'type') {
      if (afterState.inputValue !== undefined && beforeState.inputValue !== afterState.inputValue) {
        return { confirmed: true, detail: 'INPUT_VALUE_CHANGED' };
      }
      return { confirmed: false, detail: 'INPUT_VALUE_UNCHANGED' };
    }

    if (type === 'scroll') {
      if (afterState.scrollY !== undefined && beforeState.scrollY !== undefined && afterState.scrollY !== beforeState.scrollY) {
        return { confirmed: true, detail: 'SCROLL_POSITION_CHANGED' };
      }
      return { confirmed: false, detail: 'SCROLL_UNCHANGED' };
    }

    return { confirmed: false, detail: 'UNKNOWN_ACTION_TYPE' };
  }

  /**
   * Validate model plan output format.
   *
   * Expected contract:
   * { status: "continue", action: { type: "click", elementId: "el_1" } }
   * or { status: "done", message: "Goal achieved" }
   * or { status: "blocked", reason: "Cannot proceed" }
   */
  function validatePlanResponse(modelOutput) {
    if (!modelOutput || typeof modelOutput !== 'object') {
      return { valid: false, error: ERROR_CODES.INVALID_MODEL_OUTPUT };
    }

    // Check payload size bound (reject oversized payloads > 64KB)
    try {
      const serialized = JSON.stringify(modelOutput);
      if (serialized.length > 65536) {
        return { valid: false, error: ERROR_CODES.OVERSIZED_MODEL_RESPONSE };
      }
    } catch (_) {
      return { valid: false, error: ERROR_CODES.INVALID_MODEL_OUTPUT };
    }

    const status = String(modelOutput.status || '').toLowerCase().trim();
    if (!['continue', 'done', 'blocked'].includes(status)) {
      return { valid: false, error: ERROR_CODES.INVALID_MODEL_OUTPUT };
    }

    if (status === 'done') {
      return {
        valid: true,
        status: 'done',
        message: typeof modelOutput.message === 'string' ? modelOutput.message : 'Goal completed.'
      };
    }

    if (status === 'blocked') {
      return {
        valid: true,
        status: 'blocked',
        reason: typeof modelOutput.reason === 'string' ? modelOutput.reason : 'Execution blocked.'
      };
    }

    // Status is 'continue': Must have exactly ONE action
    if (Array.isArray(modelOutput.action) || Array.isArray(modelOutput.actions)) {
      const arr = Array.isArray(modelOutput.action) ? modelOutput.action : modelOutput.actions;
      if (arr.length > 1) {
        return { valid: false, error: ERROR_CODES.MULTIPLE_ACTIONS_FORBIDDEN };
      }
      if (arr.length === 0) {
        return { valid: false, error: ERROR_CODES.INVALID_MODEL_OUTPUT };
      }
    }

    const rawAction = Array.isArray(modelOutput.action)
      ? modelOutput.action[0]
      : (modelOutput.action || (Array.isArray(modelOutput.actions) ? modelOutput.actions[0] : null));
    if (!rawAction || typeof rawAction !== 'object') {
      return { valid: false, error: ERROR_CODES.INVALID_MODEL_OUTPUT };
    }

    for (const key of Object.keys(rawAction)) {
      if (typeof rawAction[key] === 'function' || key === 'fn' || key === 'code' || key === 'script') {
        return { valid: false, error: ERROR_CODES.UNSUPPORTED_ACTION_TYPE };
      }
    }

    const actionType = (rawAction.type || rawAction.action || '').toLowerCase();
    if (!ALLOWED_ACTIONS.includes(actionType)) {
      return { valid: false, error: ERROR_CODES.UNSUPPORTED_ACTION_TYPE };
    }

    // Reject dangerous target selectors or injection attempts
    const rawTarget = rawAction.elementId || rawAction.target;
    if (typeof rawTarget === 'string') {
      if (/javascript:|<script|eval\(|document\.|\/\/|xpath/i.test(rawTarget)) {
        return { valid: false, error: ERROR_CODES.ACTION_REJECTED };
      }
    }

    // Return sanitized action — strip any model-attempted spoofing of runtime fields
    const sanitizedAction = {
      type: actionType,
      action: actionType,
      elementId: rawAction.elementId,
      target: rawAction.target || rawAction.elementId,
      text: typeof rawAction.text === 'string' ? rawAction.text : (typeof rawAction.targetText === 'string' ? rawAction.targetText : undefined),
      role: typeof rawAction.role === 'string' ? rawAction.role : (typeof rawAction.semanticRole === 'string' ? rawAction.semanticRole : undefined),
      value: rawAction.value
    };

    return {
      valid: true,
      status: 'continue',
      action: sanitizedAction,
      reason: modelOutput.reason || ''
    };
  }

  /**
   * Append a step record to transaction history (metadata only, max 10 entries).
   */
  function recordHistory(transaction, record) {
    const entry = {
      stepIndex: record.stepIndex,
      actionType: record.actionType,
      target: record.target || null,
      status: record.status,
      effectObserved: Boolean(record.effectObserved),
      durationMs: Math.round(record.durationMs || 0),
      error: record.error || null,
      timestamp: Date.now()
    };

    transaction.history.push(entry);
    if (transaction.history.length > MAX_HISTORY_ENTRIES) {
      transaction.history.shift();
    }
  }

  /**
   * Get concise sidebar status display string.
   */
  function getSidebarStatus(transaction) {
    if (!transaction) return 'Agent: Idle';

    switch (transaction.status) {
      case STATUS.PLANNING:
      case STATUS.OBSERVING:
      case STATUS.GROUNDING:
      case STATUS.VALIDATING:
      case STATUS.EXECUTING:
        return `Agent: Step ${transaction.stepIndex + 1} / ${transaction.maxSteps}`;
      case STATUS.WAITING_FOR_PAGE:
        return 'Agent: Waiting for page';
      case STATUS.COMPLETED:
        return 'Agent: Completed';
      case STATUS.FAILED:
      case STATUS.CANCELLED:
      case STATUS.STALE:
        return `Agent: Stopped safely (${transaction.error || 'Done'})`;
      default:
        return 'Agent: Idle';
    }
  }

  /**
   * Execute the full bounded multi-step agent transaction loop.
   *
   * @param {string} txId
   * @param {object} handlers
   * @param {Function} handlers.observePage - async (tabId, generation) -> { url, generation, domContext, elementCount, domHash, visualNeeded }
   * @param {Function} handlers.planStep - async (context, goal, history) -> modelPlanResponse
   * @param {Function} handlers.groundAction - (action, generation, tabId) -> { success, elementId, error }
   * @param {Function} handlers.validateAction - (action, generation, tabId) -> { allowed, reason }
   * @param {Function} handlers.executeAction - async (action, generation) -> { success, error }
   * @param {Function} [handlers.settleWait] - async (ms) -> void
   * @param {Function} [handlers.onStatusUpdate] - (statusString) -> void
   * @returns {Promise<{ success: boolean, status: string, error?: string, stepsExecuted: number, finalMessage?: string }>}
   */
  async function runTransactionLoop(txId, handlers) {
    const tx = allTransactions.get(txId);
    if (!tx) {
      return { success: false, status: STATUS.FAILED, error: 'TRANSACTION_NOT_FOUND', stepsExecuted: 0 };
    }

    const settleWait = handlers.settleWait || ((ms) => new Promise(r => registerManagedTimer(tx, r, ms)));
    const notifyStatus = () => {
      if (handlers.onStatusUpdate) {
        handlers.onStatusUpdate(getSidebarStatus(tx));
      }
    };

    try {
      while (isTransactionActive(tx)) {
        // 1. Check Hard Step Limit
        if (tx.stepIndex >= tx.maxSteps) {
          tx.status = STATUS.FAILED;
          tx.error = ERROR_CODES.MAX_STEPS_REACHED;
          notifyStatus();
          break;
        }

        // 2. Check Total Timeout
        if (Date.now() - tx.startTime > MAX_TRANSACTION_TIME_MS) {
          tx.status = STATUS.FAILED;
          tx.error = ERROR_CODES.TRANSACTION_TIMEOUT;
          notifyStatus();
          break;
        }

        // 3. Status = OBSERVING: Fresh observation of active page
        tx.status = STATUS.OBSERVING;
        notifyStatus();

        const observation = await handlers.observePage(tx.tabId, tx.generation);
        if (!observation || observation.error) {
          tx.status = STATUS.FAILED;
          tx.error = observation?.error || ERROR_CODES.PAGE_CHANGED;
          notifyStatus();
          break;
        }

        // Generation invariant check: current page generation must match transaction generation
        if (typeof observation.generation === 'number' && observation.generation !== tx.generation) {
          tx.status = STATUS.STALE;
          tx.error = ERROR_CODES.STALE_GENERATION;
          notifyStatus();
          break;
        }

        // 4. Status = PLANNING: Request next step from model
        tx.status = STATUS.PLANNING;
        notifyStatus();

        let modelResponse;
        try {
          modelResponse = await handlers.planStep(observation, tx.goal, tx.history);
        } catch (planErr) {
          tx.status = STATUS.FAILED;
          tx.error = ERROR_CODES.PROVIDER_FAILED;
          notifyStatus();
          break;
        }

        // Validate model structured plan
        const plan = validatePlanResponse(modelResponse);
        if (!plan.valid) {
          tx.status = STATUS.FAILED;
          tx.error = plan.error;
          notifyStatus();
          break;
        }

        // Check if model declared DONE
        if (plan.status === 'done') {
          tx.status = STATUS.COMPLETED;
          tx.finalMessage = plan.message;
          notifyStatus();
          break;
        }

        // Check if model declared BLOCKED
        if (plan.status === 'blocked') {
          tx.status = STATUS.FAILED;
          tx.error = plan.reason;
          notifyStatus();
          break;
        }

        // Status is 'continue': extract single proposed action
        const proposedAction = plan.action;
        const actionType = (proposedAction.type || proposedAction.action || '').toLowerCase();
        const actionKey = `${actionType}:${proposedAction.elementId || proposedAction.target || ''}`;

        // 5. Loop Detection
        if (detectLoop(tx.history, proposedAction, observation)) {
          tx.status = STATUS.FAILED;
          tx.error = ERROR_CODES.LOOP_DETECTED;
          notifyStatus();
          break;
        }

        // 6. Status = GROUNDING
        tx.status = STATUS.GROUNDING;
        notifyStatus();

        const groundResult = handlers.groundAction(proposedAction, tx.generation, tx.tabId);
        if (!groundResult || !groundResult.success) {
          // Failure handling with bounded retry
          const currentRetries = tx.retryCounts.get(actionKey) || 0;
          if (currentRetries < MAX_RETRIES_PER_ACTION) {
            tx.retryCounts.set(actionKey, currentRetries + 1);
            recordHistory(tx, {
              stepIndex: tx.stepIndex,
              actionType,
              target: proposedAction.elementId || proposedAction.target,
              status: 'RETRY',
              effectObserved: false,
              durationMs: 0,
              error: groundResult?.error || ERROR_CODES.TARGET_NOT_FOUND
            });
            continue; // Safe single retry
          }

          tx.status = STATUS.FAILED;
          tx.error = groundResult?.error || ERROR_CODES.TARGET_NOT_FOUND;
          notifyStatus();
          break;
        }

        const groundedElementId = groundResult.elementId;
        const executableAction = {
          action: actionType,
          target: groundedElementId,
          value: proposedAction.value,
          generation: tx.generation,
          tabId: tx.tabId
        };

        // 7. Status = VALIDATING
        tx.status = STATUS.VALIDATING;
        notifyStatus();

        const valResult = handlers.validateAction(executableAction, tx.generation, tx.tabId);
        if (!valResult || !valResult.allowed) {
          tx.status = STATUS.FAILED;
          tx.error = valResult?.reason || ERROR_CODES.ACTION_REJECTED;
          notifyStatus();
          break;
        }

        // 8. Status = EXECUTING
        tx.status = STATUS.EXECUTING;
        notifyStatus();

        const execStart = Date.now();
        const execResult = await handlers.executeAction(executableAction, tx.generation);
        const execDuration = Date.now() - execStart;

        if (!execResult || !execResult.success) {
          const currentRetries = tx.retryCounts.get(actionKey) || 0;
          if (currentRetries < MAX_RETRIES_PER_ACTION) {
            tx.retryCounts.set(actionKey, currentRetries + 1);
            recordHistory(tx, {
              stepIndex: tx.stepIndex,
              actionType,
              target: groundedElementId,
              status: 'RETRY',
              effectObserved: false,
              durationMs: execDuration,
              error: execResult?.error || ERROR_CODES.EXECUTION_FAILED
            });
            continue;
          }

          tx.status = STATUS.FAILED;
          tx.error = execResult?.error || ERROR_CODES.EXECUTION_FAILED;
          notifyStatus();
          break;
        }

        // 9. Status = WAITING_FOR_PAGE
        tx.status = STATUS.WAITING_FOR_PAGE;
        notifyStatus();

        await settleWait(PAGE_SETTLE_TIMEOUT_MS);

        // 10. Re-observe to confirm effect
        const postObservation = await handlers.observePage(tx.tabId, tx.generation);
        const confirmation = confirmActionEffect(actionType, observation, postObservation);

        // Record history entry
        recordHistory(tx, {
          stepIndex: tx.stepIndex,
          actionType,
          target: groundedElementId,
          status: 'SUCCESS',
          effectObserved: confirmation.confirmed,
          durationMs: execDuration,
          error: null
        });

        // Advance authoritative step index
        tx.stepIndex++;

        // If navigation occurred during action execution, check if generation changed
        if (postObservation && typeof postObservation.generation === 'number') {
          if (postObservation.generation !== tx.generation) {
            // Safe termination on generation transition
            tx.status = STATUS.STALE;
            tx.error = ERROR_CODES.PAGE_CHANGED;
            notifyStatus();
            break;
          }
        }
      }
    } finally {
      cleanupTransaction(tx.transactionId, tx.status, tx.error);
    }

    return {
      success: tx.status === STATUS.COMPLETED,
      status: tx.status,
      error: tx.error,
      stepsExecuted: tx.stepIndex,
      finalMessage: tx.finalMessage
    };
  }

  function resetAll() {
    activeTransactionsByTab.clear();
    allTransactions.clear();
    nextTxSeq = 1;
  }

  return {
    MAX_STEPS,
    MAX_TRANSACTION_TIME_MS,
    PAGE_SETTLE_TIMEOUT_MS,
    STATUS,
    ERROR_CODES,
    createTransaction,
    getTransaction,
    getActiveTransaction,
    cleanupTransaction,
    registerManagedTimer,
    classifyProviderError,
    cancelTransaction,
    handleTabClosed,
    handleNavigation,
    detectLoop,
    confirmActionEffect,
    validatePlanResponse,
    recordHistory,
    getSidebarStatus,
    runTransactionLoop,
    resetAll
  };
});
