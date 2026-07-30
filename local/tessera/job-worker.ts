import { executeTesseraRunJob } from "./jobs";

const jobPath = process.argv[2];
const workerToken = process.argv[3];
if (!jobPath || !workerToken) {
  throw new Error(
    "A Tessera run job path and worker launch token are required.",
  );
}

await executeTesseraRunJob(jobPath, workerToken);
