/**
 * 流式 JSON 扫描器：从模型输出流里增量切出「目标数组内已完整闭合的对象」。
 *
 * 为什么需要它：段级流式要求「每完成一段就上屏、落库、推送」，而模型是一次吐一整个
 * JSON 响应（`{"analyses":[{…},{…}], …}`）。只有把已闭合的对象及时切出来，一批多段时
 * 才能逐段反馈，而不是等整批跑完（见 docs/architecture-v2.md §五）。
 *
 * 铁律：**半截对象绝不产出**。上屏、入库、推前端都必须等一个对象完整闭合，
 * 否则界面会渲染出残缺的段落、库里会落进半个分析。
 *
 * 设计取舍：本模块只负责「切出对象文本」，**不做 JSON.parse，也不做容错修复**。
 * 解析失败、模型引号退化（全角闭引号被写成 ASCII）等问题一律交给调用方复用既有的
 * 三级修复链（`openai-compatible.parseJsonResponse`）。这样扫描器零依赖、纯函数式、
 * 极易测试，也不会和修复策略耦合。
 */
type Frame = "object" | "array" | "target-array";

export interface JsonObjectStreamScannerOptions {
  /**
   * 目标数组的键名：只收集该键对应数组里的直接元素对象。
   * 默认 "analyses"（我们的分析响应信封）。
   */
  arrayKey?: string;
}

export class JsonObjectStreamScanner {
  private readonly arrayKey: string;
  private text = "";
  private cursor = 0;
  private stack: Frame[] = [];
  private inString = false;
  private escaped = false;
  private stringStart = -1;
  private lastString = "";
  private pendingKey: string | null = null;
  private objectStart = -1;

  public constructor(options: JsonObjectStreamScannerOptions = {}) {
    this.arrayKey = options.arrayKey ?? "analyses";
  }

  /**
   * 喂入一段流式文本，返回本次新切出的完整对象文本（可能 0 个或多个）。
   *
   * 返回值是**原始 JSON 文本**而非解析结果：JSON.parse 失败的处理权交给调用方。
   */
  public push(chunk: string): string[] {
    if (chunk.length > 0) {
      this.text += chunk;
    }
    return this.scan();
  }

  /**
   * 是否还有「已开始但未闭合」的对象。
   *
   * 流正常结束时为 false；为 true 说明响应被截断或非法，调用方应据此判定失败，
   * 而不是把已切出的部分当成完整结果。
   */
  public hasPendingObject(): boolean {
    return this.objectStart >= 0;
  }

  /** 尚未闭合的残余文本（仅用于错误诊断与调试日志，不含已产出的部分）。 */
  public pendingText(): string {
    return this.objectStart >= 0 ? this.text.slice(this.objectStart) : "";
  }

  /** 已消费的全部流式文本（调用方需要原样写入调试日志时用）。 */
  public rawText(): string {
    return this.text;
  }

  public reset(): void {
    this.text = "";
    this.cursor = 0;
    this.stack = [];
    this.inString = false;
    this.escaped = false;
    this.stringStart = -1;
    this.lastString = "";
    this.pendingKey = null;
    this.objectStart = -1;
  }

  private scan(): string[] {
    const found: string[] = [];
    const text = this.text;

    for (let index = this.cursor; index < text.length; index += 1) {
      const char = text[index]!;

      // 字符串内部：只维护转义状态，结构字符一律不参与计数
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (char === "\\") {
          this.escaped = true;
        } else if (char === "\"") {
          this.inString = false;
          this.lastString = text.slice(this.stringStart + 1, index);
        }
        continue;
      }

      switch (char) {
        case "\"": {
          this.inString = true;
          this.stringStart = index;
          break;
        }
        case ":": {
          // 记录「这个字符串是一个键」，供后面的 "[" 判定数组类型
          this.pendingKey = this.lastString;
          break;
        }
        case "{": {
          if (this.stack[this.stack.length - 1] === "target-array") {
            this.objectStart = index;
          }
          this.stack.push("object");
          this.pendingKey = null;
          break;
        }
        case "}": {
          const frame = this.stack.pop();
          const isTargetElement =
            frame === "object"
            && this.objectStart >= 0
            && this.stack[this.stack.length - 1] === "target-array";
          if (isTargetElement) {
            found.push(text.slice(this.objectStart, index + 1));
            this.objectStart = -1;
          }
          this.pendingKey = null;
          break;
        }
        case "[": {
          this.stack.push(this.pendingKey === this.arrayKey ? "target-array" : "array");
          this.pendingKey = null;
          break;
        }
        case "]": {
          this.stack.pop();
          this.pendingKey = null;
          break;
        }
        case ",": {
          this.pendingKey = null;
          break;
        }
        default: {
          break;
        }
      }
    }

    this.cursor = text.length;
    return found;
  }
}
