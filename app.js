(() => {
  'use strict';

  const API_BASE = '/api/v1';
  const STORAGE_REPORTS_KEY = 'citeverify_session_reports_v1';

  const state = {
    currentRoute: 'dashboard',
    health: { status: 'checking', llm_available: false },
    selectedFile: null,
    currentReport: null,
    sessionReports: [],
    backendReviews: [],
    claimFilter: 'ALL',
    expandedClaims: new Set(),
    isProcessing: false
  };

  // Visual mapping aligned strictly with backend verdicts in final.py:
  // VERDICTS = ["supported", "partially_supported", "unsupported", "contradictory", "possibly_outdated", "needs_review"]
  const VERDICT_META = {
    supported: {
      label: 'Supported',
      tone: 'green',
      badgeCls: 'badge-green',
      color: '#16A34A',
      group: 'supported'
    },
    partially_supported: {
      label: 'Partially Supported',
      tone: 'yellow',
      badgeCls: 'badge-yellow',
      color: '#CA8A04',
      group: 'partial'
    },
    needs_review: {
      label: 'Needs Review',
      tone: 'yellow',
      badgeCls: 'badge-yellow',
      color: '#EAB308',
      group: 'partial'
    },
    unsupported: {
      label: 'Unsupported',
      tone: 'red',
      badgeCls: 'badge-red',
      color: '#DC2626',
      group: 'unsupported'
    },
    contradictory: {
      label: 'Contradictory',
      tone: 'red',
      badgeCls: 'badge-red',
      color: '#B91C1C',
      group: 'contradictory'
    },
    possibly_outdated: {
      label: 'Potentially Outdated',
      tone: 'grey',
      badgeCls: 'badge-grey',
      color: '#64748B',
      group: 'outdated'
    }
  };

  const ROUTE_TITLES = {
    dashboard: 'Dashboard',
    upload: 'New Verification',
    verification: 'Verification Dashboard',
    claims: 'Claim-by-Claim Analysis',
    history: 'Verification History',
    reports: 'Reports',
    about: 'About CiteVerify'
  };

  function esc(val) {
    return String(val ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  function formatTimestamp(iso) {
    if (!iso) return 'Just now';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  function showToast(message, type = 'info', duration = 4200) {
    const box = document.getElementById('toast-box');
    if (!box) return;
    box.textContent = message;
    box.className = `toast-box ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
    box.classList.remove('hidden');
    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.classList.add('hidden'), duration);
  }

  function verdictBadgeHtml(verdict) {
    const meta = VERDICT_META[verdict] || VERDICT_META.needs_review;
    return `<span class="status-badge ${meta.badgeCls}"><span class="dot"></span>${esc(meta.label)}</span>`;
  }

  function loadSessionReports() {
    try {
      const raw = sessionStorage.getItem(STORAGE_REPORTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          state.sessionReports = parsed;
          state.currentReport = parsed[0];
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  function saveReportToSession(report) {
    state.currentReport = report;
    state.sessionReports = [
      report,
      ...state.sessionReports.filter(
        (r) => !(r.filename === report.filename && r.generated_at === report.generated_at)
      )
    ].slice(0, 15);
    try {
      sessionStorage.setItem(STORAGE_REPORTS_KEY, JSON.stringify(state.sessionReports));
    } catch {
      // Ignore storage quota issues
    }
  }

  // ==================== NAVIGATION ====================
  function enterApp(route = 'dashboard') {
    document.getElementById('landing-page').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    navigateTo(route);
  }

  function showLanding() {
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('landing-page').classList.remove('hidden');
  }

  function navigateTo(route) {
    if (!ROUTE_TITLES[route]) route = 'dashboard';
    state.currentRoute = route;

    document.querySelectorAll('.route-view').forEach((el) => el.classList.add('hidden'));
    const target = document.getElementById(`view-${route}`);
    if (target) target.classList.remove('hidden');

    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.route === route);
    });

    document.getElementById('topbar-title').textContent = ROUTE_TITLES[route];
    document.getElementById('topbar-breadcrumb').textContent = `CiteVerify / ${ROUTE_TITLES[route]}`;
    document.getElementById('sidebar').classList.remove('open');

    if (route === 'dashboard') renderDashboard();
    if (route === 'verification') renderVerificationDashboard();
    if (route === 'claims') renderClaimsAnalysis();
    if (route === 'history') renderHistoryPage();
    if (route === 'reports') renderReportsPage();
  }

  // ==================== BACKEND API CALLS ====================
  async function checkBackendHealth() {
    const dot = document.getElementById('backend-dot');
    const label = document.getElementById('backend-status-text');
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.health = data;
      if (data.llm_available) {
        dot.className = 'status-dot online';
        label.textContent = 'Backend Online (AI Ready)';
      } else {
        dot.className = 'status-dot warn';
        label.textContent = 'Backend Online (Manual Mode)';
      }
    } catch {
      state.health = { status: 'offline', llm_available: false };
      dot.className = 'status-dot offline';
      label.textContent = 'Backend Unreachable';
    }
  }

  async function fetchBackendReviews() {
    try {
      const res = await fetch(`${API_BASE}/reviews`);
      if (!res.ok) return;
      const data = await res.json();
      state.backendReviews = Array.isArray(data.reviews) ? data.reviews : [];
    } catch {
      // Non-blocking
    }
  }

  async function submitHumanReview(resultId, decision, note) {
    if (!state.currentReport) return;
    try {
      const res = await fetch(`${API_BASE}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: state.currentReport.filename,
          result_id: resultId,
          decision,
          note
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data.error && data.error.message) || 'Failed to save review.');
      }
      showToast(`Review saved for Claim #${resultId}.`, 'success');
      await fetchBackendReviews();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ==================== FILE SELECTION & VALIDATION ====================
  function validateAndSetFile(file) {
    const errorBox = document.getElementById('upload-error-box');
    errorBox.classList.add('hidden');
    errorBox.textContent = '';

    if (!file) return false;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) {
      errorBox.textContent = `Unsupported file format "${file.name}". Please upload a .PDF or .DOCX document.`;
      errorBox.classList.remove('hidden');
      return false;
    }

    state.selectedFile = file;
    const ext = lower.endsWith('.pdf') ? 'PDF' : 'DOCX';
    document.getElementById('file-ext-badge').textContent = ext;
    document.getElementById('selected-file-name').textContent = file.name;
    document.getElementById('selected-file-meta').textContent = `${formatBytes(file.size)} • ${ext} Document`;
    document.getElementById('selected-file-card').classList.remove('hidden');
    document.getElementById('upload-verify-btn').disabled = false;
    return true;
  }

  function clearSelectedFile() {
    state.selectedFile = null;
    document.getElementById('main-file-input').value = '';
    document.getElementById('selected-file-card').classList.add('hidden');
    document.getElementById('upload-verify-btn').disabled = true;
    document.getElementById('upload-error-box').classList.add('hidden');
  }

  async function runVerification(file, maxPairs = 20, useLlm = true) {
    if (state.isProcessing || !file) return;
    state.isProcessing = true;

    const progressPanel = document.getElementById('upload-progress-panel');
    const progressFill = document.getElementById('progress-fill');
    const progressPct = document.getElementById('progress-pct');
    const stageTitle = document.getElementById('progress-stage-title');
    const stageSub = document.getElementById('progress-stage-sub');
    const verifyBtn = document.getElementById('upload-verify-btn');
    const quickBtn = document.getElementById('quick-verify-btn');
    const errorBox = document.getElementById('upload-error-box');

    errorBox.classList.add('hidden');
    progressPanel.classList.remove('hidden');
    verifyBtn.disabled = true;
    if (quickBtn) quickBtn.disabled = true;

    const stages = [
      { pct: 20, title: 'Reading manuscript & extracting claims...', sub: 'Separating body prose from reference section.' },
      { pct: 48, title: 'Resolving references on OpenAlex, Crossref & arXiv...', sub: 'Fetching metadata and open-access full-text PDFs.' },
      { pct: 76, title: 'Ranking evidence passages with BM25...', sub: 'Scoring source chunks against extracted claims.' },
      { pct: 90, title: 'Finalizing claim verdicts & confidence scores...', sub: 'Verifying verbatim source quotes.' }
    ];

    let stepIdx = 0;
    progressFill.style.width = `${stages[0].pct}%`;
    progressPct.textContent = `${stages[0].pct}%`;
    stageTitle.textContent = stages[0].title;
    stageSub.textContent = stages[0].sub;

    const stageTimer = setInterval(() => {
      if (stepIdx < stages.length - 1) {
        stepIdx += 1;
        progressFill.style.width = `${stages[stepIdx].pct}%`;
        progressPct.textContent = `${stages[stepIdx].pct}%`;
        stageTitle.textContent = stages[stepIdx].title;
        stageSub.textContent = stages[stepIdx].sub;
      }
    }, 2400);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('max_pairs', String(maxPairs));
      formData.append('use_llm', useLlm ? 'true' : 'false');

      const res = await fetch(`${API_BASE}/analyze`, {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || `Verification failed (HTTP ${res.status}).`;
        throw new Error(msg);
      }

      clearInterval(stageTimer);
      progressFill.style.width = '100%';
      progressPct.textContent = '100%';
      stageTitle.textContent = 'Verification complete!';
      stageSub.textContent = `Analyzed ${data.stats?.pairs_verified ?? 0} claim-citation pairs in ${data.filename}.`;

      saveReportToSession(data);
      state.expandedClaims = new Set((data.results || []).slice(0, 2).map((r) => r.id));
      state.claimFilter = 'ALL';

      showToast(`Verification complete for ${data.filename}`, 'success');
      setTimeout(() => {
        progressPanel.classList.add('hidden');
        navigateTo('verification');
      }, 450);
    } catch (err) {
      clearInterval(stageTimer);
      progressPanel.classList.add('hidden');
      errorBox.textContent = err.message || 'An unexpected error occurred during verification.';
      errorBox.classList.remove('hidden');
      showToast(err.message || 'Verification failed.', 'error', 6000);
    } finally {
      state.isProcessing = false;
      verifyBtn.disabled = !state.selectedFile;
      if (quickBtn) quickBtn.disabled = false;
    }
  }

  // ==================== PAGE 2: DASHBOARD RENDERER ====================
  function renderDashboard() {
    const cardsEl = document.getElementById('dash-summary-cards');
    const quickReportEl = document.getElementById('dash-quick-report');
    const recentEl = document.getElementById('dash-recent-activity');

    const r = state.currentReport;
    if (!r) {
      cardsEl.innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">Documents Verified</div>
          <div class="kpi-value">0</div>
          <div class="kpi-sub">Upload a PDF or DOCX to begin</div>
        </div>
        <div class="kpi-card green">
          <div class="kpi-label">Supported Claims</div>
          <div class="kpi-value">&mdash;</div>
          <div class="kpi-sub">Awaiting document analysis</div>
        </div>
        <div class="kpi-card yellow">
          <div class="kpi-label">Needs Review / Partial</div>
          <div class="kpi-value">&mdash;</div>
          <div class="kpi-sub">Awaiting document analysis</div>
        </div>
        <div class="kpi-card red">
          <div class="kpi-label">Unsupported / Contradictory</div>
          <div class="kpi-value">&mdash;</div>
          <div class="kpi-sub">Awaiting document analysis</div>
        </div>
      `;

      quickReportEl.innerHTML = `
        <p style="margin:0 0 12px;color:var(--text-secondary);font-size:0.9rem;">
          No report generated yet in this session.
        </p>
        <button type="button" class="btn btn-outline btn-sm" data-nav="upload">Upload First Manuscript</button>
      `;

      recentEl.innerHTML = `
        <div class="empty-state" style="padding:28px;">
          <p style="margin:0 0 12px;">No verification activity recorded yet. Upload a research document to inspect claims and citations.</p>
          <button type="button" class="btn btn-primary btn-sm" data-nav="upload">New Verification</button>
        </div>
      `;
      return;
    }

    const s = r.stats || {};
    const vc = s.verdict_counts || {};
    const supportedCount = vc.supported || 0;
    const partialReviewCount = (vc.partially_supported || 0) + (vc.needs_review || 0);
    const flaggedCount = (vc.unsupported || 0) + (vc.contradictory || 0);

    cardsEl.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Extracted Claims</div>
        <div class="kpi-value">${esc(s.claims_found ?? 0)}</div>
        <div class="kpi-sub">${esc(s.pairs_verified ?? 0)} claim-citation pairs checked</div>
      </div>
      <div class="kpi-card green">
        <div class="kpi-label">Supported Claims</div>
        <div class="kpi-value">${esc(supportedCount)}</div>
        <div class="kpi-sub">Directly verified against source text</div>
      </div>
      <div class="kpi-card yellow">
        <div class="kpi-label">Partial / Needs Review</div>
        <div class="kpi-value">${esc(partialReviewCount)}</div>
        <div class="kpi-sub">${esc(vc.partially_supported || 0)} partial &bull; ${esc(vc.needs_review || 0)} review</div>
      </div>
      <div class="kpi-card red">
        <div class="kpi-label">Unsupported / Contradictory</div>
        <div class="kpi-value">${esc(flaggedCount)}</div>
        <div class="kpi-sub">${esc(vc.unsupported || 0)} unsupported &bull; ${esc(vc.contradictory || 0)} contradictory</div>
      </div>
    `;

    quickReportEl.innerHTML = `
      <div style="font-weight:700;color:var(--navy-900);margin-bottom:4px;">${esc(r.filename)}</div>
      <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:14px;">Generated ${esc(formatTimestamp(r.generated_at))}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" class="btn btn-primary btn-sm" data-nav="verification">View Dashboard</button>
        <button type="button" class="btn btn-outline btn-sm" data-nav="reports">Preview &amp; Download</button>
      </div>
    `;

    const rowsHtml = state.sessionReports.map((rep, idx) => {
      const rs = rep.stats || {};
      const rvc = rs.verdict_counts || {};
      return `
        <tr>
          <td><strong>${esc(rep.filename)}</strong></td>
          <td>${esc(formatTimestamp(rep.generated_at))}</td>
          <td>${esc(rs.claims_found ?? 0)} claims / ${esc(rs.references_parsed ?? 0)} refs</td>
          <td>${verdictBadgeHtml('supported')} ${esc(rvc.supported || 0)}</td>
          <td>
            <button type="button" class="btn btn-outline btn-sm" data-load-session-idx="${idx}">Open</button>
          </td>
        </tr>
      `;
    }).join('');

    recentEl.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Verified At</th>
              <th>Coverage</th>
              <th>Supported</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  // ==================== PAGE 4: VERIFICATION DASHBOARD RENDERER ====================
  function renderVerificationDashboard() {
    const emptyEl = document.getElementById('verification-empty');
    const contentEl = document.getElementById('verification-content');

    if (!state.currentReport) {
      emptyEl.classList.remove('hidden');
      contentEl.classList.add('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    const r = state.currentReport;
    const s = r.stats || {};
    const vc = s.verdict_counts || {};

    // 1. Document information
    document.getElementById('verif-doc-meta').innerHTML = `
      <div class="meta-item"><span>Document Name</span><strong>${esc(r.filename)}</strong></div>
      <div class="meta-item"><span>Analyzed Timestamp</span><strong>${esc(formatTimestamp(r.generated_at))}</strong></div>
      <div class="meta-item"><span>Total Extracted Claims</span><strong>${esc(s.claims_found ?? 0)}</strong></div>
      <div class="meta-item"><span>Detected References</span><strong>${esc(s.references_parsed ?? 0)}</strong></div>
      <div class="meta-item"><span>Claim-Citation Pairs Verified</span><strong>${esc(s.pairs_verified ?? 0)}</strong></div>
      <div class="meta-item"><span>Verification Engine</span><strong>${r.llm_enabled ? 'AI + BM25 Grounded' : 'BM25 Retrieval (Manual Review)'}</strong></div>
    `;

    const notesArea = document.getElementById('verif-notes-area');
    if (Array.isArray(r.notes) && r.notes.length > 0) {
      notesArea.innerHTML = `<div class="alert-banner alert-info" style="margin:0;">${r.notes.map((n) => `<div>&bull; ${esc(n)}</div>`).join('')}</div>`;
    } else {
      notesArea.innerHTML = '';
    }

    // Only display categories and counts returned by the backend
    const kpiItems = [
      { label: 'Total Extracted Claims', val: s.claims_found ?? 0, sub: `${s.pairs_verified ?? 0} citation pairs checked`, cls: '' },
      { label: 'Detected Citations (Refs)', val: s.references_parsed ?? 0, sub: `${(r.unused_references || []).length} unreferenced entries`, cls: '' },
      { label: 'Supported Claims', val: vc.supported ?? 0, sub: 'Green: Verified against source', cls: 'green' },
      { label: 'Partially Supported', val: vc.partially_supported ?? 0, sub: 'Yellow: Scope/magnitude differs', cls: 'yellow' },
      { label: 'Needs Review', val: vc.needs_review ?? 0, sub: 'Yellow: Insufficient evidence / manual check', cls: 'yellow' },
      { label: 'Unsupported Claims', val: vc.unsupported ?? 0, sub: 'Red: Claim not found in source', cls: 'red' },
      { label: 'Contradictory Claims', val: vc.contradictory ?? 0, sub: 'Red: Source states opposite', cls: 'red' },
      { label: 'Potentially Outdated', val: vc.possibly_outdated ?? 0, sub: 'Grey: Newer work may supersede', cls: 'grey' }
    ];

    document.getElementById('verif-kpi-grid').innerHTML = kpiItems.map((item) => `
      <div class="kpi-card ${item.cls}">
        <div class="kpi-label">${esc(item.label)}</div>
        <div class="kpi-value">${esc(item.val)}</div>
        <div class="kpi-sub">${esc(item.sub)}</div>
      </div>
    `).join('');

    // SVG Donut Chart of actual backend verdict_counts
    const segments = [
      { key: 'supported', label: 'Supported', count: vc.supported || 0, color: '#16A34A' },
      { key: 'partially_supported', label: 'Partially Supported', count: vc.partially_supported || 0, color: '#CA8A04' },
      { key: 'needs_review', label: 'Needs Review', count: vc.needs_review || 0, color: '#FACC15' },
      { key: 'unsupported', label: 'Unsupported', count: vc.unsupported || 0, color: '#DC2626' },
      { key: 'contradictory', label: 'Contradictory', count: vc.contradictory || 0, color: '#991B1B' },
      { key: 'possibly_outdated', label: 'Potentially Outdated', count: vc.possibly_outdated || 0, color: '#64748B' }
    ];

    const totalPairs = segments.reduce((acc, seg) => acc + seg.count, 0);
    const radius = 56;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;

    const circlesSvg = totalPairs === 0
      ? `<circle cx="75" cy="75" r="${radius}" fill="none" stroke="#E2E8F0" stroke-width="18" />`
      : segments.filter((seg) => seg.count > 0).map((seg) => {
          const dash = (seg.count / totalPairs) * circumference;
          const svg = `<circle cx="75" cy="75" r="${radius}" fill="none" stroke="${seg.color}" stroke-width="18" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 75 75)" />`;
          offset += dash;
          return svg;
        }).join('');

    const legendHtml = segments.map((seg) => {
      const pct = totalPairs > 0 ? Math.round((seg.count / totalPairs) * 100) : 0;
      return `
        <div class="legend-row">
          <div><span class="legend-swatch" style="background:${seg.color};"></span>${esc(seg.label)}</div>
          <strong>${esc(seg.count)} <span style="color:var(--text-muted);font-weight:500;">(${pct}%)</span></strong>
        </div>
      `;
    }).join('');

    document.getElementById('verdict-chart-container').innerHTML = `
      <svg width="150" height="150" viewBox="0 0 150 150" aria-label="Verdict Distribution Chart">
        ${circlesSvg}
        <text x="75" y="72" text-anchor="middle" font-size="20" font-weight="800" fill="#0B192C">${esc(totalPairs)}</text>
        <text x="75" y="90" text-anchor="middle" font-size="10" fill="#64748B">PAIRS</text>
      </svg>
      <div class="legend-list">${legendHtml}</div>
    `;

    // Source Retrieval Coverage Bars
    const fullText = s.sources_full_text || 0;
    const abstractOnly = s.sources_abstract_only || 0;
    const notFound = s.sources_not_found || 0;
    const totalSources = Math.max(fullText + abstractOnly + notFound, 1);

    const barRow = (label, count, color) => {
      const pct = Math.round((count / totalSources) * 100);
      return `
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;font-size:0.86rem;margin-bottom:5px;">
            <span>${esc(label)}</span>
            <strong>${esc(count)} (${pct}%)</strong>
          </div>
          <div style="height:9px;background:var(--bg-subtle);border-radius:999px;overflow:hidden;border:1px solid var(--border-light);">
            <div style="height:100%;width:${pct}%;background:${color};"></div>
          </div>
        </div>
      `;
    };

    document.getElementById('source-coverage-container').innerHTML = `
      ${barRow('Open-Access Full Text Retrieved', fullText, '#1D4ED8')}
      ${barRow('Abstract-Only Retrieved', abstractOnly, '#06B6D4')}
      ${barRow('Source Not Found / Unresolved', notFound, '#94A3B8')}
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border-light);font-size:0.83rem;color:var(--text-secondary);">
        Uncited empirical sentences detected: <strong>${esc((r.uncited_claims || []).length)}</strong>
      </div>
    `;
  }

  // ==================== PAGE 5: CLAIM-BY-CLAIM ANALYSIS ====================
  function renderClaimsAnalysis() {
    const emptyEl = document.getElementById('claims-empty');
    const contentEl = document.getElementById('claims-content');

    if (!state.currentReport || !(state.currentReport.results || []).length) {
      emptyEl.classList.remove('hidden');
      contentEl.classList.add('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    const results = state.currentReport.results || [];
    const filterCounts = {
      ALL: results.length,
      supported: results.filter((r) => r.verdict === 'supported').length,
      partially_supported: results.filter((r) => r.verdict === 'partially_supported').length,
      needs_review: results.filter((r) => r.verdict === 'needs_review').length,
      unsupported: results.filter((r) => r.verdict === 'unsupported').length,
      contradictory: results.filter((r) => r.verdict === 'contradictory').length,
      possibly_outdated: results.filter((r) => r.verdict === 'possibly_outdated').length
    };

    const chips = [
      { id: 'ALL', label: `All (${filterCounts.ALL})` },
      { id: 'supported', label: `Supported (${filterCounts.supported})` },
      { id: 'partially_supported', label: `Partially Supported (${filterCounts.partially_supported})` },
      { id: 'needs_review', label: `Needs Review (${filterCounts.needs_review})` },
      { id: 'unsupported', label: `Unsupported (${filterCounts.unsupported})` },
      { id: 'contradictory', label: `Contradictory (${filterCounts.contradictory})` },
      { id: 'possibly_outdated', label: `Outdated (${filterCounts.possibly_outdated})` }
    ];

    document.getElementById('claims-filter-bar').innerHTML = chips.map((c) => `
      <button type="button" class="filter-chip ${state.claimFilter === c.id ? 'active' : ''}" data-claim-filter="${c.id}">
        ${esc(c.label)}
      </button>
    `).join('');

    const filtered = state.claimFilter === 'ALL'
      ? results
      : results.filter((r) => r.verdict === state.claimFilter);

    const listEl = document.getElementById('claims-cards-list');
    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-state"><p style="margin:0;">No claims match the selected verdict filter.</p></div>`;
      return;
    }

    listEl.innerHTML = filtered.map((item) => {
      const meta = VERDICT_META[item.verdict] || VERDICT_META.needs_review;
      const isExpanded = state.expandedClaims.has(item.id);
      const confPct = Math.round((item.confidence || 0) * 100);
      const flagsHtml = (item.flags || []).map(
        (fl) => `<span class="status-badge badge-grey" style="font-size:0.7rem;">${esc(fl)}</span>`
      ).join(' ');

      return `
        <article class="claim-card tone-${meta.tone}">
          <div class="claim-summary-row" data-toggle-claim="${item.id}" role="button" tabindex="0" aria-expanded="${isExpanded}">
            <div style="flex:1;min-width:0;">
              <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
                <span style="font-family:var(--font-mono);font-size:0.8rem;font-weight:700;color:var(--royal-600);">CLAIM #${esc(item.id)}</span>
                <span style="font-size:0.82rem;font-weight:600;color:var(--text-secondary);">Citation: ${esc(item.citation_marker)}</span>
                ${verdictBadgeHtml(item.verdict)}
                <span style="font-size:0.8rem;color:var(--text-muted);">Confidence: <strong>${confPct}%</strong></span>
              </div>
              <p class="claim-title-text">${esc(item.claim)}</p>
            </div>
            <div style="color:var(--text-muted);font-size:0.82rem;font-weight:600;white-space:nowrap;">
              ${isExpanded ? 'Collapse ▲' : 'Expand ▼'}
            </div>
          </div>

          <div class="claim-details-body ${isExpanded ? '' : 'hidden'}">
            <div class="detail-grid-2">
              <div class="detail-box">
                <div class="detail-label">Matched Bibliography Reference</div>
                <div style="font-size:0.88rem;color:var(--navy-900);">${esc(item.reference || 'Not matched in reference list')}</div>
              </div>
              <div class="detail-box">
                <div class="detail-label">Retrieved Original Paper Details</div>
                <div style="font-size:0.88rem;color:var(--navy-900);font-weight:600;">${esc(item.source_title || 'No external paper resolved')}</div>
                <div style="font-size:0.82rem;color:var(--text-secondary);margin-top:4px;">
                  Material: <strong>${esc(item.source_kind || 'none')}</strong>
                  ${item.source_url ? ` &bull; <a href="${esc(item.source_url)}" target="_blank" rel="noopener">Open Original Source &nearr;</a>` : ''}
                </div>
              </div>
            </div>

            <div class="detail-box">
              <div class="detail-label">Verification Explanation &amp; Confidence</div>
              <p style="margin:0 0 10px;font-size:0.92rem;color:var(--navy-900);">${esc(item.explanation)}</p>
              ${item.limitations ? `<p style="margin:0 0 10px;font-size:0.83rem;color:var(--text-secondary);"><strong>Limitations:</strong> ${esc(item.limitations)}</p>` : ''}
              <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;">
                <div class="conf-bar-wrap">
                  <span style="font-size:0.8rem;color:var(--text-secondary);">Confidence Score:</span>
                  <div class="conf-bar"><div style="width:${confPct}%;"></div></div>
                  <strong style="font-size:0.84rem;">${confPct}%</strong>
                </div>
                <div>${flagsHtml}</div>
              </div>
            </div>

            ${(item.evidence_quote || item.evidence_passage) ? `
              <div>
                <div class="detail-label">Evidence Extracted from Source ${item.evidence_location ? `(${esc(item.evidence_location)})` : ''}</div>
                <blockquote class="evidence-blockquote">
                  ${item.evidence_quote ? `<strong>Verbatim Quote:</strong> &ldquo;${esc(item.evidence_quote)}&rdquo;<br/>` : ''}
                  ${item.evidence_passage ? `<span style="font-size:0.84rem;color:var(--text-secondary);display:block;margin-top:6px;"><strong>Top Ranked Passage:</strong> ${esc(item.evidence_passage)}</span>` : ''}
                </blockquote>
              </div>
            ` : ''}

            <!-- Human Review Recording connected to POST /api/v1/reviews -->
            <div class="detail-box no-print" style="background:#F8FAFC;">
              <div class="detail-label">Record Human Reviewer Decision</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                <select id="review-decision-${item.id}" style="padding:6px 10px;border:1px solid var(--border-medium);border-radius:8px;font-size:0.85rem;">
                  <option value="confirmed_verdict">Confirm Automated Verdict</option>
                  <option value="override_supported">Override: Supported</option>
                  <option value="override_unsupported">Override: Unsupported</option>
                  <option value="needs_author_revision">Flag for Author Revision</option>
                </select>
                <input type="text" id="review-note-${item.id}" placeholder="Optional reviewer note..." style="flex:1;min-width:180px;padding:6px 10px;border:1px solid var(--border-medium);border-radius:8px;font-size:0.85rem;" />
                <button type="button" class="btn btn-outline btn-sm" data-save-review="${item.id}">Save Review</button>
              </div>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  // ==================== HISTORY PAGE RENDERER ====================
  async function renderHistoryPage() {
    await fetchBackendReviews();
    const runsEl = document.getElementById('history-runs-container');
    const reviewsEl = document.getElementById('history-reviews-container');

    if (!state.sessionReports.length) {
      runsEl.innerHTML = `<p style="color:var(--text-secondary);font-size:0.9rem;">No verification runs in the current browser session yet.</p>`;
    } else {
      runsEl.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Generated At</th>
                <th>Claims Found</th>
                <th>Pairs Verified</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${state.sessionReports.map((rep, idx) => `
                <tr>
                  <td><strong>${esc(rep.filename)}</strong></td>
                  <td>${esc(formatTimestamp(rep.generated_at))}</td>
                  <td>${esc(rep.stats?.claims_found ?? 0)}</td>
                  <td>${esc(rep.stats?.pairs_verified ?? 0)}</td>
                  <td><button type="button" class="btn btn-primary btn-sm" data-load-session-idx="${idx}">Inspect Report</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if (!state.backendReviews.length) {
      reviewsEl.innerHTML = `<p style="color:var(--text-secondary);font-size:0.9rem;">No human reviewer decisions saved in <code>review_history.json</code> yet.</p>`;
    } else {
      reviewsEl.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Document</th>
                <th>Claim ID</th>
                <th>Decision</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              ${state.backendReviews.slice().reverse().map((rev) => `
                <tr>
                  <td>${esc(formatTimestamp(rev.timestamp))}</td>
                  <td>${esc(rev.filename)}</td>
                  <td>#${esc(rev.result_id)}</td>
                  <td><span class="status-badge badge-green">${esc(rev.decision)}</span></td>
                  <td>${esc(rev.note || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // ==================== PAGE 6: REPORTS RENDERER ====================
  function renderReportsPage() {
    const emptyEl = document.getElementById('reports-empty');
    const contentEl = document.getElementById('reports-content');

    if (!state.currentReport) {
      emptyEl.classList.remove('hidden');
      contentEl.classList.add('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    const r = state.currentReport;
    const s = r.stats || {};
    const vc = s.verdict_counts || {};

    document.getElementById('report-doc-heading').textContent = `Verification Report: ${r.filename}`;
    document.getElementById('report-timestamp-sub').textContent = `Generated at ${formatTimestamp(r.generated_at)}`;

    document.getElementById('report-summary-strip').innerHTML = `
      <div class="meta-item"><span>Claims Found</span><strong>${esc(s.claims_found ?? 0)}</strong></div>
      <div class="meta-item"><span>Pairs Verified</span><strong>${esc(s.pairs_verified ?? 0)}</strong></div>
      <div class="meta-item"><span>Supported</span><strong>${esc(vc.supported ?? 0)}</strong></div>
      <div class="meta-item"><span>Partially Supported</span><strong>${esc(vc.partially_supported ?? 0)}</strong></div>
      <div class="meta-item"><span>Unsupported / Contradictory</span><strong>${esc((vc.unsupported ?? 0) + (vc.contradictory ?? 0))}</strong></div>
      <div class="meta-item"><span>Needs Review / Outdated</span><strong>${esc((vc.needs_review ?? 0) + (vc.possibly_outdated ?? 0))}</strong></div>
    `;

    document.getElementById('report-disclaimer-box').textContent = r.disclaimer || '';

    const rows = (r.results || []).map((item) => `
      <tr>
        <td><strong>#${esc(item.id)}</strong></td>
        <td style="min-width:220px;">${esc(item.claim)}</td>
        <td>
          <div><strong>${esc(item.citation_marker)}</strong></div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:3px;">${esc(item.source_title || item.reference || 'Unresolved')}</div>
          ${item.source_url ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener" style="font-size:0.78rem;">Source Link &nearr;</a>` : ''}
        </td>
        <td>
          ${verdictBadgeHtml(item.verdict)}
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px;">Confidence: ${Math.round((item.confidence || 0) * 100)}%</div>
        </td>
        <td style="min-width:220px;">
          ${item.evidence_quote ? `<div style="font-style:italic;margin-bottom:5px;">&ldquo;${esc(item.evidence_quote)}&rdquo;</div>` : ''}
          <div style="font-size:0.82rem;color:var(--text-secondary);">${esc(item.explanation)}</div>
        </td>
      </tr>
    `).join('');

    document.getElementById('report-claims-table-wrap').innerHTML = rows
      ? `
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Claim</th>
              <th>Citation &amp; Source</th>
              <th>Verdict &amp; Confidence</th>
              <th>Evidence &amp; Explanation</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `
      : `<p style="color:var(--text-secondary);">No claim-citation pairs were verified in this document.</p>`;

    const flaggedItems = (r.results || []).filter((item) => item.needs_human_review || (item.flags && item.flags.length));
    const unusedRefs = r.unused_references || [];

    document.getElementById('report-flagged-section').innerHTML = `
      <div style="margin-bottom:14px;">
        <strong>Flagged Claim-Citation Pairs (${flaggedItems.length}):</strong>
        ${flaggedItems.length
          ? `<ul style="margin:8px 0 0;padding-left:20px;font-size:0.88rem;color:var(--text-secondary);">
              ${flaggedItems.map((f) => `<li><strong>#${esc(f.id)} (${esc(f.citation_marker)})</strong> &mdash; ${esc(f.verdict)} ${f.flags?.length ? `[Flags: ${esc(f.flags.join(', '))}]` : ''}: ${esc(f.explanation)}</li>`).join('')}
            </ul>`
          : `<p style="margin:6px 0 0;font-size:0.88rem;color:var(--text-secondary);">None flagged.</p>`
        }
      </div>
      <div>
        <strong>Unused Bibliography Entries (${unusedRefs.length}):</strong>
        ${unusedRefs.length
          ? `<ul style="margin:8px 0 0;padding-left:20px;font-size:0.85rem;color:var(--text-secondary);">
              ${unusedRefs.map((u) => `<li>${esc(u)}</li>`).join('')}
            </ul>`
          : `<p style="margin:6px 0 0;font-size:0.88rem;color:var(--text-secondary);">All parsed references were cited in the body.</p>`
        }
      </div>
    `;
  }

  // ==================== EVENT WIRING ====================
  document.addEventListener('DOMContentLoaded', () => {
    loadSessionReports();
    checkBackendHealth();

    // Landing page buttons
    document.querySelectorAll('[data-enter-app]').forEach((btn) => {
      btn.addEventListener('click', () => enterApp(btn.dataset.enterApp));
    });

    document.getElementById('go-landing-btn').addEventListener('click', showLanding);
    document.getElementById('topbar-home-btn').addEventListener('click', showLanding);

    // Sidebar & internal navigation
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => navigateTo(btn.dataset.route));
    });

    document.body.addEventListener('click', (e) => {
      const navTrigger = e.target.closest('[data-nav]');
      if (navTrigger) {
        navigateTo(navTrigger.dataset.nav);
        return;
      }

      const loadIdxBtn = e.target.closest('[data-load-session-idx]');
      if (loadIdxBtn) {
        const idx = Number(loadIdxBtn.dataset.loadSessionIdx);
        if (state.sessionReports[idx]) {
          state.currentReport = state.sessionReports[idx];
          state.expandedClaims = new Set((state.currentReport.results || []).slice(0, 2).map((r) => r.id));
          navigateTo('verification');
        }
        return;
      }

      const filterBtn = e.target.closest('[data-claim-filter]');
      if (filterBtn) {
        state.claimFilter = filterBtn.dataset.claimFilter;
        renderClaimsAnalysis();
        return;
      }

      const toggleRow = e.target.closest('[data-toggle-claim]');
      if (toggleRow) {
        const id = Number(toggleRow.dataset.toggleClaim);
        if (state.expandedClaims.has(id)) state.expandedClaims.delete(id);
        else state.expandedClaims.add(id);
        renderClaimsAnalysis();
        return;
      }

      const saveReviewBtn = e.target.closest('[data-save-review]');
      if (saveReviewBtn) {
        const id = Number(saveReviewBtn.dataset.saveReview);
        const decision = document.getElementById(`review-decision-${id}`)?.value || 'confirmed_verdict';
        const note = document.getElementById(`review-note-${id}`)?.value || '';
        submitHumanReview(id, decision, note);
      }
    });

    // Mobile sidebar toggle
    document.getElementById('mobile-menu-btn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });

    // Quick upload on Dashboard
    document.getElementById('quick-verify-btn').addEventListener('click', () => {
      const input = document.getElementById('quick-file-input');
      const file = input.files && input.files[0];
      if (!file) {
        showToast('Please select a PDF or DOCX file first.', 'error');
        return;
      }
      navigateTo('upload');
      if (validateAndSetFile(file)) {
        runVerification(file, 20, true);
      }
    });

    // Main Drag & Drop Upload Page
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('main-file-input');

    document.getElementById('browse-files-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    document.getElementById('replace-file-btn').addEventListener('click', () => fileInput.click());
    document.getElementById('remove-file-btn').addEventListener('click', clearSelectedFile);

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) validateAndSetFile(file);
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) validateAndSetFile(file);
    });

    document.getElementById('upload-verify-btn').addEventListener('click', () => {
      if (!state.selectedFile) return;
      const maxPairs = Math.max(1, Math.min(50, Number(document.getElementById('upload-max-pairs').value) || 20));
      const useLlm = document.getElementById('upload-use-llm').checked;
      runVerification(state.selectedFile, maxPairs, useLlm);
    });

    // Expand / Collapse all claims
    document.getElementById('expand-all-btn').addEventListener('click', () => {
      const results = state.currentReport?.results || [];
      state.expandedClaims = new Set(results.map((r) => r.id));
      renderClaimsAnalysis();
    });
    document.getElementById('collapse-all-btn').addEventListener('click', () => {
      state.expandedClaims.clear();
      renderClaimsAnalysis();
    });

    // History refresh
    document.getElementById('refresh-history-btn').addEventListener('click', renderHistoryPage);

    // Report downloads wired to existing backend /api/v1/export/<fmt>
    document.getElementById('download-json-btn').addEventListener('click', () => {
      window.location.href = `${API_BASE}/export/json`;
    });
    document.getElementById('download-csv-btn').addEventListener('click', () => {
      window.location.href = `${API_BASE}/export/csv`;
    });
  });
})();
