import type {
  TesseraSimulationBackend,
  TesseraSimulationFallbackReceipt,
  TesseraSimulationProvider as TesseraSelectedSimulationBackend,
  TesseraSimulationProviderIdentity,
} from "../../lib/rosterpilot";
import type {
  TesseraBrowserInput,
  TesseraBrowserResult,
} from "./browser";
import { TESSERA_WEBSITE_ADAPTER_VERSION } from "./browser";

export type {
  TesseraSimulationBackend,
  TesseraSimulationFallbackReceipt,
  TesseraSimulationProviderIdentity,
};

export type TesseraSimulationProviderStatus = {
  backend: TesseraSelectedSimulationBackend;
  available: boolean;
  promoted: boolean;
  evaluationOnly: boolean;
  identity: TesseraSimulationProviderIdentity;
  reasonCodes: string[];
};

export type TesseraSimulationPreflight = {
  ok: boolean;
  reasonCodes: string[];
  warnings: string[];
};

export type TesseraSimulationProviderExecution<TOutput> = {
  identity: TesseraSimulationProviderIdentity;
  data: TOutput;
};

export interface TesseraSimulationProviderAdapter<TInput, TOutput> {
  readonly backend: TesseraSelectedSimulationBackend;
  getStatus():
    | TesseraSimulationProviderStatus
    | Promise<TesseraSimulationProviderStatus>;
  preflight(
    input: TInput,
  ): TesseraSimulationPreflight | Promise<TesseraSimulationPreflight>;
  run(
    input: TInput,
  ):
    | TesseraSimulationProviderExecution<TOutput>
    | Promise<TesseraSimulationProviderExecution<TOutput>>;
}

export type TesseraSimulationBackendSelection = {
  requestedBackend: TesseraSimulationBackend;
  selectedBackend: TesseraSelectedSimulationBackend;
  reason:
    | "explicit-local-engine"
    | "explicit-website"
    | "promoted-local-engine"
    | "local-provider-missing"
    | "local-input-unavailable"
    | "local-not-promoted"
    | "local-unavailable"
    | "local-preflight-failed"
    | "local-runtime-fallback";
};

export type RoutedTesseraSimulationResult<TLocalOutput, TWebsiteOutput> =
  | {
      selection: TesseraSimulationBackendSelection & {
        selectedBackend: "local-engine";
      };
      providerStatus: TesseraSimulationProviderStatus;
      identity: Extract<
        TesseraSimulationProviderIdentity,
        { provider: "local-engine" }
      >;
      data: TLocalOutput;
      fallback: null;
    }
  | {
      selection: TesseraSimulationBackendSelection & {
        selectedBackend: "website";
      };
      providerStatus: TesseraSimulationProviderStatus;
      identity: Extract<
        TesseraSimulationProviderIdentity,
        { provider: "website" }
      >;
      data: TWebsiteOutput;
      fallback: TesseraSimulationFallbackReceipt | null;
    };

export class TesseraSimulationProviderError extends Error {
  readonly code: string;
  readonly backend: TesseraSelectedSimulationBackend | null;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      backend?: TesseraSelectedSimulationBackend | null;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "TesseraSimulationProviderError";
    this.code = code;
    this.backend = options.backend ?? null;
    this.retryable = options.retryable ?? false;
  }
}

type ProviderRoute<TInput, TOutput> = {
  provider: TesseraSimulationProviderAdapter<TInput, TOutput>;
  input: TInput;
};

export type TesseraSimulationRouterRequest<
  TLocalInput,
  TLocalOutput,
  TWebsiteInput,
  TWebsiteOutput,
> = {
  requestedBackend: TesseraSimulationBackend;
  local?: ProviderRoute<TLocalInput, TLocalOutput>;
  website?: ProviderRoute<TWebsiteInput, TWebsiteOutput>;
};

function errorCode(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "TESSERA_LOCAL_ENGINE_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local Tessera engine failed without a structured error.";
}

