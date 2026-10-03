export const ROW_IMAGE_PAGE = 0;
export const ROW_LEVEL = 1;
export const ROW_CHINESE = 2;
export const ROW_ENGLISH = 3;
export const ROW_CODE = 4;
export const ROW_CONFIDENCE = 5;
export const ROW_MALIGNANT_PRIMARY = 6;
export const ROW_MALIGNANT_SECONDARY = 7;
export const ROW_IN_SITU = 8;
export const ROW_BENIGN = 9;
export const ROW_UNCERTAIN = 10;
export const ROW_SOURCE_FILE = 11;
export const ROW_SEARCH_BLOB = 12;
export const ROW_NORMALIZED_CODES = 13;
export const ROW_PARENT = 14;
export const ROW_SUBTREE_END = 15;

export function normalizeText(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return ["nan", "none", "null"].includes(text.toLowerCase()) ? "" : text;
}

export function normalizeCode(value) {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

export function looksLikeIcdQuery(query) {
  return /^[a-z][0-9]{1,2}(?:[.\-x0-9a-z]*)?$/i.test(normalizeText(query));
}

export function rowMatchesSearch(row, query, mode) {
  const queryLower = normalizeText(query).toLowerCase();
  if (!queryLower) return false;
  if (mode === "code") {
    const codeQuery = normalizeCode(queryLower);
    return String(row[ROW_NORMALIZED_CODES] || "")
      .split(/\s+/)
      .some((code) => code.startsWith(codeQuery));
  }
  const text = normalizeText(row[ROW_SEARCH_BLOB]).toLowerCase();
  if (mode === "phrase") return text.includes(queryLower);
  return queryLower.split(/\s+/).filter(Boolean).every((token) => text.includes(token));
}

export function codeCandidateIndices(dataset, query) {
  const prefix = normalizeCode(query);
  const indices = new Set();
  for (const [code, values] of Object.entries(dataset.code_index || {})) {
    if (!code.startsWith(prefix)) continue;
    for (const index of values) indices.add(index);
  }
  return [...indices].sort((left, right) => left - right);
}

export function findSearchIndices(dataset, query, mode = "auto") {
  const queryText = normalizeText(query);
  const rows = dataset.rows || [];
  if (!queryText) {
    const roots = [];
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index][ROW_LEVEL] === 0) roots.push(index);
    }
    return roots;
  }
  const candidates =
    mode === "code" || (mode === "auto" && looksLikeIcdQuery(queryText))
      ? codeCandidateIndices(dataset, queryText)
      : rows.map((_, index) => index);
  return candidates.filter((index) => rowMatchesSearch(rows[index], queryText, mode));
}

function locateExactMatch(row, target) {
  const lower = normalizeText(target).toLowerCase();
  return [row[ROW_ENGLISH], row[ROW_CHINESE]]
    .some((value) => normalizeText(value).toLowerCase() === lower);
}

function normalizeLocatePhrase(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/，/g, ",")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function locatePartSpan(row, parts, startIndex) {
  const values = [row[ROW_ENGLISH], row[ROW_CHINESE]]
    .map(normalizeLocatePhrase)
    .filter(Boolean);
  for (let span = parts.length - startIndex; span >= 1; span -= 1) {
    const target = normalizeLocatePhrase(parts.slice(startIndex, startIndex + span).join(","));
    for (const text of values) {
      if (text === target) return span;
      if (text.startsWith(target) && " ,-/()—：:".includes(text[target.length] || "")) {
        return span;
      }
    }
  }
  return 0;
}

export function locateIndex(dataset, target) {
  const normalized = normalizeText(target).toLowerCase();
  if (!normalized) return -1;
  if (looksLikeIcdQuery(normalized)) {
    const exact = dataset.code_index?.[normalizeCode(normalized)] || [];
    if (exact.length) return exact[0];
  }

  const parts = normalized.split(/[，,]/).map((part) => part.trim()).filter(Boolean);
  const firstPart = parts[0] || normalized;
  const candidates = dataset.rows
    .map((row, index) => ({
      index,
      row,
      exact: locateExactMatch(row, firstPart),
      span: locatePartSpan(row, parts, 0),
    }))
    .filter(({ span }) => span > 0)
    .sort((left, right) =>
      left.row[ROW_LEVEL] - right.row[ROW_LEVEL]
      || Number(right.exact) - Number(left.exact)
      || left.index - right.index);

  for (const candidate of candidates) {
    let current = candidate.index;
    let partIndex = candidate.span;
    while (partIndex < parts.length) {
      const end = dataset.rows[current][ROW_SUBTREE_END];
      let next = -1;
      let nextSpan = 0;

      for (let index = current + 1; index < end; index += 1) {
        const row = dataset.rows[index];
        if (row[ROW_PARENT] !== current) continue;
        const span = locatePartSpan(row, parts, partIndex);
        if (span > 0) {
          next = index;
          nextSpan = span;
          break;
        }
      }

      if (next < 0) {
        for (let index = current + 1; index < end; index += 1) {
          const span = locatePartSpan(dataset.rows[index], parts, partIndex);
          if (span > 0) {
            next = index;
            nextSpan = span;
            break;
          }
        }
      }

      if (next < 0) break;
      current = next;
      partIndex += nextSpan;
    }
    if (partIndex === parts.length) return current;
  }

  return parts.length <= 1 ? candidates[0]?.index ?? -1 : -1;
}

function parenthesisDepthAt(text, end) {
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    const char = text[index];
    if (char === "(" || char === "（") depth += 1;
    else if ((char === ")" || char === "）") && depth > 0) depth -= 1;
  }
  return depth;
}

function referenceTargetEnd(text, start) {
  const baseDepth = parenthesisDepthAt(text, start);
  let depth = baseDepth;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === "（") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "）") {
      if (depth <= baseDepth) return index;
      depth -= 1;
      continue;
    }
    if ((char === ";" || char === "；" || char === "\n" || char === "\r") && depth === baseDepth) {
      return index;
    }
  }
  return text.length;
}

function trimReferenceRange(text, start, end) {
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /[\s\]】。，、；;,.:：*]/u.test(text[end - 1])) end -= 1;
  return { start, end };
}

function chineseMarkerAllowed(text, index, marker) {
  if (marker !== "见") return true;
  if (index === 0) return true;
  return /[\s\-—–(（；;，,:：]/u.test(text[index - 1]);
}

export function extractReferencesFromText(value, language) {
  const text = String(value ?? "");
  const refs = [];
  const markerRe = language === "en" ? /\bsee(?:\s+also)?\b/giu : /另见|参见|见/gu;

  for (const match of text.matchAll(markerRe)) {
    const marker = match[0];
    const markerIndex = match.index ?? 0;
    if (language !== "en" && !chineseMarkerAllowed(text, markerIndex, marker)) continue;

    let start = markerIndex + marker.length;
    while (start < text.length && /[\s:：]/u.test(text[start])) start += 1;
    if (start >= text.length) continue;

    const rawEnd = referenceTargetEnd(text, start);
    const range = trimReferenceRange(text, start, rawEnd);
    if (range.end <= range.start) continue;

    const display = text.slice(range.start, range.end);
    refs.push({ target: display, display, start: range.start, end: range.end, language });
  }
  return refs;
}
