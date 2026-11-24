import postgres, { type Sql } from "postgres";
import { UserPrefs, type AiOutput, type Topic } from "../domain.js";
import type { ShareLink, ActionDraft, Automation, AudioChunk, ChunkStage, Reminder, Suggestion, ChunkState, Execution, QualityTier, Session, SessionStatus, Timeline, ToolPolicy, TranscriptSegment, UsageEntry, UserSettings } from "../domain.js";
import type { FirmwareRelease } from "../ota/types.js";
import type { AuditEntry, AuthSession, Device, User, UserRecord } from "../identity/types.js";
import type { ChunkEnvelope, FavoriteFolder, PutChunkResult, Repository, UsageRollupRow } from "./repository.js";

type Row = Record<string, unknown>;

export class PostgresRepository implements Repository {
  private readonly sql: Sql;

  constructor(url: string) {
    this.sql = postgres(url, { max: 8, idle_timeout: 20, connect_timeout: 10 });
  }

  async migrate() {
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS vm_sessions (
        id uuid PRIMARY KEY,
        device_id text NOT NULL,
        user_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('recording','ended','interrupted')),
        started_at timestamptz NOT NULL,
        ended_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vm_sessions_user_started_idx ON vm_sessions(user_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS vm_audio_chunks (
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        sequence integer NOT NULL CHECK (sequence >= 0),
        sha256 char(64) NOT NULL,
        object_key text NOT NULL,
        content_type text NOT NULL,
        byte_length integer NOT NULL CHECK (byte_length > 0),
        start_ms bigint NOT NULL CHECK (start_ms >= 0),
        duration_ms integer NOT NULL CHECK (duration_ms > 0),
        uploaded_at timestamptz NOT NULL,
        PRIMARY KEY(session_id, sequence)
      );
      ALTER TABLE vm_audio_chunks ADD COLUMN IF NOT EXISTS transcript_status text NOT NULL DEFAULT 'pending';
      ALTER TABLE vm_audio_chunks ADD COLUMN IF NOT EXISTS transcript_attempts integer NOT NULL DEFAULT 0;
      ALTER TABLE vm_audio_chunks ADD COLUMN IF NOT EXISTS transcript_updated_at timestamptz NOT NULL DEFAULT now();
      CREATE INDEX IF NOT EXISTS vm_audio_transcript_queue_idx
        ON vm_audio_chunks(transcript_status, transcript_updated_at);

      CREATE TABLE IF NOT EXISTS vm_transcript_segments (
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        sequence integer NOT NULL,
        text text NOT NULL DEFAULT '',
        start_ms bigint NOT NULL CHECK (start_ms >= 0),
        end_ms bigint NOT NULL CHECK (end_ms >= 0),
        provider text NOT NULL,
        status text NOT NULL CHECK (status IN ('succeeded','failed')),
        error text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY(session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS vm_action_drafts (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        tool text NOT NULL,
        title text NOT NULL,
        detail text NOT NULL DEFAULT '',
        args jsonb NOT NULL DEFAULT '{}',
        evidence text NOT NULL DEFAULT '',
        evidence_start_ms bigint,
        evidence_end_ms bigint,
        confidence double precision NOT NULL,
        mode text NOT NULL CHECK (mode IN ('suggested','explicit','deferred')),
        risk text NOT NULL CHECK (risk IN ('record','personal_write','external_write','physical_control','destructive')),
        status text NOT NULL CHECK (status IN ('pending','confirmed','cancelled','executing','executed','failed','expired')),
        revision integer NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vm_drafts_user_status_idx ON vm_action_drafts(user_id, status, created_at);

      CREATE TABLE IF NOT EXISTS vm_tool_policies (
        user_id text NOT NULL,
        tool text NOT NULL,
        confirmation text NOT NULL CHECK (confirmation IN ('always','explicit_only','never')),
        allow_voice_confirm boolean NOT NULL DEFAULT false,
        max_draft_age_sec integer NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY(user_id, tool)
      );

      CREATE TABLE IF NOT EXISTS vm_executions (
        id uuid PRIMARY KEY,
        draft_id uuid NOT NULL REFERENCES vm_action_drafts(id) ON DELETE CASCADE,
        idempotency_key text NOT NULL UNIQUE,
        status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','unknown')),
        provider text NOT NULL,
        external_id text,
        result jsonb NOT NULL DEFAULT '{}',
        error text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vm_executions_draft_idx ON vm_executions(draft_id);

      /* ── 转写流水线（2026-09-19）──
       * transcript_status 现在是流水线阶段：pending → vad → silent | speech → asr → succeeded | merged | failed。
       * 旧数据已经是 succeeded，不受影响。*/
      ALTER TABLE vm_audio_chunks ADD COLUMN IF NOT EXISTS vad_speech_ms integer;
      -- 音量包络：每 200ms 一个字节，画波形用（5 秒块＝25 字节）
      ALTER TABLE vm_audio_chunks ADD COLUMN IF NOT EXISTS envelope bytea;
      ALTER TABLE vm_audio_chunks ADD COLUMN IF NOT EXISTS vad_first_ms integer;
      ALTER TABLE vm_audio_chunks ADD COLUMN IF NOT EXISTS vad_last_ms integer;
      ALTER TABLE vm_transcript_segments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'speech';
      -- 语义检索向量（已归一化，检索时点积即余弦相似度）
      ALTER TABLE vm_transcript_segments ADD COLUMN IF NOT EXISTS embedding real[];
      ALTER TABLE vm_transcript_segments ADD COLUMN IF NOT EXISTS embedding_tries smallint NOT NULL DEFAULT 0;
      ALTER TABLE vm_transcript_segments ADD COLUMN IF NOT EXISTS end_sequence integer;
      -- 旧段落一律 done：不能让新流水线对几千段历史转写重新调一遍大模型
      ALTER TABLE vm_transcript_segments ADD COLUMN IF NOT EXISTS intent_status text NOT NULL DEFAULT 'done';
      CREATE INDEX IF NOT EXISTS vm_transcript_intent_idx ON vm_transcript_segments(intent_status) WHERE intent_status IN ('pending','running');
      CREATE INDEX IF NOT EXISTS vm_audio_stage_idx ON vm_audio_chunks(transcript_status, session_id, sequence)
        WHERE transcript_status IN ('pending','vad','speech','asr');
      -- 历史上被识别成「嗯。」之类的段落标成语气词，界面不再显示
      UPDATE vm_transcript_segments SET kind='filler'
        WHERE kind='speech' AND status='succeeded' AND char_length(text) <= 6
          AND text ~ '^[嗯啊哦噢呃额唔哈嘿诶欸哎呀对是好的吧嘛呢。，、！？,.!?~ ]*$';
      -- 服务重启时正在处理的块：检测中的退回 pending，识别中的退回 speech
      UPDATE vm_audio_chunks SET transcript_status='pending' WHERE transcript_status='vad';
      UPDATE vm_audio_chunks SET transcript_status='speech' WHERE transcript_status='asr';
      UPDATE vm_transcript_segments SET intent_status='pending' WHERE intent_status='running';

      CREATE TABLE IF NOT EXISTS vm_usage (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL,
        user_id text NOT NULL,
        session_id uuid,
        kind text NOT NULL CHECK (kind IN ('asr','llm','embedding')),
        provider text NOT NULL,
        model text NOT NULL,
        tier text NOT NULL,
        audio_ms integer NOT NULL DEFAULT 0,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        cost_yuan numeric(14,6) NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS vm_usage_at_idx ON vm_usage(at);
      ALTER TABLE vm_usage DROP CONSTRAINT IF EXISTS vm_usage_kind_check;
      ALTER TABLE vm_usage ADD CONSTRAINT vm_usage_kind_check CHECK (kind IN ('asr','llm','embedding'));
      ALTER TABLE vm_usage ADD COLUMN IF NOT EXISTS feature text NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS vm_user_settings (
        user_id text PRIMARY KEY,
        tier text NOT NULL,
        wake_word text NOT NULL,
        schedule jsonb NOT NULL,
        updated_at timestamptz NOT NULL
      );
      ALTER TABLE vm_user_settings ADD COLUMN IF NOT EXISTS retention_days integer NOT NULL DEFAULT 0;
      ALTER TABLE vm_user_settings ADD COLUMN IF NOT EXISTS led_mode text NOT NULL DEFAULT 'designed';
      ALTER TABLE vm_user_settings ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}';

      -- 耗电测量：设备按阶段切换状态、每 15 秒记一次电池电压和放电速率，跑完整份上传
      CREATE TABLE IF NOT EXISTS vm_device_power_logs (
        id bigserial PRIMARY KEY,
        device_id text NOT NULL,
        user_id text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS vm_device_commands (
        id bigserial PRIMARY KEY,
        user_id text NOT NULL,
        command text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        delivered_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS vm_device_commands_pending_idx ON vm_device_commands(user_id) WHERE delivered_at IS NULL;

      CREATE TABLE IF NOT EXISTS vm_config (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS vm_users (
        id text PRIMARY KEY,
        email text NOT NULL UNIQUE,
        display_name text NOT NULL,
        password_hash text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin','member')),
        status text NOT NULL CHECK (status IN ('active','disabled')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS vm_auth_sessions (
        id char(64) PRIMARY KEY,
        user_id text NOT NULL REFERENCES vm_users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        user_agent text NOT NULL DEFAULT '',
        ip text NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS vm_auth_sessions_user_idx ON vm_auth_sessions(user_id);

      CREATE TABLE IF NOT EXISTS vm_devices (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES vm_users(id) ON DELETE CASCADE,
        name text NOT NULL,
        key_hash char(64) NOT NULL UNIQUE,
        key_prefix text NOT NULL DEFAULT '',
        status text NOT NULL CHECK (status IN ('active','revoked')),
        firmware text,
        last_seen_at timestamptz,
        last_battery_pct integer,
        last_network text,
        created_at timestamptz NOT NULL,
        revoked_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS vm_devices_user_idx ON vm_devices(user_id);
      -- 语音确认不做了：列留着（删列不可逆），只是不再写
      ALTER TABLE vm_tool_policies ALTER COLUMN allow_voice_confirm SET DEFAULT false;
      -- 办完之后推不推回执到设备屏：按动作类型分别设
      ALTER TABLE vm_tool_policies ADD COLUMN IF NOT EXISTS notify_device boolean NOT NULL DEFAULT true;
      -- 这一类动作什么时候从说话里抽：follow=跟随总开关 / push_to_talk=只在按住时 / off=不抽
      ALTER TABLE vm_tool_policies ADD COLUMN IF NOT EXISTS extract text NOT NULL DEFAULT 'follow';
      /* 远程升级进度：设备自己上报。设备戴在用户身上，升级推到哪一步只能靠它说。*/
      ALTER TABLE vm_devices ADD COLUMN IF NOT EXISTS last_charging boolean;
      /* 按住 OK 键说话的时间段：只在"按住说话"模式下，这些区间里的句子才送去抽意图 */
      CREATE TABLE IF NOT EXISTS vm_speech_marks (
        id bigserial PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        start_ms bigint NOT NULL,
        end_ms bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vm_speech_marks_session_idx ON vm_speech_marks(session_id, start_ms);

      /* AI 主题：一次开机录音里按话题切出的段。source=user 的是人改过或人建的，重新拆分不动它 */
      CREATE TABLE IF NOT EXISTS vm_topics (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        start_ms bigint NOT NULL,
        end_ms bigint NOT NULL,
        title text NOT NULL,
        summary text NOT NULL DEFAULT '',
        source text NOT NULL CHECK (source IN ('ai','user')),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vm_topics_session_idx ON vm_topics(session_id, start_ms);
      -- 拆主题拆到这次录音的第几毫秒了
      ALTER TABLE vm_sessions ADD COLUMN IF NOT EXISTS topics_until_ms bigint NOT NULL DEFAULT 0;
      ALTER TABLE vm_sessions ADD COLUMN IF NOT EXISTS boot_id text;
      ALTER TABLE vm_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      CREATE TABLE IF NOT EXISTS vm_share_links (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        from_ms bigint NOT NULL DEFAULT 0,
        to_ms bigint,
        token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        last_used_at timestamptz,
        uses integer NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS vm_share_links_session_idx ON vm_share_links(session_id);
      ALTER TABLE vm_share_links ALTER COLUMN session_id DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS vm_favorites (
        user_id text NOT NULL,
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS vm_fav_folders (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vm_fav_items (
        folder_id uuid NOT NULL REFERENCES vm_fav_folders(id) ON DELETE CASCADE,
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        added_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (folder_id, session_id)
      );
      ALTER TABLE vm_share_links ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES vm_fav_folders(id) ON DELETE CASCADE;
      ALTER TABLE vm_fav_folders ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS vm_fav_exclusions (
        folder_id uuid NOT NULL REFERENCES vm_fav_folders(id) ON DELETE CASCADE,
        session_id uuid NOT NULL REFERENCES vm_sessions(id) ON DELETE CASCADE,
        PRIMARY KEY (folder_id, session_id)
      );
      /* AI 产出物：纪要（Markdown）/ 思维导图（JSON），挂在主题或整次录音上 */
      CREATE TABLE IF NOT EXISTS vm_ai_outputs (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        target_type text NOT NULL CHECK (target_type IN ('topic','session')),
        target_id uuid NOT NULL,
        kind text NOT NULL CHECK (kind IN ('minutes','mindmap')),
        template text NOT NULL DEFAULT '',
        content text NOT NULL,
        model text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vm_ai_outputs_target_idx ON vm_ai_outputs(target_id, kind, created_at DESC);
      -- 自动化：到点自己做一件事（时间按北京时间算好存成 UTC 时刻）
      CREATE TABLE IF NOT EXISTS vm_automations (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        title text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        schedule jsonb NOT NULL,
        action jsonb NOT NULL,
        source text NOT NULL DEFAULT 'web',
        last_run_at timestamptz,
        last_status text NOT NULL DEFAULT '',
        next_run_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vm_automations_due_idx ON vm_automations(enabled, next_run_at);
      -- 建议：拆主题时扫出来、等用户点一下才建的事
      CREATE TABLE IF NOT EXISTS vm_suggestions (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        session_id uuid NOT NULL,
        topic_id uuid,
        tool text NOT NULL,
        title text NOT NULL,
        detail text NOT NULL DEFAULT '',
        args jsonb NOT NULL DEFAULT '{}'::jsonb,
        evidence text NOT NULL DEFAULT '',
        evidence_start_ms integer,
        evidence_end_ms integer,
        confidence real NOT NULL DEFAULT 0.7,
        status text NOT NULL DEFAULT 'open',
        draft_id uuid,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vm_suggestions_user_idx ON vm_suggestions(user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS vm_suggestions_topic_idx ON vm_suggestions(topic_id);
      -- 到点提醒：任务到期时在设备屏上弹卡片，按确认才算收到
      CREATE TABLE IF NOT EXISTS vm_reminders (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        draft_id uuid REFERENCES vm_action_drafts(id) ON DELETE CASCADE,
        title text NOT NULL,
        body text NOT NULL DEFAULT '',
        remind_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        sent_at timestamptz,
        acked_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vm_reminders_due_idx ON vm_reminders(status, remind_at);
      CREATE INDEX IF NOT EXISTS vm_reminders_user_idx ON vm_reminders(user_id, remind_at DESC);
      -- 主题的客户/项目标签：按人回看用
      ALTER TABLE vm_topics ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS vm_topics_label_idx ON vm_topics(user_id, label) WHERE label <> '';
      -- 每日小结：target_type=day，kind=daily
      ALTER TABLE vm_ai_outputs DROP CONSTRAINT IF EXISTS vm_ai_outputs_target_type_check;
      ALTER TABLE vm_ai_outputs ADD CONSTRAINT vm_ai_outputs_target_type_check CHECK (target_type IN ('topic','session','day'));
      ALTER TABLE vm_ai_outputs DROP CONSTRAINT IF EXISTS vm_ai_outputs_kind_check;
      ALTER TABLE vm_ai_outputs ADD CONSTRAINT vm_ai_outputs_kind_check CHECK (kind IN ('minutes','mindmap','daily','speakers'));
      -- 用户在设备屏上把这条回执划掉了（只影响设备屏，网页上照常能看到）
      ALTER TABLE vm_action_drafts ADD COLUMN IF NOT EXISTS device_dismissed_at timestamptz;
      ALTER TABLE vm_devices ADD COLUMN IF NOT EXISTS ota_release_id text;
      ALTER TABLE vm_devices ADD COLUMN IF NOT EXISTS ota_state text NOT NULL DEFAULT 'idle';
      ALTER TABLE vm_devices ADD COLUMN IF NOT EXISTS ota_progress_pct integer NOT NULL DEFAULT 0;
      ALTER TABLE vm_devices ADD COLUMN IF NOT EXISTS ota_error text;
      ALTER TABLE vm_devices ADD COLUMN IF NOT EXISTS ota_updated_at timestamptz;

      CREATE TABLE IF NOT EXISTS vm_firmware_releases (
        id uuid PRIMARY KEY,
        version text NOT NULL,
        project text NOT NULL DEFAULT '',
        idf_version text NOT NULL DEFAULT '',
        built_at text NOT NULL DEFAULT '',
        notes text NOT NULL DEFAULT '',
        byte_length integer NOT NULL,
        sha256 char(64) NOT NULL,
        object_key text NOT NULL,
        uploaded_at timestamptz NOT NULL,
        uploaded_by text NOT NULL DEFAULT '',
        rollout text NOT NULL DEFAULT 'none' CHECK (rollout IN ('none','all','devices')),
        rollout_device_ids jsonb NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS vm_firmware_uploaded_idx ON vm_firmware_releases(uploaded_at DESC);

      CREATE TABLE IF NOT EXISTS vm_audit_log (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL DEFAULT now(),
        actor_type text NOT NULL,
        actor_id text NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL DEFAULT '',
        target_id text NOT NULL DEFAULT '',
        detail jsonb NOT NULL DEFAULT '{}',
        ip text NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS vm_audit_at_idx ON vm_audit_log(at DESC);

      -- 过期登录会话没必要留着占地方
      DELETE FROM vm_auth_sessions WHERE expires_at < now();

      CREATE TABLE IF NOT EXISTS vm_integrations (
        user_id text NOT NULL,
        provider text NOT NULL,
        encrypted_config text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id, provider)
      );

      UPDATE vm_audio_chunks SET transcript_status='pending', transcript_updated_at=now()
      WHERE transcript_status='running' AND transcript_updated_at < now() - interval '5 minutes';
      UPDATE vm_executions SET status='unknown', error='服务重启，执行结果待幂等重试', updated_at=now()
      WHERE status='running';
      UPDATE vm_action_drafts d SET status='confirmed', updated_at=now()
      WHERE d.status='executing' AND NOT EXISTS (
        SELECT 1 FROM vm_executions e WHERE e.draft_id=d.id AND e.status='succeeded'
      );
    `);
    await this.enableVectorIndex((m) => console.warn(m));
  }

  /** 向量索引。没装 pgvector 扩展就退回原来的全表算分（能用，只是随着录音变多会越来越慢）。
   *  实测：1324 条时全表扫描还看不出慢，但这是必然会到来的问题，所以有扩展就用上。*/
  private vectorReady = false;
  private async enableVectorIndex(log?: (message: string) => void) {
    try {
      await this.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
      await this.sql.unsafe(`ALTER TABLE vm_transcript_segments ADD COLUMN IF NOT EXISTS embedding_v vector(512);`);
      /* real[] 转成文本是 {0.1,0.2}，vector 要的是 [0.1,0.2]——直接 ::vector 会报错，
       * 而且这个错误一旦被吞掉，就会安静地退回全表扫描，谁也不知道索引没建上。*/
      await this.sql.unsafe(`
        UPDATE vm_transcript_segments
        SET embedding_v = replace(replace(embedding::text, '{', '['), '}', ']')::vector
        WHERE embedding IS NOT NULL AND embedding_v IS NULL AND array_length(embedding, 1) = 512;`);
      await this.sql.unsafe(`
        CREATE INDEX IF NOT EXISTS vm_segments_embedding_idx
          ON vm_transcript_segments USING hnsw (embedding_v vector_cosine_ops);`);
      this.vectorReady = true;
    } catch (error) {
      this.vectorReady = false;   /* 没有 pgvector 扩展：照旧用 real[] 算，能用只是会随数据变慢 */
      log?.(`向量索引没建上，退回全表算分：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close() { await this.sql.end({ timeout: 5 }); }

  async createSession(input: Pick<Session, "id" | "deviceId" | "userId" | "startedAt"> & { bootId?: string | null }) {
    const rows = await this.sql`
      INSERT INTO vm_sessions (id, device_id, user_id, status, started_at, boot_id)
      VALUES (${input.id}, ${input.deviceId}, ${input.userId}, 'recording', ${input.startedAt}, ${input.bootId ?? null})
      RETURNING *`;
    return mapSession(rows[0]!);
  }

  async createShareLink(link: ShareLink) {
    await this.sql`INSERT INTO vm_share_links (id, user_id, session_id, folder_id, from_ms, to_ms, token_hash, created_at, expires_at)
      VALUES (${link.id}, ${link.userId}, ${link.sessionId}, ${link.folderId}, ${link.fromMs}, ${link.toMs}, ${link.tokenHash}, ${link.createdAt}, ${link.expiresAt})`;
    return link;
  }
  async findShareLink(tokenHash: string) {
    const rows = await this.sql`SELECT * FROM vm_share_links WHERE token_hash = ${tokenHash}`;
    return rows[0] ? mapShareLink(rows[0]) : null;
  }
  async touchShareLink(id: string) {
    await this.sql`UPDATE vm_share_links SET last_used_at = now(), uses = uses + 1 WHERE id = ${id}`;
  }
  async listShareLinks(userId: string, filter: { sessionId?: string; folderId?: string } = {}) {
    const rows = await this.sql`SELECT * FROM vm_share_links WHERE user_id = ${userId}
      AND (${filter.sessionId ?? null}::uuid IS NULL OR session_id = ${filter.sessionId ?? null})
      AND (${filter.folderId ?? null}::uuid IS NULL OR folder_id = ${filter.folderId ?? null}) ORDER BY created_at DESC LIMIT 200`;
    return rows.map(mapShareLink);
  }
  async revokeShareLink(id: string, userId: string) {
    const rows = await this.sql`UPDATE vm_share_links SET revoked_at = now() WHERE id = ${id} AND user_id = ${userId} AND revoked_at IS NULL RETURNING id`;
    return rows.length > 0;
  }

  async deleteSessions(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.sql.begin(async (sql) => {
      const keys = await sql`SELECT object_key FROM vm_audio_chunks WHERE session_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM vm_transcript_segments WHERE session_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM vm_audio_chunks WHERE session_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM vm_topics WHERE session_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM vm_speech_marks WHERE session_id = ANY(${ids}::uuid[])`;
      await sql`UPDATE vm_share_links SET revoked_at = now() WHERE session_id = ANY(${ids}::uuid[]) AND revoked_at IS NULL`;
      await sql`UPDATE vm_sessions SET deleted_at = now(), status = CASE WHEN status = 'recording' THEN 'ended' ELSE status END,
                updated_at = now() WHERE id = ANY(${ids}::uuid[])`;
      return keys;
    });
    return rows.map((r) => String(r.object_key));
  }

  async getSession(id: string) {
    const rows = await this.sql`SELECT * FROM vm_sessions WHERE id=${id}`;
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async updateSessionStatus(id: string, status: SessionStatus, endedAt: string) {
    const rows = await this.sql`
      UPDATE vm_sessions SET status=${status}, ended_at=${endedAt}, updated_at=now()
      WHERE id=${id} RETURNING *`;
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async putChunk(chunk: AudioChunk): Promise<PutChunkResult> {
    const rows = await this.sql`
      INSERT INTO vm_audio_chunks
        (session_id, sequence, sha256, object_key, content_type, byte_length, start_ms, duration_ms, uploaded_at)
      VALUES
        (${chunk.sessionId}, ${chunk.sequence}, ${chunk.sha256}, ${chunk.objectKey}, ${chunk.contentType},
         ${chunk.byteLength}, ${chunk.startMs}, ${chunk.durationMs}, ${chunk.uploadedAt})
      ON CONFLICT (session_id, sequence) DO NOTHING RETURNING *`;
    if (rows[0]) return { chunk: mapChunk(rows[0]), created: true };
    const current = await this.getChunk(chunk.sessionId, chunk.sequence);
    if (!current) throw new Error("音频块写入冲突后无法读取");
    return { chunk: current, created: false };
  }

  async getChunk(sessionId: string, sequence: number) {
    const rows = await this.sql`SELECT * FROM vm_audio_chunks WHERE session_id=${sessionId} AND sequence=${sequence}`;
    return rows[0] ? mapChunk(rows[0]) : null;
  }



  async finishTranscript(segment: TranscriptSegment) {
    const rows = await this.sql.begin(async (sql) => {
      const saved = await sql`
        INSERT INTO vm_transcript_segments
          (session_id, sequence, text, start_ms, end_ms, provider, status, error, kind, end_sequence, created_at, updated_at)
        VALUES (${segment.sessionId}, ${segment.sequence}, ${segment.text}, ${segment.startMs}, ${segment.endMs},
          ${segment.provider}, 'succeeded', NULL, ${segment.kind}, ${segment.endSequence}, ${segment.createdAt}, ${segment.updatedAt})
        ON CONFLICT (session_id, sequence) DO UPDATE SET text=excluded.text, start_ms=excluded.start_ms,
          end_ms=excluded.end_ms, provider=excluded.provider, status='succeeded', error=NULL,
          kind=excluded.kind, end_sequence=excluded.end_sequence, updated_at=excluded.updated_at RETURNING *`;
      await sql`UPDATE vm_audio_chunks SET transcript_status='succeeded', transcript_updated_at=now()
        WHERE session_id=${segment.sessionId} AND sequence=${segment.sequence}`;
      return saved;
    });
    return mapTranscript(rows[0]!);
  }

  async failTranscript(sessionId: string, sequence: number, provider: string, error: string) {
    const now = new Date().toISOString();
    const rows = await this.sql.begin(async (sql) => {
      const saved = await sql`
        INSERT INTO vm_transcript_segments
          (session_id, sequence, text, start_ms, end_ms, provider, status, error, created_at, updated_at)
        SELECT session_id, sequence, '', start_ms, start_ms + duration_ms, ${provider}, 'failed', ${error}, ${now}, ${now}
        FROM vm_audio_chunks WHERE session_id=${sessionId} AND sequence=${sequence}
        ON CONFLICT (session_id, sequence) DO UPDATE SET status='failed', provider=excluded.provider,
          error=excluded.error, updated_at=excluded.updated_at RETURNING *`;
      await sql`UPDATE vm_audio_chunks SET transcript_status='failed', transcript_updated_at=now()
        WHERE session_id=${sessionId} AND sequence=${sequence}`;
      return saved;
    });
    return mapTranscript(rows[0]!);
  }

  async listTranscripts(sessionId: string) {
    const rows = await this.sql`SELECT * FROM vm_transcript_segments WHERE session_id=${sessionId} ORDER BY sequence`;
    return rows.map(mapTranscript);
  }

  async listTimeline(sessionId: string): Promise<Timeline | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    const chunkRows = await this.sql`SELECT * FROM vm_audio_chunks WHERE session_id=${sessionId} ORDER BY sequence`;
    const draftRows = await this.sql`SELECT * FROM vm_action_drafts WHERE session_id=${sessionId} ORDER BY created_at`;
    const transcriptRows = await this.sql`SELECT * FROM vm_transcript_segments WHERE session_id=${sessionId} ORDER BY sequence`;
    const executionRows = await this.sql`
      SELECT e.* FROM vm_executions e JOIN vm_action_drafts d ON d.id=e.draft_id
      WHERE d.session_id=${sessionId} ORDER BY e.created_at`;
    return {
      session,
      chunks: chunkRows.map(mapChunk),
      transcripts: transcriptRows.map(mapTranscript),
      drafts: draftRows.map(mapDraft),
      executions: executionRows.map(mapExecution),
    };
  }

  async listSessions(limit: number, userId?: string) {
    const rows = userId
      ? await this.sql`SELECT * FROM vm_sessions WHERE user_id = ${userId} ORDER BY started_at DESC LIMIT ${limit}`
      : await this.sql`SELECT * FROM vm_sessions ORDER BY started_at DESC LIMIT ${limit}`;
    return rows.map(mapSession);
  }

  async createDraft(draft: ActionDraft) {
    const rows = await this.sql`
      INSERT INTO vm_action_drafts
        (id, session_id, user_id, tool, title, detail, args, evidence, evidence_start_ms, evidence_end_ms,
         confidence, mode, risk, status, revision, idempotency_key, created_at, updated_at)
      VALUES
        (${draft.id}, ${draft.sessionId}, ${draft.userId}, ${draft.tool}, ${draft.title}, ${draft.detail},
         ${this.sql.json(draft.args as never)}, ${draft.evidence}, ${draft.evidenceStartMs}, ${draft.evidenceEndMs},
         ${draft.confidence}, ${draft.mode}, ${draft.risk}, ${draft.status}, ${draft.revision},
         ${draft.idempotencyKey}, ${draft.createdAt}, ${draft.updatedAt})
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`;
    if (rows[0]) return mapDraft(rows[0]);
    const current = await this.getDraftByIdempotencyKey(draft.idempotencyKey);
    if (!current) throw new Error("动作幂等冲突后无法读取");
    return current;
  }

  async getDraft(id: string) {
    const rows = await this.sql`SELECT * FROM vm_action_drafts WHERE id=${id}`;
    return rows[0] ? mapDraft(rows[0]) : null;
  }
  async getDraftByIdempotencyKey(key: string) {
    const rows = await this.sql`SELECT * FROM vm_action_drafts WHERE idempotency_key=${key}`;
    return rows[0] ? mapDraft(rows[0]) : null;
  }

  async listDrafts(userId: string, status?: string) {
    const rows = status
      ? await this.sql`SELECT * FROM vm_action_drafts WHERE user_id=${userId} AND status=${status} ORDER BY created_at`
      : await this.sql`SELECT * FROM vm_action_drafts WHERE user_id=${userId} ORDER BY created_at`;
    return rows.map(mapDraft);
  }
  async findChunkAt(sessionId: string, ms: number) {
    const rows = await this.sql`
      SELECT * FROM vm_audio_chunks WHERE session_id = ${sessionId} AND start_ms <= ${ms}
      ORDER BY start_ms DESC LIMIT 1`;
    return rows[0] ? mapChunk(rows[0]) : null;
  }
  async listPendingDrafts(limit: number) {
    const rows = await this.sql`
      SELECT * FROM vm_action_drafts
      WHERE status = 'pending'
      ORDER BY created_at LIMIT ${limit}`;
    return rows.map(mapDraft);
  }
  async listExecutableDrafts(limit: number) {
    const rows = await this.sql`
      SELECT * FROM vm_action_drafts
      WHERE status = 'confirmed'
      ORDER BY created_at LIMIT ${limit}`;
    return rows.map(mapDraft);
  }

  async updateDraft(id: string, patch: Partial<ActionDraft>) {
    const current = await this.getDraft(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    const rows = await this.sql`
      UPDATE vm_action_drafts SET
        tool=${next.tool}, title=${next.title}, detail=${next.detail}, args=${this.sql.json(next.args as never)},
        evidence=${next.evidence}, evidence_start_ms=${next.evidenceStartMs}, evidence_end_ms=${next.evidenceEndMs},
        confidence=${next.confidence}, mode=${next.mode}, risk=${next.risk}, status=${next.status},
        revision=${next.revision}, updated_at=${next.updatedAt}
      WHERE id=${id} RETURNING *`;
    return rows[0] ? mapDraft(rows[0]) : null;
  }
  async transitionDraft(id: string, from: ActionDraft["status"], to: ActionDraft["status"], detail?: string) {
    const rows = detail === undefined
      ? await this.sql`UPDATE vm_action_drafts SET status=${to}, updated_at=now()
          WHERE id=${id} AND status=${from} RETURNING *`
      : await this.sql`UPDATE vm_action_drafts SET status=${to}, detail=${detail}, updated_at=now()
          WHERE id=${id} AND status=${from} RETURNING *`;
    return rows[0] ? mapDraft(rows[0]) : null;
  }

  async getToolPolicy(userId: string, tool: string) {
    const rows = await this.sql`SELECT * FROM vm_tool_policies WHERE user_id=${userId} AND tool=${tool}`;
    return rows[0] ? mapPolicy(rows[0]) : null;
  }

  async listToolPolicies(userId: string) {
    const rows = await this.sql`SELECT * FROM vm_tool_policies WHERE user_id=${userId} ORDER BY tool`;
    return rows.map(mapPolicy);
  }

  async upsertToolPolicy(policy: ToolPolicy) {
    const rows = await this.sql`
      INSERT INTO vm_tool_policies (user_id, tool, confirmation, max_draft_age_sec, notify_device, extract, updated_at)
      VALUES (${policy.userId}, ${policy.tool}, ${policy.confirmation}, ${policy.maxDraftAgeSec}, ${policy.notifyDevice},
              ${policy.extract}, ${policy.updatedAt})
      ON CONFLICT (user_id, tool) DO UPDATE SET confirmation=excluded.confirmation,
        max_draft_age_sec=excluded.max_draft_age_sec, notify_device=excluded.notify_device, extract=excluded.extract,
        updated_at=excluded.updated_at RETURNING *`;
    return mapPolicy(rows[0]!);
  }

  async createExecution(execution: Execution) {
    const rows = await this.sql`
      INSERT INTO vm_executions
        (id, draft_id, idempotency_key, status, provider, external_id, result, error, created_at, updated_at)
      VALUES (${execution.id}, ${execution.draftId}, ${execution.idempotencyKey}, ${execution.status},
        ${execution.provider}, ${execution.externalId}, ${this.sql.json(execution.result as never)}, ${execution.error},
        ${execution.createdAt}, ${execution.updatedAt})
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`;
    if (rows[0]) return { execution: mapExecution(rows[0]), created: true };
    const existing = await this.sql`SELECT * FROM vm_executions WHERE idempotency_key=${execution.idempotencyKey}`;
    return { execution: mapExecution(existing[0]!), created: false };
  }
  async claimExecution(seed: Execution, deadline: string) {
    return this.sql.begin(async (sql) => {
      // Lock the draft before inspecting the execution so concurrent drains and HTTP confirmations serialize.
      const drafts = await sql`SELECT * FROM vm_action_drafts WHERE id=${seed.draftId} FOR UPDATE`;
      const draft = drafts[0] ? mapDraft(drafts[0]) : null;
      const existing = await sql`SELECT * FROM vm_executions WHERE idempotency_key=${seed.idempotencyKey}`;
      const current = existing[0] ? mapExecution(existing[0]) : null;
      if (!draft || draft.status !== "confirmed") return { claimed: false, execution: current, draft };
      if (current && !["queued", "failed"].includes(current.status)) return { claimed: false, execution: current, draft };
      const expired = await sql`UPDATE vm_action_drafts SET status='expired', updated_at=now()
        WHERE id=${draft.id} AND clock_timestamp() >= ${deadline}::timestamptz RETURNING *`;
      if (expired[0]) return { claimed: false, execution: current, draft: mapDraft(expired[0]) };
      const rows = await sql`
        INSERT INTO vm_executions
          (id, draft_id, idempotency_key, status, provider, external_id, result, error, created_at, updated_at)
        VALUES (${seed.id}, ${draft.id}, ${seed.idempotencyKey}, 'running', ${seed.provider}, NULL, '{}', NULL, now(), now())
        ON CONFLICT (idempotency_key) DO UPDATE SET status='running', error=NULL, updated_at=now()
          WHERE vm_executions.status IN ('queued', 'failed') RETURNING *`;
      if (!rows[0]) return { claimed: false, execution: current, draft };
      const updated = await sql`UPDATE vm_action_drafts SET status='executing', updated_at=now() WHERE id=${draft.id} RETURNING *`;
      return { claimed: true, execution: mapExecution(rows[0]), draft: mapDraft(updated[0]!) };
    });
  }
  async recoverStaleExecutions(before: string) {
    const error = "执行连接中断，结果未知；请核实后重新发出指令";
    return this.sql.begin(async (sql) => {
      // Match claimExecution's draft-then-execution lock order; never wait on a live claimant.
      const drafts = await sql`SELECT d.id FROM vm_action_drafts d JOIN vm_executions e ON e.draft_id=d.id
        WHERE d.status IN ('executing', 'confirmed') AND e.updated_at < ${before}
          AND e.status IN ('running', 'queued', 'succeeded')
        ORDER BY d.created_at LIMIT 100 FOR UPDATE OF d SKIP LOCKED`;
      let count = 0;
      for (const draft of drafts) {
        const id = String(draft.id);
        const rows = await sql`UPDATE vm_executions SET status='unknown', error=${error}, updated_at=now()
          WHERE draft_id=${id} AND status IN ('running', 'queued') AND updated_at < ${before} RETURNING id`;
        if (rows.length) {
          await sql`UPDATE vm_action_drafts SET status='failed', detail=${error}, updated_at=now() WHERE id=${id}`;
          count++;
        } else {
          // Provider success persisted but process died before updating the card.
          await sql`UPDATE vm_action_drafts SET status='executed', updated_at=now() WHERE id=${id}
            AND EXISTS (SELECT 1 FROM vm_executions WHERE draft_id=${id} AND status='succeeded')`;
        }
      }
      return count;
    });
  }

  async getExecution(id: string) {
    const rows = await this.sql`SELECT * FROM vm_executions WHERE id=${id}`;
    return rows[0] ? mapExecution(rows[0]) : null;
  }
  async getExecutionByDraft(draftId: string) {
    const rows = await this.sql`SELECT * FROM vm_executions WHERE draft_id=${draftId} ORDER BY created_at DESC LIMIT 1`;
    return rows[0] ? mapExecution(rows[0]) : null;
  }
  async updateExecution(id: string, patch: Partial<Execution>) {
    const current = await this.getExecution(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    const rows = await this.sql`
      UPDATE vm_executions SET status=${next.status}, provider=${next.provider}, external_id=${next.externalId},
        result=${this.sql.json(next.result as never)}, error=${next.error}, updated_at=${next.updatedAt}
      WHERE id=${id} RETURNING *`;
    return rows[0] ? mapExecution(rows[0]) : null;
  }

  /* ── 转写流水线 ─────────────────────────────────────────────── */
  async claimVadChunks(limit: number) {
    const rows = await this.sql`
      WITH next AS (
        SELECT session_id, sequence FROM vm_audio_chunks c WHERE transcript_status = 'pending'
        /* 按住说话的音频插队：断网积压了一堆时，命令不排在几百块闲聊后面 */
        ORDER BY EXISTS (SELECT 1 FROM vm_speech_marks m WHERE m.session_id = c.session_id
                  AND m.start_ms < c.start_ms + c.duration_ms AND m.end_ms > c.start_ms) DESC, uploaded_at FOR UPDATE SKIP LOCKED LIMIT ${limit}
      )
      UPDATE vm_audio_chunks c SET transcript_status = 'vad', transcript_updated_at = now()
      FROM next WHERE c.session_id = next.session_id AND c.sequence = next.sequence
      RETURNING c.*`;
    return rows.map(mapChunk);
  }
  async saveVad(sessionId: string, sequence: number, r: { speech: boolean; speechMs: number; firstMs: number | null; lastMs: number | null }) {
    await this.sql.begin(async (sql) => {
      await sql`UPDATE vm_audio_chunks SET transcript_status = ${r.speech ? "speech" : "silent"},
          vad_speech_ms = ${r.speechMs}, vad_first_ms = ${r.firstMs}, vad_last_ms = ${r.lastMs}, transcript_updated_at = now()
        WHERE session_id = ${sessionId} AND sequence = ${sequence}`;
      if (!r.speech) {
        await sql`
          INSERT INTO vm_transcript_segments (session_id, sequence, text, start_ms, end_ms, provider, status, error, kind, intent_status, created_at, updated_at)
          SELECT session_id, sequence, '', start_ms, start_ms + duration_ms, 'vad', 'succeeded', NULL, 'silent', 'skipped', now(), now()
          FROM vm_audio_chunks WHERE session_id = ${sessionId} AND sequence = ${sequence}
          ON CONFLICT (session_id, sequence) DO UPDATE SET text = '', provider = 'vad', status = 'succeeded', error = NULL,
            kind = 'silent', intent_status = 'skipped', updated_at = now()`;
      }
    });
  }
  async sessionsWithSpeech(limit: number) {
    const rows = await this.sql`
      WITH candidates AS (
        SELECT c.*, EXISTS (SELECT 1 FROM vm_speech_marks m WHERE m.session_id = c.session_id
          AND m.start_ms < c.start_ms + c.duration_ms AND m.end_ms > c.start_ms) AS held
        FROM vm_audio_chunks c WHERE transcript_status IN ('pending', 'vad', 'speech', 'asr')
      )
      SELECT session_id, coalesce(min(sequence) FILTER (WHERE held),
        min(sequence) FILTER (WHERE transcript_status = 'speech'))::int AS first
      FROM candidates GROUP BY session_id HAVING bool_or(transcript_status = 'speech')
      /* Prioritize the command's actual chunk, not only its session. Pending/VAD prefixes
       * remain the head so a later ready chunk cannot cut the beginning off a command. */
      ORDER BY bool_or(held) DESC, min(uploaded_at) LIMIT ${limit}`;
    return rows.map((r) => ({ sessionId: String(r.session_id), firstSequence: Number(r.first) }));
  }
  async chunkStates(sessionId: string, fromSequence: number, limit: number) {
    const rows = await this.sql`
      SELECT * FROM vm_audio_chunks WHERE session_id = ${sessionId} AND sequence >= ${fromSequence}
      ORDER BY sequence LIMIT ${limit}`;
    return rows.map(mapChunkState);
  }
  async claimRun(sessionId: string, sequences: number[]) {
    if (!sequences.length) return false;
    return this.sql.begin(async (sql) => {
      const rows = await sql`SELECT sequence, transcript_status FROM vm_audio_chunks
        WHERE session_id = ${sessionId} AND sequence = ANY(${sequences}::int[]) ORDER BY sequence FOR UPDATE`;
      if (rows.length !== sequences.length || rows.some((r) => !["speech", "silent"].includes(String(r.transcript_status)))) return false;
      await sql`UPDATE vm_audio_chunks SET transcript_status = 'asr', transcript_attempts = transcript_attempts + 1, transcript_updated_at = now()
        WHERE session_id = ${sessionId} AND sequence = ANY(${sequences}::int[])`;
      return true;
    });
  }
  async markedChunkStates(sessionId: string, startMs: number, endMs: number) {
    const rows = await this.sql`SELECT * FROM vm_audio_chunks WHERE session_id = ${sessionId}
      AND start_ms < ${endMs} AND start_ms + duration_ms > ${startMs} ORDER BY sequence LIMIT 128`;
    return rows.map(mapChunkState);
  }
  async finishRun(head: TranscriptSegment, mergedSequences: number[]) {
    await this.sql.begin(async (sql) => {
      await sql`
        INSERT INTO vm_transcript_segments
          (session_id, sequence, text, start_ms, end_ms, provider, status, error, kind, end_sequence, intent_status, created_at, updated_at)
        VALUES (${head.sessionId}, ${head.sequence}, ${head.text}, ${head.startMs}, ${head.endMs}, ${head.provider},
          'succeeded', NULL, ${head.kind}, ${head.endSequence}, ${head.kind === "speech" ? "pending" : "skipped"},
          ${head.createdAt}, ${head.updatedAt})
        ON CONFLICT (session_id, sequence) DO UPDATE SET text = excluded.text, start_ms = excluded.start_ms,
          end_ms = excluded.end_ms, provider = excluded.provider, status = 'succeeded', error = NULL, kind = excluded.kind,
          end_sequence = excluded.end_sequence, intent_status = excluded.intent_status, updated_at = excluded.updated_at`;
      await sql`UPDATE vm_audio_chunks SET transcript_status = 'succeeded', transcript_updated_at = now()
        WHERE session_id = ${head.sessionId} AND sequence = ${head.sequence}`;
      if (mergedSequences.length) {
        await sql`
          INSERT INTO vm_transcript_segments (session_id, sequence, text, start_ms, end_ms, provider, status, error, kind, intent_status, created_at, updated_at)
          SELECT session_id, sequence, '', start_ms, start_ms + duration_ms, ${head.provider}, 'succeeded', NULL, 'merged', 'skipped', now(), now()
          FROM vm_audio_chunks WHERE session_id = ${head.sessionId} AND sequence = ANY(${mergedSequences}::int[])
          ON CONFLICT (session_id, sequence) DO UPDATE SET text = '', status = 'succeeded', error = NULL, kind = 'merged',
            intent_status = 'skipped', updated_at = now()`;
        await sql`UPDATE vm_audio_chunks SET transcript_status = 'merged', transcript_updated_at = now()
          WHERE session_id = ${head.sessionId} AND sequence = ANY(${mergedSequences}::int[])`;
      }
    });
  }
  async releaseRun(sessionId: string, sequences: number[], provider: string, error: string) {
    await this.sql.begin(async (sql) => {
      await sql`UPDATE vm_audio_chunks SET transcript_status = CASE WHEN transcript_attempts >= 5 THEN 'failed' ELSE 'speech' END,
          transcript_updated_at = now()
        WHERE session_id = ${sessionId} AND sequence = ANY(${sequences}::int[])`;
      await sql`
        INSERT INTO vm_transcript_segments (session_id, sequence, text, start_ms, end_ms, provider, status, error, kind, intent_status, created_at, updated_at)
        SELECT session_id, sequence, '', start_ms, start_ms + duration_ms, ${provider}, 'failed', ${error}, 'speech', 'skipped', now(), now()
        FROM vm_audio_chunks WHERE session_id = ${sessionId} AND sequence = ANY(${sequences}::int[]) AND transcript_status = 'failed'
        ON CONFLICT (session_id, sequence) DO UPDATE SET status = 'failed', error = excluded.error, provider = excluded.provider, updated_at = now()`;
    });
  }
  async claimIntentSegments(limit: number) {
    const rows = await this.sql`
      WITH next AS (
        SELECT session_id, sequence FROM vm_transcript_segments t WHERE intent_status = 'pending'
        ORDER BY EXISTS (SELECT 1 FROM vm_speech_marks m WHERE m.session_id = t.session_id
                  AND m.start_ms - 1000 <= t.end_ms AND m.end_ms + 1000 >= t.start_ms) DESC, created_at
        FOR UPDATE SKIP LOCKED LIMIT ${limit}
      )
      UPDATE vm_transcript_segments t SET intent_status = 'running'
      FROM next WHERE t.session_id = next.session_id AND t.sequence = next.sequence
      RETURNING t.*, (SELECT user_id FROM vm_sessions s WHERE s.id = t.session_id) AS user_id,
                     (SELECT started_at FROM vm_sessions s WHERE s.id = t.session_id) AS session_started_at`;
    return rows.map((r) => ({ ...mapTranscript(r), userId: String(r.user_id), sessionStartedAt: iso(r.session_started_at) }));
  }
  async deferIntent(sessionId: string, sequence: number) {
    await this.sql`UPDATE vm_transcript_segments SET intent_status = 'pending' WHERE session_id = ${sessionId} AND sequence = ${sequence}`;
  }
  async finishIntent(sessionId: string, sequence: number, status: "done" | "skipped" | "failed") {
    await this.sql`UPDATE vm_transcript_segments SET intent_status = ${status} WHERE session_id = ${sessionId} AND sequence = ${sequence}`;
  }
  async recentSpeech(sessionId: string, beforeSequence: number, limit: number) {
    const rows = await this.sql`
      SELECT * FROM vm_transcript_segments WHERE session_id = ${sessionId} AND sequence < ${beforeSequence}
        AND kind = 'speech' AND status = 'succeeded' ORDER BY sequence DESC LIMIT ${limit}`;
    return rows.map(mapTranscript).reverse();
  }

  /* ── 语义检索 ───────────────────────────────────────────────── */
  async claimEmbeddingSegments(limit: number) {
    const rows = await this.sql`
      SELECT session_id, sequence, text FROM vm_transcript_segments
      WHERE embedding IS NULL AND embedding_tries < 3 AND kind = 'speech' AND status = 'succeeded' AND text <> ''
      ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ sessionId: String(r.session_id), sequence: Number(r.sequence), text: String(r.text) }));
  }
  async saveEmbedding(sessionId: string, sequence: number, vector: number[] | null) {
    if (this.vectorReady && vector) {
      await this.sql`
        UPDATE vm_transcript_segments SET embedding = ${vector as never}, embedding_v = ${`[${vector.join(",")}]`}::vector,
          embedding_tries = embedding_tries + 1
        WHERE session_id = ${sessionId} AND sequence = ${sequence}`;
      return;
    }
    // 失败也要记一次：否则同一句会被无限重试
    await this.sql`
      UPDATE vm_transcript_segments SET embedding = ${vector as never}, embedding_tries = embedding_tries + 1
      WHERE session_id = ${sessionId} AND sequence = ${sequence}`;
  }
  async semanticSearch(vector: number[], limit: number, userId?: string) {
    if (this.vectorReady) {
      /* <=> 是余弦距离，越小越近；走 HNSW 索引，不扫全表 */
      const literal = `[${vector.join(",")}]`;
      const hits = await this.sql`
        SELECT t.session_id, t.sequence, t.text, t.start_ms, t.end_ms, s.started_at, s.device_id, s.user_id,
               1 - (t.embedding_v <=> ${literal}::vector) AS score
        FROM vm_transcript_segments t JOIN vm_sessions s ON s.id = t.session_id
        WHERE t.embedding_v IS NOT NULL AND t.kind = 'speech'
          AND (${userId ?? null}::text IS NULL OR s.user_id = ${userId ?? null})
        ORDER BY t.embedding_v <=> ${literal}::vector LIMIT ${limit}`;
      return hits.map((r) => ({ sessionId: String(r.session_id), sequence: Number(r.sequence), text: String(r.text),
        startMs: Number(r.start_ms), endMs: Number(r.end_ms), sessionStartedAt: iso(r.started_at),
        deviceId: String(r.device_id), userId: String(r.user_id), score: Number(r.score ?? 0) }));
    }
    const rows = await this.sql`
      SELECT t.session_id, t.sequence, t.text, t.start_ms, t.end_ms, s.started_at, s.device_id, s.user_id,
             (SELECT sum(a * b) FROM unnest(t.embedding, ${vector as never}::real[]) AS z(a, b)) AS score
      FROM vm_transcript_segments t JOIN vm_sessions s ON s.id = t.session_id
      WHERE t.embedding IS NOT NULL AND t.kind = 'speech'
        AND (${userId ?? null}::text IS NULL OR s.user_id = ${userId ?? null})
      ORDER BY score DESC NULLS LAST LIMIT ${limit}`;
    return rows.map((r) => ({ sessionId: String(r.session_id), sequence: Number(r.sequence), text: String(r.text),
      startMs: Number(r.start_ms), endMs: Number(r.end_ms), sessionStartedAt: iso(r.started_at),
      deviceId: String(r.device_id), userId: String(r.user_id), score: Number(r.score ?? 0) }));
  }

  /* ── 波形、导出与删除 ───────────────────────────────────────── */
  async saveEnvelope(sessionId: string, sequence: number, envelope: Buffer) {
    await this.sql`UPDATE vm_audio_chunks SET envelope = ${envelope} WHERE session_id = ${sessionId} AND sequence = ${sequence}`;
  }
  async listEnvelopes(sessionId: string) {
    const rows = await this.sql`
      SELECT c.sequence, c.start_ms, c.duration_ms, c.envelope, t.kind, coalesce(t.text, '') AS text
      FROM vm_audio_chunks c LEFT JOIN vm_transcript_segments t ON t.session_id = c.session_id AND t.sequence = c.sequence
      WHERE c.session_id = ${sessionId} ORDER BY c.sequence`;
    return rows.map((r): ChunkEnvelope => ({ sequence: Number(r.sequence), startMs: Number(r.start_ms),
      durationMs: Number(r.duration_ms), envelope: r.envelope ? Buffer.from(r.envelope as Buffer).toString("base64") : null,
      kind: r.kind === null || r.kind === undefined ? null : String(r.kind), text: String(r.text ?? "") }));
  }
  async chunksMissingEnvelope(limit: number) {
    const rows = await this.sql`
      SELECT * FROM vm_audio_chunks WHERE envelope IS NULL
      ORDER BY uploaded_at DESC LIMIT ${limit}`;
    return rows.map(mapChunk);
  }
  async chunksInRange(sessionId: string, fromMs: number, toMs: number) {
    const rows = await this.sql`
      SELECT * FROM vm_audio_chunks WHERE session_id = ${sessionId}
        AND start_ms < ${toMs} AND start_ms + duration_ms > ${fromMs} ORDER BY sequence`;
    return rows.map(mapChunk);
  }
  async deleteChunks(sessionId: string, sequences: number[]) {
    if (!sequences.length) return [];
    const rows = await this.sql.begin(async (sql) => {
      const keys = await sql`SELECT object_key FROM vm_audio_chunks WHERE session_id = ${sessionId} AND sequence = ANY(${sequences}::int[])`;
      await sql`DELETE FROM vm_transcript_segments WHERE session_id = ${sessionId} AND sequence = ANY(${sequences}::int[])`;
      await sql`DELETE FROM vm_audio_chunks WHERE session_id = ${sessionId} AND sequence = ANY(${sequences}::int[])`;
      return keys;
    });
    return rows.map((r) => String(r.object_key));
  }
  async expiredChunks(beforeIso: string, userIds: string[], limit: number) {
    if (!userIds.length) return [];
    const rows = await this.sql`
      SELECT c.session_id, c.sequence, c.object_key FROM vm_audio_chunks c
      JOIN vm_sessions s ON s.id = c.session_id
      WHERE s.user_id = ANY(${userIds}::text[]) AND c.uploaded_at < ${beforeIso}
        AND NOT EXISTS (SELECT 1 FROM vm_favorites f WHERE f.session_id = c.session_id AND f.user_id = s.user_id)   -- 收藏的录音不过期
      ORDER BY c.uploaded_at LIMIT ${limit}`;
    return rows.map((r) => ({ sessionId: String(r.session_id), sequence: Number(r.sequence), objectKey: String(r.object_key) }));
  }

  /* ── 用量与成本 ─────────────────────────────────────────────── */
  async recordUsage(e: UsageEntry) {
    await this.sql`
      INSERT INTO vm_usage (at, user_id, session_id, kind, provider, model, tier, audio_ms, input_tokens, output_tokens, cost_yuan, feature)
      VALUES (${e.at}, ${e.userId}, ${e.sessionId}, ${e.kind}, ${e.provider}, ${e.model}, ${e.tier},
              ${e.audioMs}, ${e.inputTokens}, ${e.outputTokens}, ${e.costYuan}, ${e.feature ?? ""})`;
  }
  async usageRollup(fromIso: string, toIso: string) {
    const rows = await this.sql`
      SELECT to_char(at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day, user_id, kind, feature, model, tier,
             count(*)::int AS calls, sum(audio_ms)::bigint AS audio_ms, sum(input_tokens)::bigint AS input_tokens,
             sum(output_tokens)::bigint AS output_tokens, sum(cost_yuan)::float8 AS cost_yuan
      FROM vm_usage WHERE at >= ${fromIso} AND at < ${toIso}
      GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2`;
    return rows.map((r): UsageRollupRow => ({ day: String(r.day), userId: String(r.user_id), kind: r.kind as "asr" | "llm",
      feature: String(r.feature ?? ""), model: String(r.model), tier: r.tier as QualityTier, calls: Number(r.calls), audioMs: Number(r.audio_ms),
      inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), costYuan: Number(r.cost_yuan) }));
  }

  /* ── 用户设置、设备指令、系统配置 ───────────────────────────── */
  async getUserSettings(userId: string) {
    const rows = await this.sql`SELECT * FROM vm_user_settings WHERE user_id = ${userId}`;
    const r = rows[0];
    return r ? { userId: String(r.user_id), tier: r.tier as QualityTier, wakeWord: String(r.wake_word),
      retentionDays: Number(r.retention_days ?? 0), schedule: r.schedule as UserSettings["schedule"],
      ledMode: (r.led_mode ?? "designed") as UserSettings["ledMode"],
      prefs: UserPrefs.parse(r.prefs ?? {}),
      updatedAt: iso(r.updated_at) } : null;
  }
  async saveUserSettings(v: UserSettings) {
    await this.sql`
      INSERT INTO vm_user_settings (user_id, tier, wake_word, retention_days, schedule, led_mode, prefs, updated_at)
      VALUES (${v.userId}, ${v.tier}, ${v.wakeWord}, ${v.retentionDays}, ${this.sql.json(v.schedule as never)}, ${v.ledMode},
              ${this.sql.json(v.prefs as never)}, ${v.updatedAt})
      ON CONFLICT (user_id) DO UPDATE SET tier = excluded.tier, wake_word = excluded.wake_word,
        retention_days = excluded.retention_days, schedule = excluded.schedule, led_mode = excluded.led_mode, prefs = excluded.prefs,
        updated_at = excluded.updated_at`;
    return v;
  }
  /** 设了保留期的用户 */
  async usersWithRetention() {
    const rows = await this.sql`SELECT user_id, retention_days FROM vm_user_settings WHERE retention_days > 0`;
    return rows.map((r) => ({ userId: String(r.user_id), retentionDays: Number(r.retention_days) }));
  }
  async savePowerLog(deviceId: string, userId: string, payload: unknown) {
    await this.sql`INSERT INTO vm_device_power_logs (device_id, user_id, payload) VALUES (${deviceId}, ${userId}, ${this.sql.json(payload as never)})`;
  }
  async enqueueDeviceCommand(userId: string, command: string) {
    await this.sql`INSERT INTO vm_device_commands (user_id, command) VALUES (${userId}, ${command})`;
  }
  async takeDeviceCommand(userId: string) {
    const rows = await this.sql`
      UPDATE vm_device_commands SET delivered_at = now()
      WHERE id = (SELECT id FROM vm_device_commands WHERE user_id = ${userId} AND delivered_at IS NULL
                  ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING command`;
    return rows[0] ? String(rows[0].command) : null;
  }
  async getConfig<T>(key: string) {
    const rows = await this.sql`SELECT value FROM vm_config WHERE key = ${key}`;
    return rows[0] ? rows[0].value as T : null;
  }
  async putConfig(key: string, value: unknown) {
    await this.sql`INSERT INTO vm_config (key, value, updated_at) VALUES (${key}, ${this.sql.json(value as never)}, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
  }

  /* ── 检索与统计 ─────────────────────────────────────────────── */
  async searchTranscripts(query: string, limit: number, userId?: string) {
    // 用户输入里的 % 和 _ 要转义，否则"100%"会匹配任何以 100 开头的句子
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.sql`
      SELECT t.session_id, t.sequence, t.text, t.start_ms, t.end_ms,
             s.started_at, s.device_id, s.user_id
      FROM vm_transcript_segments t JOIN vm_sessions s ON s.id = t.session_id
      WHERE t.status = 'succeeded' AND t.kind = 'speech' AND t.text ILIKE ${pattern}
        AND (${userId ?? null}::text IS NULL OR s.user_id = ${userId ?? null})
      ORDER BY s.started_at DESC, t.sequence DESC LIMIT ${limit}`;
    return rows.map((r) => ({ sessionId: String(r.session_id), sequence: Number(r.sequence), text: String(r.text),
      startMs: Number(r.start_ms), endMs: Number(r.end_ms), sessionStartedAt: iso(r.started_at),
      deviceId: String(r.device_id), userId: String(r.user_id) }));
  }
  async adminStats() {
    const [r] = await this.sql`
      SELECT
        (SELECT count(*) FROM vm_users)::int AS users,
        (SELECT count(*) FROM vm_devices WHERE status = 'active')::int AS devices_active,
        (SELECT count(*) FROM vm_devices WHERE status = 'active' AND last_seen_at > now() - interval '10 minutes')::int AS devices_online,
        (SELECT count(*) FROM vm_audio_chunks WHERE uploaded_at > now() - interval '24 hours')::int AS chunks_24h,
        (SELECT coalesce(sum(duration_ms), 0) FROM vm_audio_chunks WHERE uploaded_at > now() - interval '24 hours')::bigint AS audio_ms_24h,
        (SELECT coalesce(sum(byte_length), 0) FROM vm_audio_chunks)::bigint AS audio_bytes_total,
        (SELECT count(*) FROM vm_audio_chunks WHERE transcript_status IN ('pending', 'vad', 'speech', 'asr', 'running'))::int AS transcripts_queued,
        (SELECT count(*) FROM vm_transcript_segments WHERE status = 'failed')::int AS transcripts_failed,
        (SELECT count(*) FROM vm_action_drafts WHERE status = 'pending')::int AS drafts_pending,
        (SELECT count(*) FROM vm_executions WHERE status = 'succeeded' AND created_at > now() - interval '24 hours')::int AS executions_24h,
        (SELECT count(*) FROM vm_executions WHERE status IN ('failed', 'unknown'))::int AS executions_failed,
        (SELECT max(uploaded_at) FROM vm_audio_chunks) AS last_upload_at`;
    return { users: Number(r!.users), devicesActive: Number(r!.devices_active), devicesOnline: Number(r!.devices_online),
      chunks24h: Number(r!.chunks_24h), audioMs24h: Number(r!.audio_ms_24h), audioBytesTotal: Number(r!.audio_bytes_total),
      transcriptsQueued: Number(r!.transcripts_queued), transcriptsFailed: Number(r!.transcripts_failed),
      draftsPending: Number(r!.drafts_pending), executions24h: Number(r!.executions_24h),
      executionsFailed: Number(r!.executions_failed),
      lastUploadAt: r!.last_upload_at === null ? null : iso(r!.last_upload_at) };
  }
  async listRecentExecutions(limit: number) {
    const rows = await this.sql`
      SELECT e.*, d.tool, d.title, d.user_id FROM vm_executions e
      JOIN vm_action_drafts d ON d.id = e.draft_id
      ORDER BY e.created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: String(r.id), draftId: String(r.draft_id), status: String(r.status),
      provider: String(r.provider), externalId: r.external_id === null ? null : String(r.external_id),
      error: r.error === null ? null : String(r.error), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
      tool: String(r.tool), title: String(r.title), userId: String(r.user_id) }));
  }

  /* ── 账号 ───────────────────────────────────────────────────── */
  async countUsers() {
    const rows = await this.sql`SELECT count(*)::int AS n FROM vm_users`;
    return Number(rows[0]?.n ?? 0);
  }
  async createUser(user: UserRecord) {
    await this.sql`
      INSERT INTO vm_users (id, email, display_name, password_hash, role, status, created_at, updated_at)
      VALUES (${user.id}, ${user.email}, ${user.displayName}, ${user.passwordHash},
              ${user.role}, ${user.status}, ${user.createdAt}, ${user.updatedAt})`;
    return stripPassword(user);
  }
  async getUserById(id: string) {
    const rows = await this.sql`SELECT * FROM vm_users WHERE id = ${id}`;
    return rows[0] ? mapUser(rows[0]) : null;
  }
  async getUserByEmail(email: string) {
    const rows = await this.sql`SELECT * FROM vm_users WHERE lower(email) = lower(${email})`;
    return rows[0] ? mapUser(rows[0]) : null;
  }
  async listUsers() {
    const rows = await this.sql`SELECT * FROM vm_users ORDER BY created_at`;
    return rows.map((r) => stripPassword(mapUser(r)));
  }
  async updateUser(id: string, patch: Partial<UserRecord>) {
    const current = await this.getUserById(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    await this.sql`
      UPDATE vm_users SET email = ${next.email}, display_name = ${next.displayName},
        password_hash = ${next.passwordHash}, role = ${next.role}, status = ${next.status},
        updated_at = ${next.updatedAt}
      WHERE id = ${id}`;
    return stripPassword(next);
  }

  /* ── 登录会话 ───────────────────────────────────────────────── */
  async createAuthSession(session: AuthSession) {
    await this.sql`
      INSERT INTO vm_auth_sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
      VALUES (${session.id}, ${session.userId}, ${session.createdAt}, ${session.expiresAt},
              ${session.lastSeenAt}, ${session.userAgent}, ${session.ip})`;
  }
  async getAuthSession(id: string) {
    const rows = await this.sql`SELECT * FROM vm_auth_sessions WHERE id = ${id} AND expires_at > now()`;
    const r = rows[0];
    return r ? { id: String(r.id), userId: String(r.user_id), createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at), lastSeenAt: iso(r.last_seen_at),
      userAgent: String(r.user_agent), ip: String(r.ip) } : null;
  }
  async touchAuthSession(id: string, lastSeenAt: string) {
    await this.sql`UPDATE vm_auth_sessions SET last_seen_at = ${lastSeenAt} WHERE id = ${id}`;
  }
  async deleteAuthSession(id: string) {
    await this.sql`DELETE FROM vm_auth_sessions WHERE id = ${id}`;
  }
  async deleteAuthSessionsForUser(userId: string) {
    await this.sql`DELETE FROM vm_auth_sessions WHERE user_id = ${userId}`;
  }

  /* ── 设备 ───────────────────────────────────────────────────── */
  async createDevice(device: Device, keyHash: string) {
    await this.sql`
      INSERT INTO vm_devices (id, user_id, name, key_hash, key_prefix, status, firmware,
                              last_seen_at, last_battery_pct, last_network, created_at, revoked_at)
      VALUES (${device.id}, ${device.userId}, ${device.name}, ${keyHash}, ${device.keyPrefix},
              ${device.status}, ${device.firmware}, ${device.lastSeenAt}, ${device.lastBatteryPct},
              ${device.lastNetwork}, ${device.createdAt}, ${device.revokedAt})`;
    return device;
  }
  async getDevice(id: string) {
    const rows = await this.sql`SELECT * FROM vm_devices WHERE id = ${id}`;
    return rows[0] ? mapDevice(rows[0]) : null;
  }
  async getDeviceByKeyHash(keyHash: string) {
    const rows = await this.sql`SELECT * FROM vm_devices WHERE key_hash = ${keyHash}`;
    return rows[0] ? mapDevice(rows[0]) : null;
  }
  async listDevices(userId?: string) {
    const rows = userId
      ? await this.sql`SELECT * FROM vm_devices WHERE user_id = ${userId} ORDER BY created_at`
      : await this.sql`SELECT * FROM vm_devices ORDER BY created_at`;
    return rows.map(mapDevice);
  }
  async updateDevice(id: string, patch: Partial<Device>) {
    const current = await this.getDevice(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id };
    await this.sql`
      UPDATE vm_devices SET name = ${next.name}, status = ${next.status}, firmware = ${next.firmware},
        last_seen_at = ${next.lastSeenAt}, last_battery_pct = ${next.lastBatteryPct},
        last_network = ${next.lastNetwork}, last_charging = ${next.lastCharging}, revoked_at = ${next.revokedAt},
        ota_release_id = ${next.otaReleaseId}, ota_state = ${next.otaState},
        ota_progress_pct = ${next.otaProgressPct}, ota_error = ${next.otaError},
        ota_updated_at = ${next.otaUpdatedAt}
      WHERE id = ${id}`;
    return next;
  }

  async listFavorites(userId: string) {
    const folders = await this.sql`SELECT * FROM vm_fav_folders WHERE user_id = ${userId} ORDER BY created_at`;
    const items = await this.sql`
      SELECT f.session_id, f.created_at,
             coalesce(array_agg(i.folder_id) FILTER (WHERE i.folder_id IS NOT NULL), '{}') AS folder_ids
      FROM vm_favorites f JOIN vm_sessions s ON s.id = f.session_id AND s.deleted_at IS NULL
      LEFT JOIN vm_fav_items i ON i.session_id = f.session_id
        AND i.folder_id IN (SELECT id FROM vm_fav_folders WHERE user_id = ${userId})
      WHERE f.user_id = ${userId} GROUP BY f.session_id, f.created_at ORDER BY f.created_at DESC`;
    return {
      folders: folders.map((r) => ({ id: String(r.id), userId: String(r.user_id), name: String(r.name), createdAt: iso(r.created_at),
        keywords: ((r.keywords as string[] | null) ?? []).map(String) })),
      items: items.map((r) => ({ sessionId: String(r.session_id), favoritedAt: iso(r.created_at), folderIds: (r.folder_ids as string[]).map(String) })),
    };
  }
  async setFavorite(userId: string, sessionId: string, on: boolean) {
    if (on) { await this.sql`INSERT INTO vm_favorites (user_id, session_id) VALUES (${userId}, ${sessionId}) ON CONFLICT DO NOTHING`; return; }
    await this.sql.begin(async (sql) => {
      /* 取消收藏：自动规则别再把它收回来 */
      await sql`INSERT INTO vm_fav_exclusions (folder_id, session_id)
        SELECT id, ${sessionId} FROM vm_fav_folders WHERE user_id = ${userId} ON CONFLICT DO NOTHING`;
      await sql`DELETE FROM vm_fav_items WHERE session_id = ${sessionId} AND folder_id IN (SELECT id FROM vm_fav_folders WHERE user_id = ${userId})`;
      await sql`DELETE FROM vm_favorites WHERE user_id = ${userId} AND session_id = ${sessionId}`;
    });
  }
  async createFavoriteFolder(folder: FavoriteFolder) {
    await this.sql`INSERT INTO vm_fav_folders (id, user_id, name, created_at, keywords)
      VALUES (${folder.id}, ${folder.userId}, ${folder.name}, ${folder.createdAt}, ${folder.keywords})`;
    return folder;
  }
  async renameFavoriteFolder(userId: string, id: string, name: string) {
    return (await this.sql`UPDATE vm_fav_folders SET name = ${name} WHERE id = ${id} AND user_id = ${userId} RETURNING id`).length > 0;
  }
  async deleteFavoriteFolder(userId: string, id: string) {
    return (await this.sql`DELETE FROM vm_fav_folders WHERE id = ${id} AND user_id = ${userId} RETURNING id`).length > 0;
  }
  async setFolderItem(userId: string, folderId: string, sessionId: string, on: boolean) {
    const owned = await this.sql`SELECT 1 FROM vm_fav_folders WHERE id = ${folderId} AND user_id = ${userId}`;
    if (!owned.length) return false;
    if (on) {
      await this.sql`INSERT INTO vm_favorites (user_id, session_id) VALUES (${userId}, ${sessionId}) ON CONFLICT DO NOTHING`;
      await this.sql`INSERT INTO vm_fav_items (folder_id, session_id) VALUES (${folderId}, ${sessionId}) ON CONFLICT DO NOTHING`;
      await this.sql`DELETE FROM vm_fav_exclusions WHERE folder_id = ${folderId} AND session_id = ${sessionId}`;
    } else {
      await this.sql`DELETE FROM vm_fav_items WHERE folder_id = ${folderId} AND session_id = ${sessionId}`;
      /* 手动拿出来的：自动规则以后不再放回 */
      await this.sql`INSERT INTO vm_fav_exclusions (folder_id, session_id) VALUES (${folderId}, ${sessionId}) ON CONFLICT DO NOTHING`;
    }
    return true;
  }
  async setFolderKeywords(userId: string, id: string, keywords: string[]) {
    return (await this.sql`UPDATE vm_fav_folders SET keywords = ${keywords} WHERE id = ${id} AND user_id = ${userId} RETURNING id`).length > 0;
  }
  async applyFolderRules(userId?: string) {
    const rows = await this.sql`
      WITH rules AS (
        SELECT f.id, f.user_id, array_agg('%' || replace(replace(replace(k, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%') AS pats
        FROM vm_fav_folders f, unnest(f.keywords) AS k
        WHERE cardinality(f.keywords) > 0 AND (${userId ?? null}::text IS NULL OR f.user_id = ${userId ?? null})
        GROUP BY f.id, f.user_id),
      hits AS (
        SELECT r.id AS folder_id, r.user_id, s.id AS session_id FROM rules r
        JOIN vm_sessions s ON s.user_id = r.user_id AND s.deleted_at IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM vm_fav_items i WHERE i.folder_id = r.id AND i.session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM vm_fav_exclusions x WHERE x.folder_id = r.id AND x.session_id = s.id)
          AND (EXISTS (SELECT 1 FROM vm_transcript_segments t WHERE t.session_id = s.id AND t.text ILIKE ANY (r.pats))
            OR EXISTS (SELECT 1 FROM vm_topics tp WHERE tp.session_id = s.id AND (tp.title ILIKE ANY (r.pats) OR tp.summary ILIKE ANY (r.pats))))),
      fav AS (INSERT INTO vm_favorites (user_id, session_id) SELECT DISTINCT user_id, session_id FROM hits ON CONFLICT DO NOTHING)
      INSERT INTO vm_fav_items (folder_id, session_id) SELECT folder_id, session_id FROM hits ON CONFLICT DO NOTHING RETURNING folder_id`;
    return rows.length;
  }

  async listSessionSummaries(limit: number, userId?: string, ids?: string[]) {
    const rows = await this.sql`
      SELECT s.id, s.device_id, s.started_at, s.status,
             coalesce(c.ms, 0) AS duration_ms, c.last_upload_at,
             coalesce(t.n, 0) AS topic_count, t.title,
             coalesce(d.n, 0) AS action_count, coalesce(seg.n, 0) AS sentence_count, s.boot_id
      FROM vm_sessions s
      LEFT JOIN LATERAL (SELECT sum(duration_ms) AS ms, max(uploaded_at) AS last_upload_at
                         FROM vm_audio_chunks WHERE session_id = s.id) c ON true
      LEFT JOIN LATERAL (SELECT count(*) AS n, (SELECT title FROM vm_topics WHERE session_id = s.id ORDER BY start_ms LIMIT 1) AS title
                         FROM vm_topics WHERE session_id = s.id) t ON true
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM vm_action_drafts WHERE session_id = s.id) d ON true
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM vm_transcript_segments
                         WHERE session_id = s.id AND kind = 'speech' AND status = 'succeeded') seg ON true
      WHERE (${userId ?? null}::text IS NULL OR s.user_id = ${userId ?? null}) AND s.deleted_at IS NULL
        AND (${ids ?? null}::uuid[] IS NULL OR s.id = ANY(${ids ?? null}::uuid[]))
      ORDER BY s.started_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: String(r.id), deviceId: String(r.device_id), startedAt: iso(r.started_at),
      status: String(r.status), durationMs: Number(r.duration_ms), lastUploadAt: r.last_upload_at ? iso(r.last_upload_at) : null,
      topicCount: Number(r.topic_count), title: r.title ? String(r.title) : null,
      actionCount: Number(r.action_count), sentenceCount: Number(r.sentence_count), bootId: r.boot_id ? String(r.boot_id) : null }));
  }

  /* ── 按住说话的标记 ─────────────────────────────────────────── */
  async addSpeechMark(sessionId: string, startMs: number, endMs: number) {
    await this.sql`INSERT INTO vm_speech_marks (session_id, start_ms, end_ms) VALUES (${sessionId}, ${startMs}, ${endMs})`;
  }
  async listSpeechMarks(sessionId: string) {
    const rows = await this.sql`SELECT start_ms, end_ms FROM vm_speech_marks WHERE session_id = ${sessionId}`;
    return rows.map((r) => ({ startMs: Number(r.start_ms), endMs: Number(r.end_ms) }));
  }
  async latestTalkStatus(userId: string) {
    const [m] = await this.sql`
      SELECT m.session_id, m.start_ms, m.end_ms, m.created_at FROM vm_speech_marks m JOIN vm_sessions s ON s.id = m.session_id
      WHERE s.user_id = ${userId} AND m.created_at > now() - interval '5 minutes'
      ORDER BY m.created_at DESC LIMIT 1`;
    if (!m) return null;
    const sessionId = String(m.session_id), startMs = Number(m.start_ms), endMs = Number(m.end_ms);
    const [r] = await this.sql`
      SELECT
        EXISTS (SELECT 1 FROM vm_action_drafts d WHERE d.session_id = ${sessionId}
                  AND ((d.evidence_start_ms <= ${endMs + 1000} AND coalesce(d.evidence_end_ms, d.evidence_start_ms) >= ${startMs - 1000})
                       OR (d.evidence_start_ms IS NULL AND d.created_at >= ${m.created_at as Date}))) AS done,
        /* 松手时那一块还在录（录到松手 +1.5 秒才收尾上传）：还没盖到结尾就算没传完 */
        coalesce((SELECT max(start_ms + duration_ms) FROM vm_audio_chunks WHERE session_id = ${sessionId}), 0) >= ${endMs - 2000} AS uploaded,
        EXISTS (SELECT 1 FROM vm_audio_chunks WHERE session_id = ${sessionId}
                  AND start_ms < ${endMs} AND start_ms + duration_ms > ${startMs}
                  AND transcript_status IN ('pending', 'vad', 'speech', 'asr')) AS transcribing,
        EXISTS (SELECT 1 FROM vm_transcript_segments WHERE session_id = ${sessionId}
                  AND start_ms - 1000 <= ${endMs} AND end_ms + 1000 >= ${startMs}
                  AND intent_status IN ('pending', 'running')) AS thinking`;
    const state = r!.done ? "done" as const : !r!.uploaded || r!.transcribing || r!.thinking ? "busy" as const : "none" as const;
    return { sessionId, startMs, state };
  }
  async hasSpeechMark(sessionId: string, startMs: number, endMs: number) {
    const rows = await this.sql`
      SELECT 1 FROM vm_speech_marks WHERE session_id = ${sessionId}
        AND start_ms - 1000 <= ${endMs} AND end_ms + 1000 >= ${startMs} LIMIT 1`;
    return rows.length > 0;
  }

  /* ── AI 主题与产出物 ────────────────────────────────────────── */
  async listTopics(sessionId: string) {
    return (await this.sql`SELECT * FROM vm_topics WHERE session_id = ${sessionId} ORDER BY start_ms`).map(mapTopic);
  }
  async getTopic(id: string) {
    const rows = await this.sql`SELECT * FROM vm_topics WHERE id = ${id}`;
    return rows[0] ? mapTopic(rows[0]) : null;
  }
  async listTopicLabels(userId: string) {
    const rows = await this.sql`
      SELECT t.label, count(*)::int AS n, max(s.started_at + (t.start_ms || ' milliseconds')::interval) AS last_at
      FROM vm_topics t JOIN vm_sessions s ON s.id = t.session_id
      WHERE t.user_id = ${userId} AND t.label <> '' GROUP BY 1 ORDER BY last_at DESC`;
    return rows.map((r) => ({ label: String(r.label), count: Number(r.n), lastAt: iso(r.last_at) }));
  }
  async topicsByLabel(userId: string, label: string, limit: number) {
    const rows = await this.sql`
      SELECT t.*, s.started_at FROM vm_topics t JOIN vm_sessions s ON s.id = t.session_id
      WHERE t.user_id = ${userId} AND t.label = ${label}
      ORDER BY s.started_at DESC, t.start_ms DESC LIMIT ${limit}`;
    return rows.map((r) => ({ ...mapTopic(r), sessionStartedAt: iso(r.started_at) }));
  }

  async createTopic(t: Topic) {
    await this.sql`
      INSERT INTO vm_topics (id, session_id, user_id, start_ms, end_ms, title, summary, label, source, created_at, updated_at)
      VALUES (${t.id}, ${t.sessionId}, ${t.userId}, ${t.startMs}, ${t.endMs}, ${t.title}, ${t.summary}, ${t.label ?? ""}, ${t.source}, ${t.createdAt}, ${t.updatedAt})`;
    return t;
  }
  async updateTopic(id: string, patch: Partial<Topic>) {
    const current = await this.getTopic(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id };
    await this.sql`
      UPDATE vm_topics SET start_ms = ${next.startMs}, end_ms = ${next.endMs}, title = ${next.title}, summary = ${next.summary},
        label = ${next.label ?? ""}, source = ${next.source}, updated_at = ${next.updatedAt} WHERE id = ${id}`;
    return next;
  }
  async deleteTopic(id: string) { await this.sql`DELETE FROM vm_topics WHERE id = ${id}`; }
  async replaceAiTopics(sessionId: string, fromMs: number, toMs: number, topics: Topic[]) {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM vm_topics WHERE session_id = ${sessionId} AND source = 'ai' AND start_ms >= ${fromMs} AND start_ms < ${toMs}`;
      for (const t of topics) {
        await tx`
          INSERT INTO vm_topics (id, session_id, user_id, start_ms, end_ms, title, summary, source, created_at, updated_at)
          VALUES (${t.id}, ${t.sessionId}, ${t.userId}, ${t.startMs}, ${t.endMs}, ${t.title}, ${t.summary}, ${t.source}, ${t.createdAt}, ${t.updatedAt})`;
      }
    });
  }
  async topicsForSessions(sessionIds: string[]) {
    if (!sessionIds.length) return [];
    return (await this.sql`SELECT * FROM vm_topics WHERE session_id = ANY(${sessionIds}::uuid[]) ORDER BY start_ms`).map(mapTopic);
  }
  async searchTopics(query: string, limit: number, userId?: string) {
    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.sql`
      SELECT t.*, s.started_at AS session_started_at FROM vm_topics t JOIN vm_sessions s ON s.id = t.session_id
      WHERE (t.title ILIKE ${like} OR t.summary ILIKE ${like}) AND (${userId ?? null}::text IS NULL OR t.user_id = ${userId ?? null})
      ORDER BY s.started_at DESC, t.start_ms LIMIT ${limit}`;
    return rows.map((r) => ({ ...mapTopic(r), sessionStartedAt: iso(r.session_started_at) }));
  }
  async topicCandidates() {
    const rows = await this.sql`
      SELECT s.id, s.user_id, s.started_at, s.topics_until_ms,
             max(t.end_ms) AS speech_end_ms,
             coalesce(sum(t.end_ms - t.start_ms) FILTER (WHERE t.start_ms >= s.topics_until_ms), 0) AS new_speech_ms,
             (SELECT max(c.uploaded_at) FROM vm_audio_chunks c WHERE c.session_id = s.id) AS last_upload_at
      FROM vm_sessions s JOIN vm_transcript_segments t ON t.session_id = s.id AND t.kind = 'speech' AND t.status = 'succeeded'
      GROUP BY s.id
      HAVING max(t.end_ms) > s.topics_until_ms`;
    return rows.map((r) => ({ sessionId: String(r.id), userId: String(r.user_id), startedAt: iso(r.started_at),
      topicsUntilMs: Number(r.topics_until_ms), speechEndMs: Number(r.speech_end_ms), newSpeechMs: Number(r.new_speech_ms),
      lastUploadAt: r.last_upload_at ? iso(r.last_upload_at) : iso(r.started_at) }));
  }
  async setTopicsUntil(sessionId: string, ms: number) {
    await this.sql`UPDATE vm_sessions SET topics_until_ms = ${ms} WHERE id = ${sessionId}`;
  }
  /* ── 提醒 ── */
  async createReminder(r: Reminder) {
    await this.sql`
      INSERT INTO vm_reminders (id, user_id, draft_id, title, body, remind_at, status, sent_at, acked_at, created_at)
      VALUES (${r.id}, ${r.userId}, ${r.draftId}, ${r.title}, ${r.body}, ${r.remindAt}, ${r.status},
              ${r.sentAt}, ${r.ackedAt}, ${r.createdAt})`;
    return r;
  }
  async dueReminders(nowIso: string, limit: number) {
    const rows = await this.sql`
      SELECT * FROM vm_reminders WHERE status = 'pending' AND remind_at <= ${nowIso}
      ORDER BY remind_at LIMIT ${limit}`;
    return rows.map(mapReminder);
  }
  async activeReminder(userId: string, nowIso: string, notBeforeIso = new Date(0).toISOString()) {
    /* 已推未确认的排前面：提醒就是要等到人真的看见 */
    const rows = await this.sql`
      SELECT * FROM vm_reminders
      WHERE user_id = ${userId} AND status IN ('sent', 'pending') AND remind_at <= ${nowIso}
        AND remind_at >= ${notBeforeIso}
      ORDER BY (status = 'sent') DESC, remind_at LIMIT 1`;
    return rows[0] ? mapReminder(rows[0]) : null;
  }
  async getReminder(id: string) {
    const rows = await this.sql`SELECT * FROM vm_reminders WHERE id = ${id}`;
    return rows[0] ? mapReminder(rows[0]) : null;
  }
  async updateReminder(id: string, patch: Partial<Reminder>) {
    const current = await this.getReminder(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.sql`
      UPDATE vm_reminders SET status=${next.status}, sent_at=${next.sentAt}, acked_at=${next.ackedAt},
        title=${next.title}, body=${next.body}, remind_at=${next.remindAt} WHERE id=${id}`;
    return next;
  }
  async listReminders(userId: string, limit: number) {
    const rows = await this.sql`
      SELECT * FROM vm_reminders WHERE user_id = ${userId} ORDER BY remind_at DESC LIMIT ${limit}`;
    return rows.map(mapReminder);
  }
  async cancelRemindersForDraft(draftId: string) {
    const rows = await this.sql`
      UPDATE vm_reminders SET status='cancelled' WHERE draft_id=${draftId} AND status IN ('pending','sent') RETURNING id`;
    return rows.length;
  }

  /* ── 建议 ── */
  async createSuggestions(list: Suggestion[]) {
    for (const s of list) {
      await this.sql`
        INSERT INTO vm_suggestions (id, user_id, session_id, topic_id, tool, title, detail, args, evidence,
          evidence_start_ms, evidence_end_ms, confidence, status, draft_id, created_at, updated_at)
        VALUES (${s.id}, ${s.userId}, ${s.sessionId}, ${s.topicId}, ${s.tool}, ${s.title}, ${s.detail},
                ${this.sql.json(s.args as never)}, ${s.evidence}, ${s.evidenceStartMs}, ${s.evidenceEndMs},
                ${s.confidence}, ${s.status}, ${s.draftId}, ${s.createdAt}, ${s.updatedAt})`;
    }
    return list;
  }
  async listSuggestions(userId: string, filter: { status?: string; sessionId?: string; topicIds?: string[]; sinceIso?: string; limit?: number }) {
    const rows = await this.sql`
      SELECT * FROM vm_suggestions
      WHERE user_id = ${userId}
        AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
        AND (${filter.sessionId ?? null}::uuid IS NULL OR session_id = ${filter.sessionId ?? null})
        AND (${filter.topicIds ?? null}::uuid[] IS NULL OR topic_id = ANY(${filter.topicIds ?? null}))
        AND (${filter.sinceIso ?? null}::timestamptz IS NULL OR created_at >= ${filter.sinceIso ?? null})
      ORDER BY created_at DESC LIMIT ${filter.limit ?? 100}`;
    return rows.map(mapSuggestion);
  }
  async getSuggestion(id: string) {
    const rows = await this.sql`SELECT * FROM vm_suggestions WHERE id = ${id}`;
    return rows[0] ? mapSuggestion(rows[0]) : null;
  }
  async updateSuggestion(id: string, patch: Partial<Suggestion>) {
    const current = await this.getSuggestion(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.sql`
      UPDATE vm_suggestions SET status=${next.status}, draft_id=${next.draftId}, title=${next.title},
        args=${this.sql.json(next.args as never)}, updated_at=${next.updatedAt} WHERE id=${id}`;
    return next;
  }

  /* ── 自动化 ── */
  async createAutomation(a: Automation) {
    await this.sql`
      INSERT INTO vm_automations (id, user_id, title, enabled, schedule, action, source, last_run_at, last_status, next_run_at, created_at, updated_at)
      VALUES (${a.id}, ${a.userId}, ${a.title}, ${a.enabled}, ${this.sql.json(a.schedule as never)}, ${this.sql.json(a.action as never)},
              ${a.source}, ${a.lastRunAt}, ${a.lastStatus}, ${a.nextRunAt}, ${a.createdAt}, ${a.updatedAt})`;
    return a;
  }
  async listAutomations(userId: string) {
    const rows = await this.sql`SELECT * FROM vm_automations WHERE user_id=${userId} ORDER BY next_run_at`;
    return rows.map(mapAutomation);
  }
  async getAutomation(id: string) {
    const rows = await this.sql`SELECT * FROM vm_automations WHERE id=${id}`;
    return rows[0] ? mapAutomation(rows[0]) : null;
  }
  async updateAutomation(id: string, patch: Partial<Automation>) {
    const current = await this.getAutomation(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.sql`
      UPDATE vm_automations SET title=${next.title}, enabled=${next.enabled}, schedule=${this.sql.json(next.schedule as never)},
        action=${this.sql.json(next.action as never)}, last_run_at=${next.lastRunAt}, last_status=${next.lastStatus},
        next_run_at=${next.nextRunAt}, updated_at=${next.updatedAt} WHERE id=${id}`;
    return next;
  }
  async deleteAutomation(id: string) {
    const rows = await this.sql`DELETE FROM vm_automations WHERE id=${id} RETURNING id`;
    return rows.length > 0;
  }
  async dueAutomations(nowIso: string, limit: number) {
    const rows = await this.sql`
      SELECT * FROM vm_automations WHERE enabled AND next_run_at <= ${nowIso} ORDER BY next_run_at LIMIT ${limit}`;
    return rows.map(mapAutomation);
  }

  async createOutput(o: AiOutput) {
    await this.sql`
      INSERT INTO vm_ai_outputs (id, user_id, target_type, target_id, kind, template, content, model, created_at)
      VALUES (${o.id}, ${o.userId}, ${o.targetType}, ${o.targetId}, ${o.kind}, ${o.template}, ${o.content}, ${o.model}, ${o.createdAt})`;
    return o;
  }
  async getOutput(id: string) {
    const rows = await this.sql`SELECT * FROM vm_ai_outputs WHERE id = ${id}`;
    return rows[0] ? this.outputRow(rows[0]) : null;
  }
  private outputRow(r: Record<string, unknown>): AiOutput {
    return { id: String(r.id), userId: String(r.user_id), targetType: r.target_type as AiOutput["targetType"],
      targetId: String(r.target_id), kind: r.kind as AiOutput["kind"], template: String(r.template), content: String(r.content),
      model: String(r.model), createdAt: iso(r.created_at) };
  }
  async listOutputs(targetIds: string[]) {
    if (!targetIds.length) return [];
    const rows = await this.sql`SELECT * FROM vm_ai_outputs WHERE target_id = ANY(${targetIds}::uuid[]) ORDER BY created_at DESC`;
    return rows.map((r) => ({ id: String(r.id), userId: String(r.user_id), targetType: r.target_type as AiOutput["targetType"],
      targetId: String(r.target_id), kind: r.kind as AiOutput["kind"], template: String(r.template), content: String(r.content),
      model: String(r.model), createdAt: iso(r.created_at) }));
  }

  /* ── 设备屏幕的回执与今日概况 ───────────────────────────────── */
  async deviceFeedDrafts(userId: string, sinceIso: string, receiptsSinceIso: string) {
    const rows = await this.sql`
      SELECT * FROM vm_action_drafts
      WHERE user_id = ${userId}
        AND (created_at >= ${sinceIso}
             OR (status IN ('executed','failed') AND updated_at >= ${receiptsSinceIso} AND device_dismissed_at IS NULL))
      ORDER BY created_at DESC LIMIT 40`;
    return rows.map((r) => ({ ...mapDraft(r), dismissed: r.device_dismissed_at !== null }));
  }
  async deviceFeedVersion(userId: string, sinceIso: string) {
    const [r] = await this.sql`
      SELECT count(*) AS n, max(updated_at) AS at, count(device_dismissed_at) AS gone
      FROM vm_action_drafts WHERE user_id = ${userId} AND updated_at >= ${sinceIso}`;
    return `${Number(r?.n ?? 0)}-${r?.at ? new Date(r.at as string).getTime() : 0}-${Number(r?.gone ?? 0)}`;
  }
  async dismissDraftOnDevice(userId: string, id: string) {
    const rows = await this.sql`
      UPDATE vm_action_drafts SET device_dismissed_at = now(), updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND device_dismissed_at IS NULL RETURNING id`;
    return rows.length > 0;
  }
  async dayTotals(userId: string, sinceIso: string) {
    const [a] = await this.sql`
      SELECT coalesce(sum(c.duration_ms), 0) AS ms FROM vm_audio_chunks c JOIN vm_sessions s ON s.id = c.session_id
      WHERE s.user_id = ${userId} AND c.uploaded_at >= ${sinceIso}`;
    const [b] = await this.sql`
      SELECT count(*) AS n FROM vm_transcript_segments t JOIN vm_sessions s ON s.id = t.session_id
      WHERE s.user_id = ${userId} AND t.created_at >= ${sinceIso} AND t.kind = 'speech' AND t.status = 'succeeded'`;
    return { recordedMs: Number(a?.ms ?? 0), sentences: Number(b?.n ?? 0) };
  }

  /* ── 固件与远程升级 ─────────────────────────────────────────── */
  async createFirmware(release: FirmwareRelease) {
    await this.sql`
      INSERT INTO vm_firmware_releases (id, version, project, idf_version, built_at, notes, byte_length,
                                        sha256, object_key, uploaded_at, uploaded_by, rollout, rollout_device_ids)
      VALUES (${release.id}, ${release.version}, ${release.project}, ${release.idfVersion}, ${release.builtAt},
              ${release.notes}, ${release.byteLength}, ${release.sha256}, ${release.objectKey},
              ${release.uploadedAt}, ${release.uploadedBy}, ${release.rollout},
              ${this.sql.json(release.rolloutDeviceIds as never)})`;
    return release;
  }
  async listFirmware() {
    return (await this.sql`SELECT * FROM vm_firmware_releases ORDER BY uploaded_at DESC`).map(mapFirmware);
  }
  async getFirmware(id: string) {
    const rows = await this.sql`SELECT * FROM vm_firmware_releases WHERE id = ${id}`;
    return rows[0] ? mapFirmware(rows[0]) : null;
  }
  async updateFirmware(id: string, patch: Partial<FirmwareRelease>) {
    const current = await this.getFirmware(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id };
    await this.sql`
      UPDATE vm_firmware_releases SET notes = ${next.notes}, rollout = ${next.rollout},
        rollout_device_ids = ${this.sql.json(next.rolloutDeviceIds as never)}
      WHERE id = ${id}`;
    return next;
  }
  async deleteFirmware(id: string) {
    await this.sql`DELETE FROM vm_firmware_releases WHERE id = ${id}`;
  }

  /* ── 审计 ───────────────────────────────────────────────────── */
  async appendAudit(entry: Omit<AuditEntry, "id">) {
    await this.sql`
      INSERT INTO vm_audit_log (at, actor_type, actor_id, action, target_type, target_id, detail, ip)
      VALUES (${entry.at}, ${entry.actorType}, ${entry.actorId}, ${entry.action},
              ${entry.targetType}, ${entry.targetId}, ${this.sql.json(entry.detail as never)}, ${entry.ip})`;
  }
  async listAudit(limit: number, filter?: { actorId?: string; action?: string }) {
    const rows = await this.sql`
      SELECT * FROM vm_audit_log
      WHERE (${filter?.actorId ?? null}::text IS NULL OR actor_id = ${filter?.actorId ?? null})
        AND (${filter?.action ?? null}::text IS NULL OR action = ${filter?.action ?? null})
      ORDER BY at DESC, id DESC LIMIT ${limit}`;
    return rows.map((r): AuditEntry => ({ id: String(r.id), at: iso(r.at),
      actorType: r.actor_type as AuditEntry["actorType"], actorId: String(r.actor_id),
      action: String(r.action), targetType: String(r.target_type), targetId: String(r.target_id),
      detail: (r.detail ?? {}) as Record<string, unknown>, ip: String(r.ip) }));
  }

  async getIntegration(userId: string, provider: string) {
    const rows = await this.sql`SELECT encrypted_config, updated_at FROM vm_integrations WHERE user_id=${userId} AND provider=${provider}`;
    return rows[0] ? { encryptedConfig: String(rows[0].encrypted_config), updatedAt: iso(rows[0].updated_at) } : null;
  }
  async upsertIntegration(userId: string, provider: string, encryptedConfig: string) {
    await this.sql`INSERT INTO vm_integrations (user_id, provider, encrypted_config) VALUES (${userId},${provider},${encryptedConfig})
      ON CONFLICT (user_id,provider) DO UPDATE SET encrypted_config=excluded.encrypted_config, updated_at=now()`;
  }
}

function iso(v: unknown) { return new Date(v as string | number | Date).toISOString(); }
function mapShareLink(r: Row): ShareLink {
  return { id: String(r.id), userId: String(r.user_id), sessionId: r.session_id ? String(r.session_id) : null,
    folderId: r.folder_id ? String(r.folder_id) : null, fromMs: Number(r.from_ms),
    toMs: r.to_ms === null || r.to_ms === undefined ? null : Number(r.to_ms), tokenHash: String(r.token_hash),
    createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
    lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null, uses: Number(r.uses ?? 0) };
}
function mapSession(r: Row): Session { return { id: String(r.id), deviceId: String(r.device_id), userId: String(r.user_id), status: r.status as Session["status"], startedAt: iso(r.started_at), endedAt: r.ended_at ? iso(r.ended_at) : null, bootId: r.boot_id ? String(r.boot_id) : null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }; }
function mapChunk(r: Row): AudioChunk { return { sessionId: String(r.session_id), sequence: Number(r.sequence), sha256: String(r.sha256), objectKey: String(r.object_key), contentType: String(r.content_type), byteLength: Number(r.byte_length), startMs: Number(r.start_ms), durationMs: Number(r.duration_ms), uploadedAt: iso(r.uploaded_at) }; }
function mapTranscript(r: Row): TranscriptSegment { return { sessionId: String(r.session_id), sequence: Number(r.sequence), text: String(r.text), startMs: Number(r.start_ms), endMs: Number(r.end_ms), provider: String(r.provider), status: r.status as TranscriptSegment["status"], error: r.error ? String(r.error) : null, kind: (r.kind ?? "speech") as TranscriptSegment["kind"], endSequence: r.end_sequence === null || r.end_sequence === undefined ? null : Number(r.end_sequence), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }; }
const STAGE: Record<string, ChunkStage> = { succeeded: "done", running: "pending" };
function mapChunkState(r: Row): ChunkState { const status = String(r.transcript_status); return { ...mapChunk(r), stage: STAGE[status] ?? status as ChunkStage, attempts: Number(r.transcript_attempts ?? 0), speechMs: r.vad_speech_ms === null ? null : Number(r.vad_speech_ms), vadFirstMs: r.vad_first_ms === null ? null : Number(r.vad_first_ms), vadLastMs: r.vad_last_ms === null ? null : Number(r.vad_last_ms) }; }
function mapUser(r: Row): UserRecord { return { id: String(r.id), email: String(r.email), displayName: String(r.display_name), passwordHash: String(r.password_hash), role: r.role as UserRecord["role"], status: r.status as UserRecord["status"], createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }; }
function stripPassword(u: UserRecord): User { const { passwordHash: _ignored, ...rest } = u; return rest; }
function mapDevice(r: Row): Device { return { id: String(r.id), userId: String(r.user_id), name: String(r.name), keyPrefix: String(r.key_prefix), status: r.status as Device["status"], firmware: r.firmware === null ? null : String(r.firmware), lastSeenAt: r.last_seen_at === null ? null : iso(r.last_seen_at), lastBatteryPct: r.last_battery_pct === null ? null : Number(r.last_battery_pct), lastNetwork: r.last_network === null ? null : String(r.last_network), lastCharging: r.last_charging === null || r.last_charging === undefined ? null : Boolean(r.last_charging), otaReleaseId: r.ota_release_id === null || r.ota_release_id === undefined ? null : String(r.ota_release_id), otaState: (r.ota_state ?? "idle") as Device["otaState"], otaProgressPct: Number(r.ota_progress_pct ?? 0), otaError: r.ota_error === null || r.ota_error === undefined ? null : String(r.ota_error), otaUpdatedAt: r.ota_updated_at === null || r.ota_updated_at === undefined ? null : iso(r.ota_updated_at), createdAt: iso(r.created_at), revokedAt: r.revoked_at === null ? null : iso(r.revoked_at) }; }
function mapTopic(r: Row): Topic { return { id: String(r.id), sessionId: String(r.session_id), userId: String(r.user_id), startMs: Number(r.start_ms), endMs: Number(r.end_ms), title: String(r.title), summary: String(r.summary), label: String(r.label ?? ""), source: r.source as Topic["source"], createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }; }
function mapFirmware(r: Row): FirmwareRelease { return { id: String(r.id), version: String(r.version), project: String(r.project), idfVersion: String(r.idf_version), builtAt: String(r.built_at), notes: String(r.notes), byteLength: Number(r.byte_length), sha256: String(r.sha256), objectKey: String(r.object_key), uploadedAt: iso(r.uploaded_at), uploadedBy: String(r.uploaded_by), rollout: r.rollout as FirmwareRelease["rollout"], rolloutDeviceIds: (r.rollout_device_ids as string[]) ?? [] }; }
function mapDraft(r: Row): ActionDraft { return { id: String(r.id), sessionId: String(r.session_id), userId: String(r.user_id), tool: String(r.tool), title: String(r.title), detail: String(r.detail), args: r.args as Record<string, unknown>, evidence: String(r.evidence), evidenceStartMs: r.evidence_start_ms === null ? null : Number(r.evidence_start_ms), evidenceEndMs: r.evidence_end_ms === null ? null : Number(r.evidence_end_ms), confidence: Number(r.confidence), mode: r.mode as ActionDraft["mode"], risk: r.risk as ActionDraft["risk"], status: r.status as ActionDraft["status"], revision: Number(r.revision), idempotencyKey: String(r.idempotency_key), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }; }
function mapReminder(r: Row): Reminder {
  return { id: String(r.id), userId: String(r.user_id), draftId: r.draft_id ? String(r.draft_id) : null,
    title: String(r.title), body: String(r.body ?? ""), remindAt: iso(r.remind_at),
    status: r.status as Reminder["status"], sentAt: r.sent_at ? iso(r.sent_at) : null,
    ackedAt: r.acked_at ? iso(r.acked_at) : null, createdAt: iso(r.created_at) };
}
function mapSuggestion(r: Row): Suggestion {
  return { id: String(r.id), userId: String(r.user_id), sessionId: String(r.session_id),
    topicId: r.topic_id ? String(r.topic_id) : null, tool: String(r.tool), title: String(r.title),
    detail: String(r.detail ?? ""), args: (r.args ?? {}) as Record<string, unknown>, evidence: String(r.evidence ?? ""),
    evidenceStartMs: r.evidence_start_ms === null ? null : Number(r.evidence_start_ms),
    evidenceEndMs: r.evidence_end_ms === null ? null : Number(r.evidence_end_ms),
    confidence: Number(r.confidence ?? 0.7), status: r.status as Suggestion["status"],
    draftId: r.draft_id ? String(r.draft_id) : null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
}
function mapAutomation(r: Row): Automation {
  return { id: String(r.id), userId: String(r.user_id), title: String(r.title), enabled: r.enabled !== false,
    schedule: r.schedule as Automation["schedule"], action: r.action as Automation["action"],
    source: r.source as Automation["source"], lastRunAt: r.last_run_at ? iso(r.last_run_at) : null,
    lastStatus: String(r.last_status ?? ""), nextRunAt: iso(r.next_run_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
}
function mapPolicy(r: Row): ToolPolicy { return { userId: String(r.user_id), tool: String(r.tool), confirmation: r.confirmation as ToolPolicy["confirmation"], maxDraftAgeSec: Number(r.max_draft_age_sec), notifyDevice: r.notify_device !== false,
  extract: (r.extract ?? "follow") as ToolPolicy["extract"], updatedAt: iso(r.updated_at) }; }
function mapExecution(r: Row): Execution { return { id: String(r.id), draftId: String(r.draft_id), idempotencyKey: String(r.idempotency_key), status: r.status as Execution["status"], provider: String(r.provider), externalId: r.external_id ? String(r.external_id) : null, result: r.result as Record<string, unknown>, error: r.error ? String(r.error) : null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }; }
