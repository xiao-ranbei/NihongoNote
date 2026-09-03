export const databaseSchema = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    source_text TEXT NOT NULL,
    target_level TEXT NOT NULL CHECK (target_level IN ('auto', 'n5', 'n4', 'n3', 'n2', 'n1')),
    content_type TEXT NOT NULL DEFAULT 'article'
      CHECK (content_type IN ('lesson', 'article', 'dialogue', 'news_expository', 'note', 'other')),
    content_type_source TEXT NOT NULL DEFAULT 'default'
      CHECK (content_type_source IN ('default', 'user')),
    content_type_suggestion_json TEXT NOT NULL DEFAULT 'null',
    content_blocks_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('draft', 'analyzing', 'ready', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    speaker TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (document_id, segment_index)
  );

  CREATE TABLE IF NOT EXISTS segment_analyses (
    segment_id TEXT PRIMARY KEY NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    result_json TEXT NOT NULL,
    usage_json TEXT NOT NULL DEFAULT 'null',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audio_assets (
    id TEXT PRIMARY KEY NOT NULL,
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    voice TEXT NOT NULL,
    format TEXT NOT NULL,
    path TEXT NOT NULL,
    speed REAL NOT NULL,
    prosody_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_revisions (
    segment_id TEXT PRIMARY KEY NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    override_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY NOT NULL,
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    path TEXT NOT NULL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );

  -- 应用设置（key-value，JSON 存 value）：当前存 llm / contentDictionary 键
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );

  -- 内容词译中缓存（设计文档 jmdict-integration-design.md §6.5 阶段 B）：
  -- 英文释义 → 中文译文，首次译中后落库，避免重复本地推理。term 为归一化英文串（小写去空格）。
  CREATE TABLE IF NOT EXISTS vocabulary_cache (
    term TEXT PRIMARY KEY NOT NULL,
    translation TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'zh',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_updated_at
    ON documents (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_segments_document_index
    ON segments (document_id, segment_index);
  CREATE INDEX IF NOT EXISTS idx_documents_status_updated_at
    ON documents (status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_recordings_segment_id
    ON recordings (segment_id);
`;
