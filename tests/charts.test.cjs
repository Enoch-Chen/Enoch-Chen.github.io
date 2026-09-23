const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateCSV, comparisonData, comparisonSVG, tileStrength } = require('../app.js');
const row = (dataset, fid, extra = {}) => ({ dataset, fid, model: 'MDCL', version: 'v1', stain: 'HER2', ssim: .8, psnr: 25, ...extra });

test('shared comparison matrix averages repeated runs and preserves missing versus zero', () => {
  const data = comparisonData([row('BCI', 20), row('BCI', 40), row('MIST', null), row('BCI', 0, { model: 'Other' })], 'fid');
  assert.equal(data.groups.length, 2);
  assert.equal(data.series.length, 2);
  assert.deepEqual(data.cells, [[{ value: 30, count: 2 }, { value: null, count: 0 }], [{ value: 0, count: 1 }, { value: null, count: 0 }]]);
});

test('all three views display the same 24 original FID results', () => {
  const rows = validateCSV(fs.readFileSync(path.join(__dirname, '../results.csv'), 'utf8'));
  const data = comparisonData(rows, 'fid');
  for (const view of ['line', 'bar', 'tile']) {
    const svg = comparisonSVG(data, 'fid', view);
    assert.ok(svg.startsWith('<svg'));
    for (const row of rows) assert.ok(svg.includes(`FID: ${row.fid.toFixed(4)} (n=1)`));
    assert.ok(!svg.includes('NaN') && !svg.includes('Infinity'));
  }
});

test('line charts break at missing measurements and stain boundaries', () => {
  const data = comparisonData([row('A', 20), row('B', null), row('C', 30), row('D', 40, { stain: 'ER' })], 'fid');
  const svg = comparisonSVG(data, 'fid', 'line');
  const line = svg.match(/class="model-line" d="([^"]*)"/)[1];
  assert.equal((line.match(/M/g) || []).length, 3);
  assert.equal((line.match(/L/g) || []).length, 0);
  assert.equal((svg.match(/class="chart-point"/g) || []).length, 3);
});

test('heatmap colors respect direction, ties and missing values', () => {
  assert.equal(tileStrength(20, [20, 40, null], 'fid'), 1);
  assert.equal(tileStrength(40, [20, 40, null], 'fid'), 0);
  assert.equal(tileStrength(.9, [.7, .9], 'ssim'), 1);
  assert.equal(tileStrength(30, [20, 30], 'psnr'), 1);
  assert.equal(tileStrength(0, [0, 0], 'fid'), .5);
  assert.equal(tileStrength(null, [0, null], 'fid'), null);
  const svg = comparisonSVG(comparisonData([row('A', 0), row('B', null)], 'fid'), 'fid', 'tile');
  assert.ok(svg.includes('>0.0000</text>'));
  assert.ok(svg.includes('>—</text>'));
});

test('empty, single-point, equal and negative values generate valid finite graphics', () => {
  for (const metric of ['fid', 'ssim', 'psnr']) {
    for (const view of ['line', 'bar', 'tile']) {
      assert.equal(comparisonSVG(comparisonData([], metric), metric, view), '');
      assert.equal(comparisonSVG(comparisonData([row('A', null, { ssim: null, psnr: null })], metric), metric, view), '');
      const svg = comparisonSVG(comparisonData([row('A', 0, { ssim: -.2, psnr: -3 })], metric), metric, view);
      assert.ok(svg.includes('<svg') && !/NaN|Infinity/.test(svg));
    }
  }
});

test('imported labels are escaped in all chart views', () => {
  const data = comparisonData([row('<img src=x onerror="alert(1)">', 20)], 'fid');
  for (const view of ['line', 'bar', 'tile']) {
    const svg = comparisonSVG(data, 'fid', view);
    assert.ok(!svg.includes('<img'));
    assert.ok(svg.includes('&lt;img'));
  }
});
