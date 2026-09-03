import { randomUUID } from "node:crypto";

import type { AppDatabase } from "../../db/database.js";
import { writeDebugLog } from "../../providers/openai-compatible.js";

/**
 * 内容词译中（设计文档 jmdict-integration-design.md §6.5 阶段 B）。
 *
 * JMdict 常用词仅英文释义；用户读中文，故内容词首次出现时用本地 Ollama 把英文
 * 译中并缓存 `vocabulary_cache`，之后命中缓存零推理。仅本地 Ollama 推理，
 * 不触发 DeepSeek、零云端费用（LLM-011 已批准）。
 *
 * Ollama 未启动 / 翻译失败 → `translate` 抛错，调用方据此回退英文原文，不阻断分析。
 */

export interface GlossTranslator {
  /** 把英文释义译为目标语言（中文）；服务不可用或禁用时抛错，由调用方回退。 */
  translate(term: string): Promise<string>;
  /** 译中开关（设置页切换；默认开）。 */
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  /** 本地 Ollama 服务是否可连接（GET 状态展示用，不抛错）。 */
  isAvailable(): Promise<boolean>;
}

export interface OllamaGlossTranslatorOptions {
  database: AppDatabase;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  debugLogging?: boolean;
  debugLogFile?: string;
  enabled?: boolean;
}

function normalizeTerm(term: string): string {
  return term.toLowerCase().replace(/\s+/gu, " ").trim();
}

function chatEndpointFor(baseUrl: string): string {
  return new URL(
    "api/chat",
    `${baseUrl.replace(/\/+$/u, "").replace(/\/v1$/iu, "")}/`
  ).toString();
}

function tagsEndpointFor(baseUrl: string): string {
  return new URL(
    "api/tags",
    `${baseUrl.replace(/\/+$/u, "").replace(/\/v1$/iu, "")}/`
  ).toString();
}

const SYSTEM_PROMPT =
  "你是严谨的词典翻译器。把用户给出的英文单词/短语翻译成简体中文。"
  + "只输出中文译文本身，不要解释、不要例句、不要引号、不要序号。"
  + "若原文含多个义项（分号分隔），用同样的简体中文分号「；」分隔对应义项。";

export class OllamaGlossTranslator implements GlossTranslator {
  private readonly database: AppDatabase;
  private readonly endpoint: string;
  private readonly tagsEndpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly debugLogging: boolean;
  private readonly debugLogFile: string;
  private enabled: boolean;

  public constructor(options: OllamaGlossTranslatorOptions) {
    this.database = options.database;
    this.endpoint = chatEndpointFor(options.baseUrl);
    this.tagsEndpoint = tagsEndpointFor(options.baseUrl);
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.debugLogging = options.debugLogging ?? false;
    this.debugLogFile = options.debugLogFile ?? "";
    this.enabled = options.enabled ?? true;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(this.tagsEndpoint, {
        signal: AbortSignal.timeout(5_000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  public async translate(term: string): Promise<string> {
    if (!this.enabled) {
      throw new Error("译中已禁用");
    }
    const key = normalizeTerm(term);
    if (key.length === 0) {
      throw new Error("空术语不翻译");
    }
    const cached = this.lookupCache(key);
    if (cached !== null) {
      return cached;
    }
    const translated = await this.callOllama(key);
    this.writeCache(key, translated);
    return translated;
  }

  private lookupCache(term: string): string | null {
    const row = this.database.get<{ translation: string }>(
      "SELECT translation FROM vocabulary_cache WHERE term = ?",
      [term]
    );
    return row ? row.translation : null;
  }

  private writeCache(term: string, translation: string): void {
    const now = new Date().toISOString();
    this.database.run(
      "INSERT OR REPLACE INTO vocabulary_cache (term, translation, lang, created_at) VALUES (?, ?, 'zh', ?)",
      [term, translation, now]
    );
  }

  private async callOllama(term: string): Promise<string> {
    const requestId = randomUUID();
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: term }
      ],
      think: false,
      options: { num_ctx: 1024, num_predict: 64, temperature: 0.1 },
      stream: true
    };

    writeDebugLog(this.debugLogging, this.debugLogFile, "translate.request.started", requestId, {
      endpoint: this.endpoint,
      model: this.model,
      term
    });

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      writeDebugLog(this.debugLogging, this.debugLogFile, "translate.request.failed", requestId, {
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "unknown"
      });
      throw new Error(`译中请求失败（Ollama 未启动？）：${error instanceof Error ? error.message : "unknown"}`);
    }

    if (!response.ok || !response.body) {
      throw new Error(`译中失败：Ollama 返回 HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }
          try {
            const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
            if (chunk.message?.content) {
              content += chunk.message.content;
            }
            if (chunk.done) {
              break;
            }
          } catch {
            // 不完整行跳过
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

  const translated = content.trim();
  if (translated.length === 0) {
    throw new Error("译中返回为空");
  }
  writeDebugLog(this.debugLogging, this.debugLogFile, "translate.response.received", requestId, {
    term,
    translation: translated
  });
  return translated;
  }
}

/**
 * 不启用译中的默认实现（镜像 NullContentDictionary）：disabled 状态下
 * segment-preparation 不会进入翻译分支，行为等于「内容词显示英文原文」。
 * 用于测试、verify、本地模型未配时的默认兜底。
 */
export class NullGlossTranslator implements GlossTranslator {
  private enabled = false;

  public async translate(): Promise<string> {
    throw new Error("译中未启用");
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public async isAvailable(): Promise<boolean> {
    return false;
  }
}
