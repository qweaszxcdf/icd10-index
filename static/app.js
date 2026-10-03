import {
  ROW_IMAGE_PAGE,
  ROW_LEVEL,
  ROW_CHINESE,
  ROW_ENGLISH,
  ROW_CODE,
  ROW_CONFIDENCE,
  ROW_MALIGNANT_PRIMARY,
  ROW_MALIGNANT_SECONDARY,
  ROW_IN_SITU,
  ROW_BENIGN,
  ROW_UNCERTAIN,
  ROW_SOURCE_FILE,
  ROW_PARENT,
  ROW_SUBTREE_END,
  extractReferencesFromText,
  findSearchIndices,
  locateIndex,
  normalizeText,
} from "./client-core.mjs";

const queryInput = document.getElementById("queryInput");
const searchButton = document.getElementById("searchButton");
const browseRootButton = document.getElementById("browseRootButton");
const expandAllButton = document.getElementById("expandAllButton");
const collapseAllButton = document.getElementById("collapseAllButton");
const summaryEl = document.getElementById("summary");
const treeContainer = document.getElementById("treeContainer");
const feedbackGeneralButton = document.getElementById("feedbackGeneralButton");
const feedbackDialog = document.getElementById("feedbackDialog");
const feedbackForm = document.getElementById("feedbackForm");
const feedbackRecordName = document.getElementById("feedbackRecordName");
const feedbackType = document.getElementById("feedbackType");
const feedbackProposedValue = document.getElementById("feedbackProposedValue");
const feedbackMessage = document.getElementById("feedbackMessage");
const feedbackContact = document.getElementById("feedbackContact");
const feedbackStatus = document.getElementById("feedbackStatus");
const feedbackSubmitButton = document.getElementById("feedbackSubmitButton");
const feedbackCloseButton = document.getElementById("feedbackCloseButton");
const feedbackCancelButton = document.getElementById("feedbackCancelButton");

const NEOPLASM_FIELDS = [
  ["malignant_primary", "原发恶性"],
  ["malignant_secondary", "继发恶性"],
  ["in_situ", "原位"],
  ["benign", "良性"],
  ["uncertain_or_unspecified", "性质未定/未特指"],
];

let currentQuery = "";
let currentMode = "auto";
let currentMatchIndices = new Set();
let viewRequestId = 0;
let feedbackRecord = null;
let clientDatasetPromise = null;
const clientSearchCache = new Map();
const clientLocateCache = new Map();

const ICD_CODE_RE = /\b([A-Z][0-9]{2}(?:\.[0-9A-Z]{1,8})?)[†*]?\b/gi;
const RESULT_LIMIT = 300;
const SEARCH_MODES = new Set(["auto", "code", "phrase"]);
let clientRowCache = null;

function setSearchMode(mode) {
  const normalized = SEARCH_MODES.has(mode) ? mode : "auto";
  const radio = document.querySelector(`input[name="searchMode"][value="${normalized}"]`);
  if (radio) radio.checked = true;
  return normalized;
}

function pushNavigationUrl(url) {
  if (url.href === location.href) {
    history.replaceState(null, "", url);
  } else {
    history.pushState(null, "", url);
  }
}

function extractCodes(value) {
  const seen = new Set();
  const codes = [];
  for (const match of normalizeText(value).toUpperCase().matchAll(ICD_CODE_RE)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      codes.push(match[1]);
    }
  }
  return codes;
}

function looksLikeIcdQuery(query) {
  return /^[a-z][0-9]{1,2}(?:[.\-x0-9a-z]*)?$/i.test(query.trim());
}

