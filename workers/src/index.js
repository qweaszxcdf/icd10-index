const API_CACHE_SECONDS = 60 * 60;
const RESULT_LIMIT = 300;
const FEEDBACK_PROJECT_KEY = "icd10-index";
const FEEDBACK_MAX_BODY_BYTES = 16_000;
const FEEDBACK_TYPES = new Set([
  "中文名称错误",
  "英文名称错误",
  "主编码错误",
  "肿瘤表编码错误",
  "层级错误",
  "页码错误",
  "缺少词条",
  "重复词条",
  "其他",
]);

const ROW_IMAGE_PAGE = 0;
const ROW_LEVEL = 1;
const ROW_CHINESE = 2;
const ROW_ENGLISH = 3;
const ROW_CODE = 4;
const ROW_CONFIDENCE = 5;
const ROW_MALIGNANT_PRIMARY = 6;
const ROW_MALIGNANT_SECONDARY = 7;
const ROW_IN_SITU = 8;
const ROW_BENIGN = 9;
const ROW_UNCERTAIN = 10;
const ROW_SOURCE_FILE = 11;
const ROW_SEARCH_BLOB = 12;
const ROW_NORMALIZED_CODES = 13;
const ROW_PARENT = 14;
const ROW_SUBTREE_END = 15;

const ICD_CODE_RE = /\b([A-Z][0-9]{2}(?:\.[0-9A-Z]{1,8})?)[†*]?\b/gi;
let datasetPromise = null;

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return ["nan", "none", "null"].includes(text.toLowerCase()) ? "" : text;
}

