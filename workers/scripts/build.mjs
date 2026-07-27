import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");
export const WORKERS_DIR = path.join(ROOT_DIR, "workers");
export const PUBLIC_DIR = path.join(WORKERS_DIR, "public");
export const STATIC_DIR = path.join(PUBLIC_DIR, "static");
export const DATA_DIR = path.join(PUBLIC_DIR, "data");

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
export const HIERARCHY_MIN_LEVEL = 2;

export const ROW_SCHEMA = Object.freeze([
  "image_page",
  "level",
  "chinese",
  "english",
  "code",
  "confidence",
  "malignant_primary",
  "malignant_secondary",
  "in_situ",
  "benign",
  "uncertain_or_unspecified",
  "source_file_index",
  "search_blob",
  "normalized_codes",
  "parent_index",
  "subtree_end",
]);

const FIELD_ALIASES = Object.freeze({
  image_page: new Set(["image_page", "page", "imagepage"]),
  level: new Set(["level", "indent", "depth"]),
  chinese: new Set(["chinese", "zh", "cn", "中文"]),
  english: new Set(["english", "en", "英文"]),
  code: new Set(["code", "icd", "icd_code", "icd10", "icd_10"]),
  confidence: new Set(["confidence", "score", "probability"]),
  malignant_primary: new Set(["malignant_primary", "primary_malignant", "malignantprimary"]),
  malignant_secondary: new Set(["malignant_secondary", "secondary_malignant", "malignantsecondary"]),
  in_situ: new Set(["in_situ", "insitu", "carcinoma_in_situ"]),
  benign: new Set(["benign"]),
  uncertain_or_unspecified: new Set([
    "uncertain_or_unspecified",
    "uncertain_unspecified",
    "uncertain",
    "unspecified_behavior",
  ]),
});

const ICD_CODE_RE = /\b([A-Z][0-9]{2}(?:\.[0-9A-Z]{1,8})?)[†*]?\b/giu;
const EMPTY_MARKERS = new Set(["", "*", "**", "-", "--", "—", "–", "nan", "none", "null"]);
export function parseCsvText(text) {
  const records = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = "";
    } else if (char === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (inQuotes) throw new Error("CSV contains an unterminated quoted field");
  if (field.length || row.length) {
    row.push(field);
    records.push(row);
  }
  return records;
}

const HEADERLESS_INDEX_MAP = Object.freeze({
  image_page: 0,
  level: 1,
  chinese: 2,
  english: 3,
  code: 4,
  confidence: 5,
  malignant_primary: 6,
  malignant_secondary: 7,
  in_situ: 8,
  benign: 9,
  uncertain_or_unspecified: 10,
});

export function canonicalHeader(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replaceAll("\\", "")
    .trim()
    .replace(/^\*+|\*+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/[^0-9a-z_\u4e00-\u9fff]/g, "")
    .replace(/^_+|_+$/g, "");
}

export function resolveHeader(header) {
  const canonical = header.map(canonicalHeader);
  const resolved = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const index = canonical.findIndex((name) => aliases.has(name));
    if (index >= 0) resolved[field] = index;
  }
  return resolved;
}

