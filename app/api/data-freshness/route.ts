import { checkDataFreshnessCached } from "@/lib/rosterpilot";

export async function GET() {
  return Response.json(await checkDataFreshnessCached());
}