function normalizeCode(value) {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

function parseIntSafe(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function extractCodes(value) {
  const text = normalizeText(value).toUpperCase();
  const seen = new Set();
  const codes = [];
  for (const match of text.matchAll(ICD_CODE_RE)) {
    const code = match[1].toUpperCase();
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

function rowToJson(dataset, index, matched = false) {
  const row = dataset.rows[index];
  const confidence = typeof row[ROW_CONFIDENCE] === "number" ? row[ROW_CONFIDENCE] : null;
  const hierarchyPath = [];
  let parentIndex = row[ROW_PARENT];
  while (parentIndex >= 0) {
    const parent = dataset.rows[parentIndex];
    hierarchyPath.unshift({
      index: parentIndex,
      level: parent[ROW_LEVEL],
      image_page: parent[ROW_IMAGE_PAGE],
      chinese: normalizeText(parent[ROW_CHINESE]),
      english: normalizeText(parent[ROW_ENGLISH]),
      codes: extractCodes(parent[ROW_CODE]),
    });
    parentIndex = parent[ROW_PARENT];
  }
  return {
    id: `r${index}`,
    index,
    image_page: row[ROW_IMAGE_PAGE],
    level: row[ROW_LEVEL],
    chinese: normalizeText(row[ROW_CHINESE]),
    english: normalizeText(row[ROW_ENGLISH]),
    code: normalizeText(row[ROW_CODE]),
    codes: extractCodes(row[ROW_CODE]),
    confidence,
    source_file: dataset.source_files?.[row[ROW_SOURCE_FILE]] || "",
    neoplasm: {
      malignant_primary: extractCodes(row[ROW_MALIGNANT_PRIMARY]),
      malignant_secondary: extractCodes(row[ROW_MALIGNANT_SECONDARY]),
      in_situ: extractCodes(row[ROW_IN_SITU]),
      benign: extractCodes(row[ROW_BENIGN]),
      uncertain_or_unspecified: extractCodes(row[ROW_UNCERTAIN]),
    },
    matched,
    parent_index: row[ROW_PARENT],
    hierarchy_path: hierarchyPath,
    subtree_end: row[ROW_SUBTREE_END],
    has_children: row[ROW_SUBTREE_END] > index + 1,
  };
}

function buildHierarchy(nodes) {
  const tree = [];
  const stack = [];
  for (const node of nodes) {
    node.children = [];
    while (stack.length && stack.at(-1).level >= node.level) stack.pop();
    if (stack.length) stack.at(-1).children.push(node);
    else tree.push(node);
    stack.push(node);
  }
  return tree;
}

function collectRelevantRows(dataset, resultIndices, markMatches = true) {
  const matched = new Set(resultIndices);
  const included = new Set();
  for (const resultIndex of matched) {
    let index = resultIndex;
    while (index >= 0) {
      included.add(index);
      const parentIndex = dataset.rows[index][ROW_PARENT];
      if (parentIndex < 0 || dataset.rows[parentIndex][ROW_LEVEL] < 2) break;
      index = parentIndex;
    }
  }
  return [...included]
    .sort((a, b) => a - b)
    .map((index) => rowToJson(dataset, index, markMatches && matched.has(index)));
}

function looksLikeIcdQuery(query) {
  return /^[a-z][0-9]{1,2}(?:[.\-x0-9a-z]*)?$/i.test(query.trim());
}

function rowCodeTokens(row) {
  return normalizeText(row[ROW_NORMALIZED_CODES]).split(/\s+/).filter(Boolean);
}

function rowMatchesSearch(row, query, mode) {
  const queryLower = normalizeText(query).toLowerCase();
  if (!queryLower) return false;
  const codeMode = mode === "code";
  const autoCodeMode = mode === "auto" && looksLikeIcdQuery(queryLower);
  if (codeMode || autoCodeMode) {
    const codeQuery = normalizeCode(queryLower);
    if (rowCodeTokens(row).some((code) => code.startsWith(codeQuery))) return true;
    if (codeMode) return false;
  }
  const text = normalizeText(row[ROW_SEARCH_BLOB]).toLowerCase();
  if (mode === "phrase") return text.includes(queryLower);
  const tokens = queryLower.split(/\s+/).filter(Boolean);
  return tokens.every((token) => text.includes(token));
}

function searchRows(dataset, query, mode = "auto", limit = RESULT_LIMIT) {
  const rows = dataset.rows || [];
  const queryText = normalizeText(query);
  if (!queryText) {
    const roots = [];
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index][ROW_LEVEL] === 0) roots.push(index);
    }
    return {
      count: roots.length,
      shown: roots.length,
      limited: false,
      treeRows: roots.map((index) => rowToJson(dataset, index)),
    };
  }

  let resultIndices = [];
  const codeMode = mode === "code" || (mode === "auto" && looksLikeIcdQuery(queryText));
  if (mode === "code") {
    const exact = dataset.code_index?.[normalizeCode(queryText)] || [];
    if (exact.length) resultIndices = [...exact];
  }
  if (!resultIndices.length) {
    for (let index = 0; index < rows.length; index += 1) {
      if (rowMatchesSearch(rows[index], queryText, mode)) resultIndices.push(index);
    }
  }

  const count = resultIndices.length;
  const shownIndices = resultIndices.slice(0, limit);
  return {
    count,
    shown: shownIndices.length,
    limited: count > shownIndices.length,
    treeRows: collectRelevantRows(dataset, shownIndices, true),
  };
}

function rowMatchesLocateTarget(row, target, strictPrefix = false) {
  const targetText = normalizeText(target).toLowerCase();
  const english = normalizeText(row[ROW_ENGLISH]).toLowerCase();
  if (english === targetText) return true;
  if (!strictPrefix || !english.startsWith(targetText)) return false;
  const remainder = english.slice(targetText.length);
  return Boolean(remainder && " ,-/()—".includes(remainder[0]));
}

function findHierarchicalLocateRows(dataset, parts) {
  const rows = dataset.rows;
  const candidates = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!rowMatchesLocateTarget(rows[index], parts[0], true)) continue;
    let currentIndex = index;
    let success = true;
    for (const part of parts.slice(1)) {
      const subtreeEnd = rows[currentIndex][ROW_SUBTREE_END];
      let foundIndex = -1;
      for (let cursor = currentIndex + 1; cursor < subtreeEnd; cursor += 1) {
        if (rows[cursor][ROW_PARENT] !== currentIndex) continue;
        if (rowMatchesLocateTarget(rows[cursor], part, true)) {
          foundIndex = cursor;
          break;
        }
      }
      if (foundIndex === -1) {
        for (let cursor = currentIndex + 1; cursor < subtreeEnd; cursor += 1) {
          if (rowMatchesLocateTarget(rows[cursor], part, true)) {
            foundIndex = cursor;
            break;
          }
        }
      }
      if (foundIndex === -1) {
        if (!rowMatchesLocateTarget(rows[currentIndex], part, true)) {
          success = false;
          break;
        }
      } else {
        currentIndex = foundIndex;
      }
    }
    if (success) {
      candidates.push({
        index: currentIndex,
        firstExact: rowMatchesLocateTarget(rows[index], parts[0]),
        parentLevel: rows[index][ROW_LEVEL],
      });
    }
  }
  candidates.sort((left, right) =>
    left.parentLevel - right.parentLevel
    || Number(right.firstExact) - Number(left.firstExact)
    || left.index - right.index);
  return candidates.length ? [candidates[0].index] : [];
}

