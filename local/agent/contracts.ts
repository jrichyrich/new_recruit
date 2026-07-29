import type {
  ProfilePolicyV1,
} from "../../lib/rosterpilot";
import type {
  WorkerRosterExpectation,
  WorkerResult,
} from "../new-recruit/contracts";
import type {
  TesseraAnalysisMode,
  TesseraBrowserResult,
  TesseraMetric,
  TesseraPhase,
} from "../tessera/browser";

export const LOCAL_AGENT_PROTOCOL_VERSION = 5;
export const LOCAL_AGENT_VERSION = "1.4.0";
export const LOCAL_AGENT_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export type CredentialState =
  | "ready"
  | "not-configured"
  | "keychain-locked"
  | "authorization-required"
  | "unavailable";

export type LocalAgentProviderStatus = {
  providerId: "new-recruit" | "tessera";
  credentialMode: "keychain" | "not-required";
  credentialState: CredentialState;
  ready: boolean;
};

export type LocalAgentStatus = {
  available: boolean;
  version: string;
  protocolVersion: number;
  protocolCompatible: boolean;
  platform: string;
  projectDirectory: string;
  nodeExecutable: string;
  browserAvailable: boolean;
  brokerAvailable: boolean;
  brokerStatusCode?: string | null;
  activeJob: boolean;
  queuedJobs: number;
  providers: LocalAgentProviderStatus[];
};

export type LocalAgentDeliveryPayload = {
  sourceFilename: string;
  sourceRoszBase64: string;
  expected: WorkerRosterExpectation;
  downloadEnrichedRosz: boolean;
  downloadPrettyHtml: boolean;
};

export type SanitizedWorkerResult = Omit<
  WorkerResult,
  "enrichedRoszPath" | "prettyHtmlPath"
>;

export type LocalAgentDeliveryResult = {
  worker: SanitizedWorkerResult;
  enrichedRoszBase64?: string;
  prettyHtmlBase64?: string;
};

export type LocalAgentTesseraPayload = {
  playerFilename: string;
  playerRoszBase64: string;
  playerName: string;
  opponentFilename: string;
  opponentRoszBase64: string;
  opponentName: string;
  analysisMode?: TesseraAnalysisMode;
  phases?: TesseraPhase[];
  metrics?: TesseraMetric[];
  profilePolicy?: ProfilePolicyV1 | null;
  sessionId?: string;
};

export type LocalAgentTesseraResult = TesseraBrowserResult;
export type LocalAgentTesseraSessionCloseResult = {
  closed: boolean;
};

export type LocalAgentRequest =
  | {
      id: string;
      protocolVersion: number;
      operation: "agent.status";
    }
  | {
      id: string;
      protocolVersion: number;
      operation: "new-recruit.deliver";
      payload: LocalAgentDeliveryPayload;
    }
  | {
      id: string;
      protocolVersion: number;
      operation: "tessera.analyze";
      payload: LocalAgentTesseraPayload;
    }
  | {
      id: string;
      protocolVersion: number;
      operation: "tessera.session.close";
      payload: { sessionId: string };
    };

export type LocalAgentResponse =
  | {
      id: string;
      ok: true;
      protocolVersion: number;
      data:
        | LocalAgentStatus
        | LocalAgentDeliveryResult
        | LocalAgentTesseraResult
        | LocalAgentTesseraSessionCloseResult;
    }
  | {
      id: string;
      ok: false;
      protocolVersion: number;
      code: string;
      message: string;
    };
