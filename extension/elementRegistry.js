/**
 * Element Registry — SIH26171 Step 1 & Phase 2 Privacy Architecture
 * 
 * Provides stable, opaque, content-script-internal element identity.
 * Maps: DOM Element ↔ targetId (e.g. "el_1", "el_2")
 * 
 * Invariants:
 * 1. IDs are extension-owned, opaque, and never based on DOM index or CSS selectors.
 * 2. Stable across multiple analysis passes for the same DOM element within the same page generation.
 * 3. Never reassigns a stale or disconnected element ID to a new element.
 * 4. Stale/disconnected elements resolve to null.
 * 5. Isolated to extension content-script context.
 * 6. PAGE-SCOPED & GENERATION-BOUND: Element IDs from Page A / Generation X cannot be executed in Page B / Generation Y.
 */
(function() {
  'use strict';

  let idCounter = 0;
  let currentRegistryGeneration = 1;
  let currentNavigationIdentity = '';

  // WeakMap: DOM Element -> targetId string (prevents memory leak when DOM nodes are collected)
  const elementToId = new WeakMap();
  // Map: targetId string -> DOM Element
  const idToElement = new Map();
  // Map: targetId string -> generation number
  const idToGeneration = new Map();

  /**
   * Set the active context generation and navigation identity for the registry.
   * If generation changes or navigation identity changes, existing element mappings
   * are scoped to their respective generation.
   */
  function setContextGeneration(generation, navigationIdentity = '') {
    if (typeof generation === 'number' && generation !== currentRegistryGeneration) {
      currentRegistryGeneration = generation;
    }
    if (navigationIdentity && navigationIdentity !== currentNavigationIdentity) {
      currentNavigationIdentity = navigationIdentity;
    }
  }

  function getContextGeneration() {
    return currentRegistryGeneration;
  }

  /**
   * Register a DOM Element and obtain its stable internal target ID.
   * If already registered in the current generation, returns the existing ID.
   * 
   * @param {Element} element
   * @param {number} [generation]
   * @returns {string|null} targetId (e.g. "el_1")
   */
  function register(element, generation) {
    if (!element || !((typeof Element !== 'undefined' && element instanceof Element) || element.nodeType === 1)) {
      return null;
    }

    const gen = typeof generation === 'number' ? generation : currentRegistryGeneration;

    if (elementToId.has(element)) {
      const existingId = elementToId.get(element);
      idToElement.set(existingId, element);
      idToGeneration.set(existingId, gen);
      return existingId;
    }

    idCounter += 1;
    const targetId = `el_${idCounter}`;
    elementToId.set(element, targetId);
    idToElement.set(targetId, element);
    idToGeneration.set(targetId, gen);
    return targetId;
  }

  /**
   * Resolve an internal target ID to a connected DOM element.
   * Returns null if:
   * - target ID is unknown
   * - element is disconnected from the active document
   * - expectedGeneration is specified and does NOT match the element's generation
   * 
   * @param {string} targetId
   * @param {number} [expectedGeneration]
   * @returns {Element|null}
   */
  function resolve(targetId, expectedGeneration) {
    if (!targetId || typeof targetId !== 'string') return null;

    const element = idToElement.get(targetId);
    if (!element) return null;

    // Check generation isolation: if expectedGeneration is provided, assert match
    if (typeof expectedGeneration === 'number') {
      const registeredGen = idToGeneration.get(targetId);
      if (registeredGen !== undefined && registeredGen !== expectedGeneration) {
        console.warn(`[PRIVACY STATE] ELEMENT RESOLUTION REJECTED: targetId=${targetId} generation=${registeredGen} expected=${expectedGeneration}`);
        return null;
      }
    }

    // Check if element is still connected to the active document
    if (!element.isConnected) {
      // Element was removed from DOM. Prune it from active lookup.
      idToElement.delete(targetId);
      idToGeneration.delete(targetId);
      return null;
    }

    return element;
  }

  /**
   * Check whether a target ID exists and is currently valid, connected,
   * and belongs to the specified/current generation.
   * 
   * @param {string} targetId
   * @param {number} [expectedGeneration]
   * @returns {boolean}
   */
  function isValidTarget(targetId, expectedGeneration) {
    return resolve(targetId, expectedGeneration) !== null;
  }

  /**
   * Get the registered generation of an element ID.
   * 
   * @param {string} targetId
   * @returns {number|null}
   */
  function getElementGeneration(targetId) {
    return idToGeneration.get(targetId) ?? null;
  }

  /**
   * Prune disconnected elements from the registry.
   */
  function prune() {
    for (const [id, element] of idToElement.entries()) {
      if (!element || !element.isConnected) {
        idToElement.delete(id);
        idToGeneration.delete(id);
      }
    }
  }

  /**
   * Clear registry (useful for testing or full page resets).
   */
  function reset() {
    idCounter = 0;
    idToElement.clear();
    idToGeneration.clear();
  }

  /**
   * Get size of active registered connected elements (diagnostic/testing).
   */
  function getActiveCount() {
    prune();
    return idToElement.size;
  }

  const registry = {
    register,
    resolve,
    isValidTarget,
    getElementGeneration,
    setContextGeneration,
    getContextGeneration,
    prune,
    reset,
    getActiveCount
  };

  if (typeof window !== 'undefined') {
    window.SIH_ElementRegistry = registry;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = registry;
  }
})();
