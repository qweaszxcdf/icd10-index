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
let currentSearchController = null;
let feedbackRecord = null;

function buildSearchUrl(query, mode = "auto") {
  const params = new URLSearchParams({ q: query, mode });
  return `/api/search?${params.toString()}`;
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

function extractReferences(node) {
  const refs = [];
  const chinesePattern = /(?:另见|见)(?:\s+|[：:])([^；;)）\n]+)/gi;
  const englishPattern = /\b(?:see also|see)\s+([^;)）;\n]+)/gi;
  for (const match of String(node.chinese || "").matchAll(chinesePattern)) {
    const target = match[1].trim().replace(/[\]】()（）。，、；;,.:：*]+$/u, "");
    if (target) refs.push({ target, display: target });
  }
  for (const match of String(node.english || "").matchAll(englishPattern)) {
    const target = match[1].trim().replace(/[\]】()（）.,;:*]+$/u, "");
    if (target) refs.push({ target, display: target });
  }
  return refs;
}

function createReferenceAnchor(ref) {
  const link = document.createElement("a");
  link.href = "#";
  link.className = "ref-inline";
  link.textContent = ref.display;
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    summaryEl.textContent = `正在定位：${ref.target}`;
    try {
      const response = await fetch(`/api/locate?target=${encodeURIComponent(ref.target)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      renderSummary(data);
      renderTree(data);
      queryInput.value = ref.target;
    } catch (error) {
      console.error(error);
      summaryEl.textContent = "定位失败，请重试。";
    }
  });
  return link;
}

function appendTextWithReferenceLinks(container, text, refs) {
  if (!text || !refs.length) {
    container.appendChild(document.createTextNode(text || ""));
    return;
  }
  const lower = text.toLowerCase();
  const matches = refs
    .map((ref) => ({ ref, index: lower.indexOf(ref.display.toLowerCase()) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (!matches.length) {
    container.appendChild(document.createTextNode(text));
    return;
  }
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    if (match.index > cursor) container.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    container.appendChild(createReferenceAnchor(match.ref));
    cursor = match.index + match.ref.display.length;
  }
  if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
}

function appendNodeTitle(container, node) {
  const refs = extractReferences(node);
  const parts = [node.chinese, node.english].filter(Boolean).map((part) => String(part).replace(/\*{1,2}/g, ""));
  if (parts.length) {
    appendTextWithReferenceLinks(container, parts.join(" / "), refs);
  } else {
    container.appendChild(document.createTextNode("(无标题)"));
  }
  for (const code of node.codes || []) {
    container.appendChild(document.createTextNode(" "));
    container.appendChild(createCodeAnchor(code));
  }
}

function renderNeoplasmCodes(node) {
  const rows = [];
  for (const [key, label] of NEOPLASM_FIELDS) {
    const values = node.neoplasm?.[key] || [];
    if (!values.length) continue;
    const item = document.createElement("span");
    item.className = "neoplasm-item";
    const name = document.createElement("span");
    name.className = "neoplasm-label";
    name.textContent = `${label}：`;
    item.appendChild(name);
    values.forEach((code, index) => {
      if (index) item.appendChild(document.createTextNode(" "));
      item.appendChild(createCodeAnchor(code));
    });
    rows.push(item);
  }
  if (!rows.length) return null;
  const grid = document.createElement("div");
  grid.className = "neoplasm-grid";
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
    const params = new URLSearchParams({
      id: node.id,
      q: currentQuery,
      mode: currentMode,
    });
    const response = await fetch(`/api/children?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    fullContainer = document.createElement("div");
    fullContainer.className = "child-list";
    (data.children || []).forEach((child) => fullContainer.appendChild(renderNode(child, false)));
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
  const query = queryInput.value.trim();
  currentQuery = query;
  currentMode = document.querySelector("input[name='searchMode']:checked")?.value || "auto";

  currentSearchController?.abort();
  currentSearchController = new AbortController();
  summaryEl.textContent = "加载中……";
  treeContainer.innerHTML = '<p class="loading">正在检索索引……</p>';

  try {
    const response = await fetch(buildSearchUrl(query, currentMode), { signal: currentSearchController.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderSummary(data);
    renderTree(data);
    if (updateUrl) {
      const url = new URL(location.href);
      if (query) url.searchParams.set("q", query);
      else url.searchParams.delete("q");
      history.replaceState(null, "", url);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error(error);
    summaryEl.textContent = "检索失败，请稍后重试。";
    treeContainer.replaceChildren();
  } finally {
    currentSearchController = null;
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
  if (event.key === "Enter") {
    event.preventDefault();
    performSearch();
  }
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

window.addEventListener("DOMContentLoaded", () => {
  queryInput.value = new URL(location.href).searchParams.get("q") || "";
  performSearch({ updateUrl: false });
});