async function loadClientDataset() {
  if (!clientDatasetPromise) {
    clientDatasetPromise = fetch("/data/dataset.json", { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((dataset) => {
        clientRowCache = new Map();
        return dataset;
      });
    clientDatasetPromise.catch(() => { clientDatasetPromise = null; });
  }
  return clientDatasetPromise;
}

function clientRowToJson(dataset, index, matched = false) {
  const cached = clientRowCache?.get(index);
  if (cached) return { ...cached, matched };
  const row = dataset.rows[index];
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
  const result = {
    id: `r${index}`,
    index,
    image_page: row[ROW_IMAGE_PAGE],
    level: row[ROW_LEVEL],
    chinese: normalizeText(row[ROW_CHINESE]),
    english: normalizeText(row[ROW_ENGLISH]),
    code: normalizeText(row[ROW_CODE]),
    codes: extractCodes(row[ROW_CODE]),
    confidence: typeof row[ROW_CONFIDENCE] === "number" ? row[ROW_CONFIDENCE] : null,
    source_file: dataset.source_files?.[row[ROW_SOURCE_FILE]] || "",
    neoplasm: {
      malignant_primary: extractCodes(row[ROW_MALIGNANT_PRIMARY]),
      malignant_secondary: extractCodes(row[ROW_MALIGNANT_SECONDARY]),
      in_situ: extractCodes(row[ROW_IN_SITU]),
      benign: extractCodes(row[ROW_BENIGN]),
      uncertain_or_unspecified: extractCodes(row[ROW_UNCERTAIN]),
    },
    matched: false,
    parent_index: row[ROW_PARENT],
    hierarchy_path: hierarchyPath,
    subtree_end: row[ROW_SUBTREE_END],
    has_children: row[ROW_SUBTREE_END] > index + 1,
  };
  clientRowCache?.set(index, result);
  return { ...result, matched };
}

function clientBuildHierarchy(nodes) {
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

function clientCollectRelevantRows(dataset, indices) {
  const matched = new Set(indices);
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
  return [...included].sort((a, b) => a - b)
    .map((index) => clientRowToJson(dataset, index, matched.has(index)));
}

function clientSearch(dataset, query, mode) {
  const matches = findSearchIndices(dataset, query, mode);
  const shown = matches.slice(0, RESULT_LIMIT);
  const rows = query
    ? clientCollectRelevantRows(dataset, shown)
    : shown.map((index) => clientRowToJson(dataset, index));
  return {
    count: matches.length,
    shown: shown.length,
    limited: matches.length > shown.length,
    match_indices: matches,
    tree: clientBuildHierarchy(rows),
  };
}

async function clientSearchResponse(query, mode) {
  const cacheKey = `${mode}\u0000${query}`;
  const cached = clientSearchCache.get(cacheKey);
  if (cached) return cached;
  const dataset = await loadClientDataset();
  const result = clientSearch(dataset, query, mode);
  const response = { ...result, query, mode };
  if (clientSearchCache.size >= 50) clientSearchCache.delete(clientSearchCache.keys().next().value);
  clientSearchCache.set(cacheKey, response);
  return response;
}

async function clientLocateResponse(target) {
  const cacheKey = normalizeText(target).toLowerCase();
  const cached = clientLocateCache.get(cacheKey);
  if (cached) return cached;
  const dataset = await loadClientDataset();
  const index = locateIndex(dataset, target);
  const indices = index >= 0 ? [index] : [];
  const treeRows = clientCollectRelevantRows(dataset, indices);
  const response = {
    query: target,
    count: indices.length,
    shown: indices.length,
    limited: false,
    match_indices: indices,
    rows: indices.map((item) => clientRowToJson(dataset, item, true)),
    tree: clientBuildHierarchy(treeRows),
  };
  if (clientLocateCache.size >= 100) clientLocateCache.delete(clientLocateCache.keys().next().value);
  clientLocateCache.set(cacheKey, response);
  return response;
}

function codeUrl(code) {
  return `https://icd10.pages.dev/?code=${encodeURIComponent(code)}`;
}

function createCodeAnchor(code) {
  const link = document.createElement("a");
  link.href = codeUrl(code);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "code-link";
  link.textContent = code;
  link.title = `在 ICD-10 类目表中打开 ${code}`;
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}

function createReferenceAnchor(ref) {
  const link = document.createElement("a");
  const targetUrl = new URL(location.href);
  targetUrl.searchParams.delete("q");
  targetUrl.searchParams.set("locate", ref.target);
  link.href = targetUrl.toString();
  link.className = "ref-inline";
  link.textContent = ref.display;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    performLocate(ref.target);
  });
  return link;
}

function appendTextWithReferenceLinks(container, text, refs) {
  if (!text || !refs.length) {
    container.appendChild(document.createTextNode(text || ""));
    return;
  }
  const matches = [...refs].sort((left, right) => left.start - right.start || right.end - left.end);
  let cursor = 0;
  for (const ref of matches) {
    if (ref.start < cursor) continue;
    if (ref.start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, ref.start)));
    container.appendChild(createReferenceAnchor(ref));
    cursor = ref.end;
  }
  if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
}

