import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HIERARCHY_MIN_LEVEL,
  ROW_PARENT,
  ROW_SUBTREE_END,
  buildDataset,
  canonicalHeader,
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

test("level 0 and level 1 are excluded from hierarchy calculation", async () => {
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
    assert.equal(dataset.rows[0][ROW_SUBTREE_END], 1);
    assert.equal(dataset.rows[1][ROW_PARENT], -1);
    assert.equal(dataset.rows[1][ROW_SUBTREE_END], 2);
    assert.equal(dataset.rows[2][ROW_PARENT], -1);
    assert.equal(dataset.rows[2][ROW_SUBTREE_END], 4);
    assert.equal(dataset.rows[3][ROW_PARENT], 2);
    assert.equal(dataset.rows[3][ROW_SUBTREE_END], 4);
    assert.equal(dataset.rows[4][ROW_PARENT], -1);
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
