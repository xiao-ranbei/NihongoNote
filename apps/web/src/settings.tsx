import { useEffect, useState, type ReactElement } from "react";

import type { SegmentFieldProfile } from "@nihongonote/core";

import {
  getLlmSettings,
  saveLlmSettings,
  type LlmProviderName,
  type LlmReasoningEffort,
  type LlmSettings,
  type LlmSettingsState,
  type LlmThinkingType
} from "./api/client";

/**
 * LLM 设置页（设计文档 llm-settings-design.md，落实 LLM-011 成本显性）。
 *
 * 职责：本地 Ollama / 云端 API（DeepSeek 等）/ 禁用 三选一，保存即热切换、无需重启。
 * - apiKey 明文存本机库；输入框不回填真实 key，placeholder 显示 masked，留空 = 不修改；
 * - 保存成功后回调 App 刷新顶栏余额 pill（provider 信息可能已变化）。
 */

/** 各 provider 的端点/模型预设（仅当 baseUrl/model 仍是旧 provider 预设值时自动替换）。 */
const providerPresets: Partial<Record<LlmProviderName, { baseUrl: string; model: string }>> = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" },
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  "openai-compatible": { baseUrl: "https://api.example.com/v1", model: "your-model-name" }
};

type CloudProvider = Extract<LlmProviderName, "deepseek" | "openai" | "openai-compatible">;

function isCloudProvider(provider: LlmProviderName): provider is CloudProvider {
  return provider === "deepseek" || provider === "openai" || provider === "openai-compatible";
}

type ProviderGroup = "local" | "cloud" | "disabled";

const providerGroupOptions: Array<{ value: ProviderGroup; label: string; description: string }> = [
  { value: "local", label: "本地模型（Ollama）", description: "免费、离线，用自己的机器跑" },
  { value: "cloud", label: "云端 API", description: "DeepSeek / OpenAI 或兼容端点，按量计费" },
  { value: "disabled", label: "禁用 LLM", description: "只用词典分析，零 AI 调用" }
];

const cloudProviderOptions: Array<{ value: CloudProvider; label: string; description: string }> = [
  { value: "deepseek", label: "DeepSeek", description: "国内直连、便宜，默认 api.deepseek.com" },
  { value: "openai", label: "OpenAI", description: "官方端点 api.openai.com/v1（需可访问外网）" },
  { value: "openai-compatible", label: "其他兼容端点", description: "任何 OpenAI 兼容的 API 服务" }
];

const segmentFieldOptions: Array<{ value: SegmentFieldProfile; label: string; description: string }> = [
  { value: "minimal", label: "精简", description: "翻译 + 语法要点，最省 token" },
  { value: "standard", label: "标准", description: "翻译 + 语法 + 语气/礼貌 + 不确定性，默认档" },
  { value: "full", label: "完整", description: "7 字段独立输出，最全但最贵" }
];

const thinkingTypeOptions: Array<{ value: LlmThinkingType; label: string }> = [
  { value: "enabled", label: "启用思考" },
  { value: "disabled", label: "关闭思考" }
];

const reasoningEffortOptions: Array<{ value: LlmReasoningEffort; label: string; description: string }> = [
  { value: "minimal", label: "minimal", description: "默认，思考最少、最快" },
  { value: "low", label: "low", description: "轻量思考" },
  { value: "medium", label: "medium", description: "30 句段实测 10–20 分钟" },
  { value: "high", label: "high", description: "深度思考，慢且贵" },
  { value: "xhigh", label: "xhigh", description: "最强思考，最贵" }
];

const providerLabels: Record<string, string> = {
  disabled: "禁用",
  ollama: "本地 Ollama",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  "openai-compatible": "OpenAI 兼容端点"
};