function appendNodeTitle(container, node) {
  const parts = [
    { text: String(node.chinese || "").replace(/\*{1,2}/g, ""), language: "zh" },
    { text: String(node.english || "").replace(/\*{1,2}/g, ""), language: "en" },
  ].filter(({ text }) => text);

  if (parts.length) {
    parts.forEach((part, index) => {
      if (index) container.appendChild(document.createTextNode(" / "));
      appendTextWithReferenceLinks(container, part.text, extractReferencesFromText(part.text, part.language));
    });
  } else {
    container.appendChild(document.createTextNode("(无标题)"));
  }
  const neoplasmCodes = new Set(
    NEOPLASM_FIELDS.flatMap(([key]) => node.neoplasm?.[key] || []),
  );
  for (const code of node.codes || []) {
    if (neoplasmCodes.has(code)) continue;
    container.appendChild(document.createTextNode(" "));
    container.appendChild(createCodeAnchor(code));
  }
}

function renderNeoplasmCodes(node) {
  const rows = [];
  for (const [key, label] of NEOPLASM_FIELDS) {
    const values = node.neoplasm?.[key] || [];
    if (!values.length) continue;
    const item = document.createElement("div");
    item.className = "neoplasm-item";
    const name = document.createElement("span");
    name.className = "neoplasm-label";
    name.textContent = label;
    item.appendChild(name);
    const codes = document.createElement("span");
    codes.className = "neoplasm-codes";
    values.forEach((code, index) => {
      if (index) codes.appendChild(document.createTextNode(" "));
      codes.appendChild(createCodeAnchor(code));
    });
    item.appendChild(codes);
    rows.push(item);
  }
  if (!rows.length) return null;
  const grid = document.createElement("div");
  grid.className = "neoplasm-grid";
  grid.setAttribute("aria-label", "肿瘤表编码");
  rows.forEach((item) => grid.appendChild(item));
  return grid;
}

function feedbackRecordPayload(node) {
  if (!node) return {};
  return {
    id: node.id,
    index: node.index,
    image_page: node.image_page,
    level: node.level,
    hierarchy_level: node.level,
    chinese: node.chinese,
    english: node.english,
    code: node.code,
    codes: node.codes,
    confidence: node.confidence,
    neoplasm: node.neoplasm,
    parent_index: node.parent_index,
    hierarchy_path: node.hierarchy_path,
    subtree_end: node.subtree_end,
    source_file: node.source_file,
  };
}

function openFeedback(node = null) {
  feedbackRecord = node;
  const parentTitle = node?.hierarchy_path?.length
    ? `父项：${node.hierarchy_path
      .map((parent) => [parent.chinese, parent.english].filter(Boolean).join(" / "))
      .join(" → ")}`
    : "";
  const titleParts = node
    ? [`记录 ${node.index}`, node.chinese, node.english, ...(node.codes || []), parentTitle]
    : ["全局反馈（可用于补充缺少的词条）"];
  feedbackRecordName.textContent = titleParts.filter(Boolean).join(" / ");
  feedbackType.value = node ? "" : "缺少词条";
  feedbackProposedValue.value = "";
  feedbackMessage.value = "";
  feedbackContact.value = "";
  feedbackStatus.textContent = "";
  feedbackSubmitButton.disabled = false;
  feedbackSubmitButton.textContent = "提交反馈";
  feedbackDialog.showModal();
}

async function submitFeedback(event) {
  event.preventDefault();
  feedbackSubmitButton.disabled = true;
  feedbackSubmitButton.textContent = "正在提交……";
  feedbackStatus.textContent = "正在提交……";
  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        feedbackType: feedbackType.value,
        proposedValue: feedbackProposedValue.value,
        message: feedbackMessage.value,
        contact: feedbackContact.value,
        url: window.location.href,
        record: feedbackRecordPayload(feedbackRecord),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "提交失败");
    feedbackStatus.textContent = `反馈已提交${result.id ? `，编号 ${result.id}` : ""}`;
    window.setTimeout(() => feedbackDialog.close(), 1000);
  } catch (error) {
    feedbackStatus.textContent = error instanceof Error ? error.message : "提交失败，请稍后重试。";
  } finally {
    feedbackSubmitButton.disabled = false;
    feedbackSubmitButton.textContent = "提交反馈";
  }
}

