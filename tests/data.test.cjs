const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCSV, validateCSV, serializeCSV } = require('../app.js');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const header = 'experiment_id,dataset,stain,model,version,ssim,psnr,fid';
const record = 'E-1,BCI,HER2,MDCL,v1,0.8,26,30';

test('CSV handles BOM, CRLF, quoted commas, escaped quotes and multiline fields', () => {
  const csv = '\uFEFFid,notes\r\n1,"hello, ""world""\n下一行"\r\n\r\n';
  assert.deepEqual(parseCSV(csv).rows, [{ id: '1', notes: 'hello, "world"\n下一行' }]);
});
test('malformed CSV is rejected before replacing existing data', () => {
  for (const csv of ['', 'a,a\n1,2', ',b\n1,2', 'a,b\n1', 'a,b\n"x,y', 'a,b\n"x"oops,y']) {
    assert.throws(() => parseCSV(csv));
  }
});
test('numeric zero stays zero while missing metrics stay null', () => {
  const [row] = validateCSV(header + '\nE-1,BCI,HER2,MDCL,v1,0,,0');
  assert.equal(row.ssim, 0); assert.equal(row.psnr, null); assert.equal(row.fid, 0);
});
test('scientific notation, negative SSIM and negative PSNR are supported', () => {
  const [row] = validateCSV(header + '\nE-1,BCI,HER2,MDCL,v1,-.2,-3,3e1');
  assert.equal(row.ssim, -.2); assert.equal(row.psnr, -3); assert.equal(row.fid, 30);
});
test('missing headers, IDs and duplicate IDs are rejected', () => {
  assert.throws(() => validateCSV('experiment_id,fid\nE,3'), /缺少字段/);
  assert.throws(() => validateCSV(header + '\n' + record.replace('E-1', '')), /不可为空/);
  assert.throws(() => validateCSV(header + '\n' + record + '\n' + record), /重复/);
});
test('invalid metric ranges and non-finite numbers are rejected', () => {
  for (const metrics of ['1.01,26,30', '-1.01,26,30', '.8,26,-1', '.8,Infinity,30', '.8,26,NaN', '.8,26,1e999', '.8,26,0xFF']) {
    assert.throws(() => validateCSV(header + '\nE-1,BCI,HER2,MDCL,v1,' + metrics));
  }
});

test('all six metrics parse, while older CSV files remain supported', () => {
  const fullHeader = 'experiment_id,dataset,stain,model,version,fid,kid,ssim,psnr,lpips,dists';
  const [row] = validateCSV(fullHeader + '\nE-1,MIST,,MDCL,,32.0328,0.0123,0.8,26.5,0.14,0.09');
  assert.deepEqual([row.fid, row.kid, row.ssim, row.psnr, row.lpips, row.dists], [32.0328, 0.0123, 0.8, 26.5, 0.14, 0.09]);
  for (const metric of ['kid', 'lpips', 'dists']) {
    const invalid = { ...row, [metric]: -0.01 };
    assert.throws(() => validateCSV(serializeCSV([invalid], Object.keys(invalid))), new RegExp(metric));
  }
  assert.equal(validateCSV(header + '\n' + record)[0].kid, undefined);
});

test('unfinished placeholders are skipped, but measured rows still need a model', () => {
  const fields = ['experiment_id', 'dataset', 'stain', 'model', 'version', 'fid', 'kid', 'ssim', 'psnr', 'lpips', 'dists'];
  const draft = { experiment_id: 'DRAFT', dataset: 'MIST', stain: 'ER', model: '', version: '', fid: null };
  assert.deepEqual(validateCSV(serializeCSV([draft], fields)), []);
  assert.throws(() => validateCSV(serializeCSV([{ ...draft, fid: 34.6105 }], fields)), /model 不可为空/);
});

test('export roundtrips quotes, Unicode, nulls and extra columns', () => {
  const row = { experiment_id: 'E', dataset: 'BCI', stain: 'HER2', model: '模型,"A"', version: 'v1', ssim: null, psnr: -3, fid: 0, notes: '第一行\n第二行' };
  assert.deepEqual(validateCSV(serializeCSV([row], Object.keys(row))), [row]);
});
test('export neutralizes spreadsheet formulas in imported text', () => {
  const csv = serializeCSV([{ a: '=HYPERLINK("bad")', b: '+cmd', c: '@SUM(1)', d: -3 }], ['a', 'b', 'c', 'd']);
  const [row] = parseCSV(csv).rows;
  assert.equal(row.a[0], "'"); assert.equal(row.b[0], "'"); assert.equal(row.c[0], "'"); assert.equal(row.d, '-3');
});

test('six named data groups have valid CSV templates', () => {
  for (const name of ['mist-main', 'ihc4bc-main', 'tianjin-main', 'mist-extrapolation', 'ihc4bc-extrapolation', 'tianjin-extrapolation']) {
    const csv = read(`data/${name}.csv`);
    assert.ok(Array.isArray(validateCSV(csv)));
    for (const metric of ['fid', 'kid', 'ssim', 'psnr', 'lpips', 'dists']) assert.ok(csv.split('\n')[0].includes(metric));
  }
});
