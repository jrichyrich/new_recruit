export const NEW_RECRUIT_ORIGIN = "https://www.newrecruit.eu";
export const NEW_RECRUIT_MY_LISTS = `${NEW_RECRUIT_ORIGIN}/app/MyLists`;

export type WorkerRosterExpectation = {
  name: string;
  factionName: string;
  totalPoints: number;
  units: Array<{ name: string; modelCount: number }>;
};

export type WorkerDeliveryRequest = {
  action: "deliver";
  brokerPath: string;
  profileDirectory: string;
  roszPath: string;
  enrichedRoszPath?: string | null;
  prettyHtmlPath: string | null;
  expected: WorkerRosterExpectation;
};

export type WorkerProbeRequest = {
  action: "probe";
  brokerPath: string;
  profileDirectory: string;
};

export type WorkerRequest =
  | WorkerDeliveryRequest
  | WorkerProbeRequest;

export type WorkerProbeResult = {
  ok: boolean;
  code?: string;
  message?: string;
  /**
   * SHA-256 of safe UI build metadata observed only after authentication.
   */
  uiIdentity: string | null;
  sessionReused: boolean;
  importControlVisible: boolean;
};

export type WorkerResult = {
  ok: boolean;
  code?: string;
  message?: string;
  /**
   * The worker response was lost or malformed after dispatch, so callers
   * cannot safely conclude that no remote import occurred.
   */
  remoteOutcomeUnknown?: boolean;
  /**
   * SHA-256 of safe UI build metadata only. Raw script URLs, page content,
   * credentials, and browser state never cross the worker boundary.
   */
  uiIdentity?: string | null;
  imported: boolean;
  sessionReused: boolean;
  listUrl: string | null;
  enrichedRoszPath: string | null;
  prettyHtmlPath: string | null;
  verification: {
    name: boolean;
    faction: boolean;
    points: boolean;
    units: Array<{ name: string; modelCount: number; matched: boolean }>;
    mismatches: string[];
  } | null;
};

export type BrokerCredentials = {
  username: string;
  password: string;
};
