import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ROW_CHINESE,
  ROW_CODE,
  ROW_ENGLISH,
  ROW_IMAGE_PAGE,
  ROW_MALIGNANT_SECONDARY,
  ROW_PARENT,
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
  const byChinese = (text) => dataset.rows.find((row) => row[ROW_CHINESE] === text.normalize("NFKC"));

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

test("perinatal entries retain their common parent across CSV boundaries", () => {
  const section = dataset.rows.findIndex((row) => row[ROW_ENGLISH] === "Conditions arising in the perinatal period");
  assert.ok(section >= 0);

  for (const [page, term] of [
    [798, "Bandl's ring(contraction), complicating delivery"],
    [801, "inadequate, inadequacy"],
    [824, "Mikity-Wilson disease or syndrome"],
    [851, "hysterotomy, affecting fetus or newborn"],
  ]) {
    const row = dataset.rows.find((row) => row[ROW_IMAGE_PAGE] === page && row[ROW_ENGLISH] === term);
    assert.equal(row?.[ROW_PARENT], section, term);
  }
});

test("E and its è 厄 group continue across image pages 250 and 251", () => {
  const eRoots = dataset.rows.filter((row) => row[ROW_CHINESE] === "E" && row[ROW_PARENT] === -1);
  assert.deepEqual(eRoots.map((row) => row[ROW_IMAGE_PAGE]), [250]);

  const terms = [[250, "Erb's"], [251, "Erb(-Duchenne) paralysis (birth injury) (newborn)"]];
  const parents = terms.map(([page, term]) =>
    dataset.rows.find((row) => row[ROW_IMAGE_PAGE] === page && row[ROW_ENGLISH] === term)?.[ROW_PARENT],
  );
  assert.equal(parents[0], parents[1]);
  const group = dataset.rows[parents[0]];
  assert.equal(group?.[ROW_CHINESE], "è 厄");
  assert.equal(dataset.rows[group[ROW_PARENT]], eRoots[0]);
});

test("neoplasm code search uses the corrected secondary site code", () => {
  const index = dataset.rows.findIndex((row) => row[ROW_IMAGE_PAGE] === 1390 && row[ROW_ENGLISH] === "epitrochlear");
  assert.ok(index >= 0);
  assert.equal(dataset.rows[index][ROW_MALIGNANT_SECONDARY], "C77.3");
  assert.ok(findSearchIndices(dataset, "C77.3", "code").includes(index));
  assert.ok(!findSearchIndices(dataset, "C77.5", "code").includes(index));
});
