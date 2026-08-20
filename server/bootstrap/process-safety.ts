export function attachProcessSafetyHandlers(): void {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[process] unhandledRejection:', reason);
    void promise;
  });

  process.on('uncaughtException', (err) => {
    console.error('[process] uncaughtException:', err);
    process.exit(1);
  });
}
