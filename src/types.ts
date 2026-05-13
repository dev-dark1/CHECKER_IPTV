export type Language = "en" | "ar";

export type Verdict = "active" | "dead";
export type PlayerStatus =
  | "working_player"
  | "dead_stream"
  | "buffering"
  | "blocked_stream"
  | "timeout"
  | "expired"
  | "not_tested";

export type CheckerStatus =
  | "active"
  | "invalid"
  | "unauthorized"
  | "unreachable"
  | "error"
  | "not_found"
  | "failed"
  | "checking";

export interface CheckResult {
  url: string;
  status: CheckerStatus | string;
  verdict: Verdict;
  checkerStatus: string;
  httpCode: number | null;
  timeMs: number | null;
  message: string;
  xtreamApiUrl: string | null;
  account: AccountInfo | null;
  stream: StreamValidation;
}

export interface AccountInfo {
  userInfo: Record<string, unknown>;
  status: string | null;
  expDate: string | null;
  expTimestamp: number | null;
  remainingDays: number | null;
  isExpired: boolean | null;
  isTrial: boolean | null;
  activeConnections: number | null;
  maxConnections: number | null;
}

export interface StreamValidation {
  status: PlayerStatus;
  streamUrl: string | null;
  streamName: string | null;
  httpCode: number | null;
  contentType: string | null;
  responseMs: number | null;
  previewUrl: string | null;
  message: string;
}

export interface ExtractionSummary {
  links: string[];
  rawMatches: number;
  duplicatesRemoved: number;
  invalidRemoved: number;
  nonEmptyLineCount: number;
}

export interface ConsoleEntry {
  id: string;
  tone: "info" | "success" | "error" | "warn";
  text: string;
}