function renderNode(node, asPath = false) {
  const wrapper = document.createElement("div");
  wrapper.className = `tree-node${node.matched ? " matched-node" : ""}`;
  const hasChildren = Boolean(node.has_children || node.children?.length);
  if (hasChildren) wrapper.classList.add("has-children", "collapsed");

  const label = document.createElement("div");
  label.className = "node-label";

  const heading = document.createElement("div");
  heading.className = "node-heading";
  const toggle = document.createElement("span");
  toggle.className = "toggle-icon";
  toggle.textContent = hasChildren ? "▾" : "";
  heading.appendChild(toggle);

  const title = document.createElement("div");
  title.className = "node-title";
  appendNodeTitle(title, node);
  heading.appendChild(title);
  label.appendChild(heading);

  const actions = document.createElement("div");
  actions.className = "node-actions";
  const meta = document.createElement("div");
  meta.className = "node-meta";
  const metaParts = [`层级 ${node.level}`, `页 ${node.image_page}`];
  if (typeof node.confidence === "number") metaParts.push(`置信度 ${node.confidence.toFixed(4)}`);
  meta.textContent = metaParts.join(" · ");
  actions.appendChild(meta);

  const feedbackButton = document.createElement("button");
  feedbackButton.type = "button";
  feedbackButton.className = "node-feedback";
  feedbackButton.textContent = "反馈";
  feedbackButton.title = "反馈此词条的数据问题";
  feedbackButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openFeedback(node);
  });
  actions.appendChild(feedbackButton);
  label.appendChild(actions);
  wrapper.appendChild(label);

  const neoplasm = renderNeoplasmCodes(node);
  if (neoplasm) wrapper.appendChild(neoplasm);

  let pathContainer = null;
  if (asPath && node.children?.length) {
    pathContainer = document.createElement("div");
    pathContainer.className = "path-children";
    node.children.forEach((child) => pathContainer.appendChild(renderNode(child, true)));
    wrapper.appendChild(pathContainer);
  }

  let loaded = !node.has_children;
  let fullContainer = null;

  async function loadChildren() {
    if (loaded) return;
    const dataset = await loadClientDataset();
    const startIndex = Number(node.index);
    const end = dataset.rows[startIndex]?.[ROW_SUBTREE_END] ?? startIndex + 1;
    const children = [];
    for (let index = startIndex + 1; index < end; index += 1) {
      if (dataset.rows[index][ROW_PARENT] !== startIndex) continue;
      children.push(clientRowToJson(dataset, index, currentMatchIndices.has(index)));
    }
    fullContainer = document.createElement("div");
    fullContainer.className = "child-list";
    children.forEach((child) => fullContainer.appendChild(renderNode(child, false)));
    loaded = true;
  }

  async function expand() {
    if (!hasChildren || !wrapper.classList.contains("collapsed")) return;
    try {
      await loadChildren();
      if (pathContainer?.parentNode) pathContainer.remove();
      if (fullContainer && !fullContainer.parentNode) wrapper.appendChild(fullContainer);
      wrapper.classList.remove("collapsed");
    } catch (error) {
      console.error(error);
      summaryEl.textContent = "加载子节点失败，请重试。";
    }
  }

  function collapse() {
    if (!hasChildren || wrapper.classList.contains("collapsed")) return;
    if (fullContainer?.parentNode) fullContainer.remove();
    if (pathContainer && !pathContainer.parentNode) wrapper.appendChild(pathContainer);
    wrapper.classList.add("collapsed");
  }

  wrapper.__expandNode = expand;
  wrapper.__collapseNode = collapse;

  if (hasChildren) {
    label.addEventListener("click", async (event) => {
      if (event.target.closest("a")) return;
      if (wrapper.classList.contains("collapsed")) await expand();
      else collapse();
    });
  }

  return wrapper;
}

function renderSummary(data) {
  const shown = Number(data.shown ?? data.count ?? 0);
  const count = Number(data.count ?? 0);
  summaryEl.textContent = data.limited
    ? `检索到 ${count} 条结果，当前显示前 ${shown} 条。`
    : `检索到 ${count} 条结果。`;
}

