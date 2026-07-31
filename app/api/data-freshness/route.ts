import {
  checkDataFreshnessCached,
  withDataBundleSnapshotLease,
} from "@/lib/rosterpilot";
import {
  initializeHostedDataForRequest,
} from "@/app/hosted-data-bundles";

export async function GET(request?: Request) {
  if (request) await initializeHostedDataForRequest(request);
  return withDataBundleSnapshotLease(async () =>
    Response.json(await checkDataFreshnessCached()),
  );
}
