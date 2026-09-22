const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCSV, validateCSV, serializeCSV, pairedImprovements } = require('../app.js');
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
test('training requires unique nonnegative integer epochs', () => {
  const h = 'experiment_id,epoch,loss,val_ssim,val_psnr,val_fid\n';
  for (const epoch of ['', '-1', '1.5', 'Infinity']) assert.throws(() => validateCSV(h + `E,${epoch},1,.8,26,30`, 'curves'));
  assert.throws(() => validateCSV(h + 'E,0,1,.8,26,30\nE,0,2,.8,26,30', 'curves'), /重复/);
  const [r] = validateCSV(h + 'E,0,0,,,', 'curves');
  assert.equal(r.epoch, 0); assert.equal(r.loss, 0); assert.equal(r.val_ssim, null);
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
test('paired comparisons respect dataset, stain and version, and metric direction', () => {
  const base = { dataset: 'BCI', stain: 'HER2', version: 'v1', model: 'MDCL', fid: 40, ssim: .5 };
  const module = { ...base, model: 'MDCL + CCSDG', fid: 30, ssim: .6 };
  assert.equal(pairedImprovements([base, module], 'fid')[0].value, 25);
  assert.ok(Math.abs(pairedImprovements([base, module], 'ssim')[0].value - 20) < 1e-10);
  for (const change of [{ dataset: 'MIST' }, { stain: 'ER' }, { version: 'v2' }]) {
    assert.equal(pairedImprovements([base, { ...module, ...change }], 'fid').length, 0);
  }
  assert.equal(pairedImprovements([{ ...base, fid: 0 }, module], 'fid').length, 0);
  assert.equal(pairedImprovements([{ ...base, fid: null }, module], 'fid').length, 0);
});
test('repeated runs are averaged within each side before pairing', () => {
  const base = { dataset: 'BCI', stain: 'ER', version: 'v1', model: 'MDCL', fid: 40 };
  const module = { ...base, model: 'MDCL + CCSDG', fid: 30 };
  assert.equal(pairedImprovements([base, { ...base, fid: 60 }, module], 'fid')[0].value, 40);
});
test('repository result and training files satisfy the documented schema', () => {
  for (const prefix of ['', 'demo-']) {
    const rows = validateCSV(read(prefix + 'results.csv'));
    const curves = validateCSV(read(prefix + 'training.csv'), 'curves');
    const ids = new Set(rows.map(r => r.experiment_id));
    assert.ok(rows.length > 0);
    for (const p of curves) assert.ok(ids.has(p.experiment_id), `orphan curve: ${p.experiment_id}`);
  }
});
test('bundled demo remains explicit and separate', () => {
  const demo = validateCSV(read('demo-results.csv'));
  const real = validateCSV(read('results.csv'));
  const realIDs = new Set(real.map(r => r.experiment_id));
  assert.ok(demo.every(r => r.experiment_id.startsWith('DEMO-') && r.source === '人工示例'));
  assert.ok(demo.every(r => !realIDs.has(r.experiment_id)));
  const curves = validateCSV(read('demo-training.csv'), 'curves');
  for (const row of demo) {
    const points = curves.filter(p => p.experiment_id === row.experiment_id);
    assert.ok(points.length > 1);
    assert.ok(Math.abs(points.at(-1).val_ssim - row.ssim) < .0001);
    assert.ok(Math.abs(points.at(-1).val_psnr - row.psnr) < .0001);
    assert.ok(Math.abs(points.at(-1).val_fid - row.fid) < .0001);
  }
});