function renderTree(data) {
  treeContainer.replaceChildren();
  if (!data.tree?.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无分级索引结果。";
    treeContainer.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  data.tree.forEach((node) => fragment.appendChild(renderNode(node, true)));
  treeContainer.appendChild(fragment);
}

async function performSearch({ updateUrl = true } = {}) {
  const requestId = ++viewRequestId;
  const query = queryInput.value.trim();
  currentQuery = query;
  currentMode = setSearchMode(
    document.querySelector("input[name='searchMode']:checked")?.value || "auto",
  );

  summaryEl.textContent = "加载中……";
  treeContainer.innerHTML = '<p class="loading">正在检索索引……</p>';

  try {
    const data = await clientSearchResponse(query, currentMode);
    if (requestId !== viewRequestId) return;
    currentMatchIndices = new Set(data.match_indices || []);
    renderSummary(data);
    renderTree(data);
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.delete("locate");
      if (query) url.searchParams.set("q", query);
      else url.searchParams.delete("q");
      if (currentMode === "auto") url.searchParams.delete("mode");
      else url.searchParams.set("mode", currentMode);
      pushNavigationUrl(url);
    }
  } catch (error) {
    if (requestId !== viewRequestId) return;
    console.error(error);
    summaryEl.textContent = "检索失败，请稍后重试。";
    treeContainer.replaceChildren();
  }
}

async function performLocate(target, { updateUrl = true } = {}) {
  const normalizedTarget = String(target ?? "").trim();
  if (!normalizedTarget) return;

  const requestId = ++viewRequestId;
  currentQuery = "";
  currentMode = setSearchMode("auto");
  queryInput.value = normalizedTarget;
  summaryEl.textContent = `正在定位：${normalizedTarget}`;
  treeContainer.innerHTML = '<p class="loading">正在定位索引……</p>';

  try {
    const data = await clientLocateResponse(normalizedTarget);
    if (requestId !== viewRequestId) return;
    currentMatchIndices = new Set(data.match_indices || []);
    renderSummary(data);
    renderTree(data);
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.delete("q");
      url.searchParams.delete("mode");
      url.searchParams.set("locate", normalizedTarget);
      pushNavigationUrl(url);
    }
  } catch (error) {
    if (requestId !== viewRequestId) return;
    console.error(error);
    summaryEl.textContent = "定位失败，请重试。";
    treeContainer.replaceChildren();
  }
}

async function toggleAllNodes(collapse) {
  if (collapse) {
    const nodes = [...treeContainer.querySelectorAll(".tree-node.has-children")].reverse();
    nodes.forEach((node) => node.__collapseNode?.());
    return;
  }
  for (let pass = 0; pass < 64; pass += 1) {
    const collapsed = [...treeContainer.querySelectorAll(".tree-node.has-children.collapsed")];
    if (!collapsed.length) break;
    const frontier = collapsed.filter((node) => !node.parentElement?.closest(".tree-node.has-children.collapsed"));
    for (const node of frontier.length ? frontier : collapsed) await node.__expandNode?.();
  }
}

searchButton.addEventListener("click", () => performSearch());
queryInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  performSearch();
});
browseRootButton.addEventListener("click", () => {
  queryInput.value = "";
  performSearch();
});
expandAllButton.addEventListener("click", () => toggleAllNodes(false));
collapseAllButton.addEventListener("click", () => toggleAllNodes(true));
feedbackGeneralButton.addEventListener("click", () => openFeedback(null));
feedbackCloseButton.addEventListener("click", () => feedbackDialog.close());
feedbackCancelButton.addEventListener("click", () => feedbackDialog.close());
feedbackForm.addEventListener("submit", submitFeedback);
feedbackDialog.addEventListener("click", (event) => {
  if (event.target === feedbackDialog) feedbackDialog.close();
});

function restoreNavigationState() {
  const url = new URL(location.href);
  const locateTarget = url.searchParams.get("locate");
  if (locateTarget) {
    setSearchMode("auto");
    queryInput.value = locateTarget;
    performLocate(locateTarget, { updateUrl: false });
    return;
  }

  setSearchMode(url.searchParams.get("mode") || "auto");
  queryInput.value = url.searchParams.get("q") || "";
  performSearch({ updateUrl: false });
}

window.addEventListener("DOMContentLoaded", restoreNavigationState);
window.addEventListener("popstate", restoreNavigationState);
