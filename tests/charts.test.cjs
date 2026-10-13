const { test } = require('node:test');
const assert = require('node:assert/strict');
const { comparisonData, comparisonSVG, tileStrength, rowsForStain } = require('../app.js');
const row = (dataset, fid, extra = {}) => ({ dataset, fid, model: 'MDCL', version: 'v1', stain: 'HER2', ssim: .8, psnr: 25, ...extra });

test('shared comparison matrix averages repeated runs and preserves missing versus zero', () => {
  const data = comparisonData([row('BCI', 20), row('BCI', 40), row('MIST', null), row('BCI', 0, { model: 'Other' })], 'fid');
  assert.equal(data.groups.length, 2);
  assert.equal(data.series.length, 2);
  assert.deepEqual(data.cells, [[{ value: 30, count: 2 }, { value: null, count: 0 }], [{ value: 0, count: 1 }, { value: null, count: 0 }]]);
});

test('all three views display the same supplied FID results', () => {
  const rows = [row('MIST', 32.0328), row('MIST', 31.419, { model: 'MDCL + CCSDG' }), row('IHC4BC', 47.5187)];
  const data = comparisonData(rows, 'fid');
  for (const view of ['line', 'bar', 'tile']) {
    const svg = comparisonSVG(data, 'fid', view);
    assert.ok(svg.startsWith('<svg'));
    for (const row of rows) assert.ok(svg.includes(`FID: ${row.fid.toFixed(4)} (n=1)`));
    assert.ok(!svg.includes('NaN') && !svg.includes('Infinity'));
  }
});

test('stain selection limits rows and matches Ki67 case-insensitively', () => {
  const rows = ['ER', 'PR', 'HER2', 'Ki67'].map((stain, index) => row(`D${index}`, index, { stain }));
  for (const stain of ['ER', 'PR', 'HER2', 'KI67']) {
    assert.equal(rowsForStain(rows, stain).length, 1);
  }
  assert.equal(rowsForStain(rows, 'KI67')[0].stain, 'Ki67');
});

test('line charts break at missing measurements and stain boundaries', () => {
  const data = comparisonData([row('A', 20), row('B', null), row('C', 30), row('D', 40, { stain: 'ER' })], 'fid');
  const svg = comparisonSVG(data, 'fid', 'line');
  const line = svg.match(/class="model-line" d="([^"]*)"/)[1];
  assert.equal((line.match(/M/g) || []).length, 3);
  assert.equal((line.match(/L/g) || []).length, 0);
  assert.equal((svg.match(/class="chart-point"/g) || []).length, 3);
});

test('tile colors mark the top two distinct values per column', () => {
  assert.equal(tileStrength(20, [20, 40, null], 'fid'), 1);
  assert.equal(tileStrength(40, [20, 40, null], 'fid'), .5);
  assert.equal(tileStrength(60, [20, 40, 60], 'fid'), 0);
  assert.equal(tileStrength(.9, [.7, .9], 'ssim'), 1);
  assert.equal(tileStrength(.7, [.7, .9], 'ssim'), .5);
  assert.equal(tileStrength(30, [20, 30], 'psnr'), 1);
  assert.equal(tileStrength(0, [0, 0], 'fid'), 1);
  assert.equal(tileStrength(20, [20, 20, 30, 40], 'fid'), 1);
  assert.equal(tileStrength(30, [20, 20, 30, 40], 'fid'), .5);
  assert.equal(tileStrength(null, [0, null], 'fid'), null);
  for (const metric of ['kid', 'lpips', 'dists']) assert.equal(tileStrength(0.1, [0.1, 0.2], metric), 1);
  const svg = comparisonSVG(comparisonData([
    row('A', 0), row('A', 1, { model: 'Second' }),
    row('A', 2, { model: 'Third' }), row('B', null),
  ], 'fid'), 'fid', 'tile');
  for (const color of ['#256546', '#b9d4bf', '#f7f8f6', '#edf0ee']) assert.ok(svg.includes(`fill="${color}"`));
  assert.ok(svg.includes('>0.0000</text>'));
  assert.ok(svg.includes('>—</text>'));
});

test('empty, single-point, equal and negative values generate valid finite graphics', () => {
  for (const metric of ['fid', 'kid', 'ssim', 'psnr', 'lpips', 'dists']) {
    for (const view of ['line', 'bar', 'tile']) {
      assert.equal(comparisonSVG(comparisonData([], metric), metric, view), '');
      assert.equal(comparisonSVG(comparisonData([row('A', null, { kid: null, ssim: null, psnr: null, lpips: null, dists: null })], metric), metric, view), '');
      const svg = comparisonSVG(comparisonData([row('A', 0, { kid: 0, ssim: -.2, psnr: -3, lpips: 0, dists: 0 })], metric), metric, view);
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
