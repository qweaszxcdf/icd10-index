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

test("auto search prioritizes a valid comma-separated locate and keeps other matching paths", () => {
  const indices = findSearchIndices(dataset, "Complications,fixation device, internal", "auto");
  assert.ok(indices.length >= 1);
  assert.equal(dataset.rows[indices[0]][ROW_ENGLISH], "fixation device, internal (orthopedic)");
  assert.equal(dataset.rows[indices[0]][ROW_CODE], "T84.9");

  const unique = new Set(indices);
  assert.equal(unique.size, indices.length);
});

test("auto search falls back to ordinary text search when a comma-separated path is invalid", () => {
  const indices = findSearchIndices(dataset, "definitely-not-a-real-parent, child", "auto");
  assert.deepEqual(indices, []);
});

test("comma search can match terms distributed across an ancestor path", () => {
  const indices = findSearchIndices(dataset, "Complications, mechanical", "auto");
  assert.ok(indices.length > 0);
  assert.ok(
    indices.some((index) => {
      let current = index;
      let sawComplications = false;
      let sawMechanical = false;
      while (current >= 0) {
        const row = dataset.rows[current];
        const text = `${row[2]} ${row[3]}`.toLowerCase();
        if (text.includes("complications") || text.includes("并发症")) sawComplications = true;
        if (text.includes("mechanical") || text.includes("机械")) sawMechanical = true;
        current = row[14];
      }
      return sawComplications && sawMechanical;
    }),
  );
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
