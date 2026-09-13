import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyError, ObservabilityLogger } from "../src/observability.js";

describe("classifyError", () => {
  it("按优先级分类常见错误", () => {
    expect(classifyError("This operation was aborted")).toBe("cancelled");
    expect(classifyError("401 Invalid API key")).toBe("auth");
    expect(classifyError("429 Too Many Requests")).toBe("rate-limit");
    expect(classifyError("Request timed out after 60000 ms")).toBe("timeout");
    expect(classifyError("finish_reason=length, max_tokens reached")).toBe("truncated");
    expect(classifyError("LLM returned invalid JSON: Bad control character")).toBe("invalid-json");
    expect(classifyError("LLM analysis did not match the schema (tokens.0.confidence)")).toBe(
      "schema"
    );
    expect(classifyError("本地模型服务未启动（ECONNREFUSED 127.0.0.1:11434）")).toBe(
      "service-unavailable"
    );
    expect(classifyError("莫名其妙的失败")).toBe("unknown");
  });

  it("取消优先于超时（取消报错常含 abort 字样）", () => {
    expect(classifyError("aborted due to timeout")).toBe("cancelled");
  });
});

describe("ObservabilityLogger", () => {
  /** 每个 it 独立临时目录，互不干扰。 */
  function createLogger(enabled: boolean): { logger: ObservabilityLogger; file: string; directory: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"));
    const file = path.join(directory, "events.jsonl");
    const logger = new ObservabilityLogger();
    logger.configure(enabled, file);
    return { logger, file, directory };
  }

  it("默认关闭时不写任何文件", () => {
    const { logger, file, directory } = createLogger(false);
    expect(logger.enabled).toBe(false);
    logger.write({ event: "analyze_start", documentId: "d1" });
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("开启后追加 JSONL：每行一个事件，自动带 ISO 时间戳", () => {
    const { logger, file, directory } = createLogger(true);
    logger.write({ event: "analyze_start", documentId: "d1" });
    logger.write({ event: "analyze_finish", documentId: "d1", outcome: "success" });

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { event: string; documentId: string; at: string };
    expect(first.event).toBe("analyze_start");
    expect(first.documentId).toBe("d1");
    expect(typeof first.at).toBe("string");
    expect(() => new Date(first.at).toISOString()).not.toThrow();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("写盘失败静默吞掉（观测性永远不拖垮业务）", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"));
    const logger = new ObservabilityLogger();
    // 目标目录不存在 → 写入必然失败
    logger.configure(true, path.join(directory, "no-such-dir", "events.jsonl"));
    expect(() => logger.write({ event: "analyze_start" })).not.toThrow();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
