将正式 ICD-10 索引 CSV 放在本目录。

默认构建规则：

- 若存在非 `.sample.` CSV，只读取正式 CSV。
- 若只有样例文件，则使用样例生成演示数据。
- CSV 中原有的 `parent`、`subtreeEnd` 会被忽略。
- 根据行顺序和 `level` 重新构建树结构。

默认构建：

```bash
node workers/scripts/build.mjs
```

显式指定文件：

```bash
node workers/scripts/build.mjs --input data/source/icd10_index.csv
```
