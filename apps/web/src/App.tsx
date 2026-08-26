import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import type {
  DocumentDetail,
  DocumentSummary,
  HealthResponse,
  TargetLevel
} from "@nihongonote/core";

import {
  createDocument,
  getDocument,
  getHealth,
  listDocuments
} from "./api/client";
import "./styles.css";

const levelOptions: Array<{ value: TargetLevel; label: string }> = [
  { value: "auto", label: "自动判断" },
  { value: "n5", label: "N5" },
  { value: "n4", label: "N4" },
  { value: "n3", label: "N3" },
  { value: "n2", label: "N2" },
  { value: "n1", label: "N1" }
];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export default function App(): ReactElement {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetail | null>(null);
  const [title, setTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [targetLevel, setTargetLevel] = useState<TargetLevel>("auto");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([getHealth(), listDocuments()])
      .then(([healthResponse, documentList]) => {
        setHealth(healthResponse);
        setDocuments(documentList);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "无法连接到本机 API");
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  async function handleCreateDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!sourceText.trim()) {
      setError("请先粘贴一段日语文章或对话");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const document = await createDocument({
        title: title.trim() || undefined,
        sourceText,
        targetLevel
      });
      setSelectedDocument(document);
      setDocuments((current) => [
        {
          id: document.id,
          title: document.title,
          targetLevel: document.targetLevel,
          status: document.status,
          segmentCount: document.segmentCount,
          completedSegmentCount: document.completedSegmentCount,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt
        },
        ...current
      ]);
      setTitle("");
      setSourceText("");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "保存文章失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSelectDocument(documentId: string): Promise<void> {
    setError(null);
    try {
      setSelectedDocument(await getDocument(documentId));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "读取文章失败");
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PERSONAL JAPANESE READER</p>
          <h1>NihongoNote</h1>
        </div>
        <div className={`status-pill ${health ? "status-ready" : "status-muted"}`}>
          <span className="status-dot" />
          {health ? "本机服务已连接" : isLoading ? "正在连接…" : "服务未连接"}
        </div>
      </header>

      <main className="workspace">
        <aside className="library-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">LIBRARY</p>
              <h2>学习库</h2>
            </div>
            <span className="count-badge">{documents.length}</span>
          </div>
          {documents.length === 0 ? (
            <p className="empty-copy">还没有文章。先粘贴一段日语，建立第一个学习条目。</p>
          ) : (
            <div className="document-list">
              {documents.map((document) => (
                <button
                  className={`document-item ${selectedDocument?.id === document.id ? "is-selected" : ""}`}
                  key={document.id}
                  onClick={() => void handleSelectDocument(document.id)}
                  type="button"
                >
                  <strong>{document.title}</strong>
                  <span>
                    {document.segmentCount} 个句段 · {formatDate(document.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="content-panel">
          {error ? <div className="error-banner">{error}</div> : null}

          <form className="composer-card" onSubmit={(event) => void handleCreateDocument(event)}>
            <div className="panel-heading">
              <div>
                <p className="section-kicker">NEW MATERIAL</p>
                <h2>添加学习材料</h2>
              </div>
              <span className="foundation-badge">P0 FOUNDATION</span>
            </div>
            <label>
              标题
              <input
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：商务需求访谈・场景 1"
                value={title}
              />
            </label>
            <label>
              学习难度
              <select
                onChange={(event) => setTargetLevel(event.target.value as TargetLevel)}
                value={targetLevel}
              >
                {levelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              日语原文
              <textarea
                onChange={(event) => setSourceText(event.target.value)}
                placeholder={"粘贴文章或对话，例如：\n李：初めまして…"}
                rows={11}
                value={sourceText}
              />
            </label>
            <div className="form-footer">
              <span>当前会保存原文并按句子生成基础 segment。</span>
              <button className="primary-button" disabled={isSaving} type="submit">
                {isSaving ? "保存中…" : "保存文章"}
              </button>
            </div>
          </form>

          {selectedDocument ? (
            <article className="reader-card">
              <div className="reader-heading">
                <div>
                  <p className="section-kicker">READER PREVIEW</p>
                  <h2>{selectedDocument.title}</h2>
                </div>
                <span className="status-label">{selectedDocument.status}</span>
              </div>
              <p className="reader-note">
                这是基础阅读器预览。下一步会在句段上接入词语定位、AI 解析卡片和朗读控制。
              </p>
              <div className="segment-list">
                {selectedDocument.segments.map((segment) => (
                  <div className="segment-row" key={segment.id}>
                    <span className="segment-index">{String(segment.index + 1).padStart(2, "0")}</span>
                    <div>
                      {segment.speaker ? <span className="speaker-label">{segment.speaker}</span> : null}
                      <p>{segment.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          ) : (
            <div className="welcome-card">
              <span className="welcome-mark">日</span>
              <h2>把难句留在原文里理解</h2>
              <p>
                现在先完成文章保存和句段定位。后续会在这层基础上加入助词、语法、语气、朗读和跟读。
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
