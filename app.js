"use strict";
const RESULT_FIELDS = ["experiment_id", "dataset", "stain", "model", "version", "ssim", "psnr", "fid"];
const CURVE_FIELDS = ["experiment_id", "epoch", "loss", "val_ssim", "val_psnr", "val_fid"];
const METRICS = { fid: { label: "FID", digits: 4, direction: -1 }, ssim: { label: "SSIM", digits: 4, direction: 1 }, psnr: { label: "PSNR", digits: 2, direction: 1 } };
const COLORS = ["#50765b", "#a8be88", "#dbab81", "#acbfc8", "#9b91af", "#c4b96e", "#8bb9a8", "#ce9290"];

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
function validateCSV(text, kind = "results") {
  const parsed = parseCSV(text), required = kind === "results" ? RESULT_FIELDS : CURVE_FIELDS;
  const missing = required.filter(k => !parsed.headers.includes(k));
  if (missing.length) throw new Error(`缺少字段：${missing.join(", ")}`);
  const seen = new Set();
  return parsed.rows.map((source, i) => {
    const row = { ...source };
    const fail = message => { throw new Error(`第 ${i + 2} 条记录：${message}`); };
    (kind === "results" ? RESULT_FIELDS.slice(0, 5) : ["experiment_id"]).forEach(k => { if (!row[k]) fail(`${k} 不可为空。`); });
    (kind === "results" ? ["ssim", "psnr", "fid"] : CURVE_FIELDS.slice(1)).forEach(k => {
      if (row[k] === "") { row[k] = null; return; }
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(row[k])) fail(`${k} 必须为有限数字或留空。`);
      row[k] = Number(row[k]);
      if (!Number.isFinite(row[k])) fail(`${k} 必须为有限数字。`);
      if (k.endsWith("ssim") && (row[k] < -1 || row[k] > 1)) fail(`${k} 应在 −1 到 1 之间。`);
      if (k.endsWith("fid") && row[k] < 0) fail(`${k} 不可小于 0。`);
    });
    if (kind === "curves" && (!Number.isSafeInteger(row.epoch) || row.epoch < 0)) fail("epoch 必须为非负整数。");
    const key = kind === "results" ? row.experiment_id : JSON.stringify([row.experiment_id, row.epoch]);
    if (seen.has(key)) fail(kind === "results" ? "experiment_id 重复。" : "同一实验的 epoch 重复。");
    seen.add(key); return row;
  });
}
function serializeCSV(rows, fields) {
  const cell = value => {
    let text = value == null ? "" : String(value);
    // Prevent imported text from becoming a formula in spreadsheet software.
    if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  return "\uFEFF" + [fields.join(","), ...rows.map(r => fields.map(f => cell(r[f])).join(","))].join("\r\n");
}
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const groupKey = r => JSON.stringify([r.dataset, r.stain]);
const seriesKey = r => JSON.stringify([r.model, r.version]);
function pairedImprovements(rows, metric) {
  const groups = new Map();
  for (const r of rows) {
    if (r[metric] == null || !["MDCL", "MDCL + CCSDG"].includes(r.model)) continue;
    const key = JSON.stringify([r.dataset, r.stain, r.version]);
    if (!groups.has(key)) groups.set(key, { label: r.dataset, stain: r.stain, version: r.version, base: [], module: [] });
    groups.get(key)[r.model === "MDCL" ? "base" : "module"].push(r[metric]);
  }
  return [...groups.values()].filter(g => g.base.length && g.module.length && mean(g.base) !== 0).map(g => ({ ...g, value: METRICS[metric].direction * (mean(g.module) - mean(g.base)) / Math.abs(mean(g.base)) * 100 }));
}
if (typeof module !== "undefined") module.exports = { parseCSV, validateCSV, serializeCSV, pairedImprovements };
if (typeof document !== "undefined") {
  const $ = id => document.getElementById(id);
  const state = { rows: [], curves: [], mode: "real", source: "results.csv", metric: "fid", sort: "fid", ascending: true, request: 0 };
  const filters = ["dataset", "stain", "model", "version"];
  let toastTimer;
  const fmt = (v, metric) => v == null ? "—" : v.toFixed(METRICS[metric]?.digits ?? 4);
  const empty = (title, description, demo = false) => `<div class="empty-state"><span class="empty-icon">⌁</span><strong>${escapeHTML(title)}</strong><p>${escapeHTML(description)}</p>${demo ? '<button class="button small" data-show-demo>查看演示曲线 ↗</button>' : ""}</div>`;
  function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").hidden = true, 6000); }
  function color(model) { return COLORS[[...new Set(state.rows.map(r => r.model))].indexOf(model) % COLORS.length] || COLORS[0]; }
  function visibleRows() {
    const query = $("search").value.toLowerCase().trim();
    return state.rows.filter(r => filters.every(f => !$("filter-" + f).value || r[f] === $("filter-" + f).value) && (!query || Object.values(r).join(" ").toLowerCase().includes(query)));
  }
  function sortedRows(rows) {
    return [...rows].sort((a, b) => {
      const x = a[state.sort], y = b[state.sort];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "zh-CN", { numeric: true })) * (state.ascending ? 1 : -1);
    });
  }
  function setupFilters() {
    const labels = { dataset: "全部数据集", stain: "全部染色", model: "全部模型", version: "全部版本" };
    for (const key of filters) {
      const select = $("filter-" + key), previous = select.value;
      select.replaceChildren(new Option(labels[key], ""), ...[...new Set(state.rows.map(r => r[key]))].map(value => new Option(value, value)));
      if ([...select.options].some(o => o.value === previous)) select.value = previous;
    }
  }
  function updateNotice(extra = "") {
    const demo = state.mode === "demo";
    $("real-mode").classList.toggle("selected", !demo); $("demo-mode").classList.toggle("selected", demo);
    $("real-mode").setAttribute("aria-pressed", String(!demo)); $("demo-mode").setAttribute("aria-pressed", String(demo));
    $("source-label").textContent = `${state.source} · ${state.rows.length} 条记录`;
    $("notice").className = "notice" + (demo ? " demo" : "");
    let text = demo ? "演示模式 · 当前指标与训练曲线均为人工示例，仅用于体验功能，不代表真实实验结果。" : "实验数据 · 最佳值仅描述当前筛选范围；跨数据集结果不直接代表模型排名。";
    if (!demo && state.rows.some(r => r.source === "draw_figure.py" && r.stain === "待确认")) text = "数据待核对 · FID 来自 draw_figure.py 的当前有效数组；图表标题为 Ki67，输出文件名为 ER，因此染色标为「待确认」。SSIM、PSNR 与训练日志尚未提供。";
    $("notice").textContent = text + (extra ? " " + extra : "");
  }
  function renderStats(rows) {
    $("stat-count").textContent = rows.length;
    $("stat-coverage").textContent = `${new Set(rows.map(r => r.dataset)).size} 个数据集 · ${new Set(rows.map(r => r.model)).size} 个模型`;
    for (const metric of Object.keys(METRICS)) {
      const valid = rows.filter(r => r[metric] != null).sort((a, b) => (b[metric] - a[metric]) * METRICS[metric].direction);
      $("stat-" + metric).textContent = valid.length ? fmt(valid[0][metric], metric) : "—";
      $("best-" + metric).textContent = valid.length ? `${valid[0].model} · ${valid[0].dataset} · ${valid[0].stain}` : "当前筛选下暂无该指标";
    }
  }
  function renderComparison(rows) {
    const metric = state.metric, valid = rows.filter(r => r[metric] != null);
    const series = [...new Map(valid.map(r => [seriesKey(r), r])).values()];
    $("comparison-legend").innerHTML = series.map(r => `<span><i style="background:${color(r.model)}"></i>${escapeHTML(r.model)} <small>· ${escapeHTML(r.version)}</small></span>`).join("");
    $("comparison-description").textContent = `${METRICS[metric].label}${metric === "psnr" ? " / dB" : ""} · ${METRICS[metric].direction === 1 ? "越高越好" : "越低越好"} · 同一数据集与染色内比较`;
    if (!valid.length) { $("comparison-chart").innerHTML = empty("暂无可对比的指标", "调整筛选条件，或在 CSV 中补充此项指标。"); return; }
    const groups = [...new Map(valid.map(r => [groupKey(r), r])).values()];
    const w = Math.max(660, groups.length * Math.max(94, series.length * 21) + 65), h = 250, left = 42, top = 20, bottom = 53, plotH = h - top - bottom;
    let low = Math.min(0, ...valid.map(r => r[metric])), high = Math.max(0, ...valid.map(r => r[metric]));
    if (low === high) high = low + 1;
    high += (high - low) * .12;
    const y = v => top + (high - v) / (high - low) * plotH;
    const step = (w - left - 14) / groups.length, barW = Math.min(20, (step - 23) / series.length);
    let svg = `<svg class="chart-svg" style="min-width:${Math.max(450, w - 150)}px" viewBox="0 0 ${w} ${h}" role="img" aria-label="${METRICS[metric].label} 模型对比柱状图"><title>按数据集和染色分组的 ${METRICS[metric].label} 对比，具体数值也可在实验表格中查看</title>`;
    for (let i = 0; i <= 4; i++) { const v = low + (high - low) * i / 4, yy = y(v); svg += `<line class="grid" x1="${left}" x2="${w - 10}" y1="${yy}" y2="${yy}"/><text x="${left - 9}" y="${yy + 3}" text-anchor="end">${v.toFixed(metric === "ssim" ? 2 : 0)}</text>`; }
    groups.forEach((group, gi) => {
      const center = left + step * (gi + .5);
      series.forEach((s, si) => {
        const values = valid.filter(r => groupKey(r) === groupKey(group) && seriesKey(r) === seriesKey(s)).map(r => r[metric]);
        if (!values.length) return;
        const v = mean(values), xx = center + (si - series.length / 2) * (barW + 2);
        svg += `<rect class="bar" x="${xx}" y="${Math.min(y(v), y(0))}" width="${barW}" height="${Math.max(.8, Math.abs(y(v) - y(0)))}" rx="2" fill="${color(s.model)}"><title>${escapeHTML(`${group.dataset} · ${group.stain} / ${s.model} · ${s.version}: ${fmt(v, metric)} (n=${values.length})`)}</title></rect>`;
      });
      svg += `<text class="group-label" x="${center}" y="${h - 31}" text-anchor="middle">${escapeHTML(group.dataset)}</text><text class="axis-title" x="${center}" y="${h - 15}" text-anchor="middle">${escapeHTML(group.stain)}</text>`;
    });
    $("comparison-chart").innerHTML = svg + "</svg>";
  }
  function renderImprovements(rows) {
    const pairs = pairedImprovements(rows, state.metric);
    $("improvement-label").textContent = `配对 ${METRICS[state.metric].label} 相对改善`;
    $("improvement-value").textContent = pairs.length ? `${mean(pairs.map(p => p.value)) >= 0 ? "+" : ""}${mean(pairs.map(p => p.value)).toFixed(1)}%` : "—";
    const max = Math.max(1, ...pairs.map(p => Math.abs(p.value)));
    $("improvement-chart").innerHTML = pairs.length ? pairs.map(p => `<div class="improvement-row ${p.value < 0 ? "negative" : ""}" title="${escapeHTML(`${p.label} · ${p.stain} · ${p.version}`)}"><span>${escapeHTML(p.label)}${new Set(pairs.map(p => p.stain)).size > 1 ? " · " + escapeHTML(p.stain) : ""} · ${escapeHTML(p.version)}</span><div class="improvement-track"><i style="width:${Math.abs(p.value) / max * 100}%"></i></div><b>${p.value >= 0 ? "+" : ""}${p.value.toFixed(1)}%</b></div>`).join("") : '<p style="font-size:11px;line-height:1.8">暂无配对结果。请同时保留 MDCL 与 MDCL + CCSDG，并提供相同版本的指标。</p>';
    $("improvement-note").textContent = pairs.length ? `${pairs.length} 组配对 · 正数表示改善，负数表示退步。按相同数据集、染色和版本配对后取相对变化均值。` : "仅比较相同数据集、染色和版本；基线为 0 时不计算相对变化。";
  }
  function renderTable(rows) {
    const best = Object.fromEntries(Object.keys(METRICS).map(m => { const v = rows.map(r => r[m]).filter(v => v != null); return [m, v.length ? (METRICS[m].direction === 1 ? Math.max(...v) : Math.min(...v)) : null]; }));
    $("results-body").innerHTML = sortedRows(rows).map(r => `<tr title="${escapeHTML(r.notes || "")}"><td class="experiment-id">${escapeHTML(r.experiment_id)}</td><td><div class="model-cell"><span class="model-dot" style="background:${color(r.model)}"></span><div>${escapeHTML(r.model)}<small>${escapeHTML(r.version)}</small></div></div></td><td>${escapeHTML(r.dataset)}</td><td><span class="stain-badge">${escapeHTML(r.stain)}</span></td>${["ssim", "psnr", "fid"].map(m => `<td class="numeric ${r[m] != null && r[m] === best[m] ? "best-value" : ""}">${fmt(r[m], m)}</td>`).join("")}<td><span class="source-badge ${state.mode === "demo" ? "demo" : ""}">${escapeHTML(state.mode === "demo" ? "示例数据" : r.source || "CSV 导入")}</span></td></tr>`).join("") || '<tr><td colspan="8">' + empty("未找到匹配的实验", "尝试调整筛选条件或清空搜索。") + "</td></tr>";
    $("table-count").textContent = rows.length;
    $("table-summary").textContent = `显示 ${rows.length} / ${state.rows.length} 条实验 · ${state.mode === "demo" ? "演示数据" : "实验数据"}`;
    $("export-results").disabled = !rows.length;
    document.querySelectorAll("[data-sort]").forEach(b => b.parentElement.setAttribute("aria-sort", b.dataset.sort === state.sort ? (state.ascending ? "ascending" : "descending") : "none"));
  }
  function setupTraining(rows) {
    const previous = $("training-experiment").value;
    const ids = new Set(state.curves.map(r => r.experiment_id));
    const available = rows.filter(r => ids.has(r.experiment_id));
    $("training-experiment").replaceChildren(...(available.length ? available.map(r => new Option(`${r.experiment_id} · ${r.model} · ${r.dataset} · ${r.stain}`, r.experiment_id)) : [new Option("暂无匹配的训练日志", "")]));
    if (available.some(r => r.experiment_id === previous)) $("training-experiment").value = previous;
    $("training-experiment").disabled = !available.length;
    renderTraining();
  }
  function renderTraining() {
    const id = $("training-experiment").value, metric = $("training-metric").value;
    const points = state.curves.filter(r => r.experiment_id === id).sort((a, b) => a.epoch - b.epoch), valid = points.filter(p => p[metric] != null);
    $("curve-caption").textContent = valid.length ? `${state.mode === "demo" ? "演示曲线 · " : ""}${valid.length} 个有效记录点` : "";
    if (!valid.length) { $("training-chart").innerHTML = empty("暂无训练曲线", points.length ? "此实验未提供所选训练指标，请切换指标或补充日志。" : "导入包含 experiment_id 与 epoch 的 training.csv，查看 loss 与验证指标随训练的变化。", state.mode !== "demo"); return; }
    const w = 1000, h = 240, left = 52, right = 24, top = 20, bottom = 34;
    const xMin = Math.min(...points.map(p => p.epoch)), xMax = Math.max(...points.map(p => p.epoch));
    let yMin = Math.min(...valid.map(p => p[metric])), yMax = Math.max(...valid.map(p => p[metric]));
    const pad = (yMax - yMin || Math.abs(yMax) || 1) * .12; yMin -= pad; yMax += pad;
    const x = v => xMin === xMax ? w / 2 : left + (v - xMin) / (xMax - xMin) * (w - left - right);
    const y = v => top + (yMax - v) / (yMax - yMin) * (h - top - bottom);
    let svg = `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHTML(id)} 的 ${escapeHTML(metric)} 训练曲线"><title>${escapeHTML(id)} · ${escapeHTML(metric)}，悬停记录点查看 epoch 与数值</title>`;
    for (let i = 0; i <= 4; i++) { const v = yMin + (yMax - yMin) * i / 4, yy = y(v); svg += `<line class="grid" x1="${left}" x2="${w - right}" y1="${yy}" y2="${yy}"/><text x="${left - 10}" y="${yy + 3}" text-anchor="end">${v.toFixed(Math.abs(v) < 2 ? 3 : 1)}</text>`; }
    const ticks = [...new Set(Array.from({ length: 6 }, (_, i) => Math.round(xMin + (xMax - xMin) * i / 5)))];
    ticks.forEach(v => svg += `<text x="${x(v)}" y="${h - 15}" text-anchor="middle">${v}</text>`);
    let path = "", connected = false;
    points.forEach(p => { if (p[metric] == null) { connected = false; return; } path += `${connected ? "L" : "M"}${x(p.epoch)},${y(p[metric])} `; connected = true; });
    svg += `<path d="${path}" stroke="#598362" stroke-width="2.5" fill="none" stroke-linejoin="round"/>`;
    valid.forEach(p => svg += `<circle cx="${x(p.epoch)}" cy="${y(p[metric])}" r="4" fill="#fff" stroke="#6f956b" stroke-width="2"><title>Epoch ${p.epoch} · ${escapeHTML(metric)}: ${p[metric]}</title></circle>`);
    $("training-chart").innerHTML = svg + `<text class="axis-title" x="${w - right}" y="${h - 2}" text-anchor="end">EPOCH</text></svg>`;
  }
  function render() { const rows = visibleRows(); renderStats(rows); renderComparison(rows); renderImprovements(rows); renderTable(rows); setupTraining(rows); }
  async function fetchCSV(path, kind) { const response = await fetch(new URL(path, document.baseURI), { cache: "no-store" }); if (!response.ok) throw new Error(`${path} 读取失败（HTTP ${response.status}）。`); return validateCSV(await response.text(), kind); }
  async function loadMode(mode) {
    const request = ++state.request;
    [$("real-mode"), $("demo-mode"), $("reload-data")].forEach(b => b.disabled = true);
    try {
      const prefix = mode === "demo" ? "demo-" : "";
      const [results, curves] = await Promise.allSettled([fetchCSV(prefix + "results.csv", "results"), fetchCSV(prefix + "training.csv", "curves")]);
      if (request !== state.request) return;
      if (results.status === "rejected") throw results.reason;
      const curveRows = curves.status === "fulfilled" ? curves.value : [];
      const ids = new Set(results.value.map(r => r.experiment_id)), orphanCount = curveRows.filter(r => !ids.has(r.experiment_id)).length;
      Object.assign(state, { rows: results.value, curves: curveRows.filter(r => ids.has(r.experiment_id)), mode, source: prefix + "results.csv" });
      filters.forEach(f => $("filter-" + f).value = ""); $("search").value = "";
      setupFilters(); updateNotice(curves.status === "rejected" ? `训练日志未加载：${curves.reason.message}` : orphanCount ? `已忽略 ${orphanCount} 条未关联实验的训练记录。` : ""); render();
    } catch (error) {
      $("notice").className = "notice error";
      $("notice").textContent = `加载失败：${error.message} 请通过本地 HTTP 服务或 GitHub Pages 打开页面，也可点击「导入 CSV」。${state.rows.length ? " 当前保留上一次已加载的数据。" : ""}`;
      render();
    } finally { if (request === state.request) [$("real-mode"), $("demo-mode"), $("reload-data")].forEach(b => b.disabled = false); }
  }
  async function importFile(file, kind) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast("CSV 请控制在 10 MB 以内。"); return; }
    try {
      const rows = validateCSV(await file.text(), kind);
      if (!rows.length && kind === "results") throw new Error("实验 CSV 没有数据记录。");
      if (kind === "results") {
        ++state.request;
        Object.assign(state, { rows, curves: [], mode: "import", source: file.name });
        [$("real-mode"), $("demo-mode"), $("reload-data")].forEach(b => b.disabled = false);
        filters.forEach(f => $("filter-" + f).value = ""); $("search").value = ""; setupFilters(); updateNotice("本地导入仅在当前会话生效；请另外导入对应训练日志。");
      } else {
        const ids = new Set(state.rows.map(r => r.experiment_id));
        if (rows.some(r => !ids.has(r.experiment_id))) throw new Error("训练日志含有未关联的 experiment_id，请先导入对应实验表。");
        state.curves = rows;
      }
      render(); toast(`已导入 ${rows.length} 条${kind === "results" ? "实验" : "训练"}记录。`);
    } catch (error) { toast(`导入失败：${error.message}`); }
  }
  filters.forEach(f => $("filter-" + f).addEventListener("change", render));
  $("search").addEventListener("input", render);
  $("reset-filters").addEventListener("click", () => { filters.forEach(f => $("filter-" + f).value = ""); $("search").value = ""; render(); });
  document.querySelectorAll("[data-metric]").forEach(b => b.addEventListener("click", () => { state.metric = b.dataset.metric; document.querySelectorAll("[data-metric]").forEach(t => { t.classList.toggle("selected", t === b); t.setAttribute("aria-pressed", String(t === b)); }); render(); }));
  document.querySelectorAll("[data-sort]").forEach(b => b.addEventListener("click", () => { state.ascending = state.sort === b.dataset.sort ? !state.ascending : !["ssim", "psnr"].includes(b.dataset.sort); state.sort = b.dataset.sort; renderTable(visibleRows()); }));
  $("real-mode").addEventListener("click", () => loadMode("real")); $("demo-mode").addEventListener("click", () => loadMode("demo"));
  $("reload-data").addEventListener("click", () => loadMode(state.mode === "demo" ? "demo" : "real"));
  $("training-experiment").addEventListener("change", renderTraining); $("training-metric").addEventListener("change", renderTraining);
  $("import-results").addEventListener("click", () => $("results-file").click()); $("import-curves").addEventListener("click", () => $("curves-file").click());
  $("results-file").addEventListener("change", async e => { await importFile(e.target.files[0], "results"); e.target.value = ""; });
  $("curves-file").addEventListener("change", async e => { await importFile(e.target.files[0], "curves"); e.target.value = ""; });
  $("training-chart").addEventListener("click", e => { if (e.target.closest("[data-show-demo]")) loadMode("demo"); });
  $("export-results").addEventListener("click", () => {
    const rows = sortedRows(visibleRows()); if (!rows.length) return;
    const fields = [...new Set([...RESULT_FIELDS, "source", "notes", ...rows.flatMap(r => Object.keys(r))])];
    const blob = new Blob([serializeCSV(rows, fields)], { type: "text/csv;charset=utf-8" }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `stainlab-${state.mode === "demo" ? "DEMO-" : ""}results.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(`已导出当前筛选的 ${rows.length} 条记录${state.mode === "demo" ? "（演示数据）" : ""}。`);
  });
  const navLinks = [...document.querySelectorAll("nav a")];
  function updateNavigation() {
    const current = [...navLinks].reverse().find(a => document.querySelector(a.getAttribute("href")).getBoundingClientRect().top <= 140) || navLinks[0];
    navLinks.forEach(a => { a.classList.toggle("active", a === current); if (a === current) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current"); });
  }
  window.addEventListener("scroll", updateNavigation, { passive: true }); updateNavigation(); loadMode("real");
}
