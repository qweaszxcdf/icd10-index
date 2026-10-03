import assert from "node:assert/strict";
import test from "node:test";
import worker from "../workers/src/index.js";

const env = {
  ASSETS: {
    async fetch() {
      return new Response("not found", { status: 404 });
    },
  },
};

test("non-feedback APIs are not exposed by the Worker", async () => {
  for (const path of ["/api/search", "/api/children", "/api/locate", "/api/meta"]) {
    const response = await worker.fetch(new Request(`https://example.test${path}`), env);
    assert.equal(response.status, 404, path);
  }
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
            return { async run() { return { meta: { last_row_id: 42 } }; } };
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
  assert.equal((await response.json()).ok, false);
});