function assertProviderIdentity(
  selectedBackend: TesseraSelectedSimulationBackend,
  identity: TesseraSimulationProviderIdentity,
): void {
  if (identity.provider !== selectedBackend) {
    throw new TesseraSimulationProviderError(
      "TESSERA_PROVIDER_IDENTITY_MISMATCH",
      `The ${selectedBackend} provider returned an identity for ${identity.provider}.`,
      { backend: selectedBackend },
    );
  }
}

async function requireRunnableRoute<TInput, TOutput>(
  route: ProviderRoute<TInput, TOutput> | undefined,
  backend: TesseraSelectedSimulationBackend,
): Promise<{
  route: ProviderRoute<TInput, TOutput>;
  status: TesseraSimulationProviderStatus;
  preflight: TesseraSimulationPreflight;
}> {
  if (!route) {
    throw new TesseraSimulationProviderError(
      "TESSERA_PROVIDER_NOT_CONFIGURED",
      `The ${backend} Tessera provider is not configured.`,
      { backend },
    );
  }
  if (route.provider.backend !== backend) {
    throw new TesseraSimulationProviderError(
      "TESSERA_PROVIDER_ROUTE_MISMATCH",
      `The ${backend} route was bound to ${route.provider.backend}.`,
      { backend },
    );
  }
  const status = await route.provider.getStatus();
  if (status.backend !== backend) {
    throw new TesseraSimulationProviderError(
      "TESSERA_PROVIDER_STATUS_MISMATCH",
      `The ${backend} provider returned status for ${status.backend}.`,
      { backend },
    );
  }
  if (!status.available) {
    throw new TesseraSimulationProviderError(
      "TESSERA_PROVIDER_UNAVAILABLE",
      `The ${backend} Tessera provider is unavailable${
        status.reasonCodes.length > 0
          ? ` (${status.reasonCodes.join(", ")})`
          : ""
      }.`,
      { backend, retryable: backend === "website" },
    );
  }
  const preflight = await route.provider.preflight(route.input);
  if (!preflight.ok) {
    throw new TesseraSimulationProviderError(
      "TESSERA_PROVIDER_PREFLIGHT_FAILED",
      `The ${backend} Tessera provider rejected the complete input${
        preflight.reasonCodes.length > 0
          ? ` (${preflight.reasonCodes.join(", ")})`
          : ""
      }.`,
      { backend },
    );
  }
  return { route, status, preflight };
}

async function executeRoute<TInput, TOutput>(
  route: ProviderRoute<TInput, TOutput>,
  status: TesseraSimulationProviderStatus,
): Promise<{
  providerStatus: TesseraSimulationProviderStatus;
  identity: TesseraSimulationProviderIdentity;
  data: TOutput;
}> {
  const execution = await route.provider.run(route.input);
  assertProviderIdentity(route.provider.backend, execution.identity);
  return {
    providerStatus: status,
    identity: execution.identity,
    data: execution.data,
  };
}

/**
 * Selects exactly one provider for a complete simulation request. Auto mode is
 * deliberately conservative: an evaluation-only or merely available local
 * engine is never selected unless its exact identity is marked promoted.
 */
export async function routeTesseraSimulation<
  TLocalInput,
  TLocalOutput,
  TWebsiteInput,
  TWebsiteOutput,
