/* Sightline engine. Pure functions only: no DOM access and no storage, so the
   same code powers the app, the welcome preview and tests.html. */
(function (root) {
  'use strict';

  // Every rule threshold lives here so the rules can be read and tuned in one place.
  const THRESHOLDS = {
    cpaUpWarn: 0.20,
    cpaUpCrit: 0.40,
    roasDownWarn: 0.20,
    roasDownCrit: 0.35,
    spendUpMin: 0.25,
    spendUpConvMax: 0.05,
    ctrDownWarn: 0.15,
    spendDropWarn: 0.40,
    winnerRoasUp: 0.20,
    winnerCpaDown: 0.15,
    campaignCpaUp: 0.40,     // a single campaign's CPA rise that is worth flagging on its own
    campaignMinShare: 0.15,  // ...if it carries at least this share of the client's weekly spend
    minConversions: 5,     // per week; below this CPA and ROAS swings are mostly noise
    minImpressions: 1000,  // per week, for CTR
    minSpend: 100,         // SGD per week
    trackingDays: 3,
    trackingBaselineDays: 14,
    trackingMinDailyConv: 1,
    staleDays: 10,
  };

  const PLATFORMS = {
    meta: 'Meta Ads',
    google: 'Google Ads',
    tiktok: 'TikTok Ads',
    shopee: 'Shopee Ads',
    lazada: 'Lazada Ads',
    linkedin: 'LinkedIn Ads',
    csv: 'Other CSV',
  };

  /* ---------- dates ---------- */

  const DAY = 864e5;
  function dayNum(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY);
  }
  function isoFromDay(n) {
    return new Date(n * DAY).toISOString().slice(0, 10);
  }
  function todayISO() {
    const d = new Date();
    return isoFromDay(Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY));
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  function validYMD(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return dt.toISOString().slice(0, 10);
  }

  // Singapore exports usually write day/month, so ambiguous dates are read that way.
  function parseDate(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return validYMD(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(\s|$)/))) {
      let a = +m[1], b = +m[2];
      if (b > 12 && a <= 12) [a, b] = [b, a];
      return validYMD(+m[3], b, a);
    }
    if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
      const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
      return mo ? validYMD(+m[3], mo, +m[2]) : null;
    }
    if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/))) {
      const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
      return mo ? validYMD(+m[3], mo, +m[1]) : null;
    }
    return null;
  }

  /* ---------- numbers ---------- */

  function parseNumber(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).trim();
    if (s === '' || s === '--' || s === '-' || s === '—') return 0;
    const cleaned = s.replace(/S\$|SGD|US\$|USD|\$|,|%|\s/gi, '');
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }

  function pctChange(now, before) {
    if (now == null || before == null || before === 0) return null;
    return (now - before) / before;
  }

  /* ---------- metrics ---------- */

  function blank() {
    return { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
  }
  function addInto(acc, r) {
    acc.spend += r.spend || 0;
    acc.impressions += r.impressions || 0;
    acc.clicks += r.clicks || 0;
    acc.conversions += r.conversions || 0;
    acc.revenue += r.revenue || 0;
    return acc;
  }
  function derive(m) {
    return Object.assign({}, m, {
      cpa: m.conversions > 0 ? m.spend / m.conversions : null,
      roas: m.spend > 0 && m.revenue > 0 ? m.revenue / m.spend : null,
      ctr: m.impressions > 0 ? m.clicks / m.impressions : null,
    });
  }
  function sumRange(rows, from, to) {
    const acc = blank();
    for (const r of rows) {
      const n = r._day;
      if (n >= from && n <= to) addInto(acc, r);
    }
    return derive(acc);
  }
  function deltas(tw, lw) {
    return {
      spend: pctChange(tw.spend, lw.spend),
      conversions: pctChange(tw.conversions, lw.conversions),
      revenue: pctChange(tw.revenue, lw.revenue),
      impressions: pctChange(tw.impressions, lw.impressions),
      clicks: pctChange(tw.clicks, lw.clicks),
      cpa: pctChange(tw.cpa, lw.cpa),
      roas: pctChange(tw.roas, lw.roas),
      ctr: pctChange(tw.ctr, lw.ctr),
    };
  }

  /* ---------- analyze ---------- */

  const SEV_RANK = { crit: 0, warn: 1, good: 2, info: 3 };

  function campaignBreakdown(rows, p) {
    const map = new Map();
    for (const r of rows) {
      const key = r.platform + '\u0000' + r.campaign;
      if (!map.has(key)) map.set(key, { campaign: r.campaign, platform: r.platform, rows: [] });
      map.get(key).rows.push(r);
    }
    return [...map.values()].map((c) => {
      const tw = sumRange(c.rows, p.thisStart, p.thisEnd);
      const lw = sumRange(c.rows, p.lastStart, p.lastEnd);
      return { campaign: c.campaign, platform: c.platform, this: tw, last: lw, delta: deltas(tw, lw) };
    });
  }

  function maxBy(list, fn) {
    let best = null, bestV = -Infinity;
    for (const x of list) {
      const v = fn(x);
      if (v != null && isFinite(v) && v > bestV) { best = x; bestV = v; }
    }
    return best;
  }

  function analyzeClient(client, rows, T, todayNum) {
    const out = { client, rows: rows.length, status: 'nodata', findings: [], campaigns: [], series: [], platforms: [] };
    if (!rows.length) return out;

    let minDay = Infinity, maxDay = -Infinity;
    const plats = new Set();
    for (const r of rows) {
      if (r._day < minDay) minDay = r._day;
      if (r._day > maxDay) maxDay = r._day;
      plats.add(r.platform);
    }
    out.platforms = [...plats];
    const p = { thisStart: maxDay - 6, thisEnd: maxDay, lastStart: maxDay - 13, lastEnd: maxDay - 7 };
    out.period = {
      thisStart: isoFromDay(p.thisStart), thisEnd: isoFromDay(p.thisEnd),
      lastStart: isoFromDay(p.lastStart), lastEnd: isoFromDay(p.lastEnd),
      firstDate: isoFromDay(minDay), lastDate: isoFromDay(maxDay),
    };
    const tw = sumRange(rows, p.thisStart, p.thisEnd);
    const lw = sumRange(rows, p.lastStart, p.lastEnd);
    const d = deltas(tw, lw);
    out.kpis = { this: tw, last: lw, delta: d };
    out.hasLastWeek = minDay <= p.lastEnd;

    // Daily series for charts, up to 56 days.
    const byDay = new Map();
    for (const r of rows) {
      if (r._day < maxDay - 55) continue;
      if (!byDay.has(r._day)) byDay.set(r._day, blank());
      addInto(byDay.get(r._day), r);
    }
    for (let n = Math.max(minDay, maxDay - 55); n <= maxDay; n++) {
      const m = derive(byDay.get(n) || blank());
      out.series.push({ date: isoFromDay(n), spend: m.spend, conversions: m.conversions, cpa: m.cpa, revenue: m.revenue });
    }

    const camps = campaignBreakdown(rows, p);
    out.campaigns = camps.sort((a, b) => b.this.spend - a.this.spend);
    const f = out.findings;
    const add = (x) => f.push(Object.assign({ clientId: client.id, clientName: client.name }, x));

    if (!out.hasLastWeek) {
      add({ rule: 'onlyOneWeek', severity: 'info', impact: 0, impactLabel: '',
        title: 'Not enough history to compare yet',
        why: 'This client has less than two weeks of data, so week-on-week rules are paused.',
        action: 'Import at least 14 days of data to switch on the comparison rules.',
        evidence: [['First date', out.period.firstDate], ['Latest date', out.period.lastDate]] });
    }

    // 1. Tracking break
    let tracking = false;
    const tDays = T.trackingDays;
    const recent = sumRange(rows, maxDay - tDays + 1, maxDay);
    const baseline = sumRange(rows, maxDay - tDays - T.trackingBaselineDays + 1, maxDay - tDays);
    const baseDaily = baseline.conversions / T.trackingBaselineDays;
    let everyDaySpent = true;
    for (let n = maxDay - tDays + 1; n <= maxDay; n++) {
      if (!byDay.has(n) || byDay.get(n).spend <= 0) everyDaySpent = false;
    }
    if (everyDaySpent && recent.conversions === 0 && baseDaily >= T.trackingMinDailyConv) {
      tracking = true;
      add({ rule: 'tracking', severity: 'crit', impact: recent.spend, impactLabel: 'Spend with no recorded conversions',
        title: 'Conversions stopped recording',
        why: `S$${fmt2(recent.spend)} was spent over the last ${tDays} days with zero conversions, after averaging ${baseDaily.toFixed(1)} a day before that. A drop this sudden usually means tracking broke, not demand.`,
        action: 'Check the conversion pixel or tag, and any website or checkout changes made in the last few days, before touching bids or budgets.',
        evidence: [[`Spend, last ${tDays} days`, 'S$' + fmt2(recent.spend)], [`Conversions, last ${tDays} days`, '0'],
          [`Daily average, previous ${T.trackingBaselineDays} days`, baseDaily.toFixed(1)], ['Rule', `${tDays} days of spend with 0 conversions`]] });
    }

    if (out.hasLastWeek && !tracking) {
      const enoughConv = tw.conversions >= T.minConversions && lw.conversions >= T.minConversions;

      // 2. Spend up, conversions flat
      let spendUp = false;
      if (lw.spend >= T.minSpend && d.spend != null && d.spend >= T.spendUpMin &&
          (d.conversions == null || d.conversions < T.spendUpConvMax)) {
        spendUp = true;
        const drv = maxBy(camps, (c) => c.this.spend - c.last.spend);
        add({ rule: 'spendUp', severity: 'warn', impact: tw.spend - lw.spend, impactLabel: 'Extra spend vs last week',
          driver: drv && drv.campaign,
          title: 'Spend rose without more conversions',
          why: `Spend is up ${pct(d.spend)} but conversions ${d.conversions == null ? 'had no baseline' : 'moved ' + pct(d.conversions)}.` +
            (drv ? ` Most of the extra spend went to ${drv.campaign} (S$${fmt2(drv.last.spend)} to S$${fmt2(drv.this.spend)}).` : ''),
          action: drv ? `Confirm the budget increase on ${drv.campaign} was intended. If not, bring it back to about S$${fmt2(drv.last.spend / 7)} a day.`
            : 'Confirm the budget increase was intended.',
          evidence: [['Spend', `S$${fmt2(lw.spend)} to S$${fmt2(tw.spend)} (${pct(d.spend)})`],
            ['Conversions', `${fmt0(lw.conversions)} to ${fmt0(tw.conversions)}${d.conversions == null ? '' : ' (' + pct(d.conversions) + ')'}`],
            ['Rule', `spend up ${T.spendUpMin * 100}% or more, conversions up less than ${T.spendUpConvMax * 100}%`]] });
      }

      // 3. CPA up
      if (enoughConv && d.cpa != null && d.cpa >= T.cpaUpWarn && (!spendUp || d.cpa >= T.cpaUpCrit)) {
        const sev = d.cpa >= T.cpaUpCrit ? 'crit' : 'warn';
        const excess = Math.max(0, tw.spend - tw.conversions * lw.cpa);
        const drv = maxBy(camps.filter((c) => c.last.cpa != null), (c) => c.this.spend - c.this.conversions * c.last.cpa);
        const target = lw.cpa;
        add({ rule: 'cpaUp', severity: sev, impact: excess, impactLabel: 'Extra cost vs last week’s CPA', driver: drv && drv.campaign,
          title: `CPA up ${pctAbs(d.cpa)}`,
          why: `Each conversion cost S$${fmt2(tw.cpa)} this week, up from S$${fmt2(lw.cpa)}.` +
            (drv && drv.this.cpa != null ? ` The biggest driver is ${drv.campaign}, where CPA went from S$${fmt2(drv.last.cpa)} to S$${fmt2(drv.this.cpa)}.`
              : drv ? ` The biggest driver is ${drv.campaign}, which recorded no conversions this week.` : ''),
          action: drv ? `Review ${drv.campaign} first: check audience, search terms and any creative or bid changes this week, and move budget to campaigns still at or below S$${fmt2(target)} CPA.`
            : `Move budget toward campaigns still at or below S$${fmt2(target)} CPA.`,
          evidence: [['CPA', `S$${fmt2(lw.cpa)} to S$${fmt2(tw.cpa)} (${pct(d.cpa)})`],
            ['Conversions', `${fmt0(lw.conversions)} to ${fmt0(tw.conversions)}`],
            ['Rule', `CPA up ${T.cpaUpWarn * 100}% is a warning, ${T.cpaUpCrit * 100}% is critical`]] });
      }

      // 4. ROAS down
      if (lw.roas != null && tw.spend >= T.minSpend && enoughConv) {
        const dr = tw.roas == null ? -1 : d.roas;
        if (dr <= -T.roasDownWarn) {
          const sev = dr <= -T.roasDownCrit ? 'crit' : 'warn';
          const shortfall = Math.max(0, tw.spend * lw.roas - tw.revenue);
          const drv = maxBy(camps.filter((c) => c.last.roas != null), (c) => c.this.spend * c.last.roas - c.this.revenue);
          add({ rule: 'roasDown', severity: sev, impact: shortfall, impactLabel: 'Revenue below last week’s ROAS', driver: drv && drv.campaign,
            title: `ROAS down ${pctAbs(dr)}`,
            why: `Every S$1 of spend returned S$${fmt2(tw.roas || 0)} this week, down from S$${fmt2(lw.roas)}.` +
              (drv ? ` ${drv.campaign} accounts for the largest share of the shortfall.` : ''),
            action: drv ? `Check ${drv.campaign} for price, stock or landing-page changes, and hold its budget until ROAS recovers.`
              : 'Check for price, stock or landing-page changes before adding budget.',
            evidence: [['ROAS', `${fmt2(lw.roas)}× to ${fmt2(tw.roas || 0)}×`], ['Revenue', `S$${fmt2(lw.revenue)} to S$${fmt2(tw.revenue)}`],
              ['Rule', `ROAS down ${T.roasDownWarn * 100}% is a warning, ${T.roasDownCrit * 100}% is critical`]] });
        }
      }

      // 5. CTR down
      if (tw.impressions >= T.minImpressions && lw.impressions >= T.minImpressions && d.ctr != null && d.ctr <= -T.ctrDownWarn) {
        const drv = maxBy(camps.filter((c) => c.last.ctr != null && c.this.ctr != null), (c) => (c.last.ctr - c.this.ctr) * c.this.impressions);
        add({ rule: 'ctrDown', severity: 'warn', impact: drv ? drv.this.spend : tw.spend, impactLabel: 'Spend on the affected campaign', driver: drv && drv.campaign,
          title: `Click-through rate down ${pctAbs(d.ctr)}`,
          why: `CTR fell from ${pctPlain(lw.ctr)} to ${pctPlain(tw.ctr)}.` + (drv ? ` ${drv.campaign} dropped the most (${pctPlain(drv.last.ctr)} to ${pctPlain(drv.this.ctr)}), a common sign of ad fatigue.` : ''),
          action: drv ? `Rotate fresh creative into ${drv.campaign} before its CPA follows the CTR down.` : 'Rotate fresh creative into the top-spending campaigns.',
          evidence: [['CTR', `${pctPlain(lw.ctr)} to ${pctPlain(tw.ctr)}`], ['Impressions this week', fmt0(tw.impressions)],
            ['Rule', `CTR down ${T.ctrDownWarn * 100}% or more`]] });
      }

      // 6. Spend drop
      if (lw.spend >= T.minSpend && d.spend != null && d.spend <= -T.spendDropWarn) {
        const drv = maxBy(camps, (c) => c.last.spend - c.this.spend);
        add({ rule: 'spendDrop', severity: 'warn', impact: lw.spend - tw.spend, impactLabel: 'Spend below last week', driver: drv && drv.campaign,
          title: `Spend down ${pctAbs(d.spend)}`,
          why: `Spend fell from S$${fmt2(lw.spend)} to S$${fmt2(tw.spend)}.` + (drv ? ` The largest drop was on ${drv.campaign}.` : ''),
          action: 'Check whether a budget ran out, a campaign was paused, or a payment method failed.',
          evidence: [['Spend', `S$${fmt2(lw.spend)} to S$${fmt2(tw.spend)}`], ['Rule', `spend down ${T.spendDropWarn * 100}% or more`]] });
      }

      // 6b. Campaign-level CPA jump hidden inside healthy client totals
      const named = new Set(f.filter((x) => x.driver).map((x) => x.driver));
      for (const c of camps) {
        if (named.has(c.campaign) || tw.spend <= 0) continue;
        if (c.this.spend / tw.spend < T.campaignMinShare) continue;
        if (c.this.conversions < T.minConversions || c.last.conversions < T.minConversions) continue;
        if (c.delta.cpa == null || c.delta.cpa < T.campaignCpaUp) continue;
        add({ rule: 'campaignCpaUp', severity: 'warn', impact: Math.max(0, c.this.spend - c.this.conversions * c.last.cpa),
          impactLabel: 'Extra cost vs last week\u2019s CPA', driver: c.campaign,
          title: `${c.campaign}: CPA up ${pctAbs(c.delta.cpa)}`,
          why: `The client\u2019s totals look steady, but on ${c.campaign} (${PLATFORMS[c.platform] || c.platform}) each conversion cost S$${fmt2(c.this.cpa)} this week, up from S$${fmt2(c.last.cpa)}.`,
          action: `Check ${c.campaign} for audience, keyword, creative or bid changes this week, and cap its budget until CPA is back near S$${fmt2(c.last.cpa)}.`,
          evidence: [['Campaign CPA', `S$${fmt2(c.last.cpa)} to S$${fmt2(c.this.cpa)} (${pct(c.delta.cpa)})`],
            ['Share of client spend', Math.round((c.this.spend / tw.spend) * 100) + '%'],
            ['Rule', `campaign CPA up ${T.campaignCpaUp * 100}% with at least ${T.campaignMinShare * 100}% of spend`]] });
      }

      // 7. Winner
      const worrying = f.some((x) => x.severity === 'crit');
      if (!worrying && enoughConv) {
        const better = camps.filter((c) => c.this.conversions >= T.minConversions && c.last.conversions >= T.minConversions &&
          ((c.delta.roas != null && c.delta.roas >= T.winnerRoasUp) || (c.delta.cpa != null && c.delta.cpa <= -T.winnerCpaDown)));
        const best = maxBy(better, (c) => c.this.conversions * Math.max(-(c.delta.cpa || 0), c.delta.roas || 0));
        if (best) {
          const useCpa = best.delta.cpa != null && best.delta.cpa <= -T.winnerCpaDown;
          add({ rule: 'winner', severity: 'good', impact: best.this.spend, impactLabel: 'Current spend on this campaign', driver: best.campaign,
            title: `${best.campaign} is outperforming`,
            why: useCpa ? `CPA on ${best.campaign} improved from S$${fmt2(best.last.cpa)} to S$${fmt2(best.this.cpa)} on ${fmt0(best.this.conversions)} conversions.`
              : `ROAS on ${best.campaign} improved from ${fmt2(best.last.roas)}× to ${fmt2(best.this.roas)}x.`,
            action: `Consider shifting budget toward ${best.campaign} in small steps (10 to 20%) and watch whether the result holds.`,
            evidence: useCpa ? [['CPA', `S$${fmt2(best.last.cpa)} to S$${fmt2(best.this.cpa)} (${pct(best.delta.cpa)})`], ['Rule', `CPA down ${T.winnerCpaDown * 100}% or more`]]
              : [['ROAS', `${fmt2(best.last.roas)}× to ${fmt2(best.this.roas)}× (${pct(best.delta.roas)})`], ['Rule', `ROAS up ${T.winnerRoasUp * 100}% or more`]] });
        }
      }
    }

    // 8. Stale data
    if (todayNum - maxDay > T.staleDays) {
      add({ rule: 'stale', severity: 'warn', impact: 0, impactLabel: '',
        title: `Data is ${todayNum - maxDay} days old`,
        why: `The latest row for this client is from ${out.period.lastDate}, so this brief describes an older week.`,
        action: 'Export the latest report from each ad platform and import it again.',
        evidence: [['Latest date', out.period.lastDate], ['Rule', `more than ${T.staleDays} days old`]] });
    }

    f.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.impact - a.impact);
    out.status = f.some((x) => x.severity === 'crit') ? 'risk' : f.some((x) => x.severity === 'warn') ? 'watch' : 'good';
    return out;
  }

  function analyze(data, opts) {
    opts = opts || {};
    const T = Object.assign({}, THRESHOLDS, opts.thresholds || {});
    const todayNum = dayNum(opts.today || todayISO());
    const clients = (data && data.clients) || [];
    const byClient = new Map(clients.map((c) => [c.id, []]));
    for (const r of (data && data.rows) || []) {
      if (!byClient.has(r.clientId)) continue;
      byClient.get(r.clientId).push(Object.assign({ _day: dayNum(r.date) }, r));
    }
    const results = clients.map((c) => analyzeClient(c, byClient.get(c.id), T, todayNum));
    const counts = { risk: 0, watch: 0, good: 0, nodata: 0 };
    const tw = blank(), lw = blank();
    let latest = null;
    for (const r of results) {
      counts[r.status]++;
      if (r.kpis) { addInto(tw, r.kpis.this); addInto(lw, r.kpis.last); }
      if (r.period && (!latest || r.period.thisEnd > latest.thisEnd)) latest = r.period;
    }
    const all = [].concat(...results.map((r) => r.findings));
    const alerts = all.filter((x) => x.severity === 'crit' || x.severity === 'warn')
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.impact - a.impact);
    const actions = all.filter((x) => x.severity !== 'info')
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.impact - a.impact);
    const twD = derive(tw), lwD = derive(lw);
    // ROAS across the agency only divides by spend from clients that report revenue.
    const tracked = (wk) => results.filter((r) => r.kpis && r.kpis[wk].revenue > 0).reduce((a, r) => a + r.kpis[wk].spend, 0);
    const tSpend = tracked('this'), lSpend = tracked('last');
    twD.roas = tSpend > 0 ? tw.revenue / tSpend : null;
    lwD.roas = lSpend > 0 ? lw.revenue / lSpend : null;
    return {
      clients: results,
      counts,
      alerts,
      actions,
      period: latest,
      totals: { this: twD, last: lwD, delta: deltas(twD, lwD) },
      thresholds: T,
    };
  }

  /* ---------- small formatters used inside rule text ---------- */

  function fmt2(n) {
    return (n || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmt0(n) {
    return Math.round(n || 0).toLocaleString('en-SG');
  }
  function pct(p) {
    return (p > 0 ? '+' : '') + (p * 100).toFixed(1) + '%';
  }
  function pctAbs(p) {
    return (Math.abs(p) * 100).toFixed(1) + '%';
  }
  function pctPlain(p) {
    return p == null ? 'n/a' : (p * 100).toFixed(2) + '%';
  }

  /* ---------- CSV import ---------- */

  const FIELDS = ['date', 'campaign', 'spend', 'impressions', 'clicks', 'conversions', 'revenue'];
  const FIELD_LABELS = { date: 'Date', campaign: 'Campaign', spend: 'Spend', impressions: 'Impressions', clicks: 'Clicks', conversions: 'Conversions', revenue: 'Revenue' };
  const REQUIRED = ['date', 'spend'];

  // Header names as the platforms tend to write them. These are approximations of
  // each platform's export format, not a verified specification.
  const SYNONYMS = {
    date: ['date', 'day', 'reporting starts', 'reporting start', 'start date', 'start date (in utc)', 'stat time', 'report date', 'time'],
    campaign: ['campaign name', 'campaign', 'ad name', 'campaign group name', 'ad group', 'ad group name'],
    spend: ['amount spent', 'cost', 'spend', 'expense', 'total spent', 'total cost', 'ad spend'],
    impressions: ['impressions', 'impr.', 'impr', 'views'],
    clicks: ['link clicks', 'clicks', 'clicks (destination)', 'clicks (all)'],
    conversions: ['conversions', 'purchases', 'results', 'orders', 'conversion', 'items sold', 'leads', 'total conversions'],
    revenue: ['conv. value', 'conversion value', 'purchases conversion value', 'purchase conversion value', 'gmv', 'revenue',
      'total purchase value', 'sales', 'total conversion value', 'store revenue'],
  };

  function normHeader(h) {
    return String(h == null ? '' : h).replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  function stripParens(h) {
    // "Amount spent (SGD)" -> "amount spent"; keeps "(in utc)" style parts that are in the synonym list.
    return h.replace(/\s*\((sgd|usd|myr|idr|php|thb|vnd|eur|gbp|aud)\)\s*$/i, '').trim();
  }
  function currencyOf(headers) {
    for (const h of headers) {
      const m = normHeader(h).match(/\((sgd|usd|myr|idr|php|thb|vnd|eur|gbp|aud)\)/i);
      if (m) return m[1].toUpperCase();
    }
    return null;
  }

  function matchColumns(headers) {
    const norm = headers.map((h) => stripParens(normHeader(h)));
    const mapping = {};
    const used = new Set();
    // Pass 1: exact synonym match, in synonym priority order.
    for (const field of FIELDS) {
      for (const syn of SYNONYMS[field]) {
        const i = norm.findIndex((h, idx) => !used.has(idx) && h === syn);
        if (i >= 0) { mapping[field] = i; used.add(i); break; }
      }
    }
    // Pass 2: header starts with a synonym (e.g. "Clicks (all)" or "Amount spent (MYR)").
    for (const field of FIELDS) {
      if (mapping[field] != null) continue;
      for (const syn of SYNONYMS[field]) {
        if (syn.length < 4) continue;
        const i = norm.findIndex((h, idx) => !used.has(idx) && h.startsWith(syn));
        if (i >= 0) { mapping[field] = i; used.add(i); break; }
      }
    }
    return mapping;
  }

  function detectPlatform(headers) {
    const h = headers.map(normHeader);
    const has = (x) => h.includes(x);
    const starts = (x) => h.some((v) => v.startsWith(x));
    if (starts('amount spent') || has('reporting starts')) return 'meta';
    if (has('impr.') || has('conv. value') || has('avg. cpc')) return 'google';
    if (has('clicks (destination)') || has('stat time')) return 'tiktok';
    if (has('expense') && has('gmv')) return 'shopee';
    if (has('store revenue') || (has('sponsored solution') && has('orders'))) return 'lazada';
    if (has('total spent') || starts('start date (in utc)') || has('campaign group name')) return 'linkedin';
    return 'csv';
  }

  // Ad platforms often put title rows above the real header (Google Ads does).
  function findHeaderRow(table) {
    const limit = Math.min(table.length, 12);
    for (let i = 0; i < limit; i++) {
      const m = matchColumns(table[i] || []);
      const hits = Object.keys(m).length;
      if (hits >= 2 && (m.date != null || m.spend != null)) return i;
    }
    return -1;
  }

  function isTotalRow(cells) {
    const first = String(cells.find((c) => String(c).trim() !== '') || '').trim().toLowerCase();
    return /^(grand )?totals?\b/.test(first) || /^total:/.test(first);
  }

  // Turns a parsed CSV (array of rows) into import-ready records, or a readable error.
  function buildImport(table, opts) {
    opts = opts || {};
    const rowsIn = (table || []).filter((r) => Array.isArray(r) && r.some((c) => String(c).trim() !== ''));
    if (!rowsIn.length) {
      return { ok: false, error: 'empty', title: 'This file is empty.',
        fix: 'Export the report again from your ad platform and make sure the date range contains at least one day of activity.' };
    }
    let headerIndex = opts.headerIndex != null ? opts.headerIndex : findHeaderRow(rowsIn);
    const guessed = headerIndex < 0;
    if (guessed) headerIndex = 0;
    const headers = rowsIn[headerIndex].map((h) => String(h).trim());
    const body = rowsIn.slice(headerIndex + 1);
    const mapping = opts.mapping ? Object.assign({}, opts.mapping) : matchColumns(headers);
    const platform = opts.platform || detectPlatform(headers);
    const base = { headers, headerIndex, mapping, platform, currency: currencyOf(headers), dataRows: body.length };

    if (!body.length) {
      return Object.assign(base, { ok: false, error: 'noRows', title: 'This file has column headers but no data rows.',
        fix: 'Check the date range in your ad platform covers days with spend, then export again.' });
    }
    if (mapping.date == null) {
      return Object.assign(base, { ok: false, error: 'nodate', title: 'We couldn’t find a date column in this file.',
        fix: 'Sightline needs one row per day. In your ad platform, add a daily breakdown (a Day or Date column) to the report and export again. If the file already has a date column under another name, pick it below.' });
    }
    if (mapping.spend == null) {
      return Object.assign(base, { ok: false, error: 'nospend', title: 'We couldn’t find a spend or cost column.',
        fix: 'Add Amount spent or Cost to the report and export again, or pick the right column below.' });
    }

    const agg = new Map();
    let skipped = 0, badDates = 0;
    let minD = null, maxD = null;
    const get = (cells, f) => (mapping[f] == null ? undefined : cells[mapping[f]]);
    for (const cells of body) {
      if (isTotalRow(cells)) { skipped++; continue; }
      const date = parseDate(get(cells, 'date'));
      if (!date) { skipped++; badDates++; continue; }
      const spend = parseNumber(get(cells, 'spend'));
      if (spend == null) { skipped++; continue; }
      const campaign = String(get(cells, 'campaign') == null ? '' : get(cells, 'campaign')).trim() || '(no campaign name)';
      const rec = {
        date, campaign, spend,
        impressions: parseNumber(get(cells, 'impressions')) || 0,
        clicks: parseNumber(get(cells, 'clicks')) || 0,
        conversions: parseNumber(get(cells, 'conversions')) || 0,
        revenue: parseNumber(get(cells, 'revenue')) || 0,
      };
      const key = date + '\u0000' + campaign;
      if (agg.has(key)) addInto(agg.get(key), rec);
      else agg.set(key, rec);
      if (!minD || date < minD) minD = date;
      if (!maxD || date > maxD) maxD = date;
    }
    const records = [...agg.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.campaign.localeCompare(b.campaign)));
    if (!records.length) {
      return Object.assign(base, { ok: false, error: badDates ? 'baddates' : 'norecords',
        title: badDates ? 'The date column doesn’t contain dates we can read.' : 'No usable rows were found.',
        fix: badDates ? 'Dates should look like 2026-09-01, 01/09/2026 or 1 Sep 2026. Check you picked the right column below.'
          : 'Check that the spend column contains numbers, then export again.', skipped });
    }
    return Object.assign(base, { ok: true, records, skipped, dateRange: [minD, maxD] });
  }

  // Adds records for one client and platform. Same client, platform, date and campaign replaces the old row.
  function upsertRows(db, records, clientId, platform, importId) {
    const index = new Map();
    db.rows.forEach((r, i) => index.set(r.clientId + '|' + r.platform + '|' + r.date + '|' + r.campaign, i));
    let added = 0, updated = 0;
    for (const rec of records) {
      const row = Object.assign({ clientId, platform, importId }, rec);
      const key = clientId + '|' + platform + '|' + rec.date + '|' + rec.campaign;
      if (index.has(key)) { db.rows[index.get(key)] = row; updated++; }
      else { index.set(key, db.rows.length); db.rows.push(row); added++; }
    }
    return { added, updated };
  }

  /* ---------- demo data ---------- */

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fictional agency and clients. Each client has a scenario so every health state appears.
  const DEMO_CLIENTS = [
    { id: 'demo-kiln', name: 'Kiln & Clay Ceramics Studio', series: [
      { platform: 'meta', campaign: 'Prospecting | Workshops', spend: 180, cpm: 9, ctr: 0.014, cvr: 0.05, aov: 95 },
      { platform: 'google', campaign: 'Search | Pottery classes', spend: 140, cpm: 40, ctr: 0.06, cvr: 0.07, aov: 95, mod: 'cpaSpike' },
    ] },
    { id: 'demo-orbit', name: 'Orbit Fitness Collective', series: [
      { platform: 'meta', campaign: 'Trial pass | Lookalike', spend: 220, cpm: 8, ctr: 0.012, cvr: 0.06, aov: 0, mod: 'spendSurge' },
      { platform: 'tiktok', campaign: 'Spark ads | 30-day challenge', spend: 120, cpm: 5, ctr: 0.009, cvr: 0.035, aov: 0 },
    ] },
    { id: 'demo-marigold', name: 'Marigold Baby & Kids', series: [
      { platform: 'shopee', campaign: 'Keyword ads | Diapers', spend: 150, cpm: 6, ctr: 0.03, cvr: 0.06, aov: 48, mod: 'ctrFatigue' },
      { platform: 'meta', campaign: 'Catalogue | Retargeting', spend: 170, cpm: 12, ctr: 0.018, cvr: 0.05, aov: 62 },
    ] },
    { id: 'demo-pinecrest', name: 'Pinecrest Legal Advisory', series: [
      { platform: 'linkedin', campaign: 'Lead gen | HR directors', spend: 160, cpm: 60, ctr: 0.008, cvr: 0.12, aov: 0 },
      { platform: 'google', campaign: 'Search | Employment law', spend: 190, cpm: 45, ctr: 0.05, cvr: 0.06, aov: 0 },
    ] },
    { id: 'demo-saltwater', name: 'Saltwater Surf Supply', series: [
      { platform: 'google', campaign: 'Shopping | Wetsuits', spend: 200, cpm: 14, ctr: 0.02, cvr: 0.04, aov: 140, mod: 'winner' },
      { platform: 'lazada', campaign: 'Sponsored discovery | Boards', spend: 110, cpm: 7, ctr: 0.022, cvr: 0.035, aov: 180 },
    ] },
    { id: 'demo-tiongbahru', name: 'The Tiong Bahru Heritage Bakery and Neighbourhood Café Collective', series: [
      { platform: 'meta', campaign: 'Always-on | Weekend brunch reservations and mooncake pre-orders', spend: 130, cpm: 10, ctr: 0.016, cvr: 0.06, aov: 38, mod: 'tracking' },
      { platform: 'google', campaign: 'Search | Bakery near me', spend: 90, cpm: 35, ctr: 0.07, cvr: 0.08, aov: 32, mod: 'tracking' },
    ] },
  ];

  function buildDemo(endISO) {
    const rand = mulberry32(20260906);
    const end = dayNum(endISO || todayISO());
    const days = 56;
    const rows = [];
    const noise = (amt) => 1 + (rand() * 2 - 1) * amt;
    for (const c of DEMO_CLIENTS) {
      for (const s of c.series) {
        for (let i = 0; i < days; i++) {
          const n = end - days + 1 + i;
          const lastWeek = n > end - 7;
          const last3 = n > end - 3;
          let spend = s.spend * noise(0.12), ctr = s.ctr * noise(0.08), cvr = s.cvr * noise(0.1), aov = s.aov * noise(0.06);
          if (lastWeek && s.mod === 'cpaSpike') cvr *= 0.55;
          if (lastWeek && s.mod === 'spendSurge') { spend *= 1.55; cvr *= 0.6; }
          if (lastWeek && s.mod === 'ctrFatigue') { ctr *= 0.62; cvr *= 1.4; }
          if (lastWeek && s.mod === 'winner') cvr *= 1.45;
          const impressions = Math.round((spend / s.cpm) * 1000);
          const clicks = Math.round(impressions * ctr);
          let conversions = Math.round(clicks * cvr + (rand() - 0.5));
          if (conversions < 0) conversions = 0;
          if (last3 && s.mod === 'tracking') conversions = 0;
          const revenue = s.aov ? Math.round(conversions * aov * 100) / 100 : 0;
          rows.push({ clientId: c.id, platform: s.platform, date: isoFromDay(n), campaign: s.campaign,
            spend: Math.round(spend * 100) / 100, impressions, clicks, conversions, revenue, importId: 'demo' });
        }
      }
    }
    return {
      version: 1,
      agency: { name: 'Sample Agency' },
      clients: DEMO_CLIENTS.map((c) => ({ id: c.id, name: c.name, createdAt: isoFromDay(end - days + 1) })),
      rows,
      imports: [],
      isDemo: true,
    };
  }

  root.SightlineEngine = {
    THRESHOLDS, PLATFORMS, FIELDS, FIELD_LABELS, REQUIRED,
    analyze, buildDemo, buildImport, upsertRows, matchColumns, detectPlatform, findHeaderRow,
    parseDate, parseNumber, pctChange, dayNum, isoFromDay, todayISO,
  };
})(typeof window !== 'undefined' ? window : globalThis);
