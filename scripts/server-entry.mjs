// Reporting must run without starting the server or loading its dependencies.
if (process.argv[2] === '--report-chat') {
  process.argv.splice(2, 1)
  void import('./report-chat.mjs')
} else {
  void import('../src/server/index.ts')
}
