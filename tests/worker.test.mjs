import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { __test } from "../workers/src/index.js";

const datasetPath = new URL("../workers/public/data/dataset.json", import.meta.url);
const datasetText = await readFile(datasetPath, "utf8");
const dataset = JSON.parse(datasetText);

const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/data/dataset.json") {
        return new Response(datasetText, { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  },
};

test("builder excludes level 0 and level 1 from hierarchy", () => {
  assert.equal(dataset.meta.hierarchy_min_level, 2);
  assert.equal(dataset.rows[0][14], -1);
  assert.equal(dataset.rows[0][15], 1);
  assert.equal(dataset.rows[1][14], -1);
  assert.equal(dataset.rows[1][15], 2);
  assert.equal(dataset.rows[2][14], -1);
  assert.equal(dataset.rows[2][15], 3);
});

test("empty search returns only level 0 rows", () => {
  const result = __test.searchRows(dataset, "", "auto");
  assert.ok(result.treeRows.length > 0);
  assert.ok(result.treeRows.every((row) => row.level === 0));
});

test("locate prioritizes the English exact match", () => {
  const located = __test.findLocateIndices({
    rows: [
      [1, 2, "目标中文", "other", "", null, "", "", "", "", "", 0, "", "", -1, 1],
      [1, 2, "其他", "Target English", "", null, "", "", "", "", "", 0, "", "", -1, 1],
    ],
  }, "target english");
  assert.deepEqual(located, [1]);
});

test("locate follows canonical bilingual reference targets", () => {
  assert.deepEqual(__test.findLocateIndices(dataset, "Disease, heart"), [34631]);
});

test("marker-only neoplasm placeholders are removed", () => {
  assert.equal(dataset.rows[0][8], "");
  assert.equal(dataset.rows[0][9], "");
});

test("code search no longer includes level 0 or level 1 ancestors", () => {
  const result = __test.searchRows(dataset, "E23.0", "auto");
  assert.equal(result.count, 1);
  const tree = __test.buildHierarchy(result.treeRows);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].level, 2);
  assert.equal(tree[0].codes[0], "E23.0");
  assert.equal(tree[0].matched, true);
});

test("neoplasm codes are exposed by behavior column", () => {
  const node = __test.rowToJson(dataset, 8);
  assert.deepEqual(node.neoplasm.malignant_primary, ["C34.9"]);
  assert.deepEqual(node.neoplasm.malignant_secondary, ["C78.0"]);
  assert.deepEqual(node.neoplasm.in_situ, ["D02.2"]);
  assert.deepEqual(node.neoplasm.benign, ["D14.3"]);
  assert.deepEqual(node.neoplasm.uncertain_or_unspecified, ["D38.1"]);
});

test("Worker API serves search results from static asset dataset", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/search?q=Q07.0&mode=auto"), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.tree.length, 1);
  assert.equal(payload.tree[0].codes[0], "Q07.0");
});

test("feedback API writes unified record to D1 with project key", async () => {
  let boundValues = null;
  const feedbackEnv = {
    ...env,
    DB: {
      prepare(sql) {
        assert.match(sql, /INSERT INTO feedback/);
        return {
          bind(...values) {
            boundValues = values;
            return {
              async run() {
                return { meta: { last_row_id: 42 } };
              },
            };
          },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://example.test/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "node-test" },
      body: JSON.stringify({
        feedbackType: "层级错误",
        proposedValue: "调整到目标词条下",
        message: "该词条层级应当调整到下一级。",
        contact: "",
        url: "https://example.test/?q=测试",
        record: { index: 3, level: 3, chinese: "测试词条" },
      }),
    }),
    feedbackEnv,
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, id: 42, message: "反馈已提交" });
  assert.equal(boundValues[0], "icd10-index");
  const savedRecord = JSON.parse(boundValues[1]);
  assert.equal(savedRecord.chinese, "测试词条");
  assert.equal(savedRecord.level, 3);
  assert.equal(savedRecord.hierarchy_level, 3);
  assert.equal(boundValues[2], "层级错误");
});

test("feedback API rejects invalid feedback type", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedbackType: "未知类型", message: "这是一条足够长的反馈说明" }),
    }),
    { ...env, DB: {} },
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
});
