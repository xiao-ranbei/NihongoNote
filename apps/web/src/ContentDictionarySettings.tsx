import { useEffect, useState, type ReactElement } from "react";

import {
  getContentDictionarySettings,
  getGlossTranslationSettings,
  saveContentDictionarySettings,
  saveGlossTranslationSettings,
  type ContentDictionarySettingsState,
  type GlossTranslationState
} from "./api/client";

/**
 * 内容词数据源设置（设计文档 jmdict-integration-design.md §6.5 阶段 A）。
 *
 * - 下拉选择数据源（none / jmdict-common 等真实源），保存即热切换、无需重启；
 * - 展示当前源索引版本 / 表面键数等统计（jmdict-common 启用后可见）；
 * - 数据源释义语言取决于具体源（JMdict 常用词为英文），中文译中见 §6.5 阶段 B。
 */
export function ContentDictionarySettings(): ReactElement {
  const [state, setState] = useState<ContentDictionarySettingsState | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 译中（阶段 B）：内容词英文释义 → 中文，本地 Ollama 推理、零云端费用。
  const [gloss, setGloss] = useState<GlossTranslationState | null>(null);
  const [glossSaving, setGlossSaving] = useState(false);
  const [glossError, setGlossError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getContentDictionarySettings()
      .then((next) => {
        if (cancelled) {
          return;
        }
        setState(next);
        setSelectedId(next.current.id);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "读取内容词典设置失败");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    void getGlossTranslationSettings()
      .then((next) => {
        if (!cancelled) {
          setGloss(next);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setGlossError(reason instanceof Error ? reason.message : "读取译中设置失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(): Promise<void> {
    if (!state || !selectedId) {
      return;
    }
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveContentDictionarySettings({ id: selectedId });
      setState(next);
      setNotice("内容词典数据源已切换并立即生效，无需重启服务。");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleGlossToggle(nextEnabled: boolean): Promise<void> {
    setGlossSaving(true);
    setGlossError(null);
    try {
      const next = await saveGlossTranslationSettings({ enabled: nextEnabled });
      setGloss(next);
    } catch (reason: unknown) {
      setGlossError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setGlossSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="settings-section">
        <h3>内容词数据源</h3>
        <p className="empty-copy">正在读取…</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="settings-section">
        <h3>内容词数据源</h3>
        {error ? <div className="error-banner">{error}</div> : null}
        <p className="empty-copy">无法读取设置，请确认本机服务已启动。</p>
      </div>
    );
  }

  const stats = state.current.stats;
  return (
    <div className="settings-section">
      <h3>内容词数据源</h3>
      <p className="reader-note tools-subheading">
        内容词（名词/动词等开放类）走可插拔词典层：默认「不启用」只用固定用法库；
        启用 JMdict 常用词可把离线覆盖率从 ~48% 提到 ~93%（释义为英文）。
      </p>

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="settings-notice">{notice}</div> : null}

      <label className="settings-field">
        <span>当前数据源</span>
        <select
          onChange={(event) => setSelectedId(event.target.value)}
          value={selectedId}
        >
          {state.available.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}
            </option>
          ))}
        </select>
        <small className="field-note">
          切换即热生效（无需重启）；进行中的分析继续用旧源，下一批自动用新源。
        </small>
      </label>

      <div className="content-dict-status">
        <div>
          <span>生效中</span>
          <strong>
            {state.current.label}
            {state.current.ready ? "（已加载）" : "（未加载）"}
          </strong>
        </div>
        {stats ? (
          <span className="settings-provider-state is-ready">
            {stats.version ? `索引 ${stats.version} · ` : ""}
            {stats.entries.toLocaleString()} 表面键
          </span>
        ) : (
          <span className="settings-provider-state is-missing">无索引</span>
        )}
      </div>

      <div className="settings-save-row">
        <button
          className="primary-button"
          disabled={isSaving || selectedId === state.current.id}
          onClick={() => void handleSave()}
          type="button"
        >
          {isSaving ? "切换中…" : "保存并立即生效"}
        </button>
        <span className="field-note">
          {selectedId === state.current.id ? "已是当前数据源" : "保存即热切换至所选数据源"}
        </span>
      </div>

      <hr className="settings-divider" />

      <div className="settings-field gloss-translate-row">
        <div className="gloss-translate-head">
          <span className="gloss-translate-title">内容词译中（Ollama）</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={gloss?.enabled ?? false}
              disabled={glossSaving || gloss === null}
              onChange={(event) => void handleGlossToggle(event.target.checked)}
            />
            <span className="switch-slider" />
          </label>
        </div>
        <small className="field-note">
          内容词（如启用 JMdict）默认显示英文释义；开启后用本机 Ollama 把英文译为中文并缓存，
          后续零推理。仅本地推理、不触发云端、零费用。Ollama 未启动或翻译失败会自动回退英文，
          不阻断分析。
          {gloss ? (
            gloss.available ? "（本机 Ollama 已就绪）" : "（本机 Ollama 未连接：开启后将回退英文，启动 Ollama 后自动生效）"
          ) : null}
        </small>
        {glossError ? <div className="error-banner">{glossError}</div> : null}
      </div>
    </div>
  );
}