>(
  request: TesseraSimulationRouterRequest<
    TLocalInput,
    TLocalOutput,
    TWebsiteInput,
    TWebsiteOutput
  >,
): Promise<RoutedTesseraSimulationResult<TLocalOutput, TWebsiteOutput>> {
  if (request.requestedBackend === "local-engine") {
    const local = await requireRunnableRoute(
      request.local,
      "local-engine",
    );
    const execution = await executeRoute(local.route, local.status);
    return {
      selection: {
        requestedBackend: "local-engine",
        selectedBackend: "local-engine",
        reason: "explicit-local-engine",
      },
      providerStatus: execution.providerStatus,
      identity: execution.identity as Extract<
        TesseraSimulationProviderIdentity,
        { provider: "local-engine" }
      >,
      data: execution.data,
      fallback: null,
    };
  }

  if (request.requestedBackend === "website") {
    const website = await requireRunnableRoute(request.website, "website");
    const execution = await executeRoute(website.route, website.status);
    return {
      selection: {
        requestedBackend: "website",
        selectedBackend: "website",
        reason: "explicit-website",
      },
      providerStatus: execution.providerStatus,
      identity: execution.identity as Extract<
        TesseraSimulationProviderIdentity,
        { provider: "website" }
      >,
      data: execution.data,
      fallback: null,
    };
  }

  let autoReason: TesseraSimulationBackendSelection["reason"] =
    "local-provider-missing";
  let localStatus: TesseraSimulationProviderStatus | null = null;
  let localPreflight: TesseraSimulationPreflight | null = null;
  if (request.local) {
    localStatus = await request.local.provider.getStatus();
    if (!localStatus.promoted) {
      autoReason = "local-not-promoted";
    } else if (!localStatus.available) {
      autoReason = "local-unavailable";
    } else {
      localPreflight = await request.local.provider.preflight(
        request.local.input,
      );
      if (!localPreflight.ok) {
        autoReason = "local-preflight-failed";
      } else {
        try {
          const execution = await executeRoute(
            request.local,
            localStatus,
          );
          return {
            selection: {
              requestedBackend: "auto",
              selectedBackend: "local-engine",
              reason: "promoted-local-engine",
            },
            providerStatus: execution.providerStatus,
            identity: execution.identity as Extract<
              TesseraSimulationProviderIdentity,
              { provider: "local-engine" }
            >,
            data: execution.data,
            fallback: null,
          };
        } catch (error) {
          if (!request.website) throw error;
          const website = await requireRunnableRoute(
            request.website,
            "website",
          );
          const execution = await executeRoute(
            website.route,
            website.status,
          );
          return {
            selection: {
              requestedBackend: "auto",
              selectedBackend: "website",
              reason: "local-runtime-fallback",
            },
            providerStatus: execution.providerStatus,
            identity: execution.identity as Extract<
              TesseraSimulationProviderIdentity,
              { provider: "website" }
            >,
            data: execution.data,
            fallback: {
              from: "local-engine",
              to: "website",
              code: errorCode(error),
              message: errorMessage(error),
              discardedLocalEvidence: true,
            },
          };
        }
      }
    }
  } else if (request.local === undefined) {
    autoReason = "local-provider-missing";
  } else {
    autoReason = "local-input-unavailable";
  }

  const website = await requireRunnableRoute(request.website, "website");
  const execution = await executeRoute(website.route, website.status);
  return {
    selection: {
      requestedBackend: "auto",
      selectedBackend: "website",
      reason: autoReason,
    },
    providerStatus: execution.providerStatus,
    identity: execution.identity as Extract<
      TesseraSimulationProviderIdentity,
      { provider: "website" }
    >,
    data: execution.data,
    fallback: null,
  };
}

export type WebsiteTesseraProviderOptions = {
  available?: boolean;
  reasonCodes?: string[];
};

/** Wraps the existing browser/local-agent function without changing its contract. */
export function createWebsiteTesseraProvider(
  runWebsite: (input: TesseraBrowserInput) => Promise<TesseraBrowserResult>,
  options: WebsiteTesseraProviderOptions = {},
): TesseraSimulationProviderAdapter<
  TesseraBrowserInput,
  TesseraBrowserResult
> {
  const baseIdentity: Extract<
    TesseraSimulationProviderIdentity,
    { provider: "website" }
  > = {
    schemaVersion: 1,
    provider: "website",
    engine: "tessera-ui",
    uiIdentity: null,
    adapterVersion: TESSERA_WEBSITE_ADAPTER_VERSION,
  };
  const status: TesseraSimulationProviderStatus = {
    backend: "website",
    available: options.available ?? true,
    promoted: true,
    evaluationOnly: false,
    identity: baseIdentity,
    reasonCodes: [...(options.reasonCodes ?? [])],
  };
  return {
    backend: "website",
    getStatus: () => structuredClone(status),
    preflight: () => ({ ok: true, reasonCodes: [], warnings: [] }),
    async run(input) {
      const data = await runWebsite(input);
      return {
        identity: {
          ...baseIdentity,
          uiIdentity: data.uiIdentity ?? null,
        },
        data,
      };
    },
  };
}
