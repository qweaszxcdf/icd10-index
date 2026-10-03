const FEEDBACK_PROJECT_KEY = "icd10-index";
const FEEDBACK_MAX_BODY_BYTES = 16_000;
const FEEDBACK_TYPES = new Set([
  "错字/OCR错误",
  "中英文对应错误",
  "主编码错误",
  "肿瘤表编码错误",
  "层级错误",
  "缺少词条",
  "其他",
]);

function noStoreJsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function limitedText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

async function handleFeedback(request, env) {
  if (request.method !== "POST") {
    return noStoreJsonResponse({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  if (!env?.DB) {
    return noStoreJsonResponse({ ok: false, error: "D1 数据库未绑定" }, { status: 500 });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > FEEDBACK_MAX_BODY_BYTES) {
    return noStoreJsonResponse({ ok: false, error: "请求内容过大" }, { status: 413 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return noStoreJsonResponse({ ok: false, error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  const feedbackType = limitedText(body.feedbackType, 40);
  const proposedValue = limitedText(body.proposedValue, 500);
  const message = limitedText(body.message, 2000);
  const contact = limitedText(body.contact, 200);
  if (!FEEDBACK_TYPES.has(feedbackType)) {
    return noStoreJsonResponse({ ok: false, error: "反馈类型无效" }, { status: 400 });
  }
  if (message.length < 5) {
    return noStoreJsonResponse({ ok: false, error: "反馈说明至少需要填写 5 个字符" }, { status: 400 });
  }

  let recordData;
  try {
    const record = body.record && typeof body.record === "object" ? body.record : {};
    const normalizedRecord = { ...record };
    if (Number.isInteger(normalizedRecord.level)) normalizedRecord.hierarchy_level = normalizedRecord.level;
    recordData = JSON.stringify(normalizedRecord);
  } catch {
    return noStoreJsonResponse({ ok: false, error: "词条数据格式无效" }, { status: 400 });
  }
  if (recordData.length > 12_000) {
    return noStoreJsonResponse({ ok: false, error: "词条数据过大" }, { status: 413 });
  }

  try {
    const result = await env.DB.prepare(`
      INSERT INTO feedback (
        project_key, record_data, feedback_type, proposed_value, message,
        contact, url, user_agent, as_name, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      FEEDBACK_PROJECT_KEY,
      recordData,
      feedbackType,
      proposedValue,
      message,
      contact,
      limitedText(body.url, 1000),
      limitedText(request.headers.get("user-agent"), 500),
      limitedText(request.cf?.asOrganization, 200),
      limitedText(request.headers.get("CF-Connecting-IP"), 64),
    ).run();

    return noStoreJsonResponse(
      { ok: true, id: result.meta?.last_row_id ?? null, message: "反馈已提交" },
      { status: 201 },
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "feedback_insert_failed", message: String(error) }));
    return noStoreJsonResponse({ ok: false, error: "反馈保存失败" }, { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/feedback") return handleFeedback(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return noStoreJsonResponse({ ok: false, error: "internal_error" }, { status: 500 });
    }
  },
};

export const __test = { handleFeedback };
