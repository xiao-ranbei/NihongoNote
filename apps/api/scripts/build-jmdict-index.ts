/**
 * 构建 jmdict-common 精简索引（本地处理，零 token）。
 *
 *   pnpm --filter @nihongonote/api build:jmdict-index
 *
 * 输入：jmdict-simplified 的 jmdict-eng-common JSON（CC BY-SA 3.0 / EDRD G）。
 * 输出：apps/api/data/jmdict-common-index.json（位于 data/ 目录，已被 gitignore，不入库）。
 *
 * 设计约束（docs/jmdict-integration-design.md 五/存储节）：预构建精简索引，
 * 不用原始 16.5MB JSON，也不用 SQLite；运行时 provider 只读这个精简文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE_DIR = path.join(API_ROOT, "data", ".cache");
const DEFAULT_OUTPUT = path.join(API_ROOT, "data", "jmdict-common-index.json");
const DOWNLOAD_URL =
  "https://github.com/scriptin/jmdict-simplified/releases/download/3.6.2%2B20260831182826/jmdict-eng-common-3.6.2%2B20260831182826.json.zip";

/** JMdict 词性缩写 → 中文展示词性（未知缩写原样保留）。 */
const POS_MAP: Record<string, string> = {
  n: "名詞",
  "n-adv": "名詞",
  "n-suf": "名詞(接尾)",
  "n-pref": "名詞(接頭)",
  "n-t": "名詞",
  ns: "名詞",
  "n-pr": "固有名詞",
  v1: "動詞",
  v5: "動詞",
  v5u: "動詞",
  v5r: "動詞",
  v5k: "動詞",
  v5g: "動詞",
  v5s: "動詞",
  v5t: "動詞",
  v5n: "動詞",
  v5m: "動詞",
  v5b: "動詞",
  v5w: "動詞",
  vz: "動詞",
  vr: "動詞",
  vk: "動詞",
  vn: "動詞",
  vs: "動詞",
  "vs-s": "動詞",
  "vs-i": "動詞",
  v4: "動詞",
  "adj-i": "形容詞",
  "adj-ix": "形容詞",
  "adj-na": "形容動詞",
  "adj-nari": "形容動詞",
  "adj-no": "形容動詞",
  "adj-f": "形容詞",
  "adj-pn": "連体詞",
  "adj-t": "形容動詞",
  adv: "副詞",
  "adv-to": "副詞",
  aux: "助動詞",
  "aux-v": "助動詞",
  "aux-adj": "助動詞",
  cop: "助動詞",
  conj: "接続詞",
  int: "感動詞",
  prn: "代名詞",
  pn: "代名詞",
  pref: "接頭辞",
  suf: "接尾辞",
  num: "数詞",
  exp: "表現",
  adn: "連体詞",
  prt: "助詞",
  unc: "不明"
};

interface SlimEntry {
  r: string | null;
  p: string[];
  g: { l: string; t: string }[];
}

function pickArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** 解析输入 JSON：优先级 --input > env > 缓存 > 下载并解压。 */
function resolveInput(override?: string): string {
  if (override) return path.resolve(override);
  const env = process.env.JMDICT_ENG_COMMON_JSON;
  if (env) return path.resolve(env);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = fs
    .readdirSync(CACHE_DIR)
    .filter((f) => /^jmdict-eng-common-.*\.json$/.test(f))
    .sort();
  if (cached.length) return path.join(CACHE_DIR, cached[cached.length - 1]!);

  const zipPath = path.join(CACHE_DIR, "jmdict-eng-common.zip");
  console.log(`下载 ${DOWNLOAD_URL}`);
  const res = spawnSync("curl", ["-sL", "-C", "-", "--max-time", "300", "-o", zipPath, DOWNLOAD_URL], {
    stdio: "inherit"
  });
  if (res.status !== 0) throw new Error("下载失败");
  const uz = spawnSync("unzip", ["-o", "-q", zipPath, "-d", CACHE_DIR], { stdio: "inherit" });
  if (uz.status !== 0) throw new Error("解压失败");
  const extracted = fs
    .readdirSync(CACHE_DIR)
    .filter((f) => /^jmdict-eng-common-.*\.json$/.test(f))
    .sort();
  if (!extracted.length) throw new Error("解压后未找到 JSON");
  return path.join(CACHE_DIR, extracted[extracted.length - 1]!);
}

function mapPos(abbrs: string[]): string[] {
  const set = new Set<string>();
  for (const a of abbrs) set.add(POS_MAP[a] ?? a);
  return [...set];
}

function main(): void {
  const args = process.argv.slice(2);
  const input = resolveInput(pickArg(args, "--input"));
  const output = pickArg(args, "--output") ?? DEFAULT_OUTPUT;

  console.log(`读取源: ${input}`);
  const data = JSON.parse(fs.readFileSync(input, "utf8")) as {
    version?: string;
    words?: Array<{
      kanji?: Array<{ text: string; common?: boolean }>;
      kana?: Array<{ text: string; common?: boolean }>;
      sense?: Array<{
        partOfSpeech?: string[];
        gloss?: Array<{ lang: string; text: string }>;
      }>;
    }>;
  };

  const words = data.words ?? [];
  const entries: Record<string, SlimEntry> = {};
  let skipped = 0;

  for (const w of words) {
    const kanji = (w.kanji ?? []).map((k) => k.text);
    const kana = (w.kana ?? []).map((k) => k.text);
    const reading =
      (kana.find((_, i) => w.kana?.[i]?.common) ?? kana[0] ?? null) as string | null;

    const posSet = new Set<string>();
    const glosses: { l: string; t: string }[] = [];
    for (const s of w.sense ?? []) {
      for (const p of s.partOfSpeech ?? []) posSet.add(p);
      for (const gl of s.gloss ?? []) {
        if (gl.lang === "eng") glosses.push({ l: "en", t: gl.text });
      }
    }
    if (glosses.length === 0) {
      skipped++;
      continue;
    }

    const pos = mapPos([...posSet]);
    const surfaces = new Set<string>([...kanji, ...kana].filter(Boolean));
    for (const s of surfaces) entries[s] = { r: reading, p: pos, g: glosses };
  }

  const out = {
    version: data.version ?? null,
    source: "jmdict",
    license: "CC BY-SA 3.0 (EDRDG)",
    entries
  };
  fs.writeFileSync(output, JSON.stringify(out));
  const bytes = fs.statSync(output).size;
  console.log(`索引已写出: ${output}`);
  console.log(
    `源词条(words) ${words.length} | 跳过(无英文释义) ${skipped} | 索引表面键 ${Object.keys(entries).length} | 体积 ${(bytes / 1024 / 1024).toFixed(2)} MB`
  );
  console.log("抽样：時間/営業/見積もり/本/かかる 是否存在 →", [
    "時間",
    "営業",
    "見積もり",
    "本",
    "かかる"
  ].map((s) => `${s}:${entries[s] ? "Y" : "N"}`).join("  "));
}

main();
