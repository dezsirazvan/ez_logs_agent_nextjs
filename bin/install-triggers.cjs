#!/usr/bin/env node
// CLI shim for `npx ezlogs-nextjs install-triggers`.
//
// Lazy-imports the dist CJS bundle + `pg` so we don't load either when
// the customer is just installing the package. `pg` is a devDependency
// of the agent for tests; in customer projects it's expected to be
// present transitively (drizzle-orm, prisma, etc. all pull it in) or
// the customer can install it explicitly. We don't list it as a peer
// because the only path that needs it is this CLI.
//
// Exits non-zero on any install failure so CI scripts can catch it.

(async () => {
  const { runInstall, parseArgs } = require("../dist/triggers/index.cjs");

  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // For --help / --print / unknown-engine paths the programmatic entry
  // doesn't need a real exec. Forward without a connection.
  if (args.help || args.print) {
    const code = await runInstall(args, { out: (l) => console.log(l) });
    process.exit(code);
  }

  let pg;
  try {
    pg = require("pg");
  } catch {
    console.error(
      "[ezlogs] install-triggers needs `pg` installed in your project " +
        "(it ships as a devDependency of the agent itself, not a peer). " +
        "Run `npm install --save-dev pg` and try again, or run with " +
        "--print and pipe the SQL into your own tool.",
    );
    process.exit(1);
  }

  if (!args.connection) {
    console.error(
      "[ezlogs] No connection string. Pass --connection=<url> or set " +
        "DATABASE_URL / POSTGRES_URL.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: args.connection });
  try {
    await client.connect();
  } catch (err) {
    console.error(
      `[ezlogs] Could not connect to ${args.connection}: ${err.message}`,
    );
    process.exit(1);
  }

  let exitCode = 1;
  try {
    exitCode = await runInstall(args, {
      out: (l) => console.log(l),
      exec: (sql) => client.query(sql),
      query: (sql) => client.query(sql),
    });
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
  process.exit(exitCode);
})().catch((err) => {
  console.error(`[ezlogs] install-triggers failed: ${err && err.message}`);
  process.exit(1);
});
