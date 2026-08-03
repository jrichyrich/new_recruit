process.env.ROSTERPILOT_LOCAL_UPDATE_WORKER = "1";

export {};

const {
  initializeLocalDataBundleProvider,
  runQueuedLocalDataBundleUpdate,
} = await import("../local/data-bundles/configure");

await initializeLocalDataBundleProvider();
await runQueuedLocalDataBundleUpdate();
