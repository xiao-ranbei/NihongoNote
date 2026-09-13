import { describe, expect, it } from "vitest";

import { JsonObjectStreamScanner } from "../src/json-stream-scanner.js";

/*
 * 流式扫描器的测试重点在**分片边界**：模型输出怎么切块是不可控的，
 * 同一个响应可能一次到达，也可能被切成几百个字符逐字到达。
 * 因此最强的用例是「同一 payload 用多种粒度分片推送，结果必须完全一致」。
 */

/** 构造一个形状贴近真实的段落分析对象（字段齐全，含嵌套 tokens）。 */
const analysis = (segmentId: string, translation: string) =>
  `{"segmentId":${JSON.stringify(segmentId)},`
  + `"translation":${JSON.stringify(translation)},`
  + `"grammarSummary":null,"register":null,"tone":null,"politeness":null,`
  + `"impliedMeaning":null,"replyReason":null,"uncertaintyNote":null,`
  + `"tokens":[{"tokenId":"${segmentId}:token:0","startOffset":0,"endOffset":2,`
  + `"surface":"これ","category":"word","lemma":"これ","reading":"コレ",`
  + `"partOfSpeech":"名詞","conjugation":null,"gloss":"这个",`
  + `"particleFunction":null,"grammarPoint":null,"explanation":null,"confidence":1}],`
  + `"schemaVersion":1,"dictionaryCoverage":{"matched":1,"total":1}}`;

/** 构造完整响应信封：analyses + failures + usage（后两者都不该被切出）。 */
const envelope = (items: string[]) =>
  `{"analyses":[${items.join(",")}],`
  + `"failures":[{"segmentId":null,"message":"none"}],`
  + `"usage":{"inputTokens":100,"outputTokens":200,"totalTokens":300}}`;

const parse = (value: string) => JSON.parse(value) as { segmentId: string; translation: string };

describe("JsonObjectStreamScanner 基本切分", () => {
  it("整块推送时切出全部元素对象", () => {
    const scanner = new JsonObjectStreamScanner();
    const found = scanner.push(envelope([analysis("doc:segment:0", "甲"), analysis("doc:segment:1", "乙")]));
    expect(found).toHaveLength(2);
    expect(parse(found[0]!).segmentId).toBe("doc:segment:0");
    expect(parse(found[1]!).segmentId).toBe("doc:segment:1");
    expect(scanner.hasPendingObject()).toBe(false);
  });

  it("嵌套的 tokens 对象与 usage/failures 都不产出", () => {
    const scanner = new JsonObjectStreamScanner();
    const found = scanner.push(envelope([analysis("doc:segment:0", "甲")]));
    // 只有段落对象本身：tokens[0] 是嵌套对象，usage/failures 不在目标数组里
    expect(found).toHaveLength(1);
    expect(parse(found[0]!).segmentId).toBe("doc:segment:0");
  });

  it("空 analyses 数组产出 0 个", () => {
    const scanner = new JsonObjectStreamScanner();
    expect(scanner.push(envelope([]))).toEqual([]);
  });

  it("arrayKey 可配置（默认 analyses）", () => {
    const scanner = new JsonObjectStreamScanner({ arrayKey: "items" });
    expect(scanner.push(`{"items":[{"a":1},{"b":2}]}`)).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("JsonObjectStreamScanner 分片边界", () => {
  const payload = envelope([analysis("doc:segment:0", "甲"), analysis("doc:segment:1", "乙")]);

  it("任意分片粒度都与整块推送结果一致", () => {
    const reference = new JsonObjectStreamScanner().push(payload);

    for (const size of [1, 2, 3, 7, 13, 64, 200]) {
      const scanner = new JsonObjectStreamScanner();
      const collected: string[] = [];
      for (let index = 0; index < payload.length; index += size) {
        collected.push(...scanner.push(payload.slice(index, index + size)));
      }
      expect(collected, `分片粒度 ${size}`).toEqual(reference);
      expect(scanner.hasPendingObject(), `分片粒度 ${size} 结束后不应有残留`).toBe(false);
    }
  });

  it("逐字符推送也能逐段产出（模拟真实流式）", () => {
    const scanner = new JsonObjectStreamScanner();
    const collected: string[] = [];
    for (const char of payload) {
      collected.push(...scanner.push(char));
    }
    expect(collected).toHaveLength(2);
    expect(parse(collected[0]!).translation).toBe("甲");
  });

  it("对象刚闭合时立刻产出，不等后续内容", () => {
    const scanner = new JsonObjectStreamScanner();
    const first = analysis("doc:segment:0", "甲");
    const head = `{"analyses":[${first}`;
    expect(scanner.push(head)).toHaveLength(1);
    expect(scanner.push(",")).toEqual([]);
  });
});

describe("JsonObjectStreamScanner 截断与容错", () => {
  it("半截对象不产出，并标记存在未闭合对象", () => {
    const payload = envelope([analysis("doc:segment:0", "甲")]);
    const cut = payload.indexOf('"translation"') + 8;
    const scanner = new JsonObjectStreamScanner();

    expect(scanner.push(payload.slice(0, cut))).toEqual([]);
    expect(scanner.hasPendingObject()).toBe(true);
    expect(scanner.pendingText().startsWith("{")).toBe(true);
    expect(scanner.pendingText()).toContain('"segmentId"');
  });

  it("补上剩余片段后即可产出（截断后继续喂入）", () => {
    const payload = envelope([analysis("doc:segment:0", "甲")]);
    const cut = payload.indexOf('"translation"') + 8;
    const scanner = new JsonObjectStreamScanner();

    expect(scanner.push(payload.slice(0, cut))).toEqual([]);
    const found = scanner.push(payload.slice(cut));
    expect(found).toHaveLength(1);
    expect(scanner.hasPendingObject()).toBe(false);
  });

  it("字符串内的花括号与转义引号不影响结构判定", () => {
    const tricky = analysis("doc:segment:0", '他说「{」然后 \\ " 走[了]');
    const scanner = new JsonObjectStreamScanner();
    const found = scanner.push(envelope([tricky]));
    expect(found).toHaveLength(1);
    expect(parse(found[0]!).translation).toBe('他说「{」然后 \\ " 走[了]');
  });

  it("字段值为 null、数字、布尔时不干扰闭合判定", () => {
    const scanner = new JsonObjectStreamScanner();
    const found = scanner.push(`{"analyses":[{"a":null,"b":1,"c":true,"d":[],"e":{}}]}`);
    expect(found).toEqual(['{"a":null,"b":1,"c":true,"d":[],"e":{}}']);
  });

  it("reset 后可复用，不残留上一次的状态", () => {
    const scanner = new JsonObjectStreamScanner();
    scanner.push(`{"analyses":[{"half":`);
    expect(scanner.hasPendingObject()).toBe(true);

    scanner.reset();
    expect(scanner.hasPendingObject()).toBe(false);
    expect(scanner.pendingText()).toBe("");
    expect(scanner.rawText()).toBe("");

    const found = scanner.push(envelope([analysis("doc:segment:0", "甲")]));
    expect(found).toHaveLength(1);
  });

  it("rawText 保留完整流式原文（供调试日志原样记录）", () => {
    const payload = envelope([analysis("doc:segment:0", "甲")]);
    const scanner = new JsonObjectStreamScanner();
    scanner.push(payload.slice(0, 10));
    scanner.push(payload.slice(10));
    expect(scanner.rawText()).toBe(payload);
  });
});
