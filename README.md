# StainLab · H&E → IHC 实验指标看板

无需构建、无需后端、无需 CDN 的静态网站，支持 GitHub Pages。界面使用中文，适配桌面与手机。

- 按数据集、染色、模型、版本筛选，并搜索实验 ID 和备注。
- SSIM、PSNR、FID 排序、最佳值概览与分组模型对比。
- MDCL / MDCL + CCSDG 的配对指标变化。
- 单实验 loss、验证 SSIM / PSNR / FID 的 epoch 曲线。
- 本地 CSV 导入预览，以及导出当前筛选与排序结果。

## 本地预览

在仓库目录运行：

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

打开 http://127.0.0.1:8000 。请通过 HTTP 打开；双击 HTML 时浏览器通常会阻止 fetch 读取旁边的 CSV，但仍可手动导入。

## 文件

| 文件 | 用途 |
| --- | --- |
| `index.html` | 页面结构与数据格式说明 |
| `style.css` | 响应式样式 |
| `app.js` | CSV 解析、校验、筛选、排序与 SVG 图表 |
| `results.csv` | 每行一个实验结果 |
| `training.csv` | 每行一个实验的某个 epoch；当前只有表头 |
| `demo-results.csv` / `demo-training.csv` | 单独切换的人工演示数据 |
| `draw_figure.py` | 原有绘图脚本，保留原样 |

## 当前数据的来源与限制

`results.csv` 的 24 个 FID 数值原样取自 `draw_figure.py` **未注释的** `y1_data` 至 `y4_data`。模型依次对应原始 MDCL、MDCL 加 ccsdg、PGVMS 官方 checkpoint、USIGAN 官方 checkpoint；数据集保留原脚本名称，包括 `M_ACRBOAT` 的原始拼写。

脚本标题为 `Ki67 FID`，输出文件却为 `ER FID.html`，因此所有记录的 `stain` 均标为 `待确认`，不推断实际染色。请确认后修改该列。脚本没有 SSIM、PSNR、epoch 日志，故这些指标留空。`version` 的「原脚本」「官方 checkpoint」只是来源标签，需替换成实际实验版本。配对展示不证明训练配置或评估协议完全相同。

演示数据具有 `DEMO-` ID、人工示例来源和页面提示，与默认实验数据分开加载。不要用于论文或真实结果汇报。

## 新增实验

更新 `results.csv`，保留表头；每行使用唯一 `experiment_id`。必需字段：

```csv
experiment_id,dataset,stain,model,version,ssim,psnr,fid
```

文本字段不可空。指标缺失留空，**不要填 0 来表示缺失**。SSIM 接受 −1 到 1，PSNR 单位 dB，FID 不小于 0；支持科学计数法，可选 `source` 和 `notes`。包含逗号、引号、换行的文本按标准 CSV 引号规则转义。支持 UTF-8、BOM、CRLF 和 LF。

`training.csv` 表头：

```csv
experiment_id,epoch,loss,val_ssim,val_psnr,val_fid
```

`experiment_id` 必须关联实验表；`epoch` 为非负整数，同实验不可重复。指标允许留空，空值产生断点，不会补零。日志按 epoch 排序。训练下拉框只展示当前筛选范围内有日志的实验。

「导入 CSV」只在当前会话预览，不会上传、覆盖仓库或持久保存；导入新实验表会清空旧训练日志，避免错误关联。单文件上限 10 MB。刷新恢复仓库数据。若要长期更新，请修改 CSV 并提交到仓库。「导出结果」导出当前筛选后的记录并保留排序、备注和额外列，演示模式文件名包含 DEMO；导出文本中的公式前缀会加单引号，避免表格软件将其作为公式执行。

## 对比规则

- 顶部最佳值仅描述当前筛选范围，跨数据集不直接作为模型排名。
- 柱形按「数据集 × 染色」分组，按「模型 × 版本」分系列；重复运行以算术平均展示，悬停显示 n。
- 模块变化只匹配 `MDCL` 与 `MDCL + CCSDG`，按「数据集 × 染色 × 版本」配对；各侧重复运行先取均值。FID 改善 = `(baseline − module) / abs(baseline)`；SSIM / PSNR 改善 = `(module − baseline) / abs(baseline)`，最后按分组等权平均。基线为 0 的组跳过。此汇总不表示统计显著性。
- 训练图展示已记录 epoch；同一行的缺失指标中断连线，不自动插值。

## GitHub Pages

1. 将仓库的 **Settings → Pages → Build and deployment → Source** 设为 **GitHub Actions**。
2. 将这些文件提交并推送到 `main`。如果默认分支不同，修改 `.github/workflows/main.yml` 的触发分支。
3. `Deploy StainLab to GitHub Pages` 工作流先运行数据检查，再发布页面。部署完成后在 Pages 设置或 Actions 的 deployment 中打开地址。

仅白名单内的网站文件会发布，不会发布 Python 脚本、编辑器配置或测试文件。页面使用相对路径，同时支持个人主页根路径和项目站点子路径。更新 CSV 后推送即可重新部署。本次实现不自动提交、推送或修改远程仓库设置。

## 校验

安装 Node.js 后运行，无需 npm install：

```bash
node --test tests/data.test.cjs
```

覆盖 CSV 解析、无效数据、缺失值、导出安全、配对计算、默认及演示数据与训练日志关联。