function findOrderedLocateRows(dataset, parts) {
  const rows = dataset.rows;
  for (let index = 0; index < rows.length; index += 1) {
    if (!rowMatchesLocateTarget(rows[index], parts[0], true)) continue;
    let currentIndex = index;
    let partIndex = 1;
    for (let cursor = index + 1; cursor < rows.length && partIndex < parts.length; cursor += 1) {
      if (rowMatchesLocateTarget(rows[cursor], parts[partIndex], true)) {
        currentIndex = cursor;
        partIndex += 1;
      }
    }
    if (partIndex === parts.length) return [currentIndex];
  }
  return [];
}

function translateLocatePartsToEnglish(dataset, parts) {
  return parts.map((part) => {
    const candidates = [];
    for (let index = 0; index < dataset.rows.length; index += 1) {
      const row = dataset.rows[index];
      const chinese = normalizeText(row[ROW_CHINESE]).toLowerCase();
      if (chinese !== part) {
        if (!chinese.startsWith(part)) continue;
        const remainder = chinese.slice(part.length);
        if (!remainder || !" ,，-/()（）—".includes(remainder[0])) continue;
      }
      const english = normalizeText(row[ROW_ENGLISH]).toLowerCase();
      if (!english) continue;
      candidates.push({
        value: english.split(",")[0].trim(),
        exact: chinese === part,
        level: row[ROW_LEVEL],
        index,
      });
    }
    candidates.sort((left, right) =>
      Number(right.exact) - Number(left.exact)
      || left.level - right.level
      || left.index - right.index);
    return candidates[0]?.value || part;
  });
}

function findCorrespondingEnglishTarget(dataset, target) {
  const normalizedTarget = normalizeText(target).toLowerCase().replace(/，/g, ",");
  for (const row of dataset.rows) {
    const chinese = normalizeText(row[ROW_CHINESE]);
    const english = normalizeText(row[ROW_ENGLISH]);
    const chineseMatch = chinese.match(/(?:另见|见)\s*([^；;)）\n]+)/i);
    const englishMatch = english.match(/\b(?:see also|see)\s+([^;)）;\n]+)/i);
    if (!chineseMatch || !englishMatch) continue;
    const chineseTarget = chineseMatch[1].trim().replace(/，/g, ",").toLowerCase();
    if (chineseTarget !== normalizedTarget) continue;
    return englishMatch[1].trim().toLowerCase();
  }
  return "";
}

function findLocateIndices(dataset, target) {
  const targetLower = normalizeText(target).toLowerCase();
  if (!targetLower) return [];
  if (looksLikeIcdQuery(targetLower)) {
    const exact = dataset.code_index?.[normalizeCode(targetLower)] || [];
    if (exact.length) return exact;
  }

  const textCandidates = [];
  for (let index = 0; index < dataset.rows.length; index += 1) {
    const row = dataset.rows[index];
    if (!rowMatchesLocateTarget(row, targetLower, true)) continue;
    textCandidates.push({
      index,
      exact: rowMatchesLocateTarget(row, targetLower),
      level: row[ROW_LEVEL],
    });
  }
  if (textCandidates.length) {
    textCandidates.sort((left, right) =>
      left.level - right.level
      || Number(right.exact) - Number(left.exact)
      || left.index - right.index);
    return [textCandidates[0].index];
  }

  const parts = targetLower.split(/[，,]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const hierarchical = findHierarchicalLocateRows(dataset, parts);
    if (hierarchical.length) return hierarchical;
    return findOrderedLocateRows(dataset, parts);
  }
  return [];
}

