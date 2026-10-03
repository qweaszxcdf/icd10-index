import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HIERARCHY_MIN_LEVEL,
  ROOT_DIR,
  ROW_PARENT,
  ROW_SUBTREE_END,
  buildDataset,
  canonicalHeader,
  parseCsvText,
  resolveHeader,
} from "../workers/scripts/build.mjs";

test("markdown-like headers are canonicalized", () => {
  assert.equal(canonicalHeader("**in_situ"), "in_situ");
  assert.equal(canonicalHeader("**benign"), "benign");
  const resolved = resolveHeader([
    "image_page",
    "level",
    "chinese",
    "english",
    "code",
    "confidence",
    "malignant_primary",
    "malignant_secondary",
    "**in_situ",
    "**benign",
  ]);
  assert.equal(resolved.in_situ, 8);
  assert.equal(resolved.benign, 9);
});

test("level 0 and level 1 remain display parents while level 2 starts search-result ancestry", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "icd10-index-"));
  try {
    const inputPath = path.join(tempDir, "input.csv");
    await writeFile(
      inputPath,
      [
        "image_page,level,chinese,english,code,confidence,malignant_primary,malignant_secondary,in_situ,benign,uncertain_or_unspecified,parent,subtreeEnd",
        "1,0,A,,,,,,,,,999,999",
        "1,1,ā 阿,,,,,,,,,999,999",
        "1,2,阿词条,,E23.0,,,,,,,999,999",
        "1,3,阿词条子项,,E23.1,,,,,,,999,999",
        "1,2,另一个词条,,Q07.0,,,,,,,999,999",
      ].join("\n"),
      "utf8",
    );
    const { dataset, report } = await buildDataset([inputPath]);

    assert.equal(HIERARCHY_MIN_LEVEL, 2);
    assert.equal(dataset.rows[0][ROW_PARENT], -1);
    assert.equal(dataset.rows[0][ROW_SUBTREE_END], 5);
    assert.equal(dataset.rows[1][ROW_PARENT], 0);
    assert.equal(dataset.rows[1][ROW_SUBTREE_END], 5);
    assert.equal(dataset.rows[2][ROW_PARENT], 1);
    assert.equal(dataset.rows[2][ROW_SUBTREE_END], 4);
    assert.equal(dataset.rows[3][ROW_PARENT], 2);
    assert.equal(dataset.rows[3][ROW_SUBTREE_END], 4);
    assert.equal(dataset.rows[4][ROW_PARENT], 1);
    assert.equal(dataset.rows[4][ROW_SUBTREE_END], 5);
    assert.equal(dataset.meta.hierarchy_ignored_row_count, 2);
    assert.equal(report.warning_count, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("source parent/subtreeEnd columns are ignored", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "icd10-index-"));
  try {
    const inputPath = path.join(tempDir, "input.csv");
    await writeFile(
      inputPath,
      [
        "image_page,level,chinese,english,code,confidence,malignant_primary,malignant_secondary,in_situ,benign,uncertain_or_unspecified,parent,subtreeEnd",
        "1,2,A,,E23.0,,,,,,,999,999",
        "1,3,B,,E23.1,,,,,,,999,999",
      ].join("\n"),
      "utf8",
    );
    const { dataset, report } = await buildDataset([inputPath]);
    assert.equal(dataset.rows[0][ROW_PARENT], -1);
    assert.equal(dataset.rows[0][ROW_SUBTREE_END], 2);
    assert.equal(dataset.rows[1][ROW_PARENT], 0);
    assert.equal(dataset.rows[1][ROW_SUBTREE_END], 2);
    assert.equal(report.warning_count, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("source cross-reference targets are not obviously truncated", async () => {
  const sourceDir = path.join(ROOT_DIR, "data", "source");
  const sourceFiles = (await readdir(sourceDir))
    .filter((name) => /^rows-p\d+-\d+\.csv$/u.test(name))
    .sort();

  const problems = [];
  for (const fileName of sourceFiles) {
    const records = parseCsvText(await readFile(path.join(sourceDir, fileName), "utf8"));
    records.shift();

    for (const row of records) {
      const page = String(row[0] || "");
      const chinese = String(row[2] || "").trim();
      const english = String(row[3] || "").trim();

      const englishTruncated =
        /\bsee(?:\s+also)?\s*$/iu.test(english)
        || /\bsee(?:\s+also)?\s+[^;\n]*,\s*$/iu.test(english)
        || /\bsee(?:\s+also)?\s+[^;\n]*(?:\bupp|\bpulmona|\bmaligna|\bmaligi|\bmalignan|\bconnective|\bby|\bthe)\s*$/iu.test(english);
      const chineseTruncated =
        /(?:另见|参见|见)\s*[^；;\n]*[，,]\s*$/u.test(chinese);

      if (englishTruncated || chineseTruncated) {
        problems.push({ fileName, page, chinese, english });
      }
    }
  }

  assert.deepEqual(problems, []);
});
