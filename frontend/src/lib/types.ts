/** Wire types of the dash BFF (mirrors plugin/dashboard/dash_bff/routes.py + events.py). */

export interface DashErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export interface Session {
  id: string;
  title?: string | null;
  source?: string | null;
  model?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  end_reason?: string | null;
  message_count?: number | null;
  tool_call_count?: number | null;
  last_active?: number | null;
  preview?: string | null;
  parent_session_id?: string | null;
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
  is_bot_chat: boolean;
}

export type ContentPart = { type: "text"; text: string } | { type: "image"; url: string | null };

export interface ToolCall {
  id: string | null;
  name: string;
  arguments: string;
}

export interface Message {
  id: number | string | null;
  role: "user" | "assistant" | "tool" | "system";
  content: string | ContentPart[];
  timestamp?: number | null;
  tool_name?: string;
  tool_call_id?: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
}

export interface Capabilities {
  sessions: {
    list: boolean;
    create: boolean;
    get: boolean;
    rename: boolean;
    delete: boolean;
    messages: boolean;
    fork: boolean;
    pin_archive: boolean;
    search: string;
  };
  runs: {
    submit: boolean;
    status: boolean;
    events: boolean;
    stop: boolean;
    approval: boolean;
    tool_events: boolean;
    reasoning_events: boolean;
    idempotency: boolean;
    idempotency_durable: boolean;
    resume_from_seq: boolean;
  };
  media: {
    images: string | false;
    image_max_bytes: number;
    image_max_count: number;
    image_total_max_bytes?: number;
    uploads: boolean;
    upload_max_bytes: number;
  };
  hermes: {
    model_options: boolean;
    skills: boolean;
    toolsets: boolean;
    memory_read: boolean;
    soul_read: boolean;
    mcp_status: boolean;
  };
  bot_chat: boolean;
  steer: boolean;
}

export interface Status {
  product: string;
  symbol: string;
  version: string;
  profile: string;
  launch_profile: string;
  target: { profile: string; routing: string; auth_configured: boolean };
  hermes: {
    version: string | null;
    reachable: boolean;
    model?: string | null;
    api_platform?: string;
    error?: DashErrorBody;
  };
}

export interface ProfileItem {
  name: string;
  is_default: boolean;
  is_launch: boolean;
  model: string | null;
  provider: string | null;
}

export type RunStatus =
  | "queued"
  | "started"
  | "running"
  | "waiting_for_approval"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface RunRecord {
  run_id: string;
  status: RunStatus | string;
  session_id: string | null;
  terminal: boolean;
  output?: string;
  error?: string;
  last_event?: string | null;
  approval?: RunEvent;
}

interface EventBase {
  seq: number | null;
  run_id?: string | null;
  ts?: number | null;
}

export type RunEvent =
  | (EventBase & { type: "delta"; text: string })
  | (EventBase & { type: "commentary"; text: string; already_streamed: boolean })
  | (EventBase & { type: "reasoning"; text: string })
  | (EventBase & { type: "tool"; phase: "running" | "completed" | "failed"; tool: string; preview: string; duration?: number })
  | (EventBase & { type: "subagent"; phase: "started" | "completed"; goal?: string; summary?: string; status?: string })
  | (EventBase & {
      type: "approval";
      command?: string;
      description?: string;
      pattern_key?: string;
      pattern_keys?: string[];
      request_id?: string;
      choices: ApprovalChoice[];
      smart_denied?: boolean;
    })
  | (EventBase & { type: "approval_resolved"; choice: string; request_id: string | null })
  | (EventBase & { type: "steered" })
  | (EventBase & {
      type: "run";
      status: string;
      output?: string;
      error?: string;
      completed?: boolean;
      partial?: boolean;
      interrupted?: boolean;
      turn_exit_reason?: string;
      usage?: Record<string, number>;
      runtime?: { provider?: string; model?: string };
    })
  | (EventBase & { type: "replay_truncated"; oldest_retained_seq: number | null })
  | (EventBase & { type: "stream_end" })
  | (EventBase & { type: "stream_error"; code: string; message: string; retryable: boolean; status: number })
  | (EventBase & { type: "unknown"; name: string });

export type ApprovalChoice = "once" | "session" | "always" | "deny";

export interface Preferences {
  density: "comfortable" | "compact";
  show_reasoning: boolean;
  show_tool_details: boolean;
  enter_to_send: boolean;
}

export interface ImageAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  data: string; // base64 without prefix
  previewUrl: string; // object URL for local preview only
}

export interface UploadRef {
  upload_id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ModelChoice {
  provider: string;
  model: string;
}

export interface ModelChoices {
  available: boolean;
  current: { provider: string | null; model: string | null } | null;
  providers: { provider: string; name: string; current: boolean; models: string[] }[];
}
