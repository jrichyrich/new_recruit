/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

import {
  initializeHostedDataBundleProvider,
  createHostedObjectStoreDataBundlePersistence,
  getConfiguredDataBundleProvider,
  withDataBundleSnapshotLease,
} from "../lib/rosterpilot";

interface RosterPilotBundleObjectBody {
  text(): Promise<string>;
  etag: string;
  uploaded?: Date;
  size?: number;
}

interface RosterPilotBundleObjectMetadata {
  key: string;
  etag: string;
  uploaded: Date;
  size: number;
}

interface RosterPilotBundleObjectStore {
  get(key: string): Promise<RosterPilotBundleObjectBody | null>;
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      onlyIf?: {
        etagMatches?: string;
        etagDoesNotMatch?: string;
      };
    },
  ): Promise<RosterPilotBundleObjectMetadata | null>;
  delete(keys: string | string[]): Promise<unknown>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{
    objects: RosterPilotBundleObjectMetadata[];
    truncated: boolean;
    cursor?: string;
  }>;
}

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ROSTERPILOT_DATA_CHANNEL_URL?: string;
  ROSTERPILOT_DATA_TRUSTED_KEYS_URL?: string;
  ROSTERPILOT_DATA_TRUSTED_KEYS_JSON?: string;
  ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_MANIFEST_URL?: string;
  ROSTERPILOT_APPLICATION_ORIGIN?: string;
  ROSTERPILOT_DATA_BUNDLES?: RosterPilotBundleObjectStore;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

const DEFAULT_TRUSTED_KEYS_PATH =
  "/data-bundles/trusted-keys.json";
const DEFAULT_BOOTSTRAP_MANIFEST_PATH =
  "/data-bundles/bootstrap/manifest.json";

function jsonDocument(value: string | undefined): unknown | undefined {
  if (!value?.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function loadHostedJson(
  request: Request,
  env: Env,
  absoluteUrl: string,
): Promise<unknown | null> {
  const url = new URL(absoluteUrl);
  const requestOrigin = new URL(request.url).origin;
  const response =
    url.origin === requestOrigin
      ? await env.ASSETS.fetch(new Request(url))
      : await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Hosted data asset returned HTTP ${response.status}.`,
    );
  }
  return response.json();
}

function applicationRouteOwnsLease(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/api/data-freshness" ||
    pathname.startsWith("/api/data-freshness/") ||
    pathname === "/api/browser-engine" ||
    pathname.startsWith("/api/browser-engine/") ||
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/")
  );
}

function hostedPersistence(env: Env) {
  if (!env.ROSTERPILOT_DATA_BUNDLES) return undefined;
  const bucket = env.ROSTERPILOT_DATA_BUNDLES;
  return createHostedObjectStoreDataBundlePersistence({
    async get(key) {
      const object = await bucket.get(key);
      return object
        ? {
            value: await object.text(),
            version: object.etag,
            uploadedAt: object.uploaded?.toISOString() ?? null,
          }
        : null;
    },
    async put(key, value) {
      await bucket.put(key, value, {
        httpMetadata: { contentType: "application/json" },
      });
    },
    async compareAndSwap(key, expectedVersion, value) {
      const object = await bucket.put(key, value, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: expectedVersion
          ? { etagMatches: expectedVersion }
          : { etagDoesNotMatch: "*" },
      });
      return object !== null;
    },
    async delete(keys) {
      if (keys.length > 0) await bucket.delete([...keys]);
    },
    async list(input) {
      const page = await bucket.list(input);
      return {
        objects: page.objects.map((object) => ({
          key: object.key,
          uploadedAt: object.uploaded.toISOString(),
          size: object.size,
        })),
        cursor: page.truncated ? page.cursor : null,
      };
    },
  });
}

async function initializeWorkerDataBundles(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const origin = new URL(request.url).origin;
  return initializeHostedDataBundleProvider({
    channelUrl: env.ROSTERPILOT_DATA_CHANNEL_URL,
    bootstrapManifestUrl: new URL(
      env.ROSTERPILOT_BOOTSTRAP_DATA_BUNDLE_MANIFEST_URL ??
        DEFAULT_BOOTSTRAP_MANIFEST_PATH,
      origin,
    ).toString(),
    trustedKeysUrl: new URL(
      env.ROSTERPILOT_DATA_TRUSTED_KEYS_URL ??
        DEFAULT_TRUSTED_KEYS_PATH,
      origin,
    ).toString(),
    trustedKeysDocument: jsonDocument(
      env.ROSTERPILOT_DATA_TRUSTED_KEYS_JSON,
    ),
    loadJson: (absoluteUrl) =>
      loadHostedJson(request, env, absoluteUrl),
    scheduleBackground: (task) => ctx.waitUntil(task),
    persistence: hostedPersistence(env),
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    await initializeWorkerDataBundles(request, env, ctx);

    if (applicationRouteOwnsLease(url.pathname)) {
      return handler.fetch(request, env, ctx);
    }
    return withDataBundleSnapshotLease(() =>
      handler.fetch(request, env, ctx),
    );
  },
  scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    const origin =
      env.ROSTERPILOT_APPLICATION_ORIGIN ??
      "https://rosterpilot-worker.invalid";
    const request = new Request(
      new URL("/__rosterpilot-data-refresh", origin),
    );
    ctx.waitUntil(
      (async () => {
        await initializeWorkerDataBundles(request, env, ctx);
        const provider = getConfiguredDataBundleProvider();
        if (provider) await provider.refresh();
      })(),
    );
  },
};

export default worker;