async function loadDataset(request, env) {
  if (!datasetPromise) {
    datasetPromise = (async () => {
      if (!env?.ASSETS) throw new Error("ASSETS binding is unavailable");
      const assetUrl = new URL("/data/dataset.json", request.url);
      const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
      if (!response.ok) throw new Error(`Unable to load dataset.json: HTTP ${response.status}`);
      return response.json();
    })();
    datasetPromise.catch(() => {
      datasetPromise = null;
    });
  }
  return datasetPromise;
}

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", `public, max-age=0, s-maxage=${API_CACHE_SECONDS}`);
  headers.set("cdn-cache-control", `public, max-age=${API_CACHE_SECONDS}`);
  headers.set("cloudflare-cdn-cache-control", `public, max-age=${API_CACHE_SECONDS}`);
  return new Response(JSON.stringify(payload), { ...init, headers });
}

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
    if (Number.isInteger(normalizedRecord.level)) {
      normalizedRecord.hierarchy_level = normalizedRecord.level;
    }
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

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";
  const mode = url.searchParams.get("mode") || "auto";
  const dataset = await loadDataset(request, env);
  const result = searchRows(dataset, query, mode);
  return jsonResponse({
    query,
    mode,
    count: result.count,
    shown: result.shown,
    limited: result.limited,
    tree: buildHierarchy(result.treeRows),
  });
}

async function handleChildren(request, env) {
  const url = new URL(request.url);
  const idMatch = (url.searchParams.get("id") || "").match(/^r(\d+)$/);
  const dataset = await loadDataset(request, env);
  const startIndex = idMatch ? Number.parseInt(idMatch[1], 10) : -1;
  if (startIndex < 0 || startIndex >= dataset.rows.length) return jsonResponse({ children: [] }, { status: 400 });

  const query = url.searchParams.get("q") || "";
  const mode = url.searchParams.get("mode") || "auto";
  const children = [];
  const subtreeEnd = dataset.rows[startIndex][ROW_SUBTREE_END];
  for (let index = startIndex + 1; index < subtreeEnd; index += 1) {
    const row = dataset.rows[index];
    if (row[ROW_PARENT] !== startIndex) continue;
    children.push(rowToJson(dataset, index, rowMatchesSearch(row, query, mode)));
  }
  return jsonResponse({ children });
}

async function handleLocate(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get("target") || "";
  const dataset = await loadDataset(request, env);
  const indices = findLocateIndices(dataset, target);
  const treeRows = collectRelevantRows(dataset, indices, true);
  return jsonResponse({
    query: target,
    count: indices.length,
    shown: indices.length,
    limited: false,
    rows: indices.map((index) => rowToJson(dataset, index, true)),
    tree: buildHierarchy(treeRows),
  });
}

async function handleMeta(request, env) {
  const dataset = await loadDataset(request, env);
  return jsonResponse({ meta: dataset.meta, source_files: dataset.source_files });
}

function errorResponse(error) {
  console.error(error);
  return jsonResponse(
    { error: "internal_error", message: error instanceof Error ? error.message : String(error) },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/feedback") return handleFeedback(request, env);
      if (url.pathname === "/api/search") return handleSearch(request, env);
      if (url.pathname === "/api/children") return handleChildren(request, env);
      if (url.pathname === "/api/locate") return handleLocate(request, env);
      if (url.pathname === "/api/meta") return handleMeta(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
};

export const __test = {
  buildHierarchy,
  collectRelevantRows,
  extractCodes,
  findLocateIndices,
  handleFeedback,
  looksLikeIcdQuery,
  rowMatchesSearch,
  rowToJson,
  searchRows,
};
