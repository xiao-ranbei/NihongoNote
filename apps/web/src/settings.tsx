import { useEffect, useState, type ReactElement } from "react";

import type { SegmentFieldProfile } from "@nihongonote/core";

import {
  getLlmSettings,
  saveLlmSettings,
  type LlmProfile,
  type LlmProviderName,
  type LlmReasoningEffort,
  type LlmSettingsInput,
  type LlmSettingsState,
  type LlmThinkingType
} from "./api/client";

/**
 * LLM 设置页（设计文档 llm-settings-design.md，落实 LLM-011 成本显性 + 多配置管理）。
 *
 * 职责：
 * - 多配置管理（2026-08-30）：预先保存多组模型配置（默认预置 DeepSeek 云端 + 本地
 *   Ollama qwen3.5:9b），可随时在已保存配置之间快速切换，保存即热切换、无需重启；
 * - apiKey 明文存本机库；输入框不回填真实 key，placeholder 显示 masked，留空 = 不修改；
 * - 保存成功后回调 App 刷新顶栏余额 pill（provider 信息可能已变化）。
 */

/** 各 provider 的端点/模型预设（仅当 baseUrl/model 仍是旧 provider 预设值时自动替换）。 */
const providerPresets: Partial<Record<LlmProviderName, { baseUrl: string; model: string }>> = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b" },
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
  /** 全部已保存配置（apiKey 为 masked，来自 GET 响应）。 */
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  /** 当前激活（生效）的配置 id。 */
  const [activeProfileId, setActiveProfileId] = useState("");
  /** 正在编辑的配置 id。 */
  const [editingProfileId, setEditingProfileId] = useState("");
  /** 编辑中的配置表单；apiKey 不回填真实 key（留空 = 不修改）。 */
  const [form, setForm] = useState<LlmProfile | null>(null);
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
        setProfiles(next.profiles ?? []);
        const initialId = next.activeProfileId || next.profiles?.[0]?.id || "";
        setActiveProfileId(initialId);
        setEditingProfileId(initialId);
        const target = next.profiles?.find((p) => p.id === initialId)
          ?? next.profiles?.[0]
          ?? { id: "profile-current", name: "自定义配置", ...next.settings, apiKey: "" };
        // apiKey 不回填输入框（留空 = 不修改），placeholder 显示 masked 值
        setForm({ ...target, apiKey: "" });
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

  function updateField<K extends keyof LlmProfile>(key: K, value: LlmProfile[K]): void {
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

  /** 把 form 的编辑内容落回 profiles（apiKey 为空 = 不修改，保留库中值）。 */
  function applyEditToProfiles(current: LlmProfile[], editingId: string, draft: LlmProfile | null): LlmProfile[] {
    if (!draft) {
      return current;
    }
    return current.map((p) => (
      p.id === editingId
        ? { ...draft, apiKey: draft.apiKey?.trim() ? draft.apiKey : p.apiKey }
        : p
    ));
  }

  /** 组装 PUT body：激活配置展开为顶层字段 + 全部 profiles + activeProfileId。 */
  function buildBody(current: LlmProfile[], activeId: string): LlmSettingsInput {
    const active = current.find((p) => p.id === activeId) ?? current[0]!;
    return {
      provider: active.provider,
      baseUrl: active.baseUrl,
      apiKey: active.apiKey ?? null,
      model: active.model,
      temperature: active.temperature,
      maxTokens: active.maxTokens,
      segmentFields: active.segmentFields,
      thinkingType: active.thinkingType,
      reasoningEffort: active.reasoningEffort,
      profiles: current,
      activeProfileId: active.id
    };
  }

  /** 保存成功后刷新各状态（保持当前编辑项，重新载入其 masked key）。 */
  function adoptNext(next: LlmSettingsState, keepEditingId: string): void {
    setState(next);
    setProfiles(next.profiles ?? []);
    setActiveProfileId(next.activeProfileId ?? activeProfileId);
    const target = next.profiles?.find((p) => p.id === keepEditingId) ?? next.profiles?.[0];
    if (target) {
      setForm({ ...target, apiKey: "" });
    }
  }

  /** 切换编辑目标：先把当前编辑内容落回 profiles，再载入目标配置。 */
  function selectProfile(profileId: string): void {
    if (profileId === editingProfileId) {
      return;
    }
    setProfiles((current) => applyEditToProfiles(current, editingProfileId, form));
    setEditingProfileId(profileId);
    const target = profiles.find((p) => p.id === profileId) ?? profiles[0]!;
    setForm({ ...target, apiKey: "" });
    setError(null);
  }

  /** 新建配置：复制当前编辑项为新槽位（保留连接参数，apiKey 留空）。 */
  function handleAddProfile(): void {
    const source = form ?? profiles[0];
    if (!source) {
      return;
    }
    const id = `profile-${Date.now()}`;
    const existing = new Set(profiles.map((p) => p.name));
    let name = "新配置";
    let i = 2;
    while (existing.has(name)) {
      name = `新配置 ${i}`;
      i += 1;
    }
    setProfiles([...profiles, { ...source, id, name, apiKey: "" }]);
    setEditingProfileId(id);
    setForm({ ...source, id, name, apiKey: "" });
    setError(null);
  }

  /** 删除当前编辑的配置：至少保留一个；激活中的配置需先切换才能删除。 */
  function handleDeleteProfile(): void {
    if (profiles.length <= 1) {
      setError("至少保留一个配置");
      return;
    }
    if (editingProfileId === activeProfileId) {
      setError("当前激活的配置不能删除，请先切换到其他配置");
      return;
    }
    const next = profiles.filter((p) => p.id !== editingProfileId);
    setProfiles(next);
    setEditingProfileId(activeProfileId);
    const target = next.find((p) => p.id === activeProfileId) ?? next[0]!;
    setForm({ ...target, apiKey: "" });
    setError(null);
  }

  /** 切换 provider 分组：若 baseUrl/model 还是旧 provider 的预设值（用户没改过），则换成新预设。 */
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

  /** 保存当前编辑并整体落库（profiles + 激活项）。 */
  async function handleSave(): Promise<void> {
    if (!form) {
      return;
    }
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = applyEditToProfiles(profiles, editingProfileId, form);
      setProfiles(updated);
      const next = await saveLlmSettings(buildBody(updated, activeProfileId));
      adoptNext(next, editingProfileId);
      setNotice("设置已保存并立即生效，无需重启服务。");
      props.onSettingsSaved();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  }

  /** 快速切换：把指定配置设为当前并立即保存生效（热切换，无需点主保存）。 */
  async function handleActivate(profileId: string): Promise<void> {
    if (!form || profileId === activeProfileId) {
      return;
    }
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = applyEditToProfiles(profiles, editingProfileId, form);
      setProfiles(updated);
      const target = updated.find((p) => p.id === profileId) ?? updated[0]!;
      const next = await saveLlmSettings(buildBody(updated, target.id));
      adoptNext(next, profileId);
      setEditingProfileId(profileId);
      setNotice(`已切换到「${target.name}」并立即生效，无需重启服务。`);
      props.onSettingsSaved();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "切换失败");
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
  const maskedKey = profiles.find((p) => p.id === editingProfileId)?.apiKey ?? "";
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]!;
  const dbFields = (Object.keys(state.source) as Array<keyof LlmSettingsState["settings"]>)
    .filter((key) => state.source[key] === "db");

  return (
    <section className="tools-page">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">SETTINGS</p>
          <h2>设置</h2>
        </div>
        <span className="foundation-badge">多配置 · 本地 / 云端切换</span>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="settings-notice">{notice}</div> : null}

      <div className="settings-provider-status">
        <div>
          <span>当前生效</span>
          <strong>
            {activeProfile.name}（{providerLabels[activeProfile.provider] ?? activeProfile.provider} · {activeProfile.model}）
          </strong>
        </div>
        <span className={`settings-provider-state ${state.provider.configured ? "is-ready" : "is-missing"}`}>
          {state.provider.configured ? "已就绪" : "未配置"}
        </span>
      </div>
      <p className="reader-note">
        {activeProfile.provider === "ollama"
          ? "本地模型：免费、离线运行，不产生任何 API 费用。"
          : "云端 API：按 token 用量计费（闲时/高峰单价不同）。保存即热切换，无需重启服务。"}
      </p>

      <div className="settings-section">
        <h3>0. 已保存配置（多配置切换）</h3>
        <p className="reader-note tools-subheading">
          预先保存多组模型配置，随时一键切换生效；默认预置「DeepSeek 云端」与「本地 Ollama（qwen3.5:9b）」两组。
        </p>
        <div className="profile-tabs">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              className={`profile-tab ${
                editingProfileId === profile.id ? "is-editing" : ""
              } ${profile.id === activeProfileId ? "is-active" : ""}`}
              onClick={() => selectProfile(profile.id)}
              type="button"
            >
              <span className="profile-tab-name">{profile.name}</span>
              <span className="profile-tab-meta">
                {providerLabels[profile.provider] ?? profile.provider} · {profile.model}
              </span>
              {profile.id === activeProfileId ? <span className="profile-tab-badge">当前</span> : null}
            </button>
          ))}
          <button className="profile-tab profile-tab--add" onClick={handleAddProfile} type="button">
            ＋ 新建配置
          </button>
        </div>
        <div className="profile-actions-row">
          <button
            className="primary-button"
            disabled={isSaving || editingProfileId === activeProfileId}
            onClick={() => void handleActivate(editingProfileId)}
            type="button"
          >
            {editingProfileId === activeProfileId ? "已是当前配置" : isSaving ? "切换中…" : "设为当前并立即生效"}
          </button>
          <button
            className="secondary-button"
            disabled={profiles.length <= 1 || editingProfileId === activeProfileId}
            onClick={handleDeleteProfile}
            type="button"
          >
            删除该配置
          </button>
          <span className="field-note">
            「设为当前」立即保存并热切换（无需重启）；删除前请先切换到其他配置。
          </span>
        </div>
      </div>

      <div className="settings-section">
        <h3>1. 模型提供方</h3>
        <label className="settings-field">
          <span>正在编辑的配置</span>
          <input
            onChange={(event) => updateField("name", event.target.value)}
            type="text"
            value={form.name}
          />
        </label>
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
              placeholder={group === "local" ? "qwen3.5:9b" : "deepseek-chat"}
              type="text"
              value={form.model}
            />
            <small className="field-note">
              {group === "local"
                ? "Ollama 用 `ollama list` 里的名称（默认 qwen3.5:9b）"
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
            {isSaving ? "保存中…" : "保存全部配置并立即生效"}
          </button>
          <span className="field-note">
            保存全部配置并热切换至当前激活项，无需重启服务；进行中的分析继续用旧配置，下一批自动用新配置。
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
