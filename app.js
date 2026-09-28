/* Sightline UI. Views are template-string render functions; events use delegation on document.
   All logic that decides what the numbers mean lives in engine.js. */
(function () {
  'use strict';

  const E = window.SightlineEngine;
  const KEY = 'sightline-db-v1';
  const THEME_KEY = 'sightline-theme';
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const app = document.getElementById('app');

  const state = {
    db: null,
    result: null,
    storage: 'ok',        // ok | blocked | full | corrupt
    pending: [],          // CSV files waiting to be imported
    sort: { key: 'status', dir: 1 },
    alertFilter: 'all',
    confirm: null,        // key of the delete waiting for confirmation
    lastTrigger: null,    // button id to refocus when a confirmation is cancelled
    flash: null,          // { tone, html, sticky }
    copyFallback: null,   // { id, text } when clipboard access fails
    settingsMsg: null,
    preview: null,
    focusAfterNav: null,
    editBudget: null,     // client id whose budget form is open
    driverView: 'platform',
    formErrors: null,     // { form, errors: { field: message }, values }
    formMsg: null,        // { form, text, error }
  };

  /* ---------- storage ---------- */

  function emptyDb() {
    return { version: 1, agency: { name: 'Your agency' }, clients: [], rows: [], imports: [], notes: [], settings: {}, isDemo: false };
  }

  function load() {
    let raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { state.storage = 'blocked'; return emptyDb(); }
    if (!raw) return emptyDb();
    try {
      const d = JSON.parse(raw);
      if (!d || d.version !== 1 || !Array.isArray(d.clients) || !Array.isArray(d.rows)) throw new Error('Unexpected shape');
      return Object.assign(emptyDb(), d, {
        agency: Object.assign({ name: 'Your agency' }, d.agency),
        imports: Array.isArray(d.imports) ? d.imports : [],
        notes: Array.isArray(d.notes) ? d.notes : [],
        settings: d.settings && typeof d.settings === 'object' ? d.settings : {},
      });
    } catch (e) {
      // Leave unreadable data in place rather than overwriting it.
      state.storage = 'corrupt';
      return emptyDb();
    }
  }

  function save() {
    if (state.storage === 'corrupt' || state.storage === 'blocked') return false;
    try {
      localStorage.setItem(KEY, JSON.stringify(state.db));
      state.storage = 'ok';
      return true;
    } catch (e) {
      state.storage = e && (e.name === 'QuotaExceededError' || e.code === 22) ? 'full' : 'blocked';
      return false;
    }
  }

  function recompute() { state.result = E.analyze(state.db); }
  function commit() { const ok = save(); recompute(); return ok; }

  /* ---------- theme ---------- */

  function effectiveTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function themePref() {
    try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { return document.documentElement.getAttribute('data-theme') || 'system'; }
  }
  function setTheme(pref) {
    if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
    else document.documentElement.removeAttribute('data-theme');
    try {
      if (pref === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, pref);
    } catch (e) { /* theme still applies for this visit */ }
  }

  /* ---------- formatting ---------- */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function money(n, dp) {
    if (n == null || !isFinite(n)) return '–';
    const d = dp != null ? dp : Math.abs(n) >= 1000 ? 0 : 2;
    return 'S$' + n.toLocaleString('en-SG', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const int = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en-SG'));
  const roas = (n) => (n == null ? 'Not tracked' : n.toFixed(2) + '×');
  const ctr = (n) => (n == null ? '–' : (n * 100).toFixed(2) + '%');
  function pctTxt(p) {
    if (p == null) return '';
    return (p > 0.0005 ? '+' : p < -0.0005 ? '−' : '') + (Math.abs(p) * 100).toFixed(1) + '%';
  }
  function dshort(iso) { const [, m, d] = iso.split('-'); return +d + ' ' + MONTHS[+m - 1]; }
  function dlong(iso) { return dshort(iso) + ' ' + iso.slice(0, 4); }
  function range(a, b) { return a.slice(0, 4) === b.slice(0, 4) ? `${dshort(a)} to ${dlong(b)}` : `${dlong(a)} to ${dlong(b)}`; }
  // Keeps acronyms like CPA and ROAS intact when a label follows a number.
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
  function plural(n, one, many) { return n === 1 ? one : many || one + 's'; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // Which direction is better for each metric; 0 means neither.
  const GOOD_DIR = { spend: 0, conversions: 1, revenue: 1, cpa: -1, roas: 1, ctr: 1 };

  function delta(metric, p, withVs) {
    if (p == null) return `<span class="delta flat">${withVs ? 'No earlier period' : '–'}</span>`;
    const dir = GOOD_DIR[metric];
    let cls = 'neutral', sr = '';
    if (Math.abs(p) < 0.02) cls = 'flat';
    else if (dir) {
      const better = (p > 0) === (dir > 0);
      cls = better ? 'up-good' : 'up-bad';
      sr = better ? ' (better)' : ' (worse)';
    }
    return `<span class="delta ${cls}">${pctTxt(p)}<span class="visually-hidden">${sr}</span>${withVs ? ` <span class="vs">vs ${esc(lbl().prev)}</span>` : ''}</span>`;
  }

  /* ---------- icons (inline, decorative) ---------- */

  const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${p}</svg>`;
  const ICON = {
    overview: svg('<path d="M5 20v-7M12 20V4M19 20v-10"/>'),
    alerts: svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    reports: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
    data: svg('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
    settings: svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
    moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    print: svg('<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/>'),
    doc: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
    upDown: '<svg class="arrow" viewBox="0 0 10 14" aria-hidden="true"><path d="M5 1l4 5H1zM5 13l4-5H1z" fill="currentColor" opacity=".35"/></svg>',
    up: '<svg class="arrow" viewBox="0 0 10 14" aria-hidden="true"><path d="M5 1l4 5H1z" fill="currentColor"/></svg>',
    down: '<svg class="arrow" viewBox="0 0 10 14" aria-hidden="true"><path d="M5 13l4-5H1z" fill="currentColor"/></svg>',
  };
  const BRAND_MARK = '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="8" fill="#15191c"/><circle cx="16" cy="16" r="7" fill="none" stroke="#22d3ee" stroke-width="3"/><path d="M4 16h24" stroke="#22d3ee" stroke-width="3"/></svg>';

  /* ---------- small components ---------- */

  const STATUS = { risk: ['At risk', 'risk'], watch: ['Watch', 'watch'], good: ['Healthy', 'good'], nodata: ['No data', 'nodata'] };
  const SEV = { crit: ['Critical', 'crit'], warn: ['Warning', 'warn'], good: ['Opportunity', 'good'], info: ['Note', 'info'] };
  const STATUS_ORDER = { risk: 0, watch: 1, good: 2, nodata: 3 };

  function pill(map, key) {
    const [label, cls] = map[key];
    return `<span class="pill pill-${cls}"><span class="dot" aria-hidden="true"></span>${label}</span>`;
  }
  function platformNames(ids) { return ids.map((p) => E.PLATFORMS[p] || p).join(', '); }
  function platformPills(ids) { return ids.map((p) => `<span class="pill pill-platform">${esc(E.PLATFORMS[p] || p)}</span>`).join(''); }

  function confirmOr(key, buttonHtml, message, confirmLabel) {
    if (state.confirm !== key) return buttonHtml;
    return `<div class="confirm" role="group" aria-labelledby="cf-msg">
      <p id="cf-msg">${message}</p>
      <button type="button" class="btn btn-danger" data-action="confirm-do" data-key="${esc(key)}">${confirmLabel}</button>
      <button type="button" class="btn btn-secondary" data-action="confirm-cancel" id="confirm-cancel">Cancel</button>
    </div>`;
  }

  function emptyState(title, text, actions) {
    return `<div class="empty"><h2>${title}</h2><p>${text}</p>${actions ? `<div class="btn-row">${actions}</div>` : ''}</div>`;
  }
  const NO_DATA_ACTIONS = `<button type="button" class="btn btn-primary" data-action="demo">Try it with demo data</button>
    <a class="btn btn-secondary" href="#/data" data-action="go-import">Import CSV files</a>`;

  function kpiRow(k, metrics) {
    const all = {
      spend: [`Spend, ${lbl().short}`, money(k.this.spend)],
      conversions: ['Conversions', int(k.this.conversions)],
      cpa: ['Cost per conversion', money(k.this.cpa)],
      roas: ['ROAS', roas(k.this.roas)],
      ctr: ['Click-through rate', ctr(k.this.ctr)],
    };
    return `<dl class="kpis">${metrics.map((m) => `<div class="kpi"><dt>${all[m][0]}</dt><dd><span class="value">${all[m][1]}</span>${delta(m, k.delta[m], true)}</dd></div>`).join('')}</dl>`;
  }

  function topIssue(c) {
    const f = c.findings.find((x) => x.severity === 'crit' || x.severity === 'warn') || c.findings.find((x) => x.severity === 'good');
    return f ? f.title : c.status === 'nodata' ? 'No data yet' : 'Nothing flagged';
  }

  // Labels for the selected comparison period, so copy never hard-codes "this week".
  function lbl() { return (state.result && state.result.labels) || E.PERIODS.w7; }
  function periodKey() { return (state.result && state.result.periodKey) || 'w7'; }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function signedMoney(v, dp) {
    if (v == null || !isFinite(v)) return '–';
    return (v > 0.004 ? '+' : v < -0.004 ? '−' : '') + money(Math.abs(v), dp);
  }
  function signedInt(v) {
    if (v == null || !isFinite(v)) return '–';
    const r = Math.round(v);
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toLocaleString('en-SG');
  }
  const pctWhole = (v) => (v == null || !isFinite(v) ? '–' : Math.round(v * 100) + '%');

  function periodSelect(id) {
    const cur = periodKey();
    return `<div class="period-field"><label for="${id}">Period</label>
      <select class="select select-sm" id="${id}" data-change="period">${Object.keys(E.PERIODS).map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${E.PERIODS[k].title}</option>`).join('')}</select></div>`;
  }

  function clientNotes(clientId) {
    return (state.db.notes || []).filter((n) => n.clientId === clientId).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  function fieldError(form, key) {
    const fe = state.formErrors;
    return fe && fe.form === form && fe.errors[key] ? fe.errors[key] : null;
  }
  function formValue(form, key, fallback) {
    const fe = state.formErrors;
    return fe && fe.form === form && fe.values && key in fe.values ? fe.values[key] : fallback;
  }
  function formMsg(form) {
    const m = state.formMsg;
    return m && m.form === form ? `<p class="${m.error ? 'field-error' : 'field-ok'}" role="${m.error ? 'alert' : 'status'}">${esc(m.text)}</p>` : '';
  }
  function errAttrs(form, key) {
    return fieldError(form, key) ? ` aria-invalid="true" aria-describedby="err-${form}-${key}"` : '';
  }
  function errText(form, key) {
    const e = fieldError(form, key);
    return e ? `<p class="field-error" id="err-${form}-${key}">${esc(e)}</p>` : '';
  }

  /* ---------- budget, pacing and targets ---------- */

  const PACE_TEXT = { exceeded: 'over budget', over: 'over pace', under: 'under pace', on: 'on track', early: 'too early' };
  const PACE_CLASS = { exceeded: 'pace-bad', over: 'pace-bad', under: 'pace-warn', on: 'pace-good', early: 'pace-muted' };

  function paceCell(c) {
    if (!c.pacing) return '<span class="subtle">No budget</span>';
    const p = c.pacing;
    return `<span class="pace ${PACE_CLASS[p.status]}"><span class="num">${Math.round(p.pace * 100)}%</span> ${PACE_TEXT[p.status]}</span>`;
  }

  function pacingBlock(c) {
    const p = c.pacing;
    if (!p) return '';
    const spentPct = Math.min(100, (p.mtd / p.budget) * 100);
    const evenPct = Math.min(100, (p.elapsed / p.daysInMonth) * 100);
    const status = {
      exceeded: `${money(p.mtd - p.budget, 0)} over budget`,
      over: `On track to overspend by ${money(p.projected - p.budget, 0)}`,
      under: `On track to leave ${money(p.budget - p.projected, 0)} unspent`,
      on: 'On track to land near budget',
      early: 'Too early in the month to project',
    }[p.status];
    const aria = `${money(p.mtd, 0)} of a ${money(p.budget, 0)} budget spent, ${Math.round(spentPct)}%, after ${p.elapsed} of ${p.daysInMonth} days. Even pacing would be ${Math.round(evenPct)}%.`;
    return `<div class="pacing">
      <div class="pacing-top"><span class="pacing-label">${esc(p.month)} budget</span><span class="pace ${PACE_CLASS[p.status]}">${status}</span></div>
      <div class="pacing-bar${p.status === 'exceeded' ? ' is-over' : ''}" role="img" aria-label="${esc(aria)}"><span class="fill" style="width:${spentPct.toFixed(1)}%"></span><span class="even" style="left:${evenPct.toFixed(1)}%"></span></div>
      <p class="subtle pacing-key">The bar is spend so far. The line marks where spend would be if paced evenly through the month.</p>
      <dl class="pacing-stats">
        <div><dt>Spent so far</dt><dd class="num">${money(p.mtd, 0)}</dd></div>
        <div><dt>Projected month end</dt><dd class="num">${money(p.projected, 0)}</dd></div>
        <div><dt>Budget</dt><dd class="num">${money(p.budget, 0)}</dd></div>
        <div><dt>Days of data</dt><dd class="num">${p.elapsed} of ${p.daysInMonth}</dd></div>
      </dl></div>`;
  }

  function targetsBlock(c) {
    const t = c.targets;
    if (!t) return '';
    const row = (label, target, actual, met, fmt) => {
      const known = actual != null;
      return `<li class="target"><span class="target-label">${label}</span>
        <span class="num">${fmt(target)} target</span>
        <span class="num">${known ? fmt(actual) : 'No data'} ${lbl().cur}</span>
        ${known ? `<span class="pill ${met ? 'pill-good' : 'pill-warn'}"><span class="dot" aria-hidden="true"></span>${met ? 'On target' : 'Off target'}</span>` : ''}</li>`;
    };
    return `<ul class="targets">${t.cpa ? row('Cost per conversion', t.cpa.target, t.cpa.actual, t.cpa.met, (v) => money(v)) : ''}${t.roas ? row('ROAS', t.roas.target, t.roas.actual, t.roas.met, (v) => roas(v)) : ''}</ul>`;
  }

  function budgetForm(c) {
    const b = c.client.budget || {};
    const ct = c.client.thresholds || {};
    const agencyT = Object.assign({}, E.THRESHOLDS, E.cleanThresholds(state.db.settings.thresholds));
    const num = (key, val) => esc(formValue('budget', key, val == null ? '' : String(val)));
    const pctVal = (v) => (v == null ? '' : String(Math.round(v * 1000) / 10));
    const labels = { cpaUpWarn: 'Cost per conversion rise: warning', cpaUpCrit: 'Cost per conversion rise: critical', roasDownWarn: 'ROAS drop: warning', roasDownCrit: 'ROAS drop: critical' };
    const customOpen = Object.keys(E.cleanThresholds(ct)).length > 0 || E.CLIENT_THRESHOLD_KEYS.some((k) => fieldError('budget', k));
    return `<form class="budget-form" data-form="budget" data-id="${esc(c.client.id)}" novalidate>
      <div class="form-grid">
        <div class="field"><label for="budget-monthly">Monthly budget</label>
          <div class="unit-input"><span class="unit unit-pre">S$</span><input class="input" id="budget-monthly" name="monthly" type="number" inputmode="decimal" min="1" step="any" value="${num('monthly', b.monthly)}"${errAttrs('budget', 'monthly')}></div>
          ${errText('budget', 'monthly')}</div>
        <div class="field"><label for="budget-cpa">Target cost per conversion</label>
          <div class="unit-input"><span class="unit unit-pre">S$</span><input class="input" id="budget-cpa" name="targetCpa" type="number" inputmode="decimal" min="0.01" step="any" value="${num('targetCpa', b.targetCpa)}"${errAttrs('budget', 'targetCpa')}></div>
          ${errText('budget', 'targetCpa')}</div>
        <div class="field"><label for="budget-roas">Target ROAS</label>
          <div class="unit-input"><input class="input" id="budget-roas" name="targetRoas" type="number" inputmode="decimal" min="0.01" step="any" value="${num('targetRoas', b.targetRoas)}"${errAttrs('budget', 'targetRoas')}><span class="unit">×</span></div>
          ${errText('budget', 'targetRoas')}</div>
      </div>
      <p class="hint">Leave a field empty to switch it off. Pacing uses the calendar month of this client’s latest data.</p>
      <details class="custom-rules"${customOpen ? ' open' : ''}><summary>Custom alert rules for this client</summary>
        <p class="hint">Leave empty to use the agency rules shown in grey.</p>
        <div class="form-grid">${E.CLIENT_THRESHOLD_KEYS.map((k) => `<div class="field"><label for="client-rule-${k}">${labels[k]}</label>
          <div class="unit-input"><input class="input" id="client-rule-${k}" name="${k}" type="number" inputmode="decimal" min="1" max="500" step="any" placeholder="${pctVal(agencyT[k])}" value="${num(k, pctVal(ct[k]))}"${errAttrs('budget', k)}><span class="unit">%</span></div>
          ${errText('budget', k)}</div>`).join('')}</div>
      </details>
      <div class="btn-row">
        <button type="submit" class="btn btn-primary">Save budget and targets</button>
        <button type="button" class="btn btn-secondary" data-action="cancel-budget">Cancel</button>
      </div>
    </form>`;
  }

  function budgetSection(c) {
    const editing = state.editBudget === c.client.id;
    const hasAny = c.pacing || c.targets;
    return `<section class="section" aria-labelledby="budget-title">
      <div class="section-head"><h2 id="budget-title">Budget and targets</h2>
        ${editing ? '' : `<button type="button" class="btn btn-secondary" id="edit-budget" data-action="edit-budget" data-id="${esc(c.client.id)}">${hasAny || c.customRules ? 'Edit' : 'Set budget and targets'}</button>`}</div>
      ${formMsg('budget')}
      ${editing ? budgetForm(c) : hasAny ? pacingBlock(c) + targetsBlock(c) : '<p class="muted">No monthly budget or targets set for this client yet.</p>'}
      ${!editing && c.customRules ? '<p class="subtle">This client uses custom alert rules.</p>' : ''}
    </section>`;
  }

  /* ---------- channels and change breakdown ---------- */

  function shareCell(v) {
    if (v == null) return '–';
    const w = Math.max(0, Math.min(100, v * 100));
    return `<span class="share"><span class="share-bar" aria-hidden="true"><span style="width:${w.toFixed(1)}%"></span></span><span class="num">${pctWhole(v)}</span></span>`;
  }

  function channelsTable(channels, agency, compact) {
    if (!channels.length) return '<p class="muted">No channel data yet.</p>';
    return `<div class="table-wrap" role="region" aria-label="Channels, scrolls sideways on small screens" tabindex="0"><table class="${compact ? 'table-mid channels-compact' : 'table-full'}">
      <thead><tr><th scope="col">Platform</th>${agency ? '<th scope="col" class="r">Clients</th>' : ''}<th scope="col" class="r">Spend</th><th scope="col">Share of spend</th>
        <th scope="col" class="r">Conv.</th><th scope="col" class="r">CPA</th><th scope="col" class="r">ROAS</th><th scope="col" class="r">Spend change</th></tr></thead>
      <tbody>${channels.map((ch) => `<tr><th scope="row">${esc(ch.label)}</th>${agency ? `<td class="r">${ch.clients}</td>` : ''}
        <td class="r">${money(ch.this.spend, 0)}</td><td>${shareCell(ch.shareOfSpend)}</td>
        <td class="r">${int(ch.this.conversions)}</td><td class="r">${money(ch.this.cpa)}</td><td class="r">${roas(ch.this.roas)}</td>
        <td class="r">${delta('spend', ch.delta.spend)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function driversSection(c) {
    const head = `<div class="section-head"><h2 id="drivers-title">What drove the change</h2>
      ${c.drivers ? `<div class="filters filters-inline" role="group" aria-label="Break down by">
        <button type="button" class="filter" id="driver-platform" data-action="driver-view" data-value="platform" aria-pressed="${state.driverView === 'platform'}">By platform</button>
        <button type="button" class="filter" id="driver-campaign" data-action="driver-view" data-value="campaign" aria-pressed="${state.driverView === 'campaign'}">By campaign</button></div>` : ''}</div>`;
    if (!c.drivers) return `<section class="section" aria-labelledby="drivers-title">${head}<p class="muted">This needs data covering ${esc(lbl().prev)}. Import more history or choose a shorter period.</p></section>`;
    const list = state.driverView === 'campaign' ? c.drivers.byCampaign : c.drivers.byPlatform;
    const t = c.kpis.this, l = c.kpis.last;
    const top = list.find((x) => x.cpaEffect != null && Math.abs(x.cpaEffect) >= 0.01);
    const summary = t.cpa != null && l.cpa != null && top
      ? `Without the change in <strong>${esc(top.label)}</strong>, cost per conversion would be <strong>${money(top.cpaWithout)}</strong> instead of ${money(t.cpa)}.`
      : 'Cost per conversion can’t be broken down because one of the periods has no conversions.';
    const effectCell = (v) => {
      if (v == null) return '–';
      const cls = Math.abs(v) < 0.01 ? 'flat' : v > 0 ? 'up-bad' : 'up-good';
      const sr = Math.abs(v) < 0.01 ? '' : v > 0 ? ' (raised CPA)' : ' (lowered CPA)';
      return `<span class="delta ${cls}">${signedMoney(v, 2)}<span class="visually-hidden">${sr}</span></span>`;
    };
    return `<section class="section" aria-labelledby="drivers-title">${head}
      <p class="drivers-summary">${summary}</p>
      <div class="table-wrap" role="region" aria-label="Change breakdown, scrolls sideways on small screens" tabindex="0"><table class="table-full">
        <thead><tr><th scope="col">${state.driverView === 'campaign' ? 'Campaign' : 'Platform'}</th><th scope="col" class="r">Spend change</th><th scope="col" class="r">Share of change</th>
          <th scope="col" class="r">Conv. change</th><th scope="col" class="r">CPA without this change</th><th scope="col" class="r">Effect on CPA</th></tr></thead>
        <tbody>${list.map((x) => `<tr>${state.driverView === 'campaign' ? nameCell(x.label, null, esc(E.PLATFORMS[x.platform] || x.platform)) : `<th scope="row">${esc(x.label)}</th>`}
          <td class="r">${signedMoney(x.dSpend, 0)}</td><td class="r">${pctWhole(x.shareOfSpendChange)}</td><td class="r">${signedInt(x.dConv)}</td>
          <td class="r">${money(x.cpaWithout)}</td><td class="r">${effectCell(x.cpaEffect)}</td></tr>`).join('')}</tbody></table></div>
      <p class="subtle" style="margin-top:8px">Each row asks: if only this ${state.driverView === 'campaign' ? 'campaign' : 'platform'} had repeated its numbers from ${esc(lbl().prev)}, what would the client’s CPA be? Spend and conversion changes add up to the client total.</p>
    </section>`;
  }

  /* ---------- notes and data health ---------- */

  function notesSection(c) {
    const notes = clientNotes(c.client.id).slice().reverse();
    const defDate = formValue('note', 'date', c.period ? c.period.lastDate : E.todayISO());
    return `<section class="section" aria-labelledby="notes-title">
      <div class="section-head"><h2 id="notes-title">Notes</h2><p>Context that shows on the charts and in reports</p></div>
      <form class="note-form" data-form="note" data-id="${esc(c.client.id)}" novalidate>
        <div class="field note-date"><label for="note-date">Date</label>
          <input class="input" id="note-date" name="date" type="date" value="${esc(defDate)}"${errAttrs('note', 'date')}>${errText('note', 'date')}</div>
        <div class="field note-text"><label for="note-text">Note</label>
          <input class="input" id="note-text" name="text" maxlength="280" autocomplete="off" placeholder="For example: new creative launched" value="${esc(formValue('note', 'text', ''))}"${errAttrs('note', 'text')}>${errText('note', 'text')}</div>
        <button type="submit" class="btn btn-primary">Add note</button>
      </form>
      ${formMsg('note')}
      ${notes.length ? `<ul class="notes-list">${notes.map((n) => {
        const key = 'note:' + n.id;
        return `<li><span class="note-when num">${dlong(n.date)}</span><span class="note-body">${esc(n.text)}</span>
          ${confirmOr(key, `<button type="button" class="btn btn-danger-quiet" id="trigger-${esc(key)}" data-action="confirm-ask" data-key="${esc(key)}">Delete<span class="visually-hidden"> note from ${dlong(n.date)}</span></button>`, 'Delete this note? This can’t be undone.', 'Delete note')}</li>`;
      }).join('')}</ul>` : '<p class="muted">No notes yet. Add one when something changes, like a new offer, a price change or a paused campaign.</p>'}
    </section>`;
  }

  function healthList(issues, showClient) {
    return `<ul class="health-list">${issues.map((x) => `<li>
      <div class="alert-top">${pill(SEV, x.severity)}${showClient ? `<a class="alert-client clamp" href="#/client/${encodeURIComponent(x.clientId)}" title="${esc(x.clientName)}">${esc(x.clientName)}</a>` : ''}</div>
      <p class="health-title">${esc(x.title)}</p><p class="action-why">${esc(x.detail)}</p><p class="action-do"><strong>Fix:</strong> ${esc(x.fix)}</p></li>`).join('')}</ul>`;
  }

  /* ---------- client health table ---------- */

  function sortedClients(list) {
    const { key, dir } = state.sort;
    const val = (c) => {
      const k = c.kpis;
      switch (key) {
        case 'name': return c.client.name.toLowerCase();
        case 'status': return STATUS_ORDER[c.status];
        case 'spend': return k ? k.this.spend : null;
        case 'dspend': return k ? k.delta.spend : null;
        case 'cpa': return k ? k.this.cpa : null;
        case 'dcpa': return k ? k.delta.cpa : null;
        case 'roas': return k ? k.this.roas : null;
        case 'pace': return c.pacing ? c.pacing.pace : null;
        default: return null;
      }
    };
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return a.client.name.localeCompare(b.client.name);
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return r * dir || a.client.name.localeCompare(b.client.name);
    });
  }

  function sortTh(key, label, right) {
    const active = state.sort.key === key;
    const aria = active ? ` aria-sort="${state.sort.dir > 0 ? 'ascending' : 'descending'}"` : '';
    const arrow = active ? (state.sort.dir > 0 ? ICON.up : ICON.down) : ICON.upDown;
    return `<th scope="col"${aria}${right ? ' class="r"' : ''}><button type="button" class="sort-btn" id="sort-${key}" data-action="sort" data-key="${key}">${label}${arrow}</button></th>`;
  }

  function nameCell(name, href, sub) {
    const inner = href ? `<a href="${href}">${esc(name)}</a>` : `<span>${esc(name)}</span>`;
    return `<td class="name-cell"><div class="clamp" title="${esc(name)}">${inner}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</td>`;
  }

  function healthTable(clients, opts) {
    opts = opts || {};
    if (opts.compact) {
      return `<div class="table-wrap" role="region" aria-label="Client health (sample)" tabindex="0"><table>
        <thead><tr><th scope="col">Client</th><th scope="col">Status</th><th scope="col" class="r">Spend, 7 days</th><th scope="col" class="r">CPA change</th></tr></thead>
        <tbody>${clients.map((c) => `<tr>${nameCell(c.client.name, null, esc(platformNames(c.platforms)))}<td>${pill(STATUS, c.status)}</td>
          <td class="r">${money(c.kpis.this.spend, 0)}</td><td class="r">${delta('cpa', c.kpis.delta.cpa)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    const rows = sortedClients(clients).map((c) => {
      const k = c.kpis;
      return `<tr class="linkable">${nameCell(c.client.name, '#/client/' + encodeURIComponent(c.client.id), esc(platformNames(c.platforms)))}
        <td>${pill(STATUS, c.status)}</td>
        <td class="r">${k ? money(k.this.spend, 0) : '–'}</td>
        <td class="r">${k ? delta('spend', k.delta.spend) : ''}</td>
        <td class="r">${k ? money(k.this.cpa) : '–'}</td>
        <td class="r">${k ? delta('cpa', k.delta.cpa) : ''}</td>
        <td class="r">${k ? roas(k.this.roas) : '–'}</td>
        <td>${paceCell(c)}</td>
        <td class="issue-cell"><div class="clamp" title="${esc(topIssue(c))}">${esc(topIssue(c))}</div></td></tr>`;
    }).join('');
    return `<div class="table-wrap" role="region" aria-label="Client health, scrolls sideways on small screens" tabindex="0"><table class="table-full table-wide">
      <caption class="visually-hidden">Client health for the ${esc(lbl().short)}. Use the column buttons to sort.</caption>
      <thead><tr>${sortTh('name', 'Client')}${sortTh('status', 'Status')}${sortTh('spend', 'Spend', true)}${sortTh('dspend', 'Change', true)}
        ${sortTh('cpa', 'CPA', true)}${sortTh('dcpa', 'Change', true)}${sortTh('roas', 'ROAS', true)}${sortTh('pace', 'Budget pace')}<th scope="col">Top issue</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  /* ---------- weekly brief ---------- */

  function dirWord(p) {
    if (p == null) return 'with no earlier period to compare';
    if (Math.abs(p) < 0.02) return 'roughly flat';
    return (p > 0 ? 'up ' : 'down ') + (Math.abs(p) * 100).toFixed(1) + '%';
  }

  function changeLines(c, labels) {
    const P = labels || lbl();
    const t = c.kpis.this, l = c.kpis.last, d = c.kpis.delta;
    if (!c.hasPrev) return [`Spend was <strong>${money(t.spend)}</strong> with <strong>${int(t.conversions)}</strong> conversions ${esc(P.cur)}.`];
    const out = [
      `Spend was <strong>${money(t.spend)}</strong>, ${dirWord(d.spend)} on ${esc(P.prev)}.`,
      `Conversions were <strong>${int(t.conversions)}</strong>, ${dirWord(d.conversions)}.`,
    ];
    if (t.cpa != null && l.cpa != null) {
      out.push(Math.abs(d.cpa) < 0.02 ? `Cost per conversion held at about <strong>${money(t.cpa)}</strong>.`
        : `Cost per conversion ${d.cpa > 0 ? 'rose' : 'fell'} from ${money(l.cpa)} to <strong>${money(t.cpa)}</strong>.`);
    } else if (t.conversions === 0 && t.spend > 0) {
      out.push(`No conversions were recorded ${esc(P.cur)}, so cost per conversion can’t be calculated.`);
    }
    if (t.roas != null && l.roas != null) {
      out.push(Math.abs(d.roas) < 0.02 ? `ROAS held at about <strong>${roas(t.roas)}</strong>.`
        : `ROAS ${d.roas > 0 ? 'rose' : 'fell'} from ${roas(l.roas)} to <strong>${roas(t.roas)}</strong>.`);
    }
    return out;
  }

  function actionItem(f, compact) {
    const ev = compact ? f.evidence.slice(0, 2) : f.evidence;
    return `<li class="action"><div class="action-body">
      <p class="action-title">${pill(SEV, f.severity)} <span>${esc(f.title)}</span></p>
      <p class="action-why">${esc(f.why)}</p>
      <p class="action-do"><strong>Do this:</strong> ${esc(f.action)}</p>
      <dl class="evidence">${ev.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}${!compact && f.impact ? `<dt>${esc(f.impactLabel)}</dt><dd>${money(f.impact)}</dd>` : ''}</dl>
    </div></li>`;
  }

  function briefTitle(labels) {
    return labels.days === 7 ? 'Weekly brief' : `Brief, ${labels.short}`;
  }

  function periodNotes(c) {
    if (!c.period) return [];
    return clientNotes(c.client.id).filter((n) => n.date >= c.period.thisStart && n.date <= c.period.thisEnd);
  }

  function briefCard(c, opts) {
    opts = opts || {};
    const P = opts.labels || lbl();
    const H = opts.heading || 'h2';
    const id = 'brief-' + c.client.id + (opts.idSuffix || '');
    const acts = c.findings.filter((f) => f.severity !== 'info');
    const info = c.findings.filter((f) => f.severity === 'info');
    const shown = opts.compact ? acts.slice(0, 1) : acts;
    const context = opts.compact ? [] : periodNotes(c);
    return `<article class="brief" aria-labelledby="${id}">
      <header class="brief-head"><${H} id="${id}"${opts.showClient ? ' class="clamp"' : ''}>${briefTitle(P)}${opts.showClient ? ': ' + esc(c.client.name) : ''}</${H}>
        <span class="subtle">${range(c.period.thisStart, c.period.thisEnd)}</span></header>
      <div class="brief-body">
        <section><p class="brief-label">What changed</p><ul class="changes">${changeLines(c, P).slice(0, opts.compact ? 3 : 9).map((l) => `<li><span>${l}</span></li>`).join('')}</ul></section>
        ${context.length ? `<section><p class="brief-label">Context from your notes</p><ul class="changes">${context.map((n) => `<li><span><strong>${dshort(n.date)}:</strong> ${esc(n.text)}</span></li>`).join('')}</ul></section>` : ''}
        <section><p class="brief-label">${acts.length > 1 ? 'What to do, most urgent first' : 'What to do'}</p>
          ${shown.length ? `<ol class="actions">${shown.map((f) => actionItem(f, opts.compact)).join('')}</ol>`
            : `<p class="muted">Nothing crossed a rule threshold ${esc(P.cur)}. No action needed.</p>`}
          ${opts.compact && acts.length > shown.length ? `<p class="brief-note">${acts.length - shown.length} more ${plural(acts.length - shown.length, 'action')} in the full brief.</p>` : ''}
        </section>
        ${info.map((n) => `<p class="brief-note">${esc(n.title)}. ${esc(n.why)} ${esc(n.action)}</p>`).join('')}
      </div></article>`;
  }

  function briefText(c) {
    const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const P = lbl();
    const lines = [`${briefTitle(P)}: ${c.client.name}`, range(c.period.thisStart, c.period.thisEnd), '', 'What changed'];
    changeLines(c, P).forEach((l) => lines.push('- ' + strip(l)));
    const context = periodNotes(c);
    if (context.length) {
      lines.push('', 'Context');
      context.forEach((n) => lines.push(`- ${dshort(n.date)}: ${n.text}`));
    }
    if (c.pacing) {
      const p = c.pacing;
      lines.push('', 'Budget', `- ${money(p.mtd, 0)} of ${money(p.budget, 0)} spent in ${p.month}, projected ${money(p.projected, 0)} (${PACE_TEXT[p.status]}).`);
    }
    lines.push('', 'What to do');
    const acts = c.findings.filter((f) => f.severity !== 'info');
    if (!acts.length) lines.push(`Nothing crossed a rule threshold ${P.cur}. No action needed.`);
    acts.forEach((f, i) => {
      lines.push(`${i + 1}. [${SEV[f.severity][0]}] ${f.title}`, `   Why: ${f.why}`, `   Do this: ${f.action}`);
      f.evidence.forEach(([k, v]) => lines.push(`   ${k}: ${v}`));
    });
    lines.push('', 'Prepared with Sightline from imported ad platform exports. Rule-based insights.');
    return lines.join('\n');
  }

  /* ---------- chart (inline SVG, no library) ---------- */

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  const axisMoney = (v) => (v >= 1000 ? 'S$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : 'S$' + Math.round(v));

  // opts: { bandStart: 'YYYY-MM-DD', bandLabel, notes: [{ n, date, text }] }
  function lineChart(series, key, label, note, opts) {
    opts = opts || {};
    const W = 600, H = 200, L = 52, R = 10, T = 22, B = 28;
    const n = series.length;
    const vals = series.map((s) => s[key]).filter((v) => v != null);
    if (!vals.length) return `<figure class="chart"><figcaption>${label}</figcaption><p class="muted">No data to chart yet.</p></figure>`;
    const max = niceMax(Math.max(...vals));
    const x = (i) => L + (n > 1 ? i / (n - 1) : 0.5) * (W - L - R);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    let d = '', pen = false, gaps = 0;
    series.forEach((s, i) => {
      const v = s[key];
      if (v == null) { pen = false; gaps++; return; }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1);
      pen = true;
    });
    const step = n > 1 ? (W - L - R) / (n - 1) : 0;
    let bandIdx = opts.bandStart ? series.findIndex((s) => s.date >= opts.bandStart) : Math.max(0, n - 7);
    if (bandIdx < 0) bandIdx = n - 1;
    const bandX = Math.max(L, x(bandIdx) - step / 2);
    const grid = [0, max / 2, max].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${axisMoney(v)}</text>`).join('');
    const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)
      .map((i) => `<text class="axis-label" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${dshort(series[i].date)}</text>`).join('');
    const marks = (opts.notes || []).map((nt) => {
      const i = series.findIndex((s) => s.date === nt.date);
      if (i < 0) return '';
      const cx = x(i).toFixed(1);
      return `<line class="note-line" x1="${cx}" x2="${cx}" y1="${T}" y2="${H - B}"/><circle class="note-dot" cx="${cx}" cy="${T - 9}" r="8"/><text class="note-num" x="${cx}" y="${T - 5.5}" text-anchor="middle">${nt.n}</text>`;
    }).join('');
    const hi = Math.max(...vals);
    const bandLabel = opts.bandLabel || 'This week';
    const aria = `${label}, daily over ${n} days from ${dlong(series[0].date)} to ${dlong(series[n - 1].date)}. Highest ${money(hi)}. The shaded area is the current period (${bandLabel.toLowerCase()}).` +
      (gaps ? ` ${gaps} ${plural(gaps, 'day')} with no conversions leave gaps in the line.` : '') +
      ((opts.notes || []).length ? ` Numbered markers show notes: ${opts.notes.map((nt) => `${nt.n}, ${dshort(nt.date)}, ${nt.text}`).join('; ')}.` : '');
    return `<figure class="chart"><figcaption><span>${label}</span><span class="subtle">${note}</span></figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">
        <rect class="band" x="${bandX.toFixed(1)}" y="${T}" width="${(W - R - bandX).toFixed(1)}" height="${H - T - B}" rx="4"/>
        <text class="band-label" x="${(W - R - 6).toFixed(1)}" y="${H - B - 8}" text-anchor="end">${esc(bandLabel)}</text>
        ${grid}${xl}<path class="line" d="${d}"/>${marks}
      </svg>${gaps && key === 'cpa' ? `<p class="subtle">Gaps are days with spend but no conversions.</p>` : ''}</figure>`;
  }

  function chartNotes(c) {
    if (!c.series.length) return [];
    const first = c.series[0].date, last = c.series[c.series.length - 1].date;
    return clientNotes(c.client.id).filter((n) => n.date >= first && n.date <= last).map((n, i) => ({ n: i + 1, date: n.date, text: n.text }));
  }

  function chartKey(notes) {
    return notes.length ? `<ol class="chart-notes">${notes.map((nt) => `<li><span class="note-badge num" aria-hidden="true">${nt.n}</span><span><strong>${dshort(nt.date)}:</strong> ${esc(nt.text)}</span></li>`).join('')}</ol>` : '';
  }

  function bandLabel() { return periodKey() === 'w7' ? 'This week' : lbl().title; }

  /* ---------- views ---------- */

  function previewResult() {
    if (!state.preview) {
      const today = E.todayISO();
      state.preview = E.analyze(E.buildDemo(E.isoFromDay(E.dayNum(today) - 1)), { today });
    }
    return state.preview;
  }

  function vWelcome() {
    const r = previewResult();
    const rows = [...r.clients].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]).slice(0, 4);
    const featured = r.clients.find((c) => c.status === 'risk') || r.clients[0];
    const sources = ['Meta Ads', 'Google Ads', 'TikTok Ads', 'Shopee Ads', 'Lazada Ads', 'LinkedIn Ads'];
    return {
      title: 'Weekly client briefs from your ad exports',
      html: `<section class="welcome" aria-labelledby="welcome-title">
        <div class="welcome-grid">
          <div class="welcome-copy">
            <p class="eyebrow">For performance teams at independent agencies</p>
            <h1 id="welcome-title">Your clients' ad data, turned into <span class="hl">Monday-morning answers</span></h1>
            <p class="lede">Sightline reads the CSV exports you already pull from your ad platforms, then shows which clients need attention, what changed and what to do first.</p>
            <div class="btn-row">
              <button type="button" class="btn btn-primary btn-lg" data-action="demo">Try it with demo data</button>
              <a class="btn btn-secondary btn-lg" href="#/data" data-action="go-import">Import CSV files</a>
            </div>
            <p class="fine">Rule-based insights: every recommendation shows the numbers and the threshold behind it. Files are read in your browser and never uploaded.</p>
          </div>
          <div class="stage">
            <ul class="chips" aria-label="Supported sources">
              ${sources.map((s) => `<li><span class="chip">${s}</span></li>`).join('')}<li><span class="chip chip-csv">Any CSV</span></li>
            </ul>
            <div class="preview" role="group" aria-label="Preview of Sightline using sample data">
              <div class="preview-bar"><span class="title">Agency overview</span><span class="sample-tag">Sample data</span></div>
              <div class="preview-body">
                ${healthTable(rows, { compact: true })}
                ${briefCard(featured, { compact: true, heading: 'h2', showClient: true, idSuffix: '-preview', labels: E.PERIODS.w7 })}
              </div>
            </div>
          </div>
        </div>
        <section aria-labelledby="how-title">
          <ol class="steps">
            <li><h2 id="how-title" class="visually-hidden">How it works</h2><h3>Export CSV</h3><p>Download a daily campaign report from each ad platform, the same export you already use for reporting.</p></li>
            <li><h3>Import</h3><p>Drop the files in. Sightline recognises the platform and matches the columns, and you can correct any match.</p></li>
            <li><h3>Get your brief</h3><p>See client health, budget pacing, what changed and ranked actions, each with the numbers behind it.</p></li>
          </ol>
        </section>
      </section>`,
    };
  }

  function vOverview() {
    if (!state.db.clients.length) return vWelcome();
    const r = state.result;
    const P = lbl();
    const n = state.db.clients.length;
    const { risk, watch, good, nodata } = r.counts;
    const need = risk + watch;
    const headline = need === 0 ? `All ${n} ${plural(n, 'client')} ${n === 1 ? 'is' : 'are'} on track ${P.headline}`
      : `${need} of ${n} ${plural(n, 'client')} ${need === 1 ? 'needs' : 'need'} attention ${P.headline}`;
    const plats = new Set(state.db.rows.map((x) => x.platform));
    const top = r.actions.filter((f) => f.severity !== 'info').slice(0, 3);
    const seg = (cls, v) => (v ? `<span class="${cls}" style="flex:${v}"></span>` : '');
    const issues = r.dataIssues.filter((x) => x.severity === 'warn');
    return {
      title: 'Overview',
      html: `<header class="page-head">
          <div class="page-head-text">
            <p class="eyebrow">${esc(state.db.agency.name)}</p>
            <h1>${headline}</h1>
            <p class="lede">${r.period ? `${cap(P.short)} (${range(r.period.thisStart, r.period.thisEnd)}) compared with ${esc(P.prev)}, ` : ''}from ${int(state.db.rows.length)} imported rows across ${plats.size} ${plural(plats.size, 'platform')}.</p>
          </div>
          <div class="head-actions">${periodSelect('period-overview')}<a class="btn btn-secondary" href="#/data" data-action="go-import">${ICON.data}Import CSV files</a></div>
        </header>

        <div class="health" role="list" aria-label="Client health counts">
          <a class="health-item risk${risk ? '' : ' zero'}" role="listitem" href="#/alerts"><span class="n">${risk}</span><span class="label">at risk</span></a>
          <div class="health-item watch${watch ? '' : ' zero'}" role="listitem"><span class="n">${watch}</span><span class="label">to watch</span></div>
          <div class="health-item good${good ? '' : ' zero'}" role="listitem"><span class="n">${good}</span><span class="label">healthy</span></div>
          ${nodata ? `<div class="health-item" role="listitem"><span class="n">${nodata}</span><span class="label">no data</span></div>` : ''}
        </div>
        <div class="health-bar" aria-hidden="true">${seg('risk', risk)}${seg('watch', watch)}${seg('good', good)}</div>
        ${issues.length ? `<p class="data-note">${ICON.alerts}<span>${issues.length} data ${plural(issues.length, 'issue')} may affect these numbers. <a href="#/data" data-action="go-health">Review data health</a></span></p>` : ''}

        ${kpiRow(r.totals, ['spend', 'conversions', 'cpa', 'roas'])}
        <p class="subtle" style="margin-top:8px">Totals across all clients. ROAS only counts clients whose exports include revenue.</p>

        <section class="section" aria-labelledby="start-title">
          <div class="section-head"><h2 id="start-title">Start here</h2><p>The most urgent actions across all clients</p></div>
          ${top.length ? `<ol class="top-actions">${top.map((f) => `<li>${pill(SEV, f.severity)}
              <div class="ta-main"><a class="ta-client clamp" href="#/client/${encodeURIComponent(f.clientId)}" title="${esc(f.clientName)}">${esc(f.clientName)}</a>
                <span class="ta-title">${esc(f.title)}</span><span class="ta-do">${esc(f.action)}</span></div>
              <div class="ta-impact">${f.impact ? `<span class="num">${money(f.impact, 0)}</span>${esc(lowerFirst(f.impactLabel))}` : ''}</div></li>`).join('')}</ol>`
            : `<p class="muted">Nothing crossed a rule threshold ${esc(P.cur)}.</p>`}
        </section>

        <section class="section" aria-labelledby="clients-title">
          <div class="section-head"><h2 id="clients-title">All clients</h2><p>Select a client for the full brief</p></div>
          ${healthTable(r.clients)}
        </section>

        <section class="section" aria-labelledby="channels-title">
          <div class="section-head"><h2 id="channels-title">Channels</h2><p>Where the agency’s spend went, ${esc(P.short)}</p></div>
          ${channelsTable(r.channels, true)}
        </section>`,
    };
  }

  function findClient(id) { return state.result.clients.find((c) => c.client.id === id); }

  function vNotFound(what) {
    return { title: 'Not found', html: `<header class="page-head"><div class="page-head-text"><h1>${what || 'Page'} not found</h1></div></header>
      ${emptyState('We couldn’t find that', 'It may have been deleted, or the link is out of date.', '<a class="btn btn-primary" href="#/">Go to the overview</a>')}` };
  }

  function vClient(id) {
    const c = findClient(id);
    if (!c) return vNotFound('Client');
    const head = `<p class="crumb"><a href="#/">Overview</a> <span aria-hidden="true">/</span></p><h1 class="client-title">${esc(c.client.name)}</h1>`;
    if (c.status === 'nodata') {
      return { title: c.client.name, html: `<header class="page-head"><div class="page-head-text">${head}</div></header>
        ${emptyState('No data for this client yet', 'Import a CSV export and assign it to this client to see their brief.', '<a class="btn btn-primary" href="#/data" data-action="go-import">Import CSV files</a>')}` };
    }
    const P = lbl();
    const cf = state.copyFallback && state.copyFallback.id === id ? state.copyFallback : null;
    const issues = c.dataIssues.filter((x) => x.severity === 'warn');
    const notes = chartNotes(c);
    const campRows = c.campaigns.map((k) => `<tr>${nameCell(k.campaign, null, esc(E.PLATFORMS[k.platform] || k.platform))}
      <td class="r">${money(k.this.spend, 0)}</td><td class="r">${delta('spend', k.delta.spend)}</td>
      <td class="r">${int(k.this.conversions)}</td><td class="r">${money(k.this.cpa)}</td><td class="r">${delta('cpa', k.delta.cpa)}</td>
      <td class="r">${roas(k.this.roas)}</td></tr>`).join('');
    return {
      title: c.client.name,
      html: `<header class="page-head">
          <div class="page-head-text">${head}
            <div class="client-meta">${pill(STATUS, c.status)}${platformPills(c.platforms)}</div>
            <p class="subtle">Data from ${range(c.period.firstDate, c.period.lastDate)}</p>
          </div>
          <div class="head-actions">
            ${periodSelect('period-client')}
            <button type="button" class="btn btn-secondary" id="copy-brief" data-action="copy-brief" data-id="${esc(id)}">${ICON.copy}Copy brief</button>
            <a class="btn btn-secondary" href="#/report/${encodeURIComponent(id)}">${ICON.doc}Client report</a>
          </div>
        </header>
        ${cf ? `<div class="copy-fallback"><label for="copy-text">Your browser blocked automatic copying. The brief is selected below: press Ctrl+C (or Cmd+C on a Mac) to copy it.</label>
          <textarea id="copy-text" readonly>${esc(cf.text)}</textarea></div>` : ''}
        ${issues.length ? `<div class="banner banner-warn"><span class="banner-text"><strong>Data health:</strong> ${issues.map((x) => esc(x.title)).join('. ')}. <a href="#/data" data-action="go-health">How to fix</a></span></div>` : ''}
        ${kpiRow(c.kpis, ['spend', 'conversions', 'cpa', 'roas', 'ctr'])}
        <section class="section">${briefCard(c)}</section>
        ${budgetSection(c)}
        ${driversSection(c)}
        <section class="section" aria-labelledby="client-channels-title">
          <div class="section-head"><h2 id="client-channels-title">Channels</h2><p>${esc(cap(P.short))}, compared with ${esc(P.prev)}</p></div>
          ${channelsTable(c.channels, false)}
        </section>
        <section class="section" aria-labelledby="trend-title">
          <div class="section-head"><h2 id="trend-title">Trend</h2><p>Up to 10 weeks of daily data</p></div>
          <div class="charts">${lineChart(c.series, 'spend', 'Spend', 'Daily', { bandStart: c.period.thisStart, bandLabel: bandLabel(), notes })}${lineChart(c.series, 'cpa', 'Cost per conversion', 'Daily', { bandStart: c.period.thisStart, bandLabel: bandLabel(), notes })}</div>
          ${chartKey(notes)}
        </section>
        <section class="section" aria-labelledby="camp-title">
          <div class="section-head"><h2 id="camp-title">Campaigns</h2><p>${esc(cap(P.short))}, highest spend first</p></div>
          <div class="table-wrap" role="region" aria-label="Campaigns, scrolls sideways on small screens" tabindex="0"><table class="table-full">
            <thead><tr><th scope="col">Campaign</th><th scope="col" class="r">Spend</th><th scope="col" class="r">Change</th><th scope="col" class="r">Conv.</th>
              <th scope="col" class="r">CPA</th><th scope="col" class="r">Change</th><th scope="col" class="r">ROAS</th></tr></thead>
            <tbody>${campRows}</tbody></table></div>
        </section>
        ${notesSection(c)}`,
    };
  }

  function vAlerts() {
    const head = (lede) => `<header class="page-head"><div class="page-head-text"><h1>Alerts</h1><p class="lede">${lede}</p></div>${state.db.clients.length ? `<div class="head-actions">${periodSelect('period-alerts')}</div>` : ''}</header>`;
    if (!state.db.clients.length) {
      return { title: 'Alerts', html: head('Alerts appear when a client crosses one of the rule thresholds.') + emptyState('No data yet', 'Load the demo or import your CSV exports to see alerts.', NO_DATA_ACTIONS) };
    }
    const P = lbl();
    const all = state.result.alerts;
    const crit = all.filter((a) => a.severity === 'crit').length;
    const warn = all.length - crit;
    const f = state.alertFilter;
    const list = f === 'all' ? all : all.filter((a) => a.severity === f);
    const btn = (v, label, count) => `<button type="button" class="filter" id="filter-${v}" data-action="alert-filter" data-value="${v}" aria-pressed="${f === v}">${label}<span class="num">${count}</span></button>`;
    const emptyMsg = all.length === 0
      ? emptyState(`No alerts ${esc(P.headline)}`, 'Every client is inside the rule thresholds.', '<a class="btn btn-secondary" href="#/">Back to the overview</a>')
      : emptyState(`No ${f === 'crit' ? 'critical alerts' : 'warnings'} right now`, 'Try another filter.', '');
    return {
      title: 'Alerts',
      html: head(`${all.length} open ${plural(all.length, 'alert')} for the ${esc(P.short)}, most urgent first.`) +
        `<div class="filters" role="group" aria-label="Filter alerts">${btn('all', 'All', all.length)}${btn('crit', 'Critical', crit)}${btn('warn', 'Warning', warn)}</div>
        ${list.length ? `<ul class="alert-list">${list.map((a) => `<li class="alert ${a.severity}">
            <div class="alert-top">${pill(SEV, a.severity)}<a class="alert-client clamp" href="#/client/${encodeURIComponent(a.clientId)}" title="${esc(a.clientName)}">${esc(a.clientName)}</a>
              ${a.impact ? `<span class="subtle">${money(a.impact, 0)} ${esc(lowerFirst(a.impactLabel))}</span>` : ''}</div>
            <h2>${esc(a.title)}</h2>
            <p class="action-why">${esc(a.why)}</p>
            <p class="action-do"><strong>Do this:</strong> ${esc(a.action)}</p>
            <dl class="evidence">${a.evidence.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
          </li>`).join('')}</ul>` : emptyMsg}`,
    };
  }

  function vReports() {
    const head = `<header class="page-head"><div class="page-head-text"><h1>Client reports</h1>
      <p class="lede">A one-page report per client with your agency branding, ready to print or save as PDF from your browser.</p></div>
      ${state.db.clients.length ? `<div class="head-actions">${periodSelect('period-reports')}</div>` : ''}</header>`;
    if (!state.db.clients.length) return { title: 'Reports', html: head + emptyState('No clients yet', 'Reports are built from imported data.', NO_DATA_ACTIONS) };
    const list = sortedByName(state.result.clients);
    return {
      title: 'Reports',
      html: head + `<ul class="report-list">${list.map((c) => `<li>
          <div class="rl-name"><strong>${esc(c.client.name)}</strong><span class="subtle">${c.period ? cap(lbl().short) + ': ' + range(c.period.thisStart, c.period.thisEnd) : 'No data yet'}</span></div>
          ${pill(STATUS, c.status)}
          ${c.status === 'nodata' ? '' : `<a class="btn btn-secondary" href="#/report/${encodeURIComponent(c.client.id)}">Open report<span class="visually-hidden"> for ${esc(c.client.name)}</span></a>`}
        </li>`).join('')}</ul>
        ${state.db.settings.logo ? '' : '<p class="subtle" style="margin-top:16px">Add your logo and brand colour in <a href="#/settings">Settings</a> to brand these reports.</p>'}`,
    };
  }

  function sortedByName(list) { return [...list].sort((a, b) => a.client.name.localeCompare(b.client.name)); }

  const LOGO_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;

  function vReport(id) {
    const c = findClient(id);
    if (!c || c.status === 'nodata') return vNotFound('Report');
    const P = lbl();
    const weekly = periodKey() === 'w7';
    const t = c.kpis.this, l = c.kpis.last, d = c.kpis.delta;
    const row = (label, a, b, m) => `<tr><th scope="row">${label}</th><td class="r">${a}</td><td class="r">${b}</td><td class="r">${delta(m, d[m])}</td></tr>`;
    const acts = c.findings.filter((f) => f.severity !== 'info');
    const lastImport = state.db.imports.filter((i) => i.clientId === id)[0];
    const s = state.db.settings;
    const logo = s.logo && LOGO_RE.test(s.logo) ? s.logo : null;
    const brand = s.brandColor && COLOR_RE.test(s.brandColor) ? s.brandColor : null;
    const notes = chartNotes(c);
    const pNotes = periodNotes(c);
    return {
      title: 'Report: ' + c.client.name,
      html: `<div class="report-toolbar">
          <a class="btn btn-ghost" href="#/reports">${ICON.back}All reports</a>
          <div class="head-actions">${periodSelect('period-report')}<button type="button" class="btn btn-primary" data-action="print">${ICON.print}Print or save as PDF</button></div>
        </div>
        <article class="report" aria-labelledby="report-title"${brand ? ` style="--brand:${brand}"` : ''}>
          <header class="report-head">
            <div class="report-brand">${logo ? `<img class="report-logo" src="${esc(logo)}" alt="${esc(state.db.agency.name)} logo">` : ''}<strong>${esc(state.db.agency.name)}</strong><span>${weekly ? 'Weekly performance report' : 'Performance report, ' + esc(P.short)}</span></div>
            <h1 id="report-title">${esc(c.client.name)}</h1>
            <p class="muted">${range(c.period.thisStart, c.period.thisEnd)}, compared with ${range(c.period.lastStart, c.period.lastEnd)}</p>
          </header>
          <h2>Summary</h2>
          <div class="table-wrap"><table class="kpi-table table-mid">
            <thead><tr><th scope="col">Metric</th><th scope="col" class="r">${weekly ? 'Last week' : 'Previous period'}</th><th scope="col" class="r">${weekly ? 'This week' : 'Current period'}</th><th scope="col" class="r">Change</th></tr></thead>
            <tbody>
              ${row('Spend', money(l.spend), money(t.spend), 'spend')}
              ${row('Conversions', int(l.conversions), int(t.conversions), 'conversions')}
              ${row('Cost per conversion', money(l.cpa), money(t.cpa), 'cpa')}
              ${row('ROAS', roas(l.roas), roas(t.roas), 'roas')}
              ${row('Click-through rate', ctr(l.ctr), ctr(t.ctr), 'ctr')}
            </tbody></table></div>
          <h2>What changed</h2>
          <ul class="changes">${changeLines(c).map((x) => `<li><span>${x}</span></li>`).join('')}</ul>
          ${pNotes.length ? `<h2>Context</h2><ul class="changes">${pNotes.map((n) => `<li><span><strong>${dshort(n.date)}:</strong> ${esc(n.text)}</span></li>`).join('')}</ul>` : ''}
          ${c.pacing || c.targets ? `<h2>Budget and targets</h2>${pacingBlock(c)}${targetsBlock(c)}` : ''}
          <h2>Channels</h2>
          ${channelsTable(c.channels, false, true)}
          <h2>Daily spend</h2>
          ${lineChart(c.series, 'spend', 'Spend', 'Daily, shaded area is the current period', { bandStart: c.period.thisStart, bandLabel: bandLabel(), notes })}
          ${chartKey(notes)}
          <h2>Recommended actions</h2>
          ${acts.length ? `<ol class="actions">${acts.map((f) => actionItem(f)).join('')}</ol>` : `<p class="muted">Nothing crossed a rule threshold ${esc(P.cur)}. No action needed.</p>`}
          <footer class="report-foot">
            <p>Prepared by ${esc(state.db.agency.name)} with Sightline${lastImport ? `, from ad platform exports last imported on ${dlong(lastImport.at.slice(0, 10))}` : ''}.</p>
            <p>Insights are rule-based: each recommendation lists the numbers and the threshold that triggered it. Amounts in SGD.</p>
            ${state.db.isDemo ? '<p><strong>Sample data. This client and agency are fictional.</strong></p>' : ''}
          </footer>
        </article>`,
    };
  }

  /* ---------- data / import ---------- */

  function defaultClientChoice() {
    const real = state.db.clients;
    return real.length ? '' : 'new';
  }

  function fatal(p, title, fix) { return Object.assign(p, { fatal: { title, fix } }); }

  async function readFile(file) {
    const p = { id: uid(), fileName: file.name, clientChoice: defaultClientChoice(), newName: '', nameError: null, clientError: null };
    const ext = (file.name.includes('.') ? file.name.split('.').pop() : '').toLowerCase();
    if (['xlsx', 'xls', 'numbers', 'ods'].includes(ext)) {
      return fatal(p, 'This is a spreadsheet file, not a CSV.', 'Open it and use Save As or Export, and choose CSV. Or export the report from the ad platform as CSV.');
    }
    if (ext !== 'csv' && file.type !== 'text/csv') {
      return fatal(p, `“${file.name}” isn’t a CSV file.`, 'Sightline reads .csv exports. In your ad platform, choose Export or Download, pick CSV, then import that file.');
    }
    if (file.size === 0) return fatal(p, 'This file is empty.', 'Export the report again from your ad platform and make sure the date range contains at least one day of activity.');
    if (file.size > MAX_FILE_BYTES) return fatal(p, 'This file is larger than 25 MB.', 'Export a shorter date range, for example the last 90 days, and import that instead.');
    if (!window.Papa) return fatal(p, 'The CSV reader didn’t load.', 'Sightline loads its CSV reader from the internet. Check your connection, reload the page and try again.');
    let text;
    try { text = await file.text(); } catch (e) {
      return fatal(p, 'We couldn’t read this file.', 'Export it again, or check that it isn’t open in another program.');
    }
    text = text.replace(/^﻿/, '');
    if (!text.trim()) return fatal(p, 'This file is empty.', 'Export the report again from your ad platform and make sure the date range contains at least one day of activity.');
    p.table = window.Papa.parse(text, { skipEmptyLines: 'greedy' }).data;
    p.res = E.buildImport(p.table);
    if (!p.res.headers) return fatal(p, p.res.title, p.res.fix);
    p.platform = p.res.platform;
    p.mapping = Object.assign({}, p.res.mapping);
    return p;
  }

  function rebuild(p) {
    p.res = E.buildImport(p.table, { headerIndex: p.res.headerIndex, mapping: p.mapping, platform: p.platform });
  }

  async function handleFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const added = [];
    for (const f of files) {
      const p = await readFile(f);
      state.pending.push(p);
      added.push(p);
    }
    state.flash = null;
    if (location.hash !== '#/data') { state.focusAfterNav = 'pending-' + added[0].id; location.hash = '#/data'; return; }
    render({ focus: 'pending-' + added[0].id });
    const bad = added.filter((p) => p.fatal || !p.res.ok).length;
    announce(`${added.length} ${plural(added.length, 'file')} read. ${bad ? bad + ' need attention.' : 'Check the matches and choose a client to import.'}`);
  }

  function pendingCard(p) {
    const discard = `<button type="button" class="btn btn-ghost" data-action="pending-discard" data-id="${p.id}">Remove<span class="visually-hidden"> ${esc(p.fileName)}</span></button>`;
    if (p.fatal) {
      return `<article class="pending error" aria-labelledby="pending-${p.id}">
        <div class="pending-head"><h3 class="pending-file" id="pending-${p.id}" tabindex="-1">${esc(p.fileName)}</h3>${discard}</div>
        <div class="pending-body"><div class="pending-error" role="alert"><strong>${esc(p.fatal.title)}</strong><span>${esc(p.fatal.fix)}</span></div></div></article>`;
    }
    const res = p.res;
    const opt = (v, label, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
    const mapFields = E.FIELDS.map((f) => {
      const req = E.REQUIRED.includes(f);
      const missing = req && p.mapping[f] == null;
      return `<div class="field"><label for="map-${p.id}-${f}">${E.FIELD_LABELS[f]}${req ? ' <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span>' : ''}</label>
        <select class="select" id="map-${p.id}-${f}" data-change="map" data-id="${p.id}" data-field="${f}"${missing ? ' aria-invalid="true"' : ''}>
          ${opt('', 'Not in this file', p.mapping[f] == null)}${res.headers.map((h, i) => opt(i, h || `Column ${i + 1}`, p.mapping[f] === i)).join('')}
        </select></div>`;
    }).join('');
    const platSelect = `<div class="field"><label for="plat-${p.id}">Platform</label>
      <select class="select" id="plat-${p.id}" data-change="platform" data-id="${p.id}">${Object.keys(E.PLATFORMS).map((k) => opt(k, E.PLATFORMS[k], p.platform === k)).join('')}</select></div>`;
    const detected = res.platform === 'csv' ? 'Platform not recognised. Pick it below if you know it.' : `Detected as ${E.PLATFORMS[res.platform]}.`;
    const clientOpts = opt('', 'Choose a client', p.clientChoice === '') +
      sortedByName(state.result.clients).map((c) => opt(esc(c.client.id), c.client.name, p.clientChoice === c.client.id)).join('') +
      opt('new', 'New client', p.clientChoice === 'new');
    const previewRows = res.ok ? res.records.slice(0, 5) : [];
    return `<article class="pending${res.ok ? '' : ' error'}" aria-labelledby="pending-${p.id}">
      <div class="pending-head"><h3 class="pending-file" id="pending-${p.id}" tabindex="-1">${esc(p.fileName)}</h3>${discard}</div>
      <div class="pending-body">
        ${res.ok ? '' : `<div class="pending-error" role="alert"><strong>${esc(res.title)}</strong><span>${esc(res.fix)}</span></div>`}
        ${res.currency && res.currency !== 'SGD' ? `<p class="pending-warn">Amounts in this file look like ${esc(res.currency)}. Sightline labels everything as SGD and doesn’t convert currencies, so convert the file first or read the numbers with care.</p>` : ''}
        <p class="stats-line">${detected} Columns were matched automatically. Change any that look wrong.</p>
        <div class="map-grid">${platSelect}${mapFields}</div>
        ${res.ok ? `<p class="stats-line">${int(res.records.length)} ${plural(res.records.length, 'row')} from ${range(res.dateRange[0], res.dateRange[1])}${res.skipped ? `. ${res.skipped} skipped (total rows or rows without a readable date)` : ''}. Dates are read as day/month when unclear.</p>
          <div class="table-wrap" role="region" aria-label="Preview of the first rows" tabindex="0"><table class="table-full">
            <thead><tr><th scope="col">Date</th><th scope="col">Campaign</th><th scope="col" class="r">Spend</th><th scope="col" class="r">Impr.</th><th scope="col" class="r">Clicks</th><th scope="col" class="r">Conv.</th><th scope="col" class="r">Revenue</th></tr></thead>
            <tbody>${previewRows.map((r) => `<tr><td class="num">${r.date}</td>${nameCell(r.campaign)}<td class="r">${money(r.spend)}</td><td class="r">${int(r.impressions)}</td><td class="r">${int(r.clicks)}</td><td class="r">${int(r.conversions)}</td><td class="r">${money(r.revenue)}</td></tr>`).join('')}</tbody>
          </table></div>` : ''}
        <div class="pending-foot">
          <div class="assign">
            <div class="field"><label for="client-${p.id}">Add to client</label>
              <select class="select" id="client-${p.id}" data-change="client" data-id="${p.id}"${p.clientError ? ` aria-invalid="true" aria-describedby="client-err-${p.id}"` : ''}>${clientOpts}</select>
              ${p.clientError ? `<p class="field-error" id="client-err-${p.id}">${esc(p.clientError)}</p>` : ''}</div>
            ${p.clientChoice === 'new' ? `<div class="field"><label for="newname-${p.id}">New client name</label>
              <input class="input" id="newname-${p.id}" data-input="newname" data-id="${p.id}" value="${esc(p.newName)}" maxlength="120" autocomplete="off"${p.nameError ? ` aria-invalid="true" aria-describedby="name-err-${p.id}"` : ''}>
              ${p.nameError ? `<p class="field-error" id="name-err-${p.id}">${esc(p.nameError)}</p>` : ''}</div>` : ''}
          </div>
          <button type="button" class="btn btn-primary" id="import-${p.id}" data-action="pending-import" data-id="${p.id}"${res.ok ? '' : ' disabled'}>Import ${res.ok ? int(res.records.length) + ' ' + plural(res.records.length, 'row') : 'file'}</button>
        </div>
      </div></article>`;
  }

  function doImport(id) {
    const p = state.pending.find((x) => x.id === id);
    if (!p || !p.res || !p.res.ok) return;
    let clientId, clientName;
    if (p.clientChoice === 'new') {
      const name = p.newName.trim();
      if (!name) { p.nameError = 'Enter a name for the new client.'; return render({ focus: 'newname-' + id }); }
      const dup = state.db.clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (dup) { p.nameError = 'A client with this name already exists. Choose it from the list instead.'; return render({ focus: 'newname-' + id }); }
      clientId = 'c-' + uid();
      clientName = name;
      state.db.clients.push({ id: clientId, name, createdAt: new Date().toISOString() });
    } else if (!p.clientChoice || !state.db.clients.some((c) => c.id === p.clientChoice)) {
      p.clientError = 'Choose which client this file belongs to.';
      return render({ focus: 'client-' + id });
    } else {
      clientId = p.clientChoice;
      clientName = state.db.clients.find((c) => c.id === clientId).name;
    }
    const importId = 'i-' + uid();
    const { added, updated } = E.upsertRows(state.db, p.res.records, clientId, p.platform, importId);
    state.db.imports.unshift({ id: importId, clientId, platform: p.platform, fileName: p.fileName, rowCount: p.res.records.length,
      added, updated, at: new Date().toISOString(), dateRange: p.res.dateRange });
    const saved = commit();
    state.pending = state.pending.filter((x) => x.id !== id);
    state.flash = {
      tone: saved ? 'good' : 'warn',
      html: `Imported <strong>${esc(p.fileName)}</strong> into ${esc(clientName)}: ${added} new ${plural(added, 'row')}, ${updated} updated. <a href="#/client/${encodeURIComponent(clientId)}">View brief</a>` +
        (saved ? '' : ' This browser wouldn’t save it, so it will be gone when you close the tab.'),
    };
    announce(`Imported ${p.fileName} into ${clientName}.`);
    render({ focus: state.pending[0] ? 'pending-' + state.pending[0].id : 'file-input' });
  }

  function vData() {
    const db = state.db;
    const r = state.result;
    const clientRows = sortedByName(r.clients).map((c) => {
      const key = 'client:' + c.client.id;
      return `<tr>${nameCell(c.client.name, c.status === 'nodata' ? null : '#/client/' + encodeURIComponent(c.client.id))}
        <td>${esc(platformNames(c.platforms)) || '–'}</td><td class="r">${int(c.rows)}</td>
        <td class="num">${c.period ? range(c.period.firstDate, c.period.lastDate) : '–'}</td>
        <td>${confirmOr(key, `<button type="button" class="btn btn-danger-quiet" id="trigger-${esc(key)}" data-action="confirm-ask" data-key="${esc(key)}">Delete<span class="visually-hidden"> ${esc(c.client.name)}</span></button>`,
          `Delete ${esc(c.client.name)} and all ${int(c.rows)} of its rows? This can’t be undone.`, 'Delete client')}</td></tr>`;
    }).join('');
    const importRows = db.imports.map((i) => {
      const key = 'import:' + i.id;
      const client = db.clients.find((c) => c.id === i.clientId);
      const still = db.rows.filter((x) => x.importId === i.id).length;
      return `<tr>${nameCell(i.fileName)}<td>${esc(client ? client.name : 'Deleted client')}</td><td>${esc(E.PLATFORMS[i.platform] || i.platform)}</td>
        <td class="r">${int(i.rowCount)}</td><td class="num">${dlong(i.at.slice(0, 10))}</td>
        <td>${still ? confirmOr(key, `<button type="button" class="btn btn-danger-quiet" id="trigger-${esc(key)}" data-action="confirm-ask" data-key="${esc(key)}">Remove rows<span class="visually-hidden"> from ${esc(i.fileName)}</span></button>`,
          `Remove the ${int(still)} ${plural(still, 'row')} that came from this file? This can’t be undone.`, 'Remove rows') : '<span class="subtle">Rows replaced by a later import</span>'}</td></tr>`;
    }).join('');
    const samples = [['meta-ads-sample.csv', 'Meta Ads'], ['google-ads-sample.csv', 'Google Ads'], ['tiktok-ads-sample.csv', 'TikTok Ads'], ['shopee-ads-sample.csv', 'Shopee Ads']];
    return {
      title: 'Import and manage data',
      html: `<header class="page-head"><div class="page-head-text"><h1>Import and manage data</h1>
          <p class="lede">Import daily CSV exports from your ad platforms. Files are read in this browser and never uploaded. Importing the same file again updates rows instead of duplicating them.</p></div></header>
        <section aria-labelledby="import-title">
          <h2 id="import-title" class="visually-hidden">Import CSV files</h2>
          <div class="drop" data-drop>
            <h3>Add your CSV exports</h3>
            <p>Drag files here or choose them. Meta Ads, Google Ads, TikTok Ads, Shopee Ads, Lazada Ads, LinkedIn Ads, or any CSV with a date column and a spend column. You can add several at once.</p>
            <label class="btn btn-primary" for="file-input">${ICON.data}Choose CSV files</label>
            <input id="file-input" class="file-input" type="file" accept=".csv,text/csv" multiple data-change="files">
          </div>
          ${state.pending.length ? `<div class="pending-list">${state.pending.map(pendingCard).join('')}</div>` : ''}
        </section>

        <section class="section" aria-labelledby="health-title">
          <div class="section-head"><h2 id="health-title" tabindex="-1">Data health</h2><p>Gaps and missing columns that can make numbers look wrong</p></div>
          ${!db.clients.length ? '<p class="muted">Import data to run the checks.</p>' : r.dataIssues.length ? healthList(r.dataIssues, true) : '<p class="muted">No data problems found. Every platform has continuous daily data.</p>'}
        </section>

        <section class="section" aria-labelledby="samples-title">
          <div class="section-head"><h2 id="samples-title">Sample files</h2><p>Fictional exports for trying the importer</p></div>
          <div class="btn-row">${samples.map(([f, l]) => `<a class="btn btn-secondary" href="samples/${f}" download>${l}<span class="visually-hidden"> sample CSV</span></a>`).join('')}</div>
          <p class="subtle" style="margin-top:12px">Column names follow each platform's export format as closely as we could without live accounts, so real exports may need a column or two matched by hand.</p>
        </section>

        <section class="section" aria-labelledby="clients-title">
          <div class="section-head"><h2 id="clients-title">Clients</h2><p>${db.clients.length} ${plural(db.clients.length, 'client')}</p></div>
          ${db.clients.length ? `<div class="table-wrap" role="region" aria-label="Clients" tabindex="0"><table class="table-full">
            <thead><tr><th scope="col">Client</th><th scope="col">Platforms</th><th scope="col" class="r">Rows</th><th scope="col">Dates</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${clientRows}</tbody></table></div>` : '<p class="muted">No clients yet. Import a file and choose New client to add one.</p>'}
        </section>

        <section class="section" aria-labelledby="history-title">
          <div class="section-head"><h2 id="history-title">Import history</h2></div>
          ${db.imports.length ? `<div class="table-wrap" role="region" aria-label="Import history" tabindex="0"><table class="table-full">
            <thead><tr><th scope="col">File</th><th scope="col">Client</th><th scope="col">Platform</th><th scope="col" class="r">Rows</th><th scope="col">Imported</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${importRows}</tbody></table></div>` : `<p class="muted">${db.isDemo ? 'The sample data was generated, not imported, so it has no import history.' : 'Nothing imported yet.'}</p>`}
        </section>`,
    };
  }

  /* ---------- settings ---------- */

  function vSettings() {
    const eff = state.result ? state.result.thresholds : Object.assign({}, E.THRESHOLDS, E.cleanThresholds(state.db.settings.thresholds));
    const pc = (v) => Math.round(v * 1000) / 10 + '%';
    const pref = themePref();
    const msg = state.settingsMsg;
    const hasData = state.db.clients.length > 0;
    const s = state.db.settings;
    const logo = s.logo && LOGO_RE.test(s.logo) ? s.logo : null;
    const brand = s.brandColor && COLOR_RE.test(s.brandColor) ? s.brandColor : null;
    const hasCustomRules = Object.keys(E.cleanThresholds(s.thresholds)).length > 0;
    const radio = (v, label) => `<label class="radio"><input type="radio" name="theme" value="${v}" data-change="theme"${pref === v ? ' checked' : ''}>${label}</label>`;
    const shown = (k, unit) => (unit === 'pct' ? String(Math.round(eff[k] * 1000) / 10) : String(eff[k]));
    const unitLabel = { pct: '%', days: 'days', count: 'conv.' };
    const ruleFields = E.THRESHOLD_FIELDS.map(([k, label, unit, min, max]) => `<div class="field"><label for="rule-${k}">${label}</label>
      <div class="unit-input"><input class="input" id="rule-${k}" name="${k}" type="number" inputmode="decimal" min="${min}" max="${max}" step="${unit === 'pct' ? 'any' : '1'}" value="${esc(formValue('rules', k, shown(k, unit)))}"${errAttrs('rules', k)}><span class="unit">${unitLabel[unit]}</span></div>
      <p class="hint">Default ${unit === 'pct' ? pc(E.THRESHOLDS[k]) : E.THRESHOLDS[k]}</p>${errText('rules', k)}</div>`).join('');
    const rules = [
      ['Critical', `Tracking break: spend on each of the last ${eff.trackingDays} days with zero conversions, after averaging at least ${eff.trackingMinDailyConv} a day over the ${eff.trackingBaselineDays} days before.`],
      ['Critical', `Cost per conversion up ${pc(eff.cpaUpCrit)} or more, or ROAS down ${pc(eff.roasDownCrit)} or more, compared with the previous period. A monthly budget already spent, or a target missed by ${pc(eff.targetMissCrit)} or more.`],
      ['Warning', `Cost per conversion up ${pc(eff.cpaUpWarn)}, ROAS down ${pc(eff.roasDownWarn)}, click-through rate down ${pc(eff.ctrDownWarn)}, spend down ${pc(eff.spendDropWarn)}, or spend up ${pc(eff.spendUpMin)} while conversions rise less than ${pc(eff.spendUpConvMax)}.`],
      ['Warning', `A single campaign carrying at least ${pc(eff.campaignMinShare)} of a client’s spend sees its cost per conversion rise ${pc(eff.campaignCpaUp)} or more, even when the client’s totals look steady.`],
      ['Warning', `Budget pace: projected month-end spend ${pc(eff.pacingOverWarn)} above or ${pc(eff.pacingUnderWarn)} below the monthly budget, from day ${eff.pacingMinDays} of the month. A target missed by ${pc(eff.targetMissWarn)} or more.`],
      ['Warning', `The latest data for a client is more than ${eff.staleDays} days old.`],
      ['Opportunity', `A campaign’s cost per conversion fell ${pc(eff.winnerCpaDown)} or more, or its ROAS rose ${pc(eff.winnerRoasUp)} or more.`],
      ['Noise guard', `Cost and ROAS rules need at least ${eff.minConversions} conversions in both periods. CTR rules need ${int(eff.minImpressions)} impressions. Spend rules need S$${eff.minSpend} of spend per period.`],
    ];
    const loadBtn = `<button type="button" class="btn btn-secondary" id="trigger-reset" data-action="${hasData ? 'confirm-ask' : 'demo'}" data-key="reset">Load sample data</button>`;
    const delBtn = `<button type="button" class="btn btn-danger-quiet" id="trigger-all" data-action="confirm-ask" data-key="all"${hasData ? '' : ' disabled'}>Delete all data</button>`;
    const resetRulesBtn = `<button type="button" class="btn btn-secondary" id="trigger-rules-reset" data-action="confirm-ask" data-key="rules-reset">Reset to defaults</button>`;
    return {
      title: 'Settings',
      html: `<header class="page-head"><div class="page-head-text"><h1>Settings</h1></div></header>
        <div class="settings-grid">
          <section class="settings-section" aria-labelledby="agency-title">
            <h2 id="agency-title">Agency</h2>
            <form data-form="agency" novalidate>
              <div class="form-row">
                <div class="field"><label for="agency-name">Agency name</label>
                  <input class="input" id="agency-name" name="agency" value="${esc(state.db.agency.name)}" maxlength="80" autocomplete="organization"${msg && msg.error ? ' aria-invalid="true" aria-describedby="agency-msg"' : ' aria-describedby="agency-hint"'}>
                  <p class="hint" id="agency-hint">Shown at the top of every client report.</p>
                  ${msg ? `<p class="${msg.error ? 'field-error' : 'field-ok'}" id="agency-msg" role="${msg.error ? 'alert' : 'status'}">${esc(msg.text)}</p>` : ''}</div>
                <button type="submit" class="btn btn-primary" style="margin-bottom:26px">Save</button>
              </div>
            </form>
          </section>

          <section class="settings-section" aria-labelledby="brand-title">
            <h2 id="brand-title">Report branding</h2>
            <p>Your logo and colour appear on printed client reports. They’re saved in this browser only.</p>
            <div class="brand-row">
              <div class="logo-box">${logo ? `<img class="logo-preview" src="${esc(logo)}" alt="Current logo">` : '<span class="subtle">No logo</span>'}</div>
              <div class="field">
                <span class="label">Logo</span>
                <div class="btn-row">
                  <label class="btn btn-secondary" for="logo-input">${logo ? 'Replace logo' : 'Upload logo'}</label>
                  <input id="logo-input" class="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-change="logo" aria-describedby="logo-hint">
                  ${logo ? '<button type="button" class="btn btn-danger-quiet" id="logo-remove" data-action="logo-remove">Remove</button>' : ''}
                </div>
                <p class="hint" id="logo-hint">PNG, JPG, WebP or SVG, up to 200 KB.</p>
                ${formMsg('logo')}
              </div>
            </div>
            <div class="field color-field">
              <label for="brand-color">Brand colour</label>
              <div class="btn-row">
                <input id="brand-color" class="color-input" type="color" value="${brand || '#0b6b85'}" data-change="brand-color">
                <span class="num">${brand ? brand.toUpperCase() : 'Not set'}</span>
                ${brand ? '<button type="button" class="btn btn-ghost" id="brand-reset" data-action="brand-reset">Reset colour</button>' : ''}
              </div>
              <p class="hint">Used for the rule under each report’s heading. Text stays black for readability.</p>
              ${formMsg('brand')}
            </div>
          </section>

          <section class="settings-section" aria-labelledby="alert-rules-title">
            <h2 id="alert-rules-title">Alert rules</h2>
            <p>Change when Sightline flags a client. These apply to every client, unless a client has its own rules on its page.${hasCustomRules ? ' <strong>You’re using custom rules.</strong>' : ''}</p>
            <form data-form="rules" novalidate>
              <div class="form-grid">${ruleFields}</div>
              ${formMsg('rules')}
              <div class="btn-row">
                <button type="submit" class="btn btn-primary">Save alert rules</button>
                ${hasCustomRules ? confirmOr('rules-reset', resetRulesBtn, 'Put every alert rule back to its default?', 'Reset rules') : ''}
              </div>
            </form>
          </section>

          <section class="settings-section" aria-labelledby="theme-title">
            <h2 id="theme-title">Appearance</h2>
            <fieldset style="border:0;padding:0;margin:0"><legend class="label" style="font-weight:600;font-size:14px;margin-bottom:8px">Theme</legend>
              <div class="radio-row">${radio('system', 'Match my device')}${radio('light', 'Light')}${radio('dark', 'Dark')}</div></fieldset>
          </section>

          <section class="settings-section" aria-labelledby="data-title">
            <h2 id="data-title">Data in this browser</h2>
            <p>Everything is saved in this browser only. Clearing your browser data or switching devices starts you from scratch.</p>
            <div>
              <div class="danger-row"><div><h3>Load sample data</h3><p>Replaces everything with a fictional agency and six clients so you can explore.</p></div>
                ${confirmOr('reset', loadBtn, 'Replace all current data with the sample agency? Your clients, imports, notes and settings will be replaced.', 'Replace with sample data')}</div>
              <div class="danger-row"><div><h3>Delete all data</h3><p>Removes every client, row, import, note, budget, alert rule and branding setting saved by Sightline in this browser.</p></div>
                ${confirmOr('all', delBtn, 'Delete everything Sightline has saved in this browser? This can’t be undone.', 'Delete everything')}</div>
            </div>
          </section>

          <section class="settings-section" aria-labelledby="rules-title">
            <h2 id="rules-title">How the insights work</h2>
            <p>Sightline uses fixed rules, not a language model. Each client’s current period (${esc(lbl().short)}, chosen on the overview) is compared with ${esc(lbl().prev)}. A client is at risk if any rule is critical and on watch if any is a warning. Data health problems are listed separately and don’t change a client’s status.</p>
            <ul class="rules-list">${rules.map(([k, v]) => `<li><span>${k === 'Noise guard' ? '<strong>' + k + '</strong>' : pill(SEV, k === 'Critical' ? 'crit' : k === 'Warning' ? 'warn' : 'good')}</span><span>${esc(v)}</span></li>`).join('')}</ul>
          </section>
        </div>`,
    };
  }

  /* ---------- shell ---------- */

  function banners(rt) {
    let out = '';
    if (state.storage === 'blocked') out += '<p class="banner banner-warn" role="alert"><span class="banner-text"><strong>This browser is blocking storage.</strong> Anything you import will be lost when you close the tab.</span></p>';
    if (state.storage === 'full') out += '<p class="banner banner-warn" role="alert"><span class="banner-text"><strong>Browser storage is full.</strong> The latest change wasn’t saved. Delete a client or older imports in Import to free up space.</span></p>';
    if (state.storage === 'corrupt') {
      out += `<div class="banner banner-crit" role="alert"><span class="banner-text"><strong>We couldn’t read the data saved in this browser.</strong> It has been left untouched, and changes you make now won’t be saved.</span>
        ${confirmOr('corrupt', '<button type="button" class="btn btn-secondary" id="trigger-corrupt" data-action="confirm-ask" data-key="corrupt">Start fresh</button>', 'Replace the unreadable data with a fresh start?', 'Start fresh')}</div>`;
    }
    const onWelcome = rt.name === 'overview' && !state.db.clients.length;
    if (state.db.isDemo && !onWelcome && rt.name !== 'report') {
      out += `<div class="banner"><span class="banner-text"><strong>You’re viewing sample data.</strong> The agency, clients and numbers are fictional.${rt.name === 'data' ? ' Files you import are added alongside it.' : ''}</span>
        ${rt.name === 'data' ? '' : '<a class="btn btn-ghost" href="#/data" data-action="go-import">Import your own files</a>'}
        <button type="button" class="btn btn-secondary" data-action="clear-demo">Clear sample data</button></div>`;
    }
    if (state.flash) {
      out += `<div class="banner banner-${state.flash.tone}"><span class="banner-text">${state.flash.html}</span>
        <button type="button" class="icon-btn close" data-action="dismiss-flash" aria-label="Dismiss message">${ICON.close}</button></div>`;
    }
    return out;
  }

  function shell(rt, body) {
    const alertCount = state.result ? state.result.alerts.length : 0;
    const current = { overview: 'overview', client: 'overview', alerts: 'alerts', reports: 'reports', report: 'reports', data: 'data', settings: 'settings' }[rt.name];
    const items = [
      ['overview', 'Overview', '#/'],
      ['alerts', 'Alerts', '#/alerts'],
      ['reports', 'Reports', '#/reports'],
      ['data', 'Import', '#/data'],
      ['settings', 'Settings', '#/settings'],
    ];
    const dark = effectiveTheme() === 'dark';
    return `<button type="button" class="skip" data-action="skip">Skip to content</button>
      <div class="shell">
        <header class="sidebar">
          <a class="brand" href="#/" aria-label="Sightline, go to overview">${BRAND_MARK}<span class="brand-name">Sightline</span></a>
          <nav class="nav" aria-label="Main"><ul>${items.map(([k, label, href]) => `<li><a href="${href}"${current === k ? ' aria-current="page"' : ''}>${ICON[k]}<span class="nav-label">${label}</span>${k === 'alerts' && alertCount ? `<span class="badge">${alertCount}<span class="visually-hidden"> open</span></span>` : ''}</a></li>`).join('')}</ul></nav>
          <div class="sidebar-foot">
            ${state.db.clients.length ? `<span class="agency-name">${esc(state.db.agency.name)}</span>` : ''}
            <button type="button" class="icon-btn" id="theme-toggle" data-action="theme-toggle" aria-label="Switch to ${dark ? 'light' : 'dark'} theme" title="Switch to ${dark ? 'light' : 'dark'} theme">${dark ? ICON.sun : ICON.moon}</button>
          </div>
        </header>
        <main id="main" class="main" tabindex="-1">
          <div class="content">${banners(rt)}${body}</div>
          <footer class="app-foot">Portfolio prototype. Sample data is fictional. Your files never leave your browser.</footer>
        </main>
      </div>`;
  }

  /* ---------- routing and render ---------- */

  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [name, id] = h.split('/');
    return { name: name || 'overview', id: id ? decodeURIComponent(id) : null };
  }

  function view(rt) {
    switch (rt.name) {
      case 'overview': return vOverview();
      case 'client': return vClient(rt.id);
      case 'alerts': return vAlerts();
      case 'reports': return vReports();
      case 'report': return vReport(rt.id);
      case 'data': return vData();
      case 'settings': return vSettings();
      default: return vNotFound();
    }
  }

  function render(opts) {
    opts = opts || {};
    const activeId = document.activeElement && document.activeElement.id;
    const rt = route();
    const v = view(rt);
    document.title = v.title === 'Weekly client briefs from your ad exports' ? 'Sightline | ' + v.title : v.title + ' | Sightline';
    app.innerHTML = shell(rt, v.html);
    let target = null;
    if (opts.focus) target = document.getElementById(opts.focus);
    else if (opts.focusMain) {
      target = app.querySelector('h1');
      if (target) target.setAttribute('tabindex', '-1');
    } else if (activeId) target = document.getElementById(activeId);
    if (target) target.focus({ preventScroll: !opts.focusMain });
    if (opts.focusMain) window.scrollTo(0, 0);
    if (state.copyFallback) {
      const ta = document.getElementById('copy-text');
      if (ta && opts.selectCopy) { ta.focus(); ta.select(); }
    }
  }

  let live;
  function announce(text) {
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 50);
  }

  /* ---------- actions ---------- */

  function loadDemo() {
    state.db = E.buildDemo(E.isoFromDay(E.dayNum(E.todayISO()) - 1));
    if (state.storage === 'corrupt') state.storage = 'ok';
    const saved = commit();
    state.pending = [];
    state.sort = { key: 'status', dir: 1 };
    state.flash = saved ? null : { tone: 'warn', html: 'Sample data loaded, but this browser won’t save it. It will be gone when you close the tab.', sticky: true };
    announce('Sample data loaded. Everything shown is fictional.');
    if (route().name === 'overview') render({ focusMain: true });
    else { state.flash && (state.flash.sticky = true); location.hash = '#/'; }
  }

  function clearDemo() {
    const db = state.db;
    db.rows = db.rows.filter((r) => r.importId !== 'demo');
    const withRows = new Set(db.rows.map((r) => r.clientId));
    db.clients = db.clients.filter((c) => !c.id.startsWith('demo-') || withRows.has(c.id));
    const kept = new Set(db.clients.map((c) => c.id));
    db.notes = (db.notes || []).filter((n) => kept.has(n.clientId) && !String(n.id).startsWith('demo-note-'));
    if (db.agency.name === 'Sample Agency') db.agency.name = 'Your agency';
    db.isDemo = false;
    commit();
    announce('Sample data cleared.');
    if (!db.clients.length && route().name !== 'overview') location.hash = '#/';
    else render({ focusMain: true });
  }

  function copyText(text, id) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    };
    const done = (ok) => {
      if (ok) {
        state.copyFallback = null;
        state.flash = { tone: 'good', html: 'Brief copied. Paste it into an email, Slack or your notes.' };
        announce('Brief copied to the clipboard.');
        render({ focus: 'copy-brief' });
      } else {
        state.copyFallback = { id, text };
        render({ selectCopy: true });
      }
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(fallback()));
    } else {
      done(fallback());
    }
  }

  function runConfirmed(key) {
    const db = state.db;
    state.confirm = null;
    if (key === 'all' || key === 'corrupt') {
      if (key === 'corrupt') {
        try { localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ }
        state.storage = 'ok';
      }
      state.db = emptyDb();
      state.pending = [];
      commit();
      announce('All data deleted.');
      state.flash = { tone: 'good', html: 'All data deleted.', sticky: true };
      if (route().name === 'overview') render({ focusMain: true }); else location.hash = '#/';
      return;
    }
    if (key === 'reset') { loadDemo(); return; }
    if (key === 'rules-reset') {
      delete db.settings.thresholds;
      commit();
      state.formMsg = { form: 'rules', text: 'Alert rules are back to their defaults. Every client was rechecked.' };
      announce('Alert rules reset.');
      render({ focus: 'rule-cpaUpWarn' });
      return;
    }
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'client') {
      const c = db.clients.find((x) => x.id === id);
      db.clients = db.clients.filter((x) => x.id !== id);
      db.rows = db.rows.filter((x) => x.clientId !== id);
      db.imports = db.imports.filter((x) => x.clientId !== id);
      db.notes = (db.notes || []).filter((x) => x.clientId !== id);
      if (!db.clients.length) db.isDemo = false;
      commit();
      state.flash = { tone: 'good', html: `Deleted ${esc(c ? c.name : 'client')}.` };
      announce('Client deleted.');
      render({ focus: 'file-input' });
    } else if (kind === 'note') {
      db.notes = (db.notes || []).filter((x) => x.id !== id);
      commit();
      state.formMsg = { form: 'note', text: 'Note deleted.' };
      announce('Note deleted.');
      render({ focus: 'note-text' });
    } else if (kind === 'import') {
      const before = db.rows.length;
      db.rows = db.rows.filter((x) => x.importId !== id);
      const imp = db.imports.find((x) => x.id === id);
      db.imports = db.imports.filter((x) => x.id !== id);
      commit();
      state.flash = { tone: 'good', html: `Removed ${before - db.rows.length} rows from ${esc(imp ? imp.fileName : 'that import')}.` };
      announce('Import removed.');
      render({ focus: 'file-input' });
    }
  }


  /* ---------- forms: budget, notes, alert rules, logo ---------- */

  // Reads an optional positive number from a form field. Returns { value } or { error }.
  function readNumber(raw, label, max) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return { value: null };
    const v = Number(s);
    if (!isFinite(v) || v <= 0) return { error: `${label} must be a number above zero, or left empty.` };
    if (max && v > max) return { error: `${label} looks too large. Enter ${max.toLocaleString('en-SG')} or less.` };
    return { value: v };
  }

  function saveBudget(f) {
    const id = f.dataset.id;
    const client = state.db.clients.find((c) => c.id === id);
    if (!client) return;
    const values = {}, errors = {};
    const fields = [['monthly', 'Monthly budget', 100000000], ['targetCpa', 'Target cost per conversion', 1000000], ['targetRoas', 'Target ROAS', 1000]];
    const budget = {};
    for (const [k, label, max] of fields) {
      values[k] = f.elements[k].value;
      const r = readNumber(values[k], label, max);
      if (r.error) errors[k] = r.error; else budget[k] = r.value;
    }
    const overrides = {};
    for (const k of E.CLIENT_THRESHOLD_KEYS) {
      values[k] = f.elements[k].value;
      const r = readNumber(values[k], 'This rule', 500);
      if (r.error) errors[k] = r.error; else if (r.value != null) overrides[k] = r.value / 100;
    }
    if (!Object.keys(errors).length) {
      const agencyT = Object.assign({}, E.THRESHOLDS, E.cleanThresholds(state.db.settings.thresholds));
      const v = E.validateThresholds(Object.assign({}, agencyT, overrides));
      for (const k of E.CLIENT_THRESHOLD_KEYS) if (v[k]) errors[k] = v[k];
    }
    if (Object.keys(errors).length) {
      state.formErrors = { form: 'budget', errors, values };
      state.formMsg = { form: 'budget', text: 'Check the highlighted fields.', error: true };
      render({ focus: 'budget-' + ({ monthly: 'monthly', targetCpa: 'cpa', targetRoas: 'roas' }[Object.keys(errors)[0]] || 'monthly') });
      const first = document.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    if (budget.monthly == null && budget.targetCpa == null && budget.targetRoas == null) delete client.budget; else client.budget = budget;
    if (Object.keys(overrides).length) client.thresholds = overrides; else delete client.thresholds;
    const ok = commit();
    state.editBudget = null;
    state.formErrors = null;
    state.formMsg = { form: 'budget', text: ok ? 'Budget and targets saved. The brief and alerts were updated.' : 'This browser wouldn’t save the change.', error: !ok };
    announce('Budget and targets saved.');
    render({ focus: 'edit-budget' });
  }

  function saveNote(f) {
    const id = f.dataset.id;
    const values = { date: f.elements.date.value, text: f.elements.text.value };
    const errors = {};
    const date = E.parseDate(values.date);
    if (!date) errors.date = 'Choose a date.';
    const text = values.text.trim();
    if (!text) errors.text = 'Write a short note, for example what changed.';
    else if (text.length > 280) errors.text = 'Keep notes to 280 characters.';
    if (Object.keys(errors).length) {
      state.formErrors = { form: 'note', errors, values };
      state.formMsg = null;
      render({ focus: errors.date ? 'note-date' : 'note-text' });
      return;
    }
    state.db.notes = state.db.notes || [];
    state.db.notes.push({ id: 'n-' + uid(), clientId: id, date, text, createdAt: new Date().toISOString() });
    const ok = commit();
    state.formErrors = null;
    state.formMsg = { form: 'note', text: ok ? 'Note added. It shows on the charts and in the report.' : 'This browser wouldn’t save the note.', error: !ok };
    announce('Note added.');
    render({ focus: 'note-text' });
  }

  function saveRules(f) {
    const values = {}, errors = {}, next = {};
    for (const [k, label, unit] of E.THRESHOLD_FIELDS) {
      values[k] = f.elements[k].value;
      const raw = String(values[k]).trim();
      const v = Number(raw);
      if (raw === '' || !isFinite(v)) { errors[k] = 'Enter a number.'; continue; }
      next[k] = unit === 'pct' ? v / 100 : v;
    }
    const full = Object.assign({}, E.THRESHOLDS, next);
    const v = E.validateThresholds(full);
    for (const k of Object.keys(v)) if (!errors[k]) errors[k] = v[k];
    if (Object.keys(errors).length) {
      state.formErrors = { form: 'rules', errors, values };
      state.formMsg = { form: 'rules', text: 'Check the highlighted rules. Nothing was saved.', error: true };
      render();
      const first = document.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    // Only store values that differ from the defaults, so future default changes still apply.
    const overrides = {};
    for (const k of Object.keys(next)) if (Math.abs(next[k] - E.THRESHOLDS[k]) > 1e-9) overrides[k] = next[k];
    if (Object.keys(overrides).length) state.db.settings.thresholds = overrides; else delete state.db.settings.thresholds;
    const ok = commit();
    state.formErrors = null;
    state.formMsg = { form: 'rules', text: ok ? 'Alert rules saved. Every client was rechecked.' : 'This browser wouldn’t save the change.', error: !ok };
    announce('Alert rules saved.');
    render({ focus: 'rule-cpaUpWarn' });
  }

  const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  const MAX_LOGO_BYTES = 200 * 1024;

  function readLogo(file) {
    if (!file) return;
    const fail = (text) => { state.formMsg = { form: 'logo', text, error: true }; render({ focus: 'logo-input' }); };
    if (!LOGO_TYPES.includes(file.type)) return fail('That file type isn’t supported. Use a PNG, JPG, WebP or SVG image.');
    if (file.size > MAX_LOGO_BYTES) return fail(`That image is ${Math.round(file.size / 1024)} KB. Use one that is 200 KB or smaller.`);
    const reader = new FileReader();
    reader.onerror = () => fail('We couldn’t read that image. Try exporting it again.');
    reader.onload = () => {
      const url = String(reader.result || '');
      if (!LOGO_RE.test(url)) return fail('We couldn’t read that image. Try exporting it again.');
      state.db.settings.logo = url;
      const ok = commit();
      if (!ok) { delete state.db.settings.logo; recompute(); return fail('Browser storage is full, so the logo wasn’t saved. Try a smaller image.'); }
      state.formMsg = { form: 'logo', text: 'Logo saved. It now appears on client reports.' };
      announce('Logo saved.');
      render({ focus: 'logo-input' });
    };
    reader.readAsDataURL(file);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    switch (a) {
      case 'skip': {
        const h = app.querySelector('main h1') || document.getElementById('main');
        h.setAttribute('tabindex', '-1');
        h.focus();
        break;
      }
      case 'demo': e.preventDefault(); loadDemo(); break;
      case 'go-import':
        state.focusAfterNav = 'file-input';
        if (location.hash === '#/data') { e.preventDefault(); state.focusAfterNav = null; const f = document.getElementById('file-input'); if (f) f.focus(); }
        break;
      case 'clear-demo': clearDemo(); break;
      case 'sort': {
        const k = t.dataset.key;
        if (state.sort.key === k) state.sort.dir *= -1;
        else state.sort = { key: k, dir: k === 'name' || k === 'status' ? 1 : -1 };
        render({ focus: 'sort-' + k });
        break;
      }
      case 'alert-filter': state.alertFilter = t.dataset.value; render({ focus: 'filter-' + t.dataset.value }); break;
      case 'copy-brief': {
        const c = findClient(t.dataset.id);
        if (c) copyText(briefText(c), t.dataset.id);
        break;
      }
      case 'print': window.print(); break;
      case 'theme-toggle': setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'); render({ focus: 'theme-toggle' }); break;
      case 'confirm-ask': state.confirm = t.dataset.key; state.lastTrigger = t.id; render({ focus: 'confirm-cancel' }); break;
      case 'confirm-cancel': state.confirm = null; render({ focus: state.lastTrigger }); break;
      case 'confirm-do': runConfirmed(t.dataset.key); break;
      case 'dismiss-flash': state.flash = null; render({ focusMain: false, focus: 'main' }); break;
      case 'pending-discard': {
        state.pending = state.pending.filter((p) => p.id !== t.dataset.id);
        render({ focus: state.pending[0] ? 'pending-' + state.pending[0].id : 'file-input' });
        break;
      }
      case 'pending-import': doImport(t.dataset.id); break;
      case 'edit-budget': state.editBudget = t.dataset.id; state.formErrors = null; state.formMsg = null; render({ focus: 'budget-monthly' }); break;
      case 'cancel-budget': state.editBudget = null; state.formErrors = null; render({ focus: 'edit-budget' }); break;
      case 'driver-view': state.driverView = t.dataset.value === 'campaign' ? 'campaign' : 'platform'; render({ focus: 'driver-' + state.driverView }); break;
      case 'go-health':
        state.focusAfterNav = 'health-title';
        if (location.hash === '#/data') { e.preventDefault(); state.focusAfterNav = null; const h = document.getElementById('health-title'); if (h) { h.focus(); h.scrollIntoView(); } }
        break;
      case 'logo-remove':
        delete state.db.settings.logo;
        commit();
        state.formMsg = { form: 'logo', text: 'Logo removed.' };
        render({ focus: 'logo-input' });
        break;
      case 'brand-reset':
        delete state.db.settings.brandColor;
        commit();
        state.formMsg = { form: 'brand', text: 'Brand colour reset.' };
        render({ focus: 'brand-color' });
        break;
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    const c = t.dataset && t.dataset.change;
    if (!c) return;
    if (c === 'files') { handleFiles(t.files); t.value = ''; return; }
    if (c === 'theme') { setTheme(t.value); render({ focus: null }); const r = app.querySelector(`input[name="theme"][value="${t.value}"]`); if (r) r.focus(); return; }
    if (c === 'period') {
      if (!E.PERIODS[t.value]) return;
      state.db.settings.period = t.value;
      commit();
      announce(`Showing ${E.PERIODS[t.value].title.toLowerCase()}, compared with ${E.PERIODS[t.value].prev}.`);
      render({ focus: t.id });
      return;
    }
    if (c === 'logo') { readLogo(t.files && t.files[0]); t.value = ''; return; }
    if (c === 'brand-color') {
      if (!COLOR_RE.test(t.value)) return;
      state.db.settings.brandColor = t.value;
      const ok = commit();
      state.formMsg = { form: 'brand', text: ok ? 'Brand colour saved.' : 'This browser wouldn\u2019t save the change.', error: !ok };
      render({ focus: 'brand-color' });
      return;
    }
    const p = state.pending.find((x) => x.id === t.dataset.id);
    if (!p) return;
    if (c === 'platform') { p.platform = t.value; rebuild(p); }
    if (c === 'map') {
      if (t.value === '') delete p.mapping[t.dataset.field];
      else p.mapping[t.dataset.field] = +t.value;
      rebuild(p);
    }
    if (c === 'client') { p.clientChoice = t.value; p.clientError = null; p.nameError = null; }
    render({ focus: c === 'client' && t.value === 'new' ? 'newname-' + p.id : t.id });
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.input === 'newname') {
      const p = state.pending.find((x) => x.id === t.dataset.id);
      if (p) p.newName = t.value;
    }
  });

  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.dataset.form === 'budget') { e.preventDefault(); saveBudget(f); return; }
    if (f.dataset.form === 'note') { e.preventDefault(); saveNote(f); return; }
    if (f.dataset.form === 'rules') { e.preventDefault(); saveRules(f); return; }
    if (f.dataset.form !== 'agency') return;
    e.preventDefault();
    const name = f.elements.agency.value.trim();
    if (!name) {
      state.settingsMsg = { error: true, text: 'Enter an agency name. It appears on client reports.' };
    } else {
      state.db.agency.name = name;
      const saved = commit();
      state.settingsMsg = saved ? { text: 'Saved. Reports now show this name.' } : { error: true, text: 'This browser wouldn’t save the change.' };
    }
    render({ focus: 'agency-name' });
  });

  // Drag and drop onto the import zone. Elsewhere, stop the browser from opening a dropped file.
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    const z = e.target.closest && e.target.closest('[data-drop]');
    document.querySelectorAll('[data-drop]').forEach((d) => d.classList.toggle('dragging', d === z));
    e.dataTransfer.dropEffect = z ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', (e) => {
    if (e.target.matches && e.target.matches('[data-drop]')) e.target.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    document.querySelectorAll('[data-drop]').forEach((d) => d.classList.remove('dragging'));
    if (e.target.closest && e.target.closest('[data-drop]')) handleFiles(e.dataTransfer.files);
  });

  window.addEventListener('hashchange', () => {
    state.confirm = null;
    state.copyFallback = null;
    state.settingsMsg = null;
    state.editBudget = null;
    state.formErrors = null;
    state.formMsg = null;
    if (state.flash && state.flash.sticky) state.flash.sticky = false;
    else state.flash = null;
    const f = state.focusAfterNav;
    state.focusAfterNav = null;
    render(f ? { focus: f } : { focusMain: true });
    if (f) window.scrollTo(0, 0);
  });

  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (themePref() === 'system') render(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }

  /* ---------- start ---------- */

  live = document.createElement('div');
  live.className = 'visually-hidden';
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);

  state.db = load();
  recompute();
  render();
})();
