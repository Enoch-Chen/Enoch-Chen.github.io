"use strict";
const RESULT_FIELDS = ["experiment_id", "dataset", "stain", "model", "version", "fid", "kid", "ssim", "psnr", "lpips", "dists"];
const REQUIRED_FIELDS = ["experiment_id", "dataset", "stain", "model", "version", "fid", "ssim", "psnr"];
const METRICS = {
  fid: { label: "FID", digits: 4, direction: -1 },
  kid: { label: "KID", digits: 4, direction: -1 },
  ssim: { label: "SSIM", digits: 4, direction: 1 },
  psnr: { label: "PSNR", digits: 2, direction: 1 },
  lpips: { label: "LPIPS", digits: 4, direction: -1 },
  dists: { label: "DISTS", digits: 4, direction: -1 },
};
const CHARTS = {
  bar: { label: "柱状图", hint: "按数据集分组比较模型", footnote: "同模型、版本的重复结果取均值；悬停查看数值。" },
  line: { label: "折线图", hint: "查看模型在不同数据集上的指标变化", footnote: "横轴为数据集；不同染色和缺失值处断线。悬停查看均值与样本数。" },
  tile: { label: "平铺图", hint: "模型 × 数据集，以色块和数值展示结果", footnote: "每列按当前显示的模型比较：深绿最优，浅绿次优，并列同级；其余为中性色，灰色「—」为缺失。" },
};
const COLORS = ["#50765b", "#a8be88", "#dbab81", "#acbfc8", "#9b91af", "#c4b96e", "#8bb9a8", "#ce9290"];
const IMAGE_VERSIONS = ["MIST", "MIST_S01", "MIST_S02", "MIST_S03", "MIST_S04", "MIST_S05", "MIST_S06"];

// CSV parsing, validation and export.
function parseCSV(input) {
  const text = input.replace(/^\uFEFF/, "");
  const rows = []; let row = [], value = "", quoted = false, closed = false;
  const pushRow = () => { row.push(value); if (row.some(cell => cell.trim() !== "")) rows.push(row); row = []; value = ""; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else value += c;
    } else if (c === '"') {
      if (value || closed) throw new Error("CSV 引号格式错误。");
      quoted = true;
    } else if (c === ",") { row.push(value); value = ""; closed = false; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; pushRow(); }
    else if (closed && !/\s/.test(c)) throw new Error("CSV 结束引号后存在多余字符。");
    else if (!closed) value += c;
  }
  if (quoted) throw new Error("CSV 存在未闭合的引号。");
  pushRow();
  if (!rows.length) throw new Error("CSV 为空，请提供表头。");
  const headers = rows.shift().map(s => s.trim());
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error("CSV 表头为空或重复。");
  return { headers, rows: rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`第 ${index + 2} 条记录的列数与表头不一致。`);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i].trim()]));
  }) };
}
function validateCSV(text) {
  const { headers, rows } = parseCSV(text);
  const missing = REQUIRED_FIELDS.filter(field => !headers.includes(field));
  if (missing.length) throw new Error(`缺少字段：${missing.join(", ")}`);
  const seen = new Set();
  return rows.flatMap((source, index) => {
    // A row without a model or measurements is an unfinished CSV placeholder.
    if (!source.model && Object.keys(METRICS).every(field => !source[field])) return [];
    const row = { ...source };
    const fail = message => { throw new Error(`第 ${index + 2} 条记录：${message}`); };
    for (const field of ["experiment_id", "dataset", "model"]) {
      if (!row[field]) fail(`${field} 不可为空。`);
    }
    for (const field of Object.keys(METRICS)) {
      if (!headers.includes(field)) continue;
      if (row[field] === "") {
        row[field] = null;
        continue;
      }
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(row[field])) {
        fail(`${field} 必须为有限数字或留空。`);
      }
      row[field] = Number(row[field]);
      if (!Number.isFinite(row[field])) fail(`${field} 必须为有限数字。`);
      if (field === "ssim" && (row[field] < -1 || row[field] > 1)) fail(`${field} 应在 −1 到 1 之间。`);
      if (["fid", "kid", "lpips", "dists"].includes(field) && row[field] < 0) fail(`${field} 不可小于 0。`);
    }
    if (seen.has(row.experiment_id)) fail("experiment_id 重复。");
    seen.add(row.experiment_id);
    return [row];
  });
}