export function parseIntSafe(value, fallback = 0) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const parsed = Number.parseInt(String(Number(text)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseFloatSafe(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function cleanText(value) {
  const text = String(value ?? "").normalize("NFKC").trim();
  return ["nan", "none", "null"].includes(text.toLowerCase()) ? "" : text;
}

export function cleanCodeCell(value) {
  const text = cleanText(value);
  return EMPTY_MARKERS.has(text.toLowerCase()) ? "" : text;
}

export function extractCodes(...values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanText(value).toUpperCase();
    for (const match of text.matchAll(ICD_CODE_RE)) {
      const code = match[1].toUpperCase();
      if (!seen.has(code)) {
        seen.add(code);
        result.push(code);
      }
    }
  }
  return result;
}

function getCell(row, indexMap, field) {
  const index = indexMap[field];
  return Number.isInteger(index) && index >= 0 && index < row.length ? row[index] : "";
}

export function isProbableHeader(row) {
  const names = new Set(Object.keys(resolveHeader(row)));
  return names.has("level") && names.has("chinese") && names.has("image_page");
}

export async function readInputRows(filePath) {
  const csvText = await readFile(filePath, "utf8");
  const records = parseCsvText(csvText.replace(/^\uFEFF/, ""));
  if (!records.length) return [];

  const first = records[0];
  const hasHeader = isProbableHeader(first);
  const indexMap = hasHeader ? resolveHeader(first) : HEADERLESS_INDEX_MAP;
  const startIndex = hasHeader ? 1 : 0;
  const parsedRows = [];

  for (let recordIndex = startIndex; recordIndex < records.length; recordIndex += 1) {
    const row = records[recordIndex];
    const lineNo = recordIndex + 1;
    if (!Array.isArray(row) || !row.some((cell) => cleanText(cell))) continue;

    const imagePage = parseIntSafe(getCell(row, indexMap, "image_page"), -1);
    if (imagePage < 0) continue;

    const level = Math.max(0, parseIntSafe(getCell(row, indexMap, "level"), 0));
    const chinese = cleanText(getCell(row, indexMap, "chinese"));
    const english = cleanText(getCell(row, indexMap, "english"));
    const code = cleanCodeCell(getCell(row, indexMap, "code"));
    const malignantPrimary = cleanCodeCell(getCell(row, indexMap, "malignant_primary"));
    const malignantSecondary = cleanCodeCell(getCell(row, indexMap, "malignant_secondary"));
    const inSitu = cleanCodeCell(getCell(row, indexMap, "in_situ"));
    const benign = cleanCodeCell(getCell(row, indexMap, "benign"));
    const uncertain = cleanCodeCell(getCell(row, indexMap, "uncertain_or_unspecified"));
    const confidence = parseFloatSafe(getCell(row, indexMap, "confidence"));
    const codes = extractCodes(code, malignantPrimary, malignantSecondary, inSitu, benign, uncertain);
    const searchBlob = [
      chinese,
      english,
      code,
      malignantPrimary,
      malignantSecondary,
      inSitu,
      benign,
      uncertain,
      codes.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    parsedRows.push({
      source_line: lineNo,
      image_page: imagePage,
      level,
      chinese,
      english,
      code,
      confidence,
      malignant_primary: malignantPrimary,
      malignant_secondary: malignantSecondary,
      in_situ: inSitu,
      benign,
      uncertain_or_unspecified: uncertain,
      search_blob: searchBlob,
      codes,
    });
  }

  return parsedRows;
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function discoverInputs(explicit = []) {
  let paths;
  if (explicit.length) {
    paths = explicit.map((value) => path.resolve(value));
  } else {
    const sourceDir = path.join(ROOT_DIR, "data", "source");
    const entries = await readdir(sourceDir, { withFileTypes: true });
    paths = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
      .map((entry) => path.join(sourceDir, entry.name))
      .sort((a, b) => a.localeCompare(b, "en"));
    const nonSample = paths.filter((filePath) => !filePath.includes(".sample."));
    if (nonSample.length) paths = nonSample;
  }

  const missing = [];
  for (const filePath of paths) {
    if (!(await isFile(filePath))) missing.push(filePath);
  }
  if (missing.length) throw new Error(`Input CSV not found: ${missing.join(", ")}`);
  if (!paths.length) throw new Error("No CSV found. Put files in data/source/ or pass --input PATH.");
  return paths;
}

export async function copyAssets() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await rm(STATIC_DIR, { recursive: true, force: true });
  await cp(path.join(ROOT_DIR, "static"), STATIC_DIR, { recursive: true });
  await cp(path.join(ROOT_DIR, "templates", "index.html"), path.join(PUBLIC_DIR, "index.html"));
}

export async function buildDataset(paths) {
  const rawRows = [];
  const warnings = [];
  const sourceFiles = paths.map((filePath) => path.basename(filePath));

  for (let sourceIndex = 0; sourceIndex < paths.length; sourceIndex += 1) {
    const fileRows = await readInputRows(paths[sourceIndex]);
    for (const row of fileRows) rawRows.push({ ...row, source_file_index: sourceIndex });
  }

  const rows = [];
  const stack = [];
  let rootCount = 0;
  let ignoredHierarchyRowCount = 0;

  for (const raw of rawRows) {
    const level = raw.level;

    while (stack.length && rows[stack.at(-1)][ROW_LEVEL] >= level) {
      rows[stack.pop()][ROW_SUBTREE_END] = rows.length;
    }

    let parentIndex;
    if (stack.length) {
      const parentLevel = rows[stack.at(-1)][ROW_LEVEL];
      if (level > parentLevel + 1) {
        warnings.push({
          type: "level_gap",
          source_file: sourceFiles[raw.source_file_index],
          source_line: raw.source_line,
          level,
          parent_level: parentLevel,
          message: `level jumps from ${parentLevel} to ${level}`,
        });
      }
      parentIndex = stack.at(-1);
    } else {
      parentIndex = -1;
      rootCount += 1;
      if (level > HIERARCHY_MIN_LEVEL) {
        warnings.push({
          type: "orphan_hierarchy_level",
          source_file: sourceFiles[raw.source_file_index],
          source_line: raw.source_line,
          level,
          message: `level ${level} has no preceding level ${HIERARCHY_MIN_LEVEL} or deeper parent and is treated as a root`,
        });
      }
    }

    rows.push([
      raw.image_page,
      level,
      raw.chinese,
      raw.english,
      raw.code,
      raw.confidence,
      raw.malignant_primary,
      raw.malignant_secondary,
      raw.in_situ,
      raw.benign,
      raw.uncertain_or_unspecified,
      raw.source_file_index,
      raw.search_blob,
      raw.codes.map((code) => code.toLowerCase()).join(" "),
      parentIndex,
      -1,
    ]);
    stack.push(rows.length - 1);

    if (level < HIERARCHY_MIN_LEVEL) ignoredHierarchyRowCount += 1;
  }

  while (stack.length) rows[stack.pop()][ROW_SUBTREE_END] = rows.length;

  const codeIndex = {};
  for (let index = 0; index < rows.length; index += 1) {
    for (const code of String(rows[index][ROW_NORMALIZED_CODES]).split(/\s+/).filter(Boolean)) {
      (codeIndex[code] ??= []).push(index);
    }
  }

  return {
    dataset: {
      meta: {
        row_count: rows.length,
        root_count: rootCount,
        row_schema: ROW_SCHEMA,
        generated_from: sourceFiles,
        hierarchy_min_level: HIERARCHY_MIN_LEVEL,
        hierarchy_ignored_row_count: ignoredHierarchyRowCount,
      },
      source_files: sourceFiles,
      rows,
      code_index: codeIndex,
    },
    report: {
      row_count: rows.length,
      root_count: rootCount,
      source_files: sourceFiles,
      hierarchy_min_level: HIERARCHY_MIN_LEVEL,
      hierarchy_ignored_row_count: ignoredHierarchyRowCount,
      warning_count: warnings.length,
      warnings,
    },
  };
}

export function parseArgs(argv) {
  const options = { input: [], pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input" || arg === "-i") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options.input.push(value);
      index += 1;
    } else if (arg.startsWith("--input=")) {
      options.input.push(arg.slice("--input=".length));
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/build.mjs [options]\n\nOptions:\n  -i, --input PATH  CSV input path; repeat for multiple files\n      --pretty      Pretty-print dataset.json\n  -h, --help        Show this help`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const paths = await discoverInputs(options.input);
  await copyAssets();
  const { dataset, report } = await buildDataset(paths);
  await writeFile(
    path.join(DATA_DIR, "dataset.json"),
    JSON.stringify(dataset, null, options.pretty ? 2 : 0),
    "utf8",
  );
  await writeFile(path.join(DATA_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(`Built ${dataset.meta.row_count} rows from ${paths.length} CSV file(s).`);
  console.log(`Rebuilt ${dataset.meta.root_count} roots across all levels; level 0/1 are display parents, but are excluded from search-result ancestry.`);
  if (report.warning_count) {
    console.log(`Warnings: ${report.warning_count} (see workers/public/data/build-report.json)`);
  }
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
