/**
 * ═════════════════════════════════════════════════════════════════════
 * SIH26171 Privacy-Preserving Browser Assistant — Website Logic
 * Pure Vanilla JavaScript — Lightweight, Accessible, Performant
 * ═════════════════════════════════════════════════════════════════
 */

// ── 1. SITE CONFIGURATION (Single Source of Truth) ──
const SITE_CONFIG = {
  projectName: "SIH26171 Privacy-Preserving Browser AI Assistant",
  shortName: "SIH Privacy Assistant",
  version: "v1.6.0 (Release Candidate)",
  githubUrl: "https://github.com/SAMIHZS/SIH2026",
  releaseUrl: "https://github.com/SAMIHZS/SIH2026/releases",
  downloadUrl: null, // Set to release asset URL (e.g. "https://github.com/SAMIHZS/SIH2026/releases/download/v1.6.0/extension.zip") once published
  issuesUrl: "https://github.com/SAMIHZS/SIH2026/issues",
  status: "Release Candidate Verified (P1–P252 PASS)"
};

// Descriptions for each extension interface showcase tab
const GALLERY_DESCRIPTIONS = {
  'gallery-chat': 'The main interaction surface for browser tasks with local status indication and prompt execution.',
  'gallery-context': 'Shows the structured context and interactive element inventory available to the agent.',
  'gallery-privacy': 'Makes the local processing, face redaction, and PII sanitization boundary directly verifiable.',
  'gallery-settings': 'Controls the configured model/provider (Gemini, Groq, OpenRouter, Local) and capabilities.'
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initMobileNav();
  initSmoothScrollAndActiveNav();
  initGalleryTabs();
  initFaqAccordion();
  initDownloadFlow();
  initComparisonToggle();
});

// ── 2. THEME MANAGEMENT (Light Cream / Genuine Dark) ──
function initTheme() {
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const storedTheme = localStorage.getItem('sih_web_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  const initialTheme = storedTheme || (prefersDark ? 'dark' : 'light');
  applyTheme(initialTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('sih_web_theme', next);
    });
  }

  // System preference listener
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('sih_web_theme')) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (!themeToggleBtn) return;

  const isDark = theme === 'dark';
  themeToggleBtn.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
  themeToggleBtn.innerHTML = isDark
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

// ── 3. MOBILE NAVIGATION DRAWER ──
function initMobileNav() {
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileDrawer = document.getElementById('mobileNavDrawer');
  if (!hamburgerBtn || !mobileDrawer) return;

  function toggleDrawer(open) {
    const isOpen = open !== undefined ? open : !mobileDrawer.classList.contains('open');
    mobileDrawer.classList.toggle('open', isOpen);
    hamburgerBtn.setAttribute('aria-expanded', isOpen);
    hamburgerBtn.innerHTML = isOpen
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
  }

  hamburgerBtn.addEventListener('click', () => toggleDrawer());

  // Close when tapping links
  mobileDrawer.querySelectorAll('a, button').forEach(el => {
    el.addEventListener('click', () => toggleDrawer(false));
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mobileDrawer.classList.contains('open')) {
      toggleDrawer(false);
    }
  });
}

// ── 4. SMOOTH SCROLL & ACTIVE LINK OBSERVER ──
function initSmoothScrollAndActiveNav() {
  const sections = document.querySelectorAll('section[id]');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.getAttribute('id');
        document.querySelectorAll('.nav-menu a').forEach(link => {
          if (link.getAttribute('href') === `#${id}`) {
            link.classList.add('active');
          } else {
            link.classList.remove('active');
          }
        });
      }
    });
  }, {
    rootMargin: '-20% 0px -70% 0px'
  });

  sections.forEach(section => observer.observe(section));
}

// ── 5. SCREENSHOT GALLERY TAB SWITCHER WITH DESCRIPTIONS ──
function initGalleryTabs() {
  const tabButtons = document.querySelectorAll('.gallery-tab-btn');
  const panels = document.querySelectorAll('.gallery-image-panel');
  const descEl = document.getElementById('galleryDescription');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      
      tabButtons.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const activePanel = document.getElementById(target);
      if (activePanel) {
        activePanel.classList.add('active');
      }

      if (descEl && GALLERY_DESCRIPTIONS[target]) {
        descEl.textContent = GALLERY_DESCRIPTIONS[target];
      }
    });
  });
}

// ── 6. ACCESSIBLE FAQ ACCORDION ──
function initFaqAccordion() {
  const faqItems = document.querySelectorAll('.faq-item');

  faqItems.forEach(item => {
    const questionBtn = item.querySelector('.faq-question');
    if (!questionBtn) return;

    questionBtn.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');

      // Close other items
      faqItems.forEach(other => {
        if (other !== item) {
          other.classList.remove('open');
          const otherBtn = other.querySelector('.faq-question');
          if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
        }
      });

      // Toggle current
      item.classList.toggle('open', !isOpen);
      questionBtn.setAttribute('aria-expanded', String(!isOpen));
    });
  });
}

// ── 7. DOWNLOAD / RELEASE FLOW WITH MODAL DIALOG ──
function initDownloadFlow() {
  const downloadBtns = document.querySelectorAll('.js-download-btn');
  const modal = document.getElementById('downloadModal');
  const closeBtn = document.getElementById('closeDownloadModalBtn');
  const modalInstallLink = document.getElementById('modalInstallLink');
  const modalReleasesLink = document.getElementById('modalReleasesLink');
  const modalSourceLink = document.getElementById('modalSourceLink');

  // Populate URLs from SITE_CONFIG
  if (modalReleasesLink) modalReleasesLink.href = SITE_CONFIG.releaseUrl;
  if (modalSourceLink) modalSourceLink.href = SITE_CONFIG.githubUrl;

  function openModal() {
    if (SITE_CONFIG.downloadUrl) {
      window.location.href = SITE_CONFIG.downloadUrl;
      return;
    }
    if (modal) {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal() {
    if (modal) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    }
  }

  downloadBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', closeModal);
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });
  }

  if (modalInstallLink) {
    modalInstallLink.addEventListener('click', () => {
      closeModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeModal();
    }
  });
}

// ── 8. INTERACTIVE RAW VS SANITIZED COMPARISON TOGGLE ──
function initComparisonToggle() {
  const toggleBtn = document.getElementById('toggleComparisonFocus');
  if (!toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    const rawBox = document.getElementById('rawContextPreview');
    const sanitizedBox = document.getElementById('sanitizedContextPreview');
    if (rawBox && sanitizedBox) {
      rawBox.classList.toggle('highlight-leak');
      sanitizedBox.classList.toggle('highlight-safe');
    }
  });
}
