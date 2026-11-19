正式 ICD-10 索引按影像页范围拆分，每 50 页一个 CSV。例如：

```text
rows-p0001-0050.csv
rows-p0051-0100.csv
...
rows-p1451-1500.csv
```

每个文件都保留相同的表头。页码范围写入文件名，补足四位数字；默认构建会按文件名顺序合并所有分片，便于按页段审阅和比较变更。

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