export function SettingsPanel(props: { onSettingsSaved: () => void }): ReactElement {
  const [state, setState] = useState<LlmSettingsState | null>(null);
  const [form, setForm] = useState<LlmSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getLlmSettings()
      .then((next) => {
        if (cancelled) {
          return;
        }
        setState(next);
        // apiKey 不回填输入框（留空 = 不修改），placeholder 显示 masked 值
        setForm({ ...next.settings, apiKey: "" });
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "读取设置失败");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function updateField<K extends keyof LlmSettings>(key: K, value: LlmSettings[K]): void {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function groupOf(provider: LlmProviderName): ProviderGroup {
    if (provider === "ollama") {
      return "local";
    }
    if (isCloudProvider(provider)) {
      return "cloud";
    }
    return "disabled";
  }

  function presetOf(provider: LlmProviderName): { baseUrl: string; model: string } | null {
    return providerPresets[provider] ?? null;
  }

  /** 切换提供方：若 baseUrl/model 还是旧 provider 的预设值（用户没改过），则换成新预设。 */
  function handleGroupChange(nextGroup: ProviderGroup): void {
    setForm((current) => {
      if (!current) {
        return current;
      }
      const previous = current.provider;
      const nextProvider: LlmProviderName = nextGroup === "local"
        ? "ollama"
        : nextGroup === "cloud"
          ? (isCloudProvider(previous) ? previous : "deepseek")
          : "disabled";
      const oldPreset = presetOf(previous);
      const nextPreset = presetOf(nextProvider);
      return {
        ...current,
        provider: nextProvider,
        baseUrl: oldPreset && nextPreset && current.baseUrl === oldPreset.baseUrl
          ? nextPreset.baseUrl
          : current.baseUrl,
        model: oldPreset && nextPreset && current.model === oldPreset.model
          ? nextPreset.model
          : current.model
      };
    });
  }

  function handleCloudProviderChange(nextProvider: CloudProvider): void {
    setForm((current) => {
      if (!current || !isCloudProvider(current.provider)) {
        return current;
      }
      const oldPreset = presetOf(current.provider);
      const nextPreset = presetOf(nextProvider);
      return {
        ...current,
        provider: nextProvider,
        baseUrl: oldPreset && nextPreset && current.baseUrl === oldPreset.baseUrl
          ? nextPreset.baseUrl
          : current.baseUrl,
        model: oldPreset && nextPreset && current.model === oldPreset.model
          ? nextPreset.model
          : current.model
      };
    });
  }

  async function handleSave(): Promise<void> {
    if (!form) {
      return;
    }
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveLlmSettings(form);
      setState(next);
      // 保存成功后清空 key 输入（placeholder 自动显示最新 masked 值）
      setForm({ ...next.settings, apiKey: "" });
      setNotice("设置已保存并立即生效，无需重启服务。");
      props.onSettingsSaved();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <section className="tools-page">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">SETTINGS</p>
            <h2>设置</h2>
          </div>
          <span className="foundation-badge">LLM 配置</span>
        </div>
        <p className="empty-copy">正在读取设置…</p>
      </section>
    );
  }

  if (!form || !state) {
    return (
      <section className="tools-page">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">SETTINGS</p>
            <h2>设置</h2>
          </div>
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        <p className="empty-copy">无法读取设置，请确认本机服务已启动。</p>
      </section>
    );
  }

  const group = groupOf(form.provider);
  const isCloud = group === "cloud";
  const maskedKey = state.settings.apiKey;
  const dbFields = (Object.keys(state.source) as Array<keyof LlmSettings>)
    .filter((key) => state.source[key] === "db");

  return (
    <section className="tools-page">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">SETTINGS</p>
          <h2>设置</h2>
        </div>
        <span className="foundation-badge">本地 / 云端切换</span>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="settings-notice">{notice}</div> : null}

      <div className="settings-provider-status">
        <div>
          <span>当前生效</span>
          <strong>
            {providerLabels[state.provider.name] ?? state.provider.name} · {state.provider.model}
          </strong>
        </div>
        <span className={`settings-provider-state ${state.provider.configured ? "is-ready" : "is-missing"}`}>
          {state.provider.configured ? "已就绪" : "未配置"}
        </span>
      </div>
      <p className="reader-note">
        {state.provider.isLocal
          ? "本地模型：免费、离线运行，不产生任何 API 费用。"
          : "云端 API：按 token 用量计费（闲时/高峰单价不同）。保存即热切换，无需重启服务。"}
      </p>

      <div className="settings-section">
        <h3>1. 模型提供方</h3>
        <div className="tools-mode-options">
          {providerGroupOptions.map((option) => (
            <label
              className={`tools-mode-option ${group === option.value ? "is-selected" : ""}`}
              key={option.value}
            >
              <input
                checked={group === option.value}
                name="provider-group"
                onChange={() => handleGroupChange(option.value)}
                type="radio"
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>
        {isCloud ? (
          <div className="settings-field">
            <span>云端服务商</span>
            <select
              onChange={(event) => handleCloudProviderChange(event.target.value as CloudProvider)}
              value={form.provider}
            >
              {cloudProviderOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — {option.description}
                </option>
              ))}
            </select>
            <small className="field-note">
              切换服务商会同步替换对应的默认端点与模型（仅当 baseUrl/model 未手动修改过时）。
            </small>
          </div>
        ) : null}
      </div>

      <div className="settings-section">
        <h3>2. 连接参数</h3>
        <div className="settings-grid">
          <label className="settings-field">
            <span>API 地址（baseUrl）</span>
            <input
              onChange={(event) => updateField("baseUrl", event.target.value)}
              placeholder={group === "local" ? "http://127.0.0.1:11434" : "https://api.deepseek.com"}
              type="url"
              value={form.baseUrl}
            />
            <small className="field-note">
              {group === "local"
                ? "本地 Ollama 服务地址，通常无需修改"
                : "OpenAI 兼容端点；DeepSeek 用 api.deepseek.com"}
            </small>
          </label>

          {group !== "local" ? (
            <label className="settings-field">
              <span>API Key</span>
              <input
                autoComplete="off"
                onChange={(event) => updateField("apiKey", event.target.value)}
                placeholder={maskedKey ? `${maskedKey}（留空不修改）` : "sk-…（云端必填）"}
                type="password"
                value={form.apiKey ?? ""}
              />
              <small className="field-note">
                {maskedKey
                  ? "当前已配置；留空则保持原 key 不变"
                  : "云端服务需要 API key，明文保存在本机数据库"}
              </small>
            </label>
          ) : (
            <div className="settings-field">
              <span>API Key</span>
              <p className="settings-skip-note">本地 Ollama 无需 API key。</p>
            </div>
          )}

          <label className="settings-field">
            <span>模型（model）</span>
            <input
              onChange={(event) => updateField("model", event.target.value)}
              placeholder={group === "local" ? "qwen2.5:7b" : "deepseek-chat"}
              type="text"
              value={form.model}
            />
            <small className="field-note">
              {group === "local"
                ? "Ollama 用 `ollama list` 里的名称"
                : "云端用服务商的模型名（如 deepseek-chat）"}
            </small>
          </label>

          <label className="settings-field">
            <span>温度（temperature）</span>
            <input
              max={2}
              min={0}
              onChange={(event) => updateField("temperature", Number(event.target.value))}
              step={0.1}
              type="number"
              value={form.temperature}
            />
            <small className="field-note">0–2，越低越稳定；默认 0.2</small>
          </label>

          <label className="settings-field">
            <span>最大输出 tokens（maxTokens）</span>
            <input
              max={32_000}
              min={1}
              onChange={(event) => updateField("maxTokens", Number(event.target.value))}
              step={1}
              type="number"
              value={form.maxTokens}
            />
            <small className="field-note">
              1–32000；输出同时受服务端预算（min 8192）约束
            </small>
          </label>
        </div>
      </div>

      <div className="settings-section">
        <h3>3. 输出档位与思考成本</h3>
        <p className="reader-note tools-subheading">
          档位越低，每段要输出与思考的内容越少、费用越低（LLM-011 成本显性）。
        </p>
        <div className="settings-subheading">段级语义字段档位（完整分析生效）</div>
        <div className="tools-mode-options">
          {segmentFieldOptions.map((option) => (
            <label
              className={`tools-mode-option ${form.segmentFields === option.value ? "is-selected" : ""}`}
              key={option.value}
            >
              <input
                checked={form.segmentFields === option.value}
                name="segment-fields"
                onChange={() => updateField("segmentFields", option.value)}
                type="radio"
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>

        {isCloud ? (
          <>
            <div className="settings-subheading">思考模式（thinking）</div>
            <div className="settings-field">
              <select
                onChange={(event) => updateField(
                  "thinkingType",
                  event.target.value === "" ? null : event.target.value as LlmThinkingType
                )}
                value={form.thinkingType ?? ""}
              >
                <option value="">不指定（跟随服务端默认）</option>
                {thinkingTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <small className="field-note">
                DeepSeek 默认开启思考；关闭可大幅降低 token 消耗（推理 token 同样按量计费）。
              </small>
            </div>

            <div className="settings-subheading">推理强度（reasoning effort）</div>
            <div className="settings-field">
              <select
                onChange={(event) => updateField(
                  "reasoningEffort",
                  event.target.value === "" ? null : event.target.value as LlmReasoningEffort
                )}
                value={form.reasoningEffort ?? ""}
              >
                <option value="">不指定（默认 minimal）</option>
                {reasoningEffortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} — {option.description}
                  </option>
                ))}
              </select>
              <small className="field-note">
                强度越高思考 token 越多、费用越高、耗时越长；medium 实测 30 句段需 10–20 分钟。
              </small>
            </div>
          </>
        ) : null}
      </div>

      <div className="settings-section">
        <h3>4. 保存与生效</h3>
        <div className="settings-save-row">
          <button
            className="primary-button"
            disabled={isSaving}
            onClick={() => void handleSave()}
            type="button"
          >
            {isSaving ? "保存中…" : "保存并立即生效"}
          </button>
          <span className="field-note">
            保存即热切换，无需重启服务；进行中的分析继续用旧配置，下一批自动用新配置。
          </span>
        </div>
        <p className="field-note">
          字段来源：{dbFields.length > 0
            ? `数据库覆盖了「${dbFields.join("、")}」，其余来自 .env`
            : "全部来自 .env（初始默认）"}。
          {" "}清空数据库设置（app_settings 表的 llm 键）即可回到 .env 行为。
        </p>
      </div>
    </section>
  );
}
