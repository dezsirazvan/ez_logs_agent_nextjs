#!/usr/bin/env node
// CLI for `npx ezlogs-nextjs install-triggers` (also installed as the
// `install-triggers` bin).
//
// Lazy-imports the dist CJS bundle + `pg` so we don't load either when
// the customer is just installing the package. `pg` is resolved from
// the customer's project first (the directory the command runs in),
// so it works with npm, pnpm and bun layouts where `pg` isn't hoisted
// next to this package. We don't list it as a peer because only this
// CLI and the trigger reader need it.
//
// Exits non-zero on any install failure so CI scripts can catch it.

const fs = require("node:fs");
const path = require("node:path");

// The ezlogs-nextjs this project would load (nearest node_modules up
// from the working directory, so monorepo hoisting counts), or null.
function installedFromProject() {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "ezlogs-nextjs");
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

(async () => {
  const { runInstall, parseArgs } = require("../dist/triggers/index.cjs");
  const { version } = require("../package.json");

  const argv = process.argv.slice(2);
  const command = argv.find((a) => !a.startsWith("-"));
  if (command !== undefined && command !== "install-triggers") {
    console.error(
      `[ezlogs] Unknown command "${command}". Usage: npx ezlogs-nextjs install-triggers [--help]`,
    );
    process.exit(1);
  }
  const args = parseArgs(argv);

  // `npx` / `bunx` download the package to a temp dir when it isn't
  // installed in this project — a version that may differ from the one
  // your app runs, and a place `pg` can't be found from. They also do
  // it when it IS installed but the lockfile's bin metadata predates
  // the `ezlogs-nextjs` bin (seen with bun and a `file:` dependency):
  // then point at the project's own copy.
  const local = installedFromProject();
  let runLocal = null;
  if (local !== fs.realpathSync(path.join(__dirname, ".."))) {
    let hint;
    if (local) {
      let localVersion = "?";
      try {
        localVersion = JSON.parse(fs.readFileSync(path.join(local, "package.json"), "utf8")).version;
      } catch {
        /* keep "?" */
      }
      const localBin = path.join(local, "bin", "install-triggers.cjs");
      if (fs.existsSync(localBin)) {
        runLocal = `node ${JSON.stringify(path.relative(process.cwd(), localBin))} install-triggers`;
      }
      hint =
        `This project has ezlogs-nextjs ${localVersion} installed, but npx / bunx did not use it ` +
        "(usually a lockfile whose bin entries predate 0.3.0, e.g. bun with a `file:` dependency). " +
        "Run your project's copy instead:\n" +
        (runLocal ? `    ${runLocal}\n  or ` : "    ") +
        "./node_modules/.bin/ezlogs-nextjs install-triggers (./node_modules/.bin/install-triggers on older installs).";
    } else {
      hint =
        "Run it from your app's directory after `npm install ezlogs-nextjs` " +
        "(or `./node_modules/.bin/ezlogs-nextjs install-triggers`).";
    }
    console.warn(
      `[ezlogs] Running ezlogs-nextjs ${version} from ${path.dirname(__dirname)}, not from ` +
        `this project's node_modules. ${hint}`,
    );
  }

  // For --help / --print / unknown-engine paths the programmatic entry
  // doesn't need a real exec. Forward without a connection.
  if (args.help || args.print) {
    const code = await runInstall(args, { out: (l) => console.log(l) });
    process.exit(code);
  }

  let pg;
  try {
    pg = require(require.resolve("pg", { paths: [process.cwd(), __dirname] }));
  } catch {
    console.error(
      `[ezlogs] install-triggers needs the \`pg\` package, and it was not found from ${process.cwd()}.\n` +
        "  Install it in your app (the agent also needs it at runtime to read the audit log):\n" +
        "    npm install pg      (or: pnpm add pg / yarn add pg / bun add pg)\n" +
        "  then run this command again from your app's directory.\n" +
        "  Or print the SQL and run it with your own tool: npx ezlogs-nextjs install-triggers --print" +
        (runLocal ? `\n  This copy was not run from your project; try: ${runLocal}` : ""),
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
    // A statement stuck behind a long transaction would make the app's
    // writes queue behind it. Give up after 5s instead; re-running the
    // (idempotent) install finishes the job.
    await client.query("SET lock_timeout = '5s'");
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
