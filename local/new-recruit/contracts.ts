export const NEW_RECRUIT_ORIGIN = "https://www.newrecruit.eu";
export const NEW_RECRUIT_MY_LISTS = `${NEW_RECRUIT_ORIGIN}/app/MyLists`;

export type WorkerRosterExpectation = {
  name: string;
  factionName: string;
  totalPoints: number;
  units: Array<{ name: string; modelCount: number }>;
};

export type WorkerRequest = {
  action: "deliver";
  brokerPath: string;
  profileDirectory: string;
  roszPath: string;
  prettyHtmlPath: string | null;
  expected: WorkerRosterExpectation;
};

export type WorkerResult = {
  ok: boolean;
  code?: string;
  message?: string;
  imported: boolean;
  sessionReused: boolean;
  listUrl: string | null;
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
