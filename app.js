/* Shared helpers: config, theme, API client, status map, nav, toasts */
const CONFIG = {
  // Override in the browser console: localStorage.setItem('citeverify_api','http://127.0.0.1:5000/api/v1')
  API_BASE: localStorage.getItem('citeverify_api') || 'http://127.0.0.1:5000/api/v1',
  ALLOW_DEMO: true // demo data is used ONLY when the backend is unreachable, and must always be labelled
};

const THEME_KEY = 'citeverify-theme';

const STATUS = {
  SUPPORTED: { label: 'SUPPORTED', cls: 'st-supported' },
  PARTIALLY_SUPPORTED: { label: 'PARTIALLY SUPPORTED', cls: 'st-partial' },
  UNSUPPORTED: { label: 'UNSUPPORTED', cls: 'st-unsupported' },
  CONTRADICTORY: { label: 'CONTRADICTORY', cls: 'st-contradictory' },
  POTENTIALLY_OUTDATED: { label: 'POTENTIALLY OUTDATED', cls: 'st-outdated' },
  NEEDS_REVIEW: { label: 'NEEDS REVIEW', cls: 'st-review' }
};

class ApiError extends Error {
  constructor(msg, status = 0, kind = 'http', details = null) {
    super(msg);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.details = details;
  }
}

async function api(path, { method = 'GET', body, form, headers = {}, timeout = 30000, signal } = {}) {
  const controller = new AbortController();
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const reqHeaders = { Accept: 'application/json', ...headers };
  if (body && !form && !reqHeaders['Content-Type']) {
    reqHeaders['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(CONFIG.API_BASE + path, {
      method,
      headers: reqHeaders,
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ApiError(
        signal && signal.aborted
          ? 'The request was cancelled.'
          : 'The CiteVerify server took too long to respond. Please try again.',
        0,
        'timeout'
      );
    }
    throw new ApiError(
      'Cannot reach the CiteVerify server at ' + CONFIG.API_BASE + '. Check that the Flask backend is running.',
      0,
      'network'
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const message =
      (data && data.error && data.error.message) ||
      (data && data.message) ||
      `Request failed (${res.status}).`;
    throw new ApiError(message, res.status, 'http', data && data.error ? data.error : data);
  }

  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function badge(status) {
  const s = STATUS[status] || STATUS.NEEDS_REVIEW;
  return `<span class="badge ${s.cls}">${esc(s.label)}</span>`;
}

function toast(msg, type = 'info', duration = 4000) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'left:50%',
      'transform:translateX(-50%) translateY(8px)',
      'max-width:min(92vw,480px)',
      'padding:12px 18px',
      'border-radius:11px',
      'font:500 0.9rem/1.4 var(--font,system-ui,sans-serif)',
      'box-shadow:0 12px 32px rgba(0,0,0,0.24)',
      'border:1px solid rgba(255,255,255,0.12)',
      'z-index:120',
      'opacity:0',
      'pointer-events:none',
      'transition:opacity 0.18s ease,transform 0.18s ease'
    ].join(';');
    document.body.appendChild(t);
  }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const palette = {
    info: isDark ? { bg: '#1E293B', fg: '#F8FAFC', bd: '#334155' } : { bg: '#0B1F3A', fg: '#FFFFFF', bd: 'rgba(255,255,255,0.12)' },
    success: { bg: '#065F46', fg: '#ECFDF5', bd: '#10B981' },
    error: { bg: '#991B1B', fg: '#FEF2F2', bd: '#F87171' }
  }[type] || { bg: '#0B1F3A', fg: '#FFFFFF', bd: 'rgba(255,255,255,0.12)' };

  t.style.background = palette.bg;
  t.style.color = palette.fg;
  t.style.borderColor = palette.bd;
  t.textContent = msg;
  t.hidden = false;

  requestAnimationFrame(() => {
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
  });

  clearTimeout(t._h);
  t._h = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(8px)';
    setTimeout(() => {
      t.hidden = true;
    }, 190);
  }, duration);
}

/* Theme Controller (Light / Dark Mode) */
function getPreferredTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(isDark));
    btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  }
}

function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

function ensureThemeToggleButton() {
  let btn = document.getElementById('theme-toggle');
  const navLinks = document.querySelector('.nav-links');

  // Auto-inject into pages (upload.html, dashboard.html, history.html, reports.html) if not already in HTML
  if (!btn && navLinks) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.id = 'theme-toggle';
    btn.innerHTML = `
      <svg class="icon-moon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
      <svg class="icon-sun" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4"/>
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
      </svg>
    `;
    const primaryCta = navLinks.querySelector('.btn-primary');
    if (primaryCta) {
      navLinks.insertBefore(btn, primaryCta);
    } else {
      navLinks.appendChild(btn);
    }
  }

  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = 'true';
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });
  }
}

// Apply theme immediately on script load
applyTheme(getPreferredTheme());

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem(THEME_KEY)) {
    applyTheme(e.matches ? 'dark' : 'light');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  ensureThemeToggleButton();
  applyTheme(getPreferredTheme());

  // Mobile navigation drawer
  const navToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');
  if (navToggle && navLinks && !navToggle.dataset.bound) {
    navToggle.dataset.bound = 'true';

    const closeNav = () => {
      navLinks.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    };

    navToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = navLinks.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(isOpen));
    });

    navLinks.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', closeNav);
    });

    document.addEventListener('click', (e) => {
      if (navLinks.classList.contains('open') && !navLinks.contains(e.target) && !navToggle.contains(e.target)) {
        closeNav();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && navLinks.classList.contains('open')) {
        closeNav();
        navToggle.focus();
      }
    });
  }

  // Interactive claim evidence inspector (landing page preview)
  const claimRows = document.querySelectorAll('.crow[data-source]');
  const pvMeta = document.getElementById('pv-meta');
  const pvQuote = document.getElementById('pv-quote');
  if (claimRows.length && pvMeta && pvQuote) {
    claimRows.forEach((row) => {
      if (row.dataset.bound) return;
      row.dataset.bound = 'true';
      row.addEventListener('click', () => {
        claimRows.forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
        pvMeta.textContent = row.dataset.source;
        pvQuote.textContent = row.dataset.quote;
      });
    });
  }
});