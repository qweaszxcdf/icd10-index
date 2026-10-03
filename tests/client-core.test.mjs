import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ROW_CODE,
  ROW_ENGLISH,
  extractReferencesFromText,
  findSearchIndices,
  locateIndex,
} from "../static/client-core.mjs";

const datasetPath = new URL("../workers/public/data/dataset.json", import.meta.url);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));

test("Chinese references work without whitespace after 见/另见", () => {
  const refs = extractReferencesFromText(
    "主动脉冠状动脉(搭桥术)移植物-见并发症，冠状动脉(搭桥术)移植物",
    "zh",
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, "并发症，冠状动脉(搭桥术)移植物");
});

test("见于 is an index phrase, not a cross-reference marker", () => {
  assert.deepEqual(extractReferencesFromText("见于(由于)", "zh"), []);
  assert.deepEqual(extractReferencesFromText("见于糖尿病母亲的婴儿", "zh"), []);
  const refs = extractReferencesFromText("见三体性，13", "zh");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, "三体性，13");
});

test("reference parser preserves balanced parentheses in English targets", () => {
  const refs = extractReferencesFromText(
    "aortocoronary (bypass) graft - see Complications, coronary artery (bypass) graft",
    "en",
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, "Complications, coronary artery (bypass) graft");
});

test("reference parser stops at an outer parenthesis only", () => {
  const refs = extractReferencesFromText(
    "x (see Complications, coronary artery (bypass) graft)",
    "en",
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, "Complications, coronary artery (bypass) graft");
});

test("multi-part locate resolves fixation device internal to T84.9", () => {
  const index = locateIndex(dataset, "Complications, fixation device, internal");
  assert.ok(index >= 0);
  assert.equal(dataset.rows[index][ROW_ENGLISH], "fixation device, internal (orthopedic)");
  assert.equal(dataset.rows[index][ROW_CODE], "T84.9");
});

test("auto comma search keeps the canonical path plus other rows that directly match all query tokens", () => {
  const indices = findSearchIndices(dataset, "Complications,fixation device, internal", "auto");
  assert.ok(indices.length >= 1);
  assert.equal(dataset.rows[indices[0]][ROW_ENGLISH], "fixation device, internal (orthopedic)");
  assert.equal(dataset.rows[indices[0]][ROW_CODE], "T84.9");

  const unique = new Set(indices);
  assert.equal(unique.size, indices.length);

  for (const index of indices.slice(1)) {
    const text = String(dataset.rows[index][12] || "").toLowerCase();
    for (const token of ["complications", "fixation", "device", "internal"]) {
      assert.ok(text.includes(token), `row ${index} should directly contain ${token}`);
    }
  }

  assert.ok(!indices.some((index) => dataset.rows[index][ROW_CODE] === "T84.6"));
  assert.ok(!indices.some((index) => dataset.rows[index][ROW_CODE] === "T84.2"));
  assert.ok(!indices.some((index) => dataset.rows[index][ROW_CODE] === "T84.1"));
  assert.ok(!indices.some((index) => dataset.rows[index][ROW_CODE] === "T84.8"));
});

test("auto search falls back to ordinary text search when a comma-separated path is invalid", () => {
  const indices = findSearchIndices(dataset, "definitely-not-a-real-parent, child", "auto");
  assert.deepEqual(indices, []);
});


test("multi-part locate resolves parenthesized coronary graft target", () => {
  const index = locateIndex(dataset, "Complications, coronary artery (bypass) graft");
  assert.ok(index >= 0);
  assert.match(dataset.rows[index][ROW_ENGLISH], /^coronary artery \(bypass\) graft/i);
});

test("incomplete multi-part locate fails instead of using a shallow fallback", () => {
  assert.equal(locateIndex(dataset, "Complications, definitely-not-a-real-child"), -1);
});

test("code mode remains a prefix search when an exact code exists", () => {
  const indices = findSearchIndices(dataset, "E23", "code");
  const codes = new Set(indices.map((index) => dataset.rows[index][ROW_CODE]));
  assert.ok(codes.has("E23.0"));
  assert.ok([...codes].some((code) => String(code).startsWith("E23.") && code !== "E23.0"));
});

test("known split references are merged in source data", () => {
  const byChinese = (text) => dataset.rows.find((row) => String(row[2] || "") === text);

  assert.equal(
    byChinese("黑釉质母细胞瘤[黑素性釉质母细胞瘤](M9363/0)-见肿瘤，骨，良性")?.[3],
    "Melanoameloblastoma (M9363/0) - see Neoplasm, bone, benign",
  );
  assert.equal(
    byChinese("淋巴瘤性乳头状囊腺瘤[沃辛瘤](M8561/0)-见肿瘤，涎腺，良性")?.[3],
    "Warthin's tumor (M8561/0) - see Neoplasm, salivary gland, benign",
  );
  assert.equal(
    byChinese("帕特南(-达纳)病或综合征[亚急性脊髓联合变性]-见变性，混合")?.[3],
    "Putnam(-Dana) disease or syndrome - see Degeneration, combined",
  );
});
