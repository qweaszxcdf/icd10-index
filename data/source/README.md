正式 ICD-10 索引按影像页范围拆分，每 50 页一个 CSV。例如：

```text
rows-p0001-0050.csv
rows-p0051-0100.csv
...
rows-p1451-1500.csv
```

每个文件都保留相同的表头。页码范围写入文件名，补足四位数字；默认构建会按文件名顺序合并所有分片，便于按页段审阅和比较变更。

## 数据校订依据

使用 NHS Classifications Browser 的 ICD-10 第五版第三卷复核 OCR 数据。按英文词条、父级路径和原表相邻行确认错码、串行、分栏和缩进。中国版与 NHS 版存在编码差异，遇到版本差异或对应关系不明确时保留原记录。双重编码使用本库约定的 `+` 和 `*`。

- 影像页 797–851 的围生期词条层级，参照 [NHS 围生期索引](https://classbrowser.nhs.uk/ICD-10-5TH-Edition/vol3/KRA_C.html#S109791)。
- 影像页 1264 的移位词条，以及影像页 1330 的术后粘连词条，参照 [NHS 移位索引](https://classbrowser.nhs.uk/ICD-10-5TH-Edition/vol3/KRA_D.html#ICD10_5th_DSP_KRA_D_54530)和 [NHS 术后粘连索引](https://classbrowser.nhs.uk/ICD-10-5TH-Edition/vol3/KRA_A.html#ICD10_5th_DSP_KRA_A_20381)。
- 肿瘤编码按原发恶性、继发恶性、原位、良性及性质未定五栏核对，编码修正后同步更新 `code` 字段。参照 [NHS 肿瘤索引](https://classbrowser.nhs.uk/ICD-10-5TH-Edition/vol3/KRA_N.html#S153782)。

## 构建

默认构建规则：

- 若存在非 `.sample.` CSV，只读取正式 CSV。
- 若只有样例文件，则使用样例生成演示数据。
- CSV 中原有的 `parent`、`subtreeEnd` 会被忽略。
- 根据行顺序和 `level` 重新构建树结构。

默认构建：

```bash
node workers/scripts/build.mjs
```

默认构建会读取本目录全部正式 CSV。显式指定文件时，只会构建列出的分片：

```bash
node workers/scripts/build.mjs \
  --input data/source/rows-p0001-0050.csv \
  --input data/source/rows-p0051-0100.csv
```
