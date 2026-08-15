import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";

// --- Utility Functions ---

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatCost(n) {
  if (!n) return '$0.00';
  if (n >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

function formatDuration(ms) {
  if (!ms) return '0m';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return totalMin + 'm';
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (mins === 0) return hours + 'h';
  return hours + 'h ' + mins + 'm';
}

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day} ${hours}:${mins}`;
}

function shortModel(model) {
  if (!model) return '-';
  const FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'mythos']);
  const parts = model.split('-').filter(p => p !== 'claude' && !/^\d{8}$/.test(p)); // drop 'claude' and date suffixes like 20251001
  const family = parts.find(p => FAMILIES.has(p));
  const nums = parts.filter(p => /^\d+$/.test(p));
  if (!family) return model;
  const name = family[0].toUpperCase() + family.slice(1);
  return nums.length ? `${name} ${nums.join('.')}` : name;
}

function shortDate(dateStr) {
  // 'YYYY-MM-DD' -> 'M/D'
  const [, m, d] = dateStr.split('-');
  return `${Number.parseInt(m)}/${Number.parseInt(d)}`;
}

// Accessibility props for clickable non-form elements: keyboard activation +
// button role so they work for screen readers and tabbing.
function clickableProps(onActivate) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate(e);
      }
    },
  };
}

// --- Chart Components ---

// Show every label for short ranges, thin them out as the range grows.
function labelIntervalFor(count) {
  if (count > 30) return 7;
  if (count > 15) return 3;
  return 1;
}

// mode 'point' maps x to the nearest of `count` evenly-spaced points (plotW / (count-1)
// spacing) — matches charts that plot vertices, e.g. LineChart/ModelChart.
// mode 'band' maps x to the band it falls in (plotW / count spacing) — matches charts
// that render bars centered in equal-width bands, e.g. MonthlySpendChart. Using 'point'
// mode against a bar chart systematically misattributes x positions near band edges,
// since bar centers (plotW/count spacing) don't line up with point positions
// (plotW/(count-1) spacing).
function useDragSelect(padL, plotW, count, onDone, { mode = 'point' } = {}) {
  const [drag, setDrag] = useState(null); // {x0, x1} in viewBox units
  const toIdx = (x) => mode === 'band'
    ? Math.max(0, Math.min(count - 1, Math.floor((x - padL) / (plotW / count))))
    : Math.max(0, Math.min(count - 1, Math.round(((x - padL) / plotW) * (count - 1))));
  const vbX = (e) => {
    const svg = e.currentTarget.ownerSVGElement || e.currentTarget;
    const ctm = svg.getScreenCTM();
    if (!ctm) return 0;
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse()).x;
  };
  return {
    drag,
    onMouseDown: (e) => setDrag({ x0: vbX(e), x1: vbX(e) }),
    onMouseMove: (e) => drag && setDrag({ ...drag, x1: vbX(e) }),
    onMouseUp: () => {
      if (drag && Math.abs(drag.x1 - drag.x0) > 4 && count > 1) {
        const [a, b] = [toIdx(Math.min(drag.x0, drag.x1)), toIdx(Math.max(drag.x0, drag.x1))];
        onDone(a, b);
      }
      setDrag(null);
    },
    onCancel: () => setDrag(null),
  };
}

function LineChart({ data, title, onSelectRange }) {
  const [tooltip, setTooltip] = useState(null);

  const W = 500, H = 100, padL = 56, padR = 10, padT = 5, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const ds = useDragSelect(padL, plotW, data ? data.length : 0, (a, b) => onSelectRange(data[a].date, data[b].date));

  if (!data || data.length === 0) return null;

  const maxTokens = Math.max(...data.map(d => d.tokens), 1);
  const maxCost = Math.max(...data.map(d => d.cost), 0.01);

  const xAt = (i) => padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const yTokens = (v) => padT + plotH - (v / maxTokens) * plotH;
  const yCost = (v) => padT + plotH - (v / maxCost) * plotH;

  // Build SVG path (smooth curve via catmull-rom-ish approach, or just polyline)
  const tokenPoints = data.map((d, i) => `${xAt(i)},${yTokens(d.tokens)}`);
  const costPoints = data.map((d, i) => `${xAt(i)},${yCost(d.cost)}`);

  const tokenLine = tokenPoints.join(' ');
  const costLine = costPoints.join(' ');

  // Area fill paths
  const tokenArea = `M${tokenPoints[0]} ${tokenPoints.join(' L')} L${xAt(data.length - 1)},${padT + plotH} L${padL},${padT + plotH} Z`;
  const costArea = `M${costPoints[0]} ${costPoints.join(' L')} L${xAt(data.length - 1)},${padT + plotH} L${padL},${padT + plotH} Z`;

  // Y-axis ticks for tokens (kept low so the larger label font doesn't crowd gridlines)
  const yTicks = 3;
  const tokenStep = maxTokens / yTicks;

  const labelInterval = labelIntervalFor(data.length);

  return (
    <div className="chart-wrapper">
      <div className="chart-header">
        <div className="chart-title">{title}</div>
        <div className="chart-legend">
          <span className="legend-item">
            <span className="legend-dot" style={{background: '#ff6b35'}}></span> tokens
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{background: '#4da6ff'}}></span> cost
          </span>
        </div>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
        onMouseDown={ds.onMouseDown} onMouseMove={ds.onMouseMove} onMouseUp={ds.onMouseUp}
        onMouseLeave={() => { setTooltip(null); ds.onCancel(); }}>
        {/* Y-axis gridlines + labels */}
        {Array.from({length: yTicks + 1}, (_, i) => {
          const val = tokenStep * i;
          const y = yTokens(val);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--border)" strokeWidth="0.5" />
              <text x={padL - 4} y={y + 3} textAnchor="end" className="chart-axis-label">
                {formatTokens(val)}
              </text>
            </g>
          );
        })}
        {/* Token area + line */}
        <path d={tokenArea} fill="#ff6b35" opacity="0.1" />
        <polyline points={tokenLine} fill="none" stroke="#ff6b35" strokeWidth="1.5" />
        {data.map((d, i) => (
          <circle key={d.date} cx={xAt(i)} cy={yTokens(d.tokens)} r="2.5" fill="#ff6b35"
            onMouseEnter={(e) => setTooltip({
              x: e.clientX, y: e.clientY,
              text: `${shortDate(d.date)}: ${formatTokens(d.tokens)} tokens, ${formatCost(d.cost)} (${d.sessions} sessions)`
            })}
          />
        ))}
        {/* Cost area + line */}
        <path d={costArea} fill="#4da6ff" opacity="0.08" />
        <polyline points={costLine} fill="none" stroke="#4da6ff" strokeWidth="1.5" strokeDasharray="3,2" />
        {data.map((d, i) => (
          <circle key={d.date} cx={xAt(i)} cy={yCost(d.cost)} r="2" fill="#4da6ff"
            onMouseEnter={(e) => setTooltip({
              x: e.clientX, y: e.clientY,
              text: `${shortDate(d.date)}: ${formatCost(d.cost)} cost, ${formatTokens(d.tokens)} tokens`
            })}
          />
        ))}
        {/* X-axis labels */}
        {data.map((d, i) => (
          i % labelInterval === 0 ? (
            <text key={d.date} x={xAt(i)} y={H - 2} textAnchor="middle" className="chart-label">
              {shortDate(d.date)}
            </text>
          ) : null
        ))}
        {ds.drag && <rect x={Math.min(ds.drag.x0, ds.drag.x1)} y={padT} width={Math.abs(ds.drag.x1 - ds.drag.x0)} height={plotH} fill="var(--blue)" opacity="0.15" stroke="var(--blue)" strokeWidth="0.5" />}
      </svg>
      {tooltip && (
        <div className="chart-tooltip" style={{ left: tooltip.x + 10, top: tooltip.y - 30 }}>
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

// Model display names (from shortModel) that don't match a known family fall
// back to the raw model id and are grouped into "Other" rather than dropped.
const MODEL_FAMILY_ORDER = new Set(['fable', 'mythos', 'opus', 'sonnet', 'haiku']);

const MODEL_EXACT_COLORS = {
  'Fable 5': '#b57bff',
  'Mythos': '#e0aaff',
  'Opus 5': '#ff6b35',
  'Opus 4.6': '#cc4f22',
  'Sonnet 5': '#4da6ff',
  'Sonnet 4.6': '#2d6abf',
  'Sonnet 4.5': '#7fc0ff',
  'Haiku 4.5': '#00cc6a',
};

const MODEL_FAMILY_SHADES = {
  fable: ['#b57bff', '#9a5eef', '#7d43df'],
  mythos: ['#e0aaff', '#c98ef0', '#b072e0'],
  opus: ['#ff6b35', '#cc4f22', '#995533'],
  sonnet: ['#4da6ff', '#2d6abf', '#7fc0ff'],
  haiku: ['#00cc6a', '#00995a', '#007a48'],
};

const MODEL_OTHER_COLOR = '#7a8a9e';

function modelFamily(displayName) {
  const first = displayName.split(' ')[0].toLowerCase();
  return MODEL_FAMILY_ORDER.has(first) ? first : null;
}

function modelVersion(displayName) {
  const m = displayName.match(/[\d.]+/);
  return m ? Number.parseFloat(m[0]) : 0;
}

// Deterministic stack order: family order (Fable, Mythos, Opus, Sonnet, Haiku),
// newest version first within a family, unclassified names ("Other") last.
function buildModelOrder(names) {
  const byFamily = {};
  const other = [];
  for (const n of names) {
    const fam = modelFamily(n);
    if (!fam) {
      other.push(n);
      continue;
    }
    if (!byFamily[fam]) byFamily[fam] = [];
    byFamily[fam].push(n);
  }
  const order = [];
  for (const fam of MODEL_FAMILY_ORDER) {
    if (byFamily[fam]) order.push(...byFamily[fam].slice().sort((a, b) => modelVersion(b) - modelVersion(a)));
  }
  order.push(...other.toSorted((a, b) => a.localeCompare(b)));
  return order;
}

// Exact display-name match first, else a shade cycled by family, else gray.
function buildModelColors(names) {
  const colors = {};
  const remaining = [];
  for (const n of names) {
    if (MODEL_EXACT_COLORS[n]) colors[n] = MODEL_EXACT_COLORS[n];
    else remaining.push(n);
  }
  const byFamily = {};
  for (const n of remaining) {
    const fam = modelFamily(n);
    if (!fam) { colors[n] = MODEL_OTHER_COLOR; continue; }
    if (!byFamily[fam]) byFamily[fam] = [];
    byFamily[fam].push(n);
  }
  for (const [fam, list] of Object.entries(byFamily)) {
    const sorted = list.slice().sort((a, b) => modelVersion(b) - modelVersion(a));
    const shades = MODEL_FAMILY_SHADES[fam] || [MODEL_OTHER_COLOR];
    sorted.forEach((n, i) => { colors[n] = shades[Math.min(i, shades.length - 1)]; });
  }
  return colors;
}

function ModelChart({ data, title, onSelectRange }) {
  const [tooltip, setTooltip] = useState(null);

  const W = 500, H = 100, padL = 36, padR = 10, padT = 5, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const ds = useDragSelect(padL, plotW, data ? data.length : 0, (a, b) => onSelectRange(data[a].date, data[b].date));

  if (!data || data.length === 0) return null;

  // Display name for a raw model id; anything shortModel can't classify
  // (returns the raw id unchanged) is grouped into "Other" instead of dropped.
  const displayModel = (m) => {
    const name = shortModel(m);
    return name === m ? 'Other' : name;
  };

  const allNames = new Set();
  for (const d of data) {
    for (const model of Object.keys(d.models || {})) allNames.add(displayModel(model));
  }
  const modelOrder = buildModelOrder([...allNames]); // bottom to top for stacking
  const modelColors = buildModelColors(modelOrder);

  const processed = data.map(d => {
    const byModel = {};
    let total = 0;
    for (const [model, tokens] of Object.entries(d.models || {})) {
      const name = displayModel(model);
      byModel[name] = (byModel[name] || 0) + tokens;
      total += tokens;
    }
    const pcts = {};
    for (const m of modelOrder) {
      pcts[m] = total > 0 ? (byModel[m] || 0) / total * 100 : 0;
    }
    return { ...d, pcts, total };
  });

  const xAt = (i) => padL + (processed.length === 1 ? plotW / 2 : (i / (processed.length - 1)) * plotW);
  const yAt = (pct) => padT + plotH - (pct / 100) * plotH;

  // Build stacked area paths
  const areas = {};
  const lines = {};
  for (const model of modelOrder) {
    const points = processed.map((d, i) => {
      // Cumulative percentage up to and including this model
      let cumBelow = 0;
      for (const m of modelOrder) {
        if (m === model) break;
        cumBelow += d.pcts[m];
      }
      const cumTop = cumBelow + d.pcts[model];
      return { x: xAt(i), yTop: yAt(cumTop), yBot: yAt(cumBelow) };
    });

    const topLine = points.map(p => `${p.x},${p.yTop}`).join(' L');
    const botLine = points.slice().reverse().map(p => `${p.x},${p.yBot}`).join(' L');
    areas[model] = `M${topLine} L${botLine} Z`;
    lines[model] = points.map(p => `${p.x},${p.yTop}`).join(' ');
  }

  const labelInterval = labelIntervalFor(data.length);

  return (
    <div className="chart-wrapper">
      <div className="chart-header">
        <div className="chart-title">{title}</div>
        <div className="chart-legend">
          {modelOrder.map(m => (
            <span className="legend-item" key={m}>
              <span className="legend-dot" style={{background: modelColors[m]}}></span>
              {m}
            </span>
          ))}
        </div>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
        onMouseDown={ds.onMouseDown} onMouseMove={ds.onMouseMove} onMouseUp={ds.onMouseUp}
        onMouseLeave={() => { setTooltip(null); ds.onCancel(); }}>
        {/* Y-axis gridlines */}
        {[0, 50, 100].map(pct => (
          <g key={pct}>
            <line x1={padL} y1={yAt(pct)} x2={W - padR} y2={yAt(pct)} stroke="var(--border)" strokeWidth="0.5" />
            <text x={padL - 4} y={yAt(pct) + 3} textAnchor="end" className="chart-axis-label">
              {pct}%
            </text>
          </g>
        ))}
        {/* Stacked areas */}
        {modelOrder.map(model => (
          <path key={model} d={areas[model]} fill={modelColors[model]} opacity="0.25" />
        ))}
        {/* Lines on top */}
        {modelOrder.map(model => (
          <polyline key={`l-${model}`} points={lines[model]} fill="none" stroke={modelColors[model]} strokeWidth="1" />
        ))}
        {/* Hover targets */}
        {processed.map((d, i) => (
          <rect key={d.date} x={xAt(i) - (plotW / processed.length / 2)} y={padT} width={plotW / processed.length} height={plotH}
            fill="transparent" cursor="pointer"
            onMouseEnter={(e) => {
              const parts = modelOrder
                .filter(m => d.pcts[m] > 0)
                .map(m => `${m}: ${d.pcts[m].toFixed(0)}%`);
              setTooltip({
                x: e.clientX, y: e.clientY,
                text: `${shortDate(d.date)}: ${parts.join(', ')} (${formatTokens(d.total)} tokens)`
              });
            }}
          />
        ))}
        {/* X-axis labels */}
        {data.map((d, i) => (
          i % labelInterval === 0 ? (
            <text key={d.date} x={xAt(i)} y={H - 2} textAnchor="middle" className="chart-label">
              {shortDate(d.date)}
            </text>
          ) : null
        ))}
        {ds.drag && <rect x={Math.min(ds.drag.x0, ds.drag.x1)} y={padT} width={Math.abs(ds.drag.x1 - ds.drag.x0)} height={plotH} fill="var(--blue)" opacity="0.15" stroke="var(--blue)" strokeWidth="0.5" />}
      </svg>
      {tooltip && (
        <div className="chart-tooltip" style={{ left: tooltip.x + 10, top: tooltip.y - 30 }}>
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

function MonthlySpendChart({ data, title, onSelectRange }) {
  const [tooltip, setTooltip] = useState(null);

  const W = 500, H = 100, padL = 46, padR = 10, padT = 10, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
  const ds = useDragSelect(padL, plotW, data ? data.length : 0, (a, b) => onSelectRange(`${data[a].month}-01`, lastDay(data[b].month)), { mode: 'band' });

  if (!data || data.length === 0) return null;

  const maxCost = Math.max(...data.map(d => d.cost), 150); // At least 150 so $100 line is visible
  const yScale = (v) => padT + plotH - (v / maxCost) * plotH;

  const barWidth = Math.min(plotW / data.length * 0.6, 40);
  const barGap = plotW / data.length;

  const xAt = (i) => padL + barGap * i + barGap / 2;

  // Y-axis ticks — target ~4 gridlines regardless of scale so the larger label
  // font (needed to hit the 11px effective floor) doesn't crowd the axis.
  const niceStep = (raw) => {
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / magnitude;
    let niceNorm;
    if (norm <= 1) niceNorm = 1;
    else if (norm <= 2) niceNorm = 2;
    else if (norm <= 5) niceNorm = 5;
    else niceNorm = 10;
    return niceNorm * magnitude;
  };
  const yStep = niceStep(maxCost / 4);
  const yTicks = [];
  for (let v = 0; v <= maxCost; v += yStep) yTicks.push(v);

  // Format month label
  const monthLabel = (m) => {
    const [y, mo] = m.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return data.length > 12 ? `${months[Number.parseInt(mo) - 1]} '${y.slice(2)}` : months[Number.parseInt(mo) - 1];
  };

  return (
    <div className="chart-wrapper">
      <div className="chart-header">
        <div className="chart-title">{title}</div>
        <div className="chart-legend">
          <span className="legend-item">
            <span className="legend-dot" style={{background: 'var(--amber)'}}></span> spend
          </span>
          <span className="legend-item" style={{color: 'var(--green)'}}>--- $100/mo Max Plan</span>
        </div>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
        onMouseDown={ds.onMouseDown} onMouseMove={ds.onMouseMove} onMouseUp={ds.onMouseUp}
        onMouseLeave={() => { setTooltip(null); ds.onCancel(); }}>
        {/* Y-axis gridlines + labels */}
        {yTicks.map(v => (
          <g key={v}>
            <line x1={padL} y1={yScale(v)} x2={W - padR} y2={yScale(v)} stroke="var(--border)" strokeWidth="0.5" />
            <text x={padL - 4} y={yScale(v) + 3} textAnchor="end" className="chart-axis-label">
              ${v}
            </text>
          </g>
        ))}
        {/* $100 reference line */}
        <line x1={padL} y1={yScale(100)} x2={W - padR} y2={yScale(100)}
          stroke="var(--green)" strokeWidth="1" strokeDasharray="4,3" />
        <text x={W - padR + 2} y={yScale(100) + 3} className="chart-axis-label" fill="var(--green)" textAnchor="start" style={{fontSize: '7px'}}>
          $100
        </text>
        {/* Bars */}
        {data.map((d, i) => {
          const barH = (d.cost / maxCost) * plotH;
          return (
            <g key={d.month}>
              <rect
                x={xAt(i) - barWidth / 2}
                y={yScale(d.cost)}
                width={barWidth}
                height={barH}
                fill="var(--amber)"
                opacity="0.6"
                rx="1"
                onMouseEnter={(e) => setTooltip({
                  x: e.clientX, y: e.clientY,
                  text: `${monthLabel(d.month)} ${d.month.split('-')[0]}: ${formatCost(d.cost)} (${d.sessions} sessions)`
                })}
              />
              {/* Value label above bar */}
              <text x={xAt(i)} y={yScale(d.cost) - 2} textAnchor="middle"
                className="chart-axis-label" fill="var(--amber)" style={{fontSize: '7.5px', fontWeight: 600}}>
                {formatCost(d.cost)}
              </text>
            </g>
          );
        })}
        {/* X-axis labels */}
        {data.map((d, i) => (
          <text key={d.month} x={xAt(i)} y={H - 2} textAnchor="middle" className="chart-label">
            {monthLabel(d.month)}
          </text>
        ))}
        {ds.drag && <rect x={Math.min(ds.drag.x0, ds.drag.x1)} y={padT} width={Math.abs(ds.drag.x1 - ds.drag.x0)} height={plotH} fill="var(--blue)" opacity="0.15" stroke="var(--blue)" strokeWidth="0.5" />}
      </svg>
      {tooltip && (
        <div className="chart-tooltip" style={{ left: tooltip.x + 10, top: tooltip.y - 30 }}>
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

function ChartsPanel({ dailyStats, monthlyStats, onSelectRange }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      <div className="charts-toggle" {...clickableProps(() => setCollapsed(!collapsed))}>
        <span className={`charts-toggle-arrow ${collapsed ? 'collapsed' : ''}`}>▼</span>
        <span>DAILY ACTIVITY</span>
      </div>
      {!collapsed && (
        <div className="charts-panel">
          <div className="charts-container">
            <LineChart data={dailyStats} title="USAGE OVER TIME" onSelectRange={onSelectRange} />
            <ModelChart data={dailyStats} title="MODEL SPLIT" onSelectRange={onSelectRange} />
            <MonthlySpendChart data={monthlyStats} title="MONTHLY SPEND vs MAX PLAN" onSelectRange={onSelectRange} />
          </div>
        </div>
      )}
    </>
  );
}

// --- Components ---

function TopBar({ stats, searchQuery, onSearch, wipFilter, onToggleWip, wipCount, timeRange, onClearRange, beads }) {
  return (
    <div className="top-bar">
      <span className="top-bar-title">CC-MISSION-CONTROL</span>
      <div className="top-bar-stats">
        <span className="stat-item">
          <span className="stat-label">Projects</span>
          <span className="stat-value green">{stats.projectCount || 0}</span>
        </span>
        <span className="stat-item">
          <span className="stat-label">Sessions</span>
          <span className="stat-value">{stats.sessionCount || 0}</span>
        </span>
        <span className="stat-item money">
          <span className="stat-label">Est. Cost</span>
          <span className="stat-value cost">{formatCost(stats.totalCost)}</span>
        </span>
        <span className="stat-item">
          <span className="stat-label">Time Saved</span>
          <span className="stat-value time">{formatDuration(stats.timeSavedMs)}</span>
        </span>
        <span className="stat-item">
          <span className="stat-label">Multiplier</span>
          <span className="stat-value">{stats.multiplier || '-'}x</span>
        </span>
        {beads?.hasBeads && (
          <span className="stat-item money" title="$/Bead = spend ÷ beads closed for the current scope and window">
            <span className="stat-label">$/Bead</span>
            <span className="stat-value cost">{typeof stats.totalCost === 'number' && beads.closed > 0 ? formatCost(stats.totalCost / beads.closed) : '—'}</span>
          </span>
        )}
      </div>
      <div className="top-bar-controls">
        {(timeRange.from || timeRange.to) && (
          <button type="button" className="timerange-chip" onClick={onClearRange}>
            {timeRange.from} → {timeRange.to} ✕
          </button>
        )}
        <button
          type="button"
          className={`wip-filter-btn ${wipFilter ? 'active' : ''}`}
          onClick={onToggleWip}
        >
          WIP{wipCount > 0 ? ` (${wipCount})` : ''}
        </button>
        <input
          className="search-input"
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
    </div>
  );
}

function Sidebar({ projects, selectedProject, onSelect, activeSessions, wipCounts }) {
  const activeProjects = new Set(activeSessions.map(s => s.cwd));

  const totalSessions = projects.reduce((sum, p) => sum + p.sessionCount, 0);

  return (
    <div className="sidebar">
      <div className="sidebar-header">Projects</div>
      <div
        className={`project-item all-projects ${selectedProject === '__all__' ? 'active' : ''}`}
        {...clickableProps(() => onSelect('__all__'))}
      >
        <span className="project-dot" style={{background: 'var(--green)'}}></span>
        <span className="project-name" style={{fontWeight: 600}}>All Projects</span>
        <span className="project-count">{totalSessions}</span>
      </div>
      <div className="sidebar-divider"></div>
      {projects.map(p => {
        let dotClass = '';
        if (activeProjects.has(p.path)) dotClass = 'active';
        else if (p.sessionCount > 0) dotClass = 'has-sessions';
        const wip = wipCounts[p.encodedPath] || 0;

        return (
          <div
            key={p.encodedPath}
            className={`project-item ${selectedProject === p.encodedPath ? 'active' : ''}`}
            {...clickableProps(() => onSelect(p.encodedPath))}
          >
            <span className={`project-dot ${dotClass}`}></span>
            <span className="project-name">{p.name}</span>
            <span className="project-count">
              {p.sessionCount}{wip > 0 ? <span className="wip-count"> ({wip} WIP)</span> : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StatusDot({ sessionId, status, onChange }) {
  const handleClick = (e) => {
    e.stopPropagation();
    // Cycle: null -> wip -> complete -> null
    let next;
    if (!status) next = 'wip';
    else if (status === 'wip') next = 'complete';
    else next = null;
    fetch(`/api/sessions/${sessionId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next })
    })
      .then(r => r.json())
      .then(() => onChange(sessionId, next))
      .catch(console.error);
  };

  const APPEARANCE = {
    wip: { cls: 'status-dot wip', title: 'WIP — click to mark complete' },
    complete: { cls: 'status-dot complete', title: 'Complete — click to clear' },
  };
  const { cls, title } = APPEARANCE[status] || { cls: 'status-dot', title: 'Click to mark WIP' };
  const label = status === 'complete' ? '\u2713' : '';

  return (
    <span className={cls} {...clickableProps(handleClick)} title={title}>{label}</span>
  );
}

function EditableSummary({ sessionId, sessionName, summary, onSave }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(summary || '');

  const handleSave = () => {
    setEditing(false);
    if (value !== (summary || '')) {
      onSave(sessionId, value);
    }
  };

  if (editing) {
    return (
      <input
        className="summary-edit-input"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
          if (e.key === 'Escape') {
            setValue(summary || '');
            setEditing(false);
          }
        }}
        autoFocus
      />
    );
  }

  return (
    <span
      className="summary-text"
      onDoubleClick={() => { setValue(summary || ''); setEditing(true); }}
      title={sessionName ? `${sessionName}\n\nDouble-click to edit summary` : 'Double-click to edit'}
    >
      {sessionName && <span className="summary-name">{sessionName}</span>}
      {sessionName && summary && <span className="summary-sep"> · </span>}
      {summary || (sessionName ? '' : '(no summary)')}
    </span>
  );
}

const COLUMNS = [
  {
    key: 'status', label: '', className: 'col-status', prio: 1, sortField: null,
    render: (s, ctx) => (
      s.sessionId && <StatusDot sessionId={s.sessionId} status={s.status} onChange={ctx.onStatusChange} />
    )
  },
  {
    key: 'created', label: 'Created', className: 'col-date', prio: 1, sortField: 'firstTimestamp',
    render: (s) => formatDate(s.firstTimestamp),
    title: (s) => s.firstTimestamp ? new Date(s.firstTimestamp).toLocaleString() : undefined
  },
  {
    key: 'lastActive', label: 'Last Active', className: 'col-date', prio: 3, sortField: 'lastTimestamp',
    render: (s) => formatDate(s.lastTimestamp),
    title: (s) => s.lastTimestamp ? new Date(s.lastTimestamp).toLocaleString() : undefined
  },
  {
    key: 'sessionid', label: '', className: 'col-sessionid', prio: 2, sortField: null,
    render: (s, ctx) => (
      s.sessionId && (
        <button
          type="button"
          className={`sessionid-btn ${s.sessionName ? 'named' : ''} ${ctx.copied === s.sessionId ? 'copied' : ''}`}
          onClick={(e) => { e.stopPropagation(); ctx.handleCopyId(s.sessionId); }}
          title={s.sessionName ? `${s.sessionName}\n${s.sessionId}` : s.sessionId}
        >
          {ctx.copied === s.sessionId ? 'copied' : 'sessionid'}
        </button>
      )
    )
  },
  {
    key: 'actions', label: '', className: 'col-actions', prio: 1, sortField: null,
    render: (s, ctx) => (
      s.sessionId && (() => {
        const msg = ctx.restoreMsg?.sessionId === s.sessionId ? ctx.restoreMsg : null;
        const isRestoring = ctx.restoring === s.sessionId;

        if (msg?.type === 'error') {
          return <button type="button" className="restore-btn restore-error-btn"
            title={msg.text}
            onClick={(e) => { e.stopPropagation(); ctx.setRestoreMsg(null); }}
          >Error</button>;
        }

        if (msg?.type === 'partial') {
          return <button type="button" className={`restore-btn restore-copy-btn${msg.copied ? ' copied' : ''}`}
            title={`Click to copy: ${msg.text}`}
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(msg.text).then(() => {
                ctx.setRestoreMsg({ ...msg, copied: true });
                setTimeout(() => ctx.setRestoreMsg(null), 2000);
              });
            }}
          >{msg.copied ? 'Copied!' : 'Copy Cmd'}</button>;
        }

        return <button
          type="button"
          className={`restore-btn ${isRestoring ? 'restoring' : ''}`}
          onClick={(e) => { e.stopPropagation(); ctx.handleRestore(s.sessionId, s.projectPath); }}
          title={`Resume session\n${s.sessionId}`}
          disabled={isRestoring}
        >{isRestoring ? '...' : 'Launch'}</button>;
      })()
    )
  },
  {
    key: 'project', label: 'Project', className: 'col-project', prio: 1, sortField: 'projectName',
    render: (s, ctx) => (
      <span className="project-link" {...clickableProps((e) => { e.stopPropagation(); ctx.onSelectProject?.(s.encodedPath); })}>
        {s.projectName || '-'}
      </span>
    )
  },
  {
    key: 'summary', label: 'Summary / Session Name', className: 'col-summary', prio: 1, sortField: 'summary',
    render: (s, ctx) => <EditableSummary sessionId={s.sessionId} sessionName={s.sessionName} summary={s.summary} onSave={ctx.onSummaryEdit} />
  },
  {
    key: 'model', label: 'Model', className: 'col-model', prio: 2, sortField: 'primaryModel',
    render: (s) => shortModel(s.primaryModel)
  },
  {
    key: 'subs', label: 'Subs', className: 'col-subs', prio: 3, sortField: 'subagentCount',
    render: (s) => s.subagentCount > 0 ? s.subagentCount : ''
  },
  {
    key: 'tokens', label: 'Tokens', className: 'col-tokens', prio: 2, sortField: 'totalTokens',
    render: (s) => formatTokens(s.totalTokens)
  },
  {
    key: 'cost', label: 'Cost', className: 'col-cost', prio: 1, sortField: 'totalCost',
    render: (s) => formatCost(s.totalCost)
  },
  {
    key: 'duration', label: 'Duration', className: 'col-duration', prio: 3, sortField: 'durationMs',
    render: (s) => formatDuration(s.durationMs)
  },
  {
    key: 'turns', label: 'Turns', className: 'col-turns', prio: 3, sortField: 'turnCount',
    render: (s) => s.turnCount || 0
  }
];

function SessionTable({ sessions, sortField, sortDir, onSort, projectPath, onStatusChange, onSummaryEdit, showProject, onSelectProject }) {
  const [restoring, setRestoring] = useState(null);
  const [restoreMsg, setRestoreMsg] = useState(null);
  const [copied, setCopied] = useState(null);

  const sorted = [...sessions].sort((a, b) => {
    let aVal = a[sortField];
    let bVal = b[sortField];
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDir === 'asc' ? (aVal || 0) - (bVal || 0) : (bVal || 0) - (aVal || 0);
  });

  const handleSort = (field) => {
    if (sortField === field) {
      onSort(field, sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      onSort(field, 'desc');
    }
  };

  const handleRestore = (sessionId, sessionProjectPath) => {
    const cwd = sessionProjectPath || projectPath;
    if (!sessionId || !cwd) return;
    setRestoring(sessionId);
    setRestoreMsg(null);
    fetch(`/api/restore/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd })
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setRestoreMsg({ sessionId, type: 'error', text: data.error });
        } else if (data.partial && data.resumeCommand) {
          setRestoreMsg({ sessionId, type: 'partial', text: data.resumeCommand });
        }
        setTimeout(() => setRestoring(null), 2000);
      })
      .catch(() => {
        setRestoreMsg({ sessionId, type: 'error', text: 'Network error launching terminal' });
        setRestoring(null);
      });
  };

  const handleCopyId = (sessionId) => {
    navigator.clipboard.writeText(sessionId).then(() => {
      setCopied(sessionId);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const arrow = (field) => {
    if (sortField !== field) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  };

  const columns = COLUMNS.filter(c => c.key !== 'project' || showProject);

  const ctx = {
    onStatusChange, onSummaryEdit, onSelectProject,
    restoring, restoreMsg, copied,
    setRestoreMsg, handleRestore, handleCopyId
  };

  return (
    <div className="session-table-container">
      <table className="session-table">
        <thead>
          <tr>
            {columns.map(c => (
              <th
                key={c.key}
                className={`${c.className} prio-${c.prio}`}
                onClick={c.sortField ? () => handleSort(c.sortField) : undefined}
              >
                {c.label}{c.sortField ? arrow(c.sortField) : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => (
            <tr key={`${s.sessionId}-${i}`}>
              {columns.map(c => (
                <td key={c.key} className={`${c.className} prio-${c.prio}`} title={c.title ? c.title(s) : undefined}>
                  {c.render(s, ctx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Rollup({ aggregate, beads }) {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem('rollupCollapsed');
    if (stored !== null) return stored === 'true';
    return window.matchMedia('(max-height: 820px)').matches;
  });

  if (!aggregate) return null;

  const toggle = () => {
    setCollapsed(c => {
      const next = !c;
      localStorage.setItem('rollupCollapsed', String(next));
      return next;
    });
  };

  const models = Object.entries(aggregate.tokensByModel || {});
  const subModels = Object.entries(aggregate.subagentTokensByModel || {});
  const subCountByModel = aggregate.subagentCountByModel || {};
  const totalTokens = models.reduce((sum, [, m]) => sum + m.input + m.output + m.cacheRead + m.cacheWrite, 0);
  const totalSubTokens = subModels.reduce((sum, [, m]) => sum + m.input + m.output + m.cacheRead + m.cacheWrite, 0);
  const totalSubCost = subModels.reduce((sum, [, m]) => sum + m.cost, 0);
  const hasBeads = beads?.hasBeads;

  const digestParts = [
    `${formatTokens(totalTokens)} tok`,
    `${aggregate.totalSubagentCount || 0} subs`,
  ];
  if (hasBeads) {
    digestParts.push(
      `beads ${beads.closed}/${beads.created}`,
      `$/bead ${typeof aggregate.totalCost === 'number' && beads.closed > 0 ? formatCost(aggregate.totalCost / beads.closed) : '—'}`
    );
  }
  digestParts.push(formatDuration(aggregate.totalDurationMs));

  return (
    <>
      <div className="rollup-toggle" {...clickableProps(toggle)}>
        <span className={`rollup-toggle-arrow ${collapsed ? 'collapsed' : ''}`}>▼</span>
        <span>ROLLUP</span>
        {collapsed && <span className="rollup-digest">{digestParts.join(' · ')}</span>}
      </div>
      {!collapsed && (
        <div className="rollup">
        <div className="rollup-section">
          <div className="rollup-title">Tokens by Model</div>
          <div className="rollup-list">
            {models.map(([model, tokens]) => {
              const modelTotal = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
              const pct = totalTokens > 0 ? (modelTotal / totalTokens * 100) : 0;
              return (
                <div className="model-bar" key={model}>
                  <div className="model-bar-track">
                    <div className="model-bar-fill" style={{ width: Math.max(pct, 1) + '%' }}></div>
                  </div>
                  <span className="model-bar-label">
                    <span className="model-name">{shortModel(model)}</span> {formatTokens(modelTotal)} ({pct.toFixed(0)}%) <span className="rollup-value cost">{formatCost(tokens.cost)}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {aggregate.totalSubagentCount > 0 && (
          <div className="rollup-section">
            <div className="rollup-title">Subagents</div>
            <div className="subagent-summary">
              {aggregate.totalSubagentCount} subagent{aggregate.totalSubagentCount !== 1 ? 's' : ''} · {formatTokens(totalSubTokens)} tokens · {formatCost(totalSubCost)}
            </div>
            <div className="rollup-list">
              {subModels.map(([model, tokens]) => {
                const modelTotal = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
                const count = subCountByModel[model] || 0;
                return (
                  <div className="subagent-model-row" key={model}>
                    <span className="model-name">{shortModel(model)}</span> {count} subagent{count !== 1 ? 's' : ''} · {formatTokens(modelTotal)} · <span className="rollup-value cost">{formatCost(tokens.cost)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {hasBeads && (
          <div className="rollup-section">
            <div className="rollup-title">Beads</div>
            <div><span className="rollup-label">Closed</span> <span className="rollup-value">{beads.closed}</span></div>
            <div><span className="rollup-label">Created</span> <span className="rollup-value">{beads.created}</span></div>
            <div><span className="rollup-label">$/bead</span> <span className="rollup-value cost">{typeof aggregate.totalCost === 'number' && beads.closed > 0 ? formatCost(aggregate.totalCost / beads.closed) : '—'}</span></div>
          </div>
        )}
        <div className="rollup-section">
          <div className="rollup-title">Totals</div>
          <div><span className="rollup-label">Input</span> <span className="rollup-value">{formatTokens(aggregate.totalInputTokens)}</span></div>
          <div><span className="rollup-label">Output</span> <span className="rollup-value">{formatTokens(aggregate.totalOutputTokens)}</span></div>
          <div><span className="rollup-label">Cache Read</span> <span className="rollup-value">{formatTokens(aggregate.totalCacheReadTokens)}</span></div>
          <div><span className="rollup-label">Cache Write</span> <span className="rollup-value">{formatTokens(aggregate.totalCacheWriteTokens)}</span></div>
          <div><span className="rollup-label">Tool Calls</span> <span className="rollup-value">{aggregate.totalToolCalls}</span></div>
        </div>
        <div className="rollup-section">
          <div className="rollup-title">Time</div>
          <div><span className="rollup-label">Claude Time</span> <span className="rollup-value time">{formatDuration(aggregate.totalDurationMs)}</span></div>
          <div><span className="rollup-label">Est. Manual</span> <span className="rollup-value cost">{formatDuration(aggregate.totalDurationMs * 8)}</span></div>
          <div><span className="rollup-label">Time Saved</span> <span className="rollup-value green">{formatDuration(aggregate.timeSavedMs)}</span></div>
        </div>
      </div>
      )}
    </>
  );
}

function BottomBar({ activeSessions }) {
  return (
    <div className="bottom-bar">
      <span>
        {activeSessions.length > 0 ? (
          <span className="active-indicator">
            ● ACTIVE: {activeSessions.map(s =>
              `${s.cwd.split('/').pop()} (pid:${s.pid})`
            ).join(' | ')}
          </span>
        ) : (
          <span>No active sessions</span>
        )}
      </span>
      <span>CC-MISSION-CONTROL v0.1.0</span>
    </div>
  );
}

// --- Main App ---

// '' when no window is set, else a from/to query fragment prefixed with sep ('?' or '&')
function rangeQuery(timeRange, sep) {
  const parts = [];
  if (timeRange.from) parts.push(`from=${encodeURIComponent(timeRange.from)}`);
  if (timeRange.to) parts.push(`to=${encodeURIComponent(timeRange.to)}`);
  return parts.length ? sep + parts.join('&') : '';
}

function SessionsPane({ loading, sessions, tableProps }) {
  if (loading) {
    return <div className="loading"><span className="loading-pulse">Loading sessions...</span></div>;
  }
  if (sessions.length === 0) {
    return <div className="empty-state">No sessions found</div>;
  }
  return <SessionTable sessions={sessions} {...tableProps} />;
}

function ContentHeader({ title, sessionCount, totalCost, totalDurationMs }) {
  return (
    <div className="content-header">
      <span className="content-title">{title}</span>
      <div className="content-stats">
        <span>Sessions: <strong>{sessionCount || 0}</strong></span>
        <span>Cost: <strong style={{color: 'var(--amber)'}}>{formatCost(totalCost)}</strong></span>
        <span>Time: <strong style={{color: 'var(--blue)'}}>{formatDuration(totalDurationMs)}</strong></span>
      </div>
    </div>
  );
}

function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [stats, setStats] = useState({});
  const [dailyStats, setDailyStats] = useState([]);
  const [monthlyStats, setMonthlyStats] = useState([]);
  const [activeSessions, setActiveSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [sortField, setSortField] = useState('firstTimestamp');
  const [sortDir, setSortDir] = useState('desc');
  const [wipFilter, setWipFilter] = useState(false);
  const [wipSessions, setWipSessions] = useState({});
  const [timeRange, setTimeRange] = useState({ from: null, to: null });
  const [beadsStats, setBeadsStats] = useState(null);
  const [globalBeads, setGlobalBeads] = useState(null);
  const [projectStats, setProjectStats] = useState(null);

  const rangeQS = (sep) => rangeQuery(timeRange, sep);

  // Load projects on mount
  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => {
        setProjects(data);
        setLoading(false);
        // Default to All Projects view
        setSelectedProject('__all__');
        // Now that projects are loaded (cache populated), fetch wip
        fetch('/api/wip').then(r => r.json()).then(setWipSessions).catch(console.error);
      })
      .catch(err => {
        console.error('Failed to load projects:', err);
        setLoading(false);
      });

    // Poll active sessions
    const poll = setInterval(() => {
      fetch('/api/active').then(r => r.json()).then(setActiveSessions).catch(() => {});
    }, 5000);
    fetch('/api/active').then(r => r.json()).then(setActiveSessions).catch(() => {});

    return () => clearInterval(poll);
  }, []);

  // Clear time range on Esc (ignored inside inputs/textareas, and when no window is set)
  useEffect(() => {
    const h = (e) => {
      if (e.key !== 'Escape') return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      setTimeRange(r => (r.from || r.to) ? { from: null, to: null } : r);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Load stats + sessions + chart data when project or time range changes
  useEffect(() => {
    if (!selectedProject) return;
    let cancelled = false;
    setLoadingSessions(true);

    const load = (url, setter, onError) =>
      fetch(url)
        .then(r => r.json())
        .then(data => { if (!cancelled) setter(data); })
        .catch(onError || console.error);

    const proj = encodeURIComponent(selectedProject);

    load(`/api/stats${rangeQS('?')}`, setStats);

    // Fetch project-scoped, windowed stats for the project view's Rollup + header
    // (currentProject.aggregate is computed once at scan time and ignores the time window)
    setProjectStats(null);
    if (selectedProject !== '__all__') {
      load(`/api/stats?project=${proj}${rangeQS('&')}`, setProjectStats);
    }

    // Fetch sessions
    const sessionsUrl = selectedProject === '__all__'
      ? '/api/sessions/all'
      : `/api/projects/${proj}/sessions`;
    load(`${sessionsUrl}${rangeQS('?')}`,
      data => {
        setSessions(data);
        setLoadingSessions(false);
      },
      err => {
        if (cancelled) return;
        console.error('Failed to load sessions:', err);
        setLoadingSessions(false);
      });

    // Fetch chart data filtered by project
    const projectParam = selectedProject !== '__all__' ? `?project=${proj}` : '';
    const chartQS = `${projectParam}${rangeQS(projectParam ? '&' : '?')}`;
    load(`/api/daily-stats${chartQS}`, setDailyStats);
    load(`/api/monthly-stats${chartQS}`, setMonthlyStats);
    load(`/api/beads${chartQS}`, setBeadsStats, () => { if (!cancelled) setBeadsStats(null); });
    // Fetch global beads (for TopBar headline $/BEAD) — always global, respecting only time window
    load(`/api/beads${rangeQS('?')}`, setGlobalBeads, () => { if (!cancelled) setGlobalBeads(null); });

    return () => { cancelled = true; };
  }, [selectedProject, timeRange.from, timeRange.to]);

  // Search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const timeout = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(searchQuery)}${rangeQS('&')}`)
        .then(r => r.json())
        .then(setSearchResults)
        .catch(console.error);
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchQuery, timeRange.from, timeRange.to]);

  const handleSort = useCallback((field, dir) => {
    setSortField(field);
    setSortDir(dir);
  }, []);

  const handleSummaryEdit = useCallback((sessionId, newSummary) => {
    fetch(`/api/sessions/${sessionId}/summary`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: newSummary })
    })
      .then(r => r.json())
      .then(() => {
        const updater = prev => prev.map(s =>
          s.sessionId === sessionId ? { ...s, summary: newSummary } : s
        );
        setSessions(updater);
        setSearchResults(prev => prev ? updater(prev) : prev);
      })
      .catch(console.error);
  }, []);

  const handleStatusChange = useCallback((sessionId, newStatus) => {
    // Update local session state (both sessions and search results)
    const updater = prev => prev.map(s =>
      s.sessionId === sessionId ? { ...s, status: newStatus } : s
    );
    setSessions(updater);
    setSearchResults(prev => prev ? updater(prev) : prev);
    // Update WIP sessions cache
    setWipSessions(prev => {
      const next = { ...prev };
      if (newStatus === 'wip') {
        next[sessionId] = { status: 'wip', updatedAt: new Date().toISOString() };
      } else {
        delete next[sessionId];
      }
      return next;
    });
  }, []);

  // Count WIP sessions per project from loaded sessions
  const wipCounts = {};
  for (const p of projects) {
    wipCounts[p.encodedPath] = 0;
  }
  // Count from current project's sessions
  if (selectedProject) {
    wipCounts[selectedProject] = sessions.filter(s => s.status === 'wip').length;
  }
  // Also count from global WIP data for other projects — requires session->project mapping
  // For now, the current project count comes from sessions data

  const totalWipCount = Object.keys(wipSessions).length;

  const currentProject = projects.find(p => p.encodedPath === selectedProject);

  // Apply WIP filter
  let displaySessions;
  if (wipFilter) {
    displaySessions = (searchResults || sessions).filter(s => s.status === 'wip');
  } else {
    displaySessions = searchResults || sessions;
  }

  if (loading) {
    return (
      <div className="loading">
        <span className="loading-pulse">SCANNING PROJECTS...</span>
      </div>
    );
  }

  const tableProps = {
    sortField, sortDir, onSort: handleSort,
    onStatusChange: handleStatusChange, onSummaryEdit: handleSummaryEdit,
  };

  let content;
  if (selectedProject === '__all__') {
    content = (
      <>
        <ContentHeader title="All Projects" sessionCount={stats.sessionCount}
          totalCost={stats.totalCost} totalDurationMs={stats.totalDurationMs} />
        <SessionsPane loading={loadingSessions} sessions={displaySessions}
          tableProps={{ ...tableProps, projectPath: null, showProject: true, onSelectProject: setSelectedProject }} />
        <Rollup aggregate={stats} beads={beadsStats} />
      </>
    );
  } else if (currentProject) {
    // projectStats is the windowed /api/stats?project=... aggregate; fall back to
    // the static (un-windowed) currentProject.aggregate only while it's loading,
    // to avoid a blank flash.
    const agg = projectStats || currentProject.aggregate;
    content = (
      <>
        <ContentHeader title={currentProject.name}
          sessionCount={projectStats ? projectStats.sessionCount : currentProject.sessionCount}
          totalCost={agg?.totalCost} totalDurationMs={agg?.totalDurationMs} />
        <SessionsPane loading={loadingSessions} sessions={displaySessions}
          tableProps={{ ...tableProps, projectPath: currentProject.path }} />
        <Rollup aggregate={agg} beads={beadsStats} />
      </>
    );
  } else {
    content = <div className="empty-state">Select a project</div>;
  }

  return (
    <>
      <TopBar stats={stats} searchQuery={searchQuery} onSearch={setSearchQuery}
        wipFilter={wipFilter} onToggleWip={() => setWipFilter(f => !f)} wipCount={totalWipCount}
        timeRange={timeRange} onClearRange={() => setTimeRange(r => (r.from || r.to) ? { from: null, to: null } : r)} beads={globalBeads} />
      <div className="main-layout">
        <Sidebar
          projects={projects}
          selectedProject={selectedProject}
          onSelect={setSelectedProject}
          activeSessions={activeSessions}
          wipCounts={wipCounts}
        />
        <div className="content">
          <ChartsPanel dailyStats={dailyStats} monthlyStats={monthlyStats}
            onSelectRange={(from, to) => setTimeRange({ from, to })} />
          {content}
        </div>
      </div>
      <BottomBar activeSessions={activeSessions} />
    </>
  );
}

// Mount
const root = createRoot(document.getElementById('root'));
root.render(<App />);