function serializeCSV(rows, fields) {
  const cell = value => {
    let text = value == null ? "" : String(value);
    // Prevent imported text from becoming a formula in spreadsheet software.
    if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  return "\uFEFF" + [fields.map(cell).join(","), ...rows.map(r => fields.map(f => cell(r[f])).join(","))].join("\r\n");
}
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const groupKey = r => JSON.stringify([r.dataset, r.stain]);
const seriesKey = r => JSON.stringify([r.model, r.version]);
const rowsForStain = (rows, stain) => rows.filter(row => row.stain.toUpperCase() === stain);
// Chart data and rendering. All views share means; absent measurements stay null.
function comparisonData(rows, metric) {
  const groups = [...new Map(rows.map(r => [groupKey(r), r])).values()];
  const stains = [...new Set(groups.map(r => r.stain))];
  groups.sort((a, b) => stains.indexOf(a.stain) - stains.indexOf(b.stain));
  const series = [...new Map(rows.map(r => [seriesKey(r), r])).values()];
  const buckets = new Map();
  rows.forEach(r => {
    if (r[metric] == null) return;
    const key = JSON.stringify([groupKey(r), seriesKey(r)]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r[metric]);
  });
  const cells = series.map(model => groups.map(group => {
    const values = buckets.get(JSON.stringify([groupKey(group), seriesKey(model)])) || [];
    return { value: values.length ? mean(values) : null, count: values.length };
  }));
  return { groups, series, cells };
}
function selectComparisonSeries(data, hidden) {
  const indices = data.series.map((_, index) => index).filter(index => !hidden.has(seriesKey(data.series[index])));
  return { ...data, series: indices.map(index => data.series[index]), cells: indices.map(index => data.cells[index]), seriesIndices: indices.map(index => data.seriesIndices?.[index] ?? index) };
}
function tileStrength(value, values, metric) {
  if (value == null) return null;
  const ranked = [...new Set(values.filter(v => v != null))]
    .sort((a, b) => (b - a) * METRICS[metric].direction);
  const place = ranked.indexOf(value);
  return place === 0 ? 1 : place === 1 ? .5 : 0;
}
function comparisonSVG(data, metric, view, colorFor = (_, index) => COLORS[index % COLORS.length]) {
  const { groups, series, cells } = data;
  const values = cells.flat().map(c => c.value).filter(v => v != null);
  if (!values.length) return '';
  const label = METRICS[metric].label;
  const format = v => v == null ? '—' : v.toFixed(METRICS[metric].digits);
  const tooltip = (si, gi) => {
    const cell = cells[si][gi], group = groups[gi], model = series[si];
    const groupName = group.dataset;
    const modelName = [model.model, model.version].filter(Boolean).join(' · ');
    return `${groupName} / ${modelName} / ${label}: ${format(cell.value)}${cell.value == null ? '（未提供）' : ` (n=${cell.count})`}`;
  };
  const viewLabel = CHARTS[view].label;
  if (view === 'tile') {
    const left = 190, top = 65, cellW = 126, cellH = 70;
    const w = left + groups.length * cellW + 18, h = top + series.length * cellH + 18;
    let svg = `<svg class="chart-svg tile-svg" style="min-width:${w}px" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label} 模型对比${viewLabel}"><title>每格展示指标均值；每列深绿为最优、浅绿为次优，其余为中性色，灰色为缺失值。</title>`;
    groups.forEach((group, gi) => {
      const x = left + (gi + .5) * cellW;
      svg += `<text class="group-label" x="${x}" y="26" text-anchor="middle">${escapeHTML(group.dataset)}</text>`;
    });
    series.forEach((model, si) => {
      const y = top + si * cellH;
      svg += `<text class="group-label" x="${left - 14}" y="${y + 26}" text-anchor="end">${escapeHTML(model.model)}</text>`;
      if (model.version) svg += `<text class="axis-title" x="${left - 14}" y="${y + 44}" text-anchor="end">${escapeHTML(model.version)}</text>`;
      groups.forEach((_, gi) => {
        const cell = cells[si][gi], strength = tileStrength(cell.value, cells.map(row => row[gi].value), metric);
        const shade = strength === 1 ? '#256546' : strength === .5 ? '#b9d4bf' : strength === 0 ? '#f7f8f6' : '#edf0ee';
        const text = strength === 1 ? '#ffffff' : '#315440';
        const x = left + gi * cellW, title = escapeHTML(tooltip(si, gi));
        svg += `<g class="tile" tabindex="0" aria-label="${title}"><title>${title}</title><rect x="${x + 4}" y="${y + 4}" width="${cellW - 8}" height="${cellH - 8}" rx="7" fill="${shade}"/><text class="tile-value" style="fill:${text}" x="${x + cellW / 2}" y="${y + 38}" text-anchor="middle">${format(cell.value)}</text></g>`;
      });
    });
    return svg + '</svg>';
  }
  const w = Math.max(960, groups.length * Math.max(130, series.length * 30) + 80), h = 380;
  const left = 55, top = 25, bottom = 60, plotH = h - top - bottom;
  let low = Math.min(0, ...values), high = Math.max(0, ...values);
  if (low === high) high = low + 1;
  high += (high - low) * .12;
  const y = value => top + (high - value) / (high - low) * plotH;
  const step = (w - left - 14) / groups.length, x = gi => left + step * (gi + .5);
  const barW = Math.min(30, (step - 30) / series.length);
  let svg = `<svg class="chart-svg" style="min-width:${Math.max(660, w - 280)}px" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label} 模型对比${viewLabel}">`;
  for (let i = 0; i <= 4; i++) {
    const value = low + (high - low) * i / 4, yy = y(value);
    svg += `<line class="grid" x1="${left}" x2="${w - 10}" y1="${yy}" y2="${yy}"/><text x="${left - 9}" y="${yy + 3}" text-anchor="end">${value.toFixed(METRICS[metric].digits > 2 ? 3 : 1)}</text>`;
  }
  series.forEach((model, si) => {
    const seriesIndex = data.seriesIndices?.[si] ?? si;
    const color = colorFor(model.model, seriesIndex);
    if (view === 'line') {
      let path = '', previousStain = null, connected = false;
      groups.forEach((group, gi) => {
        const cell = cells[si][gi];
        if (cell.value == null) { connected = false; return; }
        path += `${connected && previousStain === group.stain ? 'L' : 'M'}${x(gi)},${y(cell.value)} `;
        connected = true; previousStain = group.stain;
      });
      svg += `<path class="model-line" d="${path}" stroke="${color}" stroke-width="2.5" fill="none" stroke-linejoin="round"${seriesIndex % 2 ? ' stroke-dasharray="7 3"' : ''}/>`;
    }
    groups.forEach((_, gi) => {
      const cell = cells[si][gi]; if (cell.value == null) return;
      const title = escapeHTML(tooltip(si, gi));
      if (view === 'line') {
        svg += `<g class="chart-point-group" data-tooltip="${title}"><circle class="chart-point" tabindex="0" aria-label="${title}" cx="${x(gi)}" cy="${y(cell.value)}" r="5" fill="${color}" stroke="#fff" stroke-width="1.5"></circle><circle class="point-hit" cx="${x(gi)}" cy="${y(cell.value)}" r="14" fill="transparent" aria-hidden="true"/></g>`;
      } else {
        const xx = x(gi) + (si - series.length / 2) * (barW + 2) + 1;
        svg += `<rect class="bar" tabindex="0" aria-label="${title}" data-tooltip="${title}" x="${xx}" y="${Math.min(y(cell.value), y(0))}" width="${barW}" height="${Math.max(.8, Math.abs(y(cell.value) - y(0)))}" rx="2" fill="${color}"></rect>`;
      }
    });
  });
  groups.forEach((group, gi) => {
    svg += `<text class="group-label" x="${x(gi)}" y="${h - 31}" text-anchor="middle">${escapeHTML(group.dataset)}</text>`;
  });
  return svg + '</svg>';
}

if (typeof module !== "undefined") module.exports = { parseCSV, validateCSV, serializeCSV, comparisonData, comparisonSVG, tileStrength, selectComparisonSeries, rowsForStain };
// Page state, rendering and interactions. Node tests only use the pure helpers above.
if (typeof document !== "undefined") {
  const $ = id => document.getElementById(id);
  const groupButtons = [...document.querySelectorAll("[data-group]")];
  const stainButtons = [...document.querySelectorAll("[data-stain]")];
  const imageModelButtons = [...document.querySelectorAll("[data-image-model]")];
  const state = { rows: [], group: "mist-main", source: "", stain: "ER", metric: "fid", chart: "bar", hiddenSeries: new Set(), request: 0, imageModel: "Baseline", imageSample: 0, examples: null, examplesError: "", gallerySignature: "" };
  let toastTimer;
  const empty = (title, description) => `<div class="empty-state"><strong>${escapeHTML(title)}</strong><p>${escapeHTML(description)}</p></div>`;
  const chartTooltip = $("chart-tooltip");
  function setSelected(buttons, selected) {
    buttons.forEach(button => {
      const active = button === selected;
      button.classList.toggle("selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  function showChartTooltip(target, x, y) {
    chartTooltip.textContent = target.getAttribute("data-tooltip");
    chartTooltip.hidden = false;
    const width = chartTooltip.offsetWidth, height = chartTooltip.offsetHeight;
    chartTooltip.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - width - 8))}px`;
    chartTooltip.style.top = `${y + height + 16 > window.innerHeight ? Math.max(8, y - height - 14) : y + 14}px`;
  }
  function hideChartTooltip() { chartTooltip.hidden = true; }
  function toast(message) {
    $("toast").textContent = message; $("toast").hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").hidden = true, 6000);
  }
  function color(model) { return COLORS[[...new Set(state.rows.map(r => r.model))].indexOf(model) % COLORS.length] || COLORS[0]; }
  function filteredRows() { return rowsForStain(state.rows, state.stain); }
  function selectedRows() { return filteredRows().filter(row => !state.hiddenSeries.has(seriesKey(row))); }
  function setLoading(loading) {
    [...groupButtons, $("reload-data")].forEach(button => button.disabled = loading);
  }
  function updateSourceControls() {
    const selected = groupButtons.find(button => button.dataset.group === state.group);
    setSelected(groupButtons, selected);
    $("source-label").textContent = `${selected ? selected.textContent : state.source} · ${filteredRows().length} 条结果`;
  }
  function renderComparison() {
    hideChartTooltip();
    const rows = filteredRows();
    const metric = state.metric, allData = comparisonData(rows, metric);
    const data = selectComparisonSeries(allData, state.hiddenSeries);
    const chart = CHARTS[state.chart];
    $("comparison-description").textContent = `${METRICS[metric].label}${metric === 'psnr' ? ' / dB' : ''} · ${METRICS[metric].direction === 1 ? '越高越好' : '越低越好'} · ${chart.label}`;
    $("chart-hint").textContent = chart.hint;
    $("chart-footnote").textContent = chart.footnote;
    const legendButtons = allData.series.map((model, index) => {
      const key = seriesKey(model), enabled = !state.hiddenSeries.has(key);
      const label = [model.model, model.version].filter(Boolean).join(' · ');
      const marker = state.chart === 'line'
        ? `border-top: 3px ${index % 2 ? 'dashed' : 'solid'} ${color(model.model)};background:transparent`
        : `background:${color(model.model)}`;
      return `<button type="button" class="legend-toggle${enabled ? '' : ' is-hidden'}" data-series="${escapeHTML(key)}" aria-pressed="${enabled}" aria-label="${escapeHTML(label)}" title="${enabled ? '点击隐藏' : '点击显示'} ${escapeHTML(label)}"><i class="${state.chart === 'line' ? 'line-key' : ''}" style="${marker}" aria-hidden="true"></i><span>${escapeHTML(model.model)}${model.version ? ` <small>· ${escapeHTML(model.version)}</small>` : ''}</span></button>`;
    }).join('');
    const heatScale = state.chart === 'tile' && data.series.length
      ? '<span class="heat-scale"><i class="best-key"></i>最优<i class="second-key"></i>次优<i class="other-key"></i>其余</span><span class="missing-key"><i></i>未提供</span>' : '';
    $("comparison-legend").innerHTML = legendButtons + (allData.series.length ? `<span class="legend-help">${data.series.length} / ${allData.series.length} 已显示 · 点击切换</span>` : '') + heatScale;
    let content = comparisonSVG(data, metric, state.chart, color);
    if (!content) {
      if (allData.series.length && !data.series.length) content = empty('所有模型已隐藏', '点击上方任意模型名称恢复显示。');
      else if (!state.rows.length) content = empty('这个数据组暂无结果', '在对应 CSV 中填写实验结果后刷新页面。');
      else if (!rows.length) content = empty('该染色暂无结果', '切换染色类型，或在 CSV 中补充此项染色的结果。');
      else content = empty('暂无可对比的指标', '切换指标，或在 CSV 中补充此项指标。');
    }
    $("comparison-chart").innerHTML = content;
  }
  function renderGallery() {
    const section = $("image-comparison");
    section.hidden = state.group !== "mist-main";
    if (section.hidden) return;
    const signature = JSON.stringify([state.stain, state.imageModel, state.imageSample, state.examples, state.examplesError]);
    if (signature === state.gallerySignature) return;
    state.gallerySignature = signature;
    const gallery = $("image-gallery");
    if (!state.examples) {
      gallery.innerHTML = empty("正在读取示例图", "");
      return;
    }
    if (state.examplesError) {
      gallery.innerHTML = empty("示例图读取失败", state.examplesError);
      return;
    }
    if (!state.examples.length) {
      gallery.innerHTML = empty("暂无示例图", "图像清单中还没有样本。");
      return;
    }
    const sample = state.examples[state.imageSample] || state.examples[0];
    const base = `./data/results_MIST/${encodeURIComponent(sample.id)}/`;
    const imageCell = (label, filename, context) => {
      const title = `${sample.id} · ${context} · ${label}`;
      return `<div class="image-cell"><span>${escapeHTML(label)}</span><button type="button" class="image-zoom" data-image-label="${escapeHTML(title)}" aria-label="放大查看 ${escapeHTML(title)}"><img src="${escapeHTML(base + filename)}" alt="${escapeHTML(title)}" loading="lazy" decoding="async" width="1024" height="1024"></button></div>`;
    };
    const stainCounts = {};
    const sampleTabs = state.examples.map((example, index) => {
      stainCounts[example.stain] = (stainCounts[example.stain] || 0) + 1;
      return `<button type="button" data-image-sample="${index}" class="${example === sample ? 'selected' : ''}" aria-pressed="${example === sample}">${example.stain} ${stainCounts[example.stain]}</button>`;
    }).join("");
    const reference = `<div class="image-machine"><h3>参考</h3>${imageCell("H&E", "HE.jpg", "参考")}${imageCell("真实 IHC", "IHC.jpg", "参考")}</div>`;
    const versions = IMAGE_VERSIONS.map(version => {
      const label = version === "MIST" ? "MIST" : version.slice(5);
      const he = version === "MIST" ? "HE.jpg" : `HE_${version}.jpg`;
      return `<div class="image-machine"><h3>${label}</h3>${imageCell("H&E 输入", he, version)}${imageCell(`${state.imageModel} 生成`, `outputs/${state.imageModel}_${version}.png`, version)}</div>`;
    }).join("");
    gallery.innerHTML = `<div class="image-sample-heading"><div class="image-samples" role="group" aria-label="选择样例">${sampleTabs}</div><span>${escapeHTML(sample.id)}</span></div><div class="image-scroll"><div class="image-grid">${reference}${versions}</div></div>`;
  }
  function render() {
    renderComparison();
    renderGallery();
    $("export-results").disabled = !selectedRows().length;
  }

  async function loadExamples() {
    try {
      const path = "data/results_MIST/examples.json";
      const response = await fetch(new URL(path, document.baseURI));
      if (!response.ok) throw new Error(`${path} 读取失败（HTTP ${response.status}）。`);
      const examples = await response.json();
      if (!Array.isArray(examples) || examples.some(example => !/^[\w-]+$/.test(example.id) || !["ER", "PR", "HER2", "KI67"].includes(example.stain))) {
        throw new Error("示例图清单格式错误。");
      }
      state.examples = examples;
      state.imageSample = Math.max(0, examples.findIndex(example => example.stain === state.stain));
    } catch (error) {
      state.examples = [];
      state.examplesError = error.message;
    }
    renderGallery();
  }

  async function loadGroup(group) {
    const request = ++state.request;
    setLoading(true);
    try {
      const path = `data/${group}.csv`;
      const response = await fetch(new URL(path, document.baseURI), { cache: "no-store" });
      if (!response.ok) throw new Error(`${path} 读取失败（HTTP ${response.status}）。`);
      const rows = validateCSV(await response.text());
      if (request !== state.request) return;
      Object.assign(state, { rows, group, source: path, hiddenSeries: new Set() });
      updateSourceControls(); render();
    } catch (error) {
      if (request !== state.request) return;
      if (!state.rows.length) $("source-label").textContent = "数据未加载";
      toast(`加载失败：${error.message}${state.rows.length ? " 当前保留已加载的数据。" : ""}`);
      render();
    } finally { if (request === state.request) setLoading(false); }
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast("CSV 请控制在 10 MB 以内。"); return; }
    try {
      const rows = validateCSV(await file.text());
      if (!rows.length) throw new Error("CSV 没有数据记录。");
      ++state.request;
      Object.assign(state, { rows, group: null, source: file.name, hiddenSeries: new Set() });
      setLoading(false); updateSourceControls(); render();
      toast(`已导入 ${rows.length} 条结果，仅在当前会话生效。`);
    } catch (error) { toast(`导入失败：${error.message}`); }
  }
  for (const key of ["metric", "chart"]) {
    const buttons = document.querySelectorAll(`[data-${key}]`);
    buttons.forEach(button => button.addEventListener("click", () => {
      state[key] = button.dataset[key];
      setSelected(buttons, button);
      render();
    }));
  }
  const chart = $("comparison-chart");
  chart.addEventListener("pointermove", event => {
    const target = event.target.closest("[data-tooltip]");
    if (target) showChartTooltip(target, event.clientX, event.clientY);
    else hideChartTooltip();
  });
  chart.addEventListener("pointerleave", hideChartTooltip);
  chart.addEventListener("scroll", hideChartTooltip, { passive: true });
  chart.addEventListener("focusin", event => {
    const target = event.target.closest("[data-tooltip]");
    if (target) {
      const bounds = target.getBoundingClientRect();
      showChartTooltip(target, bounds.right, bounds.top);
    }
  });
  chart.addEventListener("focusout", hideChartTooltip);
  $("comparison-legend").addEventListener("click", event => {
    const button = event.target.closest("button[data-series]");
    if (!button) return;
    const key = button.dataset.series;
    if (state.hiddenSeries.has(key)) state.hiddenSeries.delete(key);
    else state.hiddenSeries.add(key);
    render();
    // Keep keyboard focus on the same legend control after its markup is refreshed.
    [...$("comparison-legend").querySelectorAll("button[data-series]")].find(item => item.dataset.series === key)?.focus({ preventScroll: true });
  });
  imageModelButtons.forEach(button => button.addEventListener("click", () => {
    state.imageModel = button.dataset.imageModel;
    setSelected(imageModelButtons, button);
    renderGallery();
  }));
  const imageDialog = $("image-dialog");
  let imageScrollY = 0, imageScroller = null, imageScrollLeft = 0;
  function restoreImageScroll() {
    window.scrollTo(0, imageScrollY);
    if (imageScroller) imageScroller.scrollLeft = imageScrollLeft;
  }
  $("image-gallery").addEventListener("click", event => {
    const sampleButton = event.target.closest("button[data-image-sample]");
    if (sampleButton) {
      state.imageSample = Number(sampleButton.dataset.imageSample);
      const sample = state.examples?.[state.imageSample];
      if (sample && sample.stain !== state.stain) {
        state.stain = sample.stain;
        setSelected(stainButtons, stainButtons.find(button => button.dataset.stain === state.stain));
        updateSourceControls();
        render();
      } else renderGallery();
      $("image-gallery").querySelector(`button[data-image-sample="${state.imageSample}"]`)?.focus({ preventScroll: true });
      return;
    }
    const button = event.target.closest("button.image-zoom");
    if (!button) return;
    const image = button.querySelector("img");
    imageDialog.querySelector("img").src = image.src;
    imageDialog.querySelector("img").alt = image.alt;
    imageDialog.querySelector("p").textContent = button.dataset.imageLabel;
    imageScrollY = window.scrollY;
    imageScroller = button.closest(".image-scroll");
    imageScrollLeft = imageScroller?.scrollLeft || 0;
    imageDialog.showModal();
    requestAnimationFrame(restoreImageScroll);
  });
  imageDialog.querySelector("button").addEventListener("click", () => imageDialog.close());
  imageDialog.addEventListener("click", event => { if (event.target === imageDialog) imageDialog.close(); });
  imageDialog.addEventListener("close", () => requestAnimationFrame(restoreImageScroll));
  groupButtons.forEach(button => button.addEventListener("click", () => loadGroup(button.dataset.group)));
  stainButtons.forEach(button => button.addEventListener("click", () => {
    state.stain = button.dataset.stain;
    state.imageSample = Math.max(0, state.examples?.findIndex(example => example.stain === state.stain) ?? 0);
    setSelected(stainButtons, button);
    updateSourceControls(); render();
  }));
  $("reload-data").addEventListener("click", () => state.group ? loadGroup(state.group) : toast("当前为导入数据，请重新导入 CSV。"));
  $("import-results").addEventListener("click", () => $("results-file").click());
  $("results-file").addEventListener("change", async event => { await importFile(event.target.files[0]); event.target.value = ""; });
  $("export-results").addEventListener("click", () => {
    const rows = selectedRows(); if (!rows.length) return;
    const fields = [...new Set([...RESULT_FIELDS, "source", "notes", ...rows.flatMap(r => Object.keys(r))])];
    const blob = new Blob([serializeCSV(rows, fields)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `stainlab-${state.group || "import"}-results.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出当前显示模型的 ${rows.length} 条结果。`);
  });
  loadGroup("mist-main");
  loadExamples();
}
