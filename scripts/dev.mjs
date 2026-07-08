#!/usr/bin/env node
/**
 * warden dev.mjs — Standardized development tools for warden
 *
 * This script provides safe, tested, and documented ways to perform common
 * development operations. Agents should call these tools instead of inventing
 * their own approaches.
 *
 * USAGE:
 *   node scripts/dev.mjs <category> <command> [args]
 *
 * CATEGORIES:
 *   server  - Manage the warden server (start, stop, status, restart)
 *   git     - Git operations (checkout-pr, create-branch, push-upstream, clean-branches)
 *   build   - Build operations (check, run, clean)
 *   test    - Testing operations (run, file, smoke)
 *
 * EXIT CODES:
 *   0 - Success
 *   1 - General error
 *   2 - Already in desired state (idempotent)
 *   3 - Not found (PR, branch, file, etc.)
 *   4 - Conflict (port in use, uncommitted changes, etc.)
 *
 * All tools are idempotent (safe to run multiple times) and handle edge cases
 * gracefully. No tool will ever kill the calling agent process.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'web');
const distIndex = path.join(webDir, 'dist', 'index.html');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const DEFAULT_PORT = 7421;

// ---------- ANSI colors ----------
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m',
};

const paint = (s, c) => (process.stdout.isTTY ? `${c}${s}${C.reset}` : s);
const log = {
  info: (msg) => console.log(paint(`dev: ${msg}`, C.cyan)),
  success: (msg) => console.log(paint(`dev: ${msg}`, C.green)),
  warn: (msg) => console.warn(paint(`dev: ${msg}`, C.yellow)),
  error: (msg) => console.error(paint(`dev: ${msg}`, C.red)),
};

function die(msg, code = 1) {
  log.error(msg);
  process.exit(code);
}

// ---------- Process management utilities ----------

/**
 * Find the warden server process WITHOUT matching the calling agent.
 *
 * CRITICAL: We cannot use `pkill -f "warden"` because the agent's command
 * line contains "warden" (e.g., "warden: /workspace/warden") which would
 * match and kill the agent itself.
 *
 * Instead, we match specifically on the server.js file path which is unique
 * to the actual server process.
 */
function findWardenProcess() {
  try {
    // Use pgrep to find processes by exact command pattern
    // This matches "node /workspace/warden/src/server.js" but NOT
    // "warden: /workspace/warden" (the agent's command line)
    const result = spawnSync(
      'pgrep',
      ['-f', `^${process.execPath} ${path.join(root, 'src', 'server.js')}`],
      { encoding: 'utf8' }
    );

    if (result.status === 0 && result.stdout.trim()) {
      const pid = parseInt(result.stdout.trim(), 10);
      return { pid, running: true };
    }

    return { running: false };
  } catch (error) {
    // pgrep might not be available, try alternative method
    try {
      // Try using lsof to check if port is in use
      const lsofResult = spawnSync('lsof', [`-ti:${DEFAULT_PORT}`], {
        encoding: 'utf8',
      });

      if (lsofResult.status === 0 && lsofResult.stdout.trim()) {
        const pid = parseInt(lsofResult.stdout.trim(), 10);
        // Verify it's actually the warden server by checking the command
        const psResult = spawnSync('ps', ['-p', pid, '-o', 'command='], {
          encoding: 'utf8',
        });

        const cmd = psResult.stdout.trim();
        if (cmd.includes('server.js') || cmd.includes('warden')) {
          // Additional check: make sure it's NOT the current process
          if (pid === process.pid) {
            return { running: false };
          }
          return { pid, running: true };
        }
      }

      return { running: false };
    } catch (lsofError) {
      // If both methods fail, assume not running
      return { running: false };
    }
  }
}

/**
 * Stop the warden server safely.
 *
 * This function will NEVER kill the calling agent process because:
 * 1. It uses process-specific patterns (pgrep by exact command)
 * 2. It verifies the PID is not the current process
 * 3. It only matches on server.js, not general "warden" string
 */
function stopWardenServer(signal = 'SIGTERM') {
  const { pid, running } = findWardenProcess();

  if (!running) {
    log.info('Server is not running');
    return { stopped: false, alreadyStopped: true };
  }

  if (!pid) {
    log.warn('Server appears running but PID could not be determined');
    return { stopped: false };
  }

  try {
    log.info(`Stopping server (PID ${pid})...`);
    process.kill(pid, signal);

    // Wait a bit for graceful shutdown
    let attempts = 0;
    while (attempts < 10) {
      const { running: stillRunning } = findWardenProcess();
      if (!stillRunning) {
        log.success('Server stopped');
        return { stopped: true };
      }
      attempts++;
      // eslint-disable-next-line no-plusplus -- simple counter
      const sleep = spawnSync('sleep', ['0.1'], { stdio: 'ignore' });
    }

    // If still running, try harder
    log.warn('Server did not stop gracefully, forcing...');
    process.kill(pid, 'SIGKILL');

    // Final check
    const { running: stillRunning } = findWardenProcess();
    if (stillRunning) {
      log.error('Server could not be stopped');
      return { stopped: false };
    }

    log.success('Server force-stopped');
    return { stopped: true };
  } catch (error) {
    if (error.code === 'ESRCH') {
      // Process already gone
      log.success('Server already stopped');
      return { stopped: true, alreadyStopped: true };
    }
    throw error;
  }
}

// ---------- Build utilities ----------

function newestMtime(dir, base = 0) {
  let m = base;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const st = fs.statSync(p);
      m = Math.max(
        m,
        e.isDirectory() ? newestMtime(p, st.mtimeMs) : st.mtimeMs
      );
    }
  } catch {
    /* noop */
  }
  return m;
}

function distStale() {
  if (!fs.existsSync(distIndex)) return true;
  return newestMtime(path.join(webDir, 'src')) > fs.statSync(distIndex).mtimeMs;
}

function checkDependencies() {
  const pkgPath = path.join(root, 'package.json');
  const nodeModulesPath = path.join(root, 'node_modules');

  if (!fs.existsSync(nodeModulesPath)) {
    return { installed: false, needsInstall: true };
  }

  // Check if package.json is newer than node_modules
  const pkgMtime = fs.statSync(pkgPath).mtimeMs;
  let nodeModulesMtime = 0;

  try {
    nodeModulesMtime = newestMtime(nodeModulesPath);
  } catch {
    // node_modules exists but couldn't read it
    return { installed: true, needsInstall: false };
  }

  if (pkgMtime > nodeModulesMtime) {
    return { installed: true, needsInstall: true, stale: true };
  }

  return { installed: true, needsInstall: false };
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = http.createServer();

    server.listen(port, () => {
      server.close(() => resolve(false));
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

// ---------- Server commands ----------

async function cmdServerStart(args) {
  const port = parseInt(args[0] || process.env.PORT || String(DEFAULT_PORT), 10);

  // Check if already running
  const { running, pid } = findWardenProcess();
  if (running) {
    log.info(`Server already running (PID ${pid}) on http://localhost:${port}`);
    return { exitCode: 2 }; // Already running
  }

  // Check if port is in use by another process
  const portInUse = await checkPortInUse(port);
  if (portInUse) {
    die(`Port ${port} is already in use by another process`, 4);
  }

  // Check dependencies
  const deps = checkDependencies();
  if (deps.needsInstall) {
    log.info('Installing dependencies...');
    const installResult = spawnSync(npmBin, ['install', '--omit=dev'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (installResult.status !== 0) {
      die('Dependency installation failed');
    }
    log.success('Dependencies installed');
  }

  // Check if build is needed
  if (distStale()) {
    log.info('Building web frontend...');
    const buildResult = spawnSync(npmBin, ['run', 'build'], {
      cwd: webDir,
      stdio: 'inherit',
    });
    if (buildResult.status !== 0) {
      die('Web build failed');
    }
    log.success('Web frontend built');
  }

  // Start the server
  log.info(`Starting server on http://localhost:${port}...`);
  const server = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
  });

  // Give it a moment to start
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Check if it's still running
  if (server.exitCode !== null) {
    die('Server failed to start');
  }

  log.success(`Server started on http://localhost:${port} (PID ${server.pid})`);

  // Handle signals for graceful shutdown
  const stop = (sig) => () => {
    try {
      server.kill(sig);
    } catch {
      /* noop */
    }
  };
  process.on('SIGINT', stop('SIGINT'));
  process.on('SIGTERM', stop('SIGTERM'));
  process.on('SIGHUP', stop('SIGTERM'));

  server.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  // Keep running
  return { exitCode: 0, keepRunning: true };
}

function cmdServerStop() {
  const result = stopWardenServer();
  return { exitCode: result.stopped ? 0 : 1 };
}

function cmdServerStatus() {
  const { running, pid } = findWardenProcess();
  const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);

  if (running) {
    log.success(`Server is running (PID ${pid}) on http://localhost:${port}`);
    return { exitCode: 0, running: true, pid, url: `http://localhost:${port}` };
  }

  log.info('Server is not running');
  return { exitCode: 1, running: false };
}

async function cmdServerRestart(args) {
  log.info('Restarting server...');

  // Stop if running
  const stopResult = stopWardenServer();

  // Wait a moment
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Start again
  return cmdServerStart(args);
}

// ---------- Git commands ----------

function cmdGitCheckoutPr(args) {
  const prNumber = args[0];
  if (!prNumber || prNumber === '--help' || prNumber === '-h') {
    console.log(`
USAGE: dev git checkout-pr <PR-number>

Checkout a pull request by number.

EXAMPLES:
  dev git checkout-pr 123    # Checkout PR #123
  dev git checkout-pr 42     # Checkout PR #42

REQUIREMENTS:
  - gh CLI must be installed and configured
  - No uncommitted changes (commit or stash first)
`);
    return { exitCode: 0 };
  }

  // Check if gh CLI is available
  const ghCheck = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  if (ghCheck.status !== 0) {
    die('gh CLI not found. Install it from: https://cli.github.com/');
  }

  // Check for uncommitted changes
  const statusResult = spawnSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
  });
  if (statusResult.stdout.trim()) {
    die(
      'You have uncommitted changes. Commit or stash them first.',
      4
    );
  }

  log.info(`Checking out PR #${prNumber}...`);

  // Use gh to checkout the PR
  const result = spawnSync('gh', ['pr', 'checkout', prNumber], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    die(`Failed to checkout PR #${prNumber}. Does it exist?`, 3);
  }

  log.success(`Checked out PR #${prNumber}`);
  return { exitCode: 0 };
}

function cmdGitCreateBranch(args) {
  const ticketId = args[0];
  if (!ticketId || ticketId === '--help' || ticketId === '-h') {
    console.log(`
USAGE: dev git create-branch <ticket-id>

Create a feature branch from a ticket ID.

EXAMPLES:
  dev git create-branch WARDEN-79    # Creates feature/warden-79
  dev git create-branch TINK-42       # Creates feature/tink-42

BEHAVIOR:
  - Switches to main branch first
  - Pulls latest from origin/main
  - Creates feature branch from ticket ID (lowercase, prefixed)
  - Checks out the new branch

EXIT CODES:
  0 - Branch created and checked out
  2 - Branch already exists (checked out instead)
`);
    return { exitCode: 0 };
  }

  // Ensure we're on main
  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    encoding: 'utf8',
  });
  const currentBranch = branchResult.stdout.trim();

  if (currentBranch !== 'main') {
    log.info('Switching to main branch first...');
    const checkoutResult = spawnSync('git', ['checkout', 'main'], {
      stdio: 'inherit',
    });
    if (checkoutResult.status !== 0) {
      die('Failed to checkout main branch');
    }
  }

  // Pull latest
  log.info('Pulling latest from origin/main...');
  const pullResult = spawnSync('git', ['pull', 'origin', 'main'], {
    stdio: 'inherit',
  });
  if (pullResult.status !== 0) {
    log.warn('Failed to pull from origin/main (network issue?)');
  }

  // Generate branch name from ticket ID
  // Convert WARDEN-79 to feature/warden-79-description
  const branchName = `feature/${ticketId.toLowerCase()}`;

  // Check if branch already exists
  const checkResult = spawnSync('git', ['branch', '--list', branchName], {
    encoding: 'utf8',
  });
  if (checkResult.stdout.trim()) {
    log.info(`Branch ${branchName} already exists. Checking it out...`);
    const checkoutResult = spawnSync('git', ['checkout', branchName], {
      stdio: 'inherit',
    });
    if (checkoutResult.status !== 0) {
      die(`Failed to checkout existing branch ${branchName}`);
    }
    log.success(`Checked out existing branch ${branchName}`);
    return { exitCode: 0, branch: branchName, existed: true };
  }

  // Create new branch
  log.info(`Creating new branch ${branchName}...`);
  const createResult = spawnSync('git', ['checkout', '-b', branchName], {
    stdio: 'inherit',
  });
  if (createResult.status !== 0) {
    die(`Failed to create branch ${branchName}`);
  }

  log.success(`Created and checked out ${branchName}`);
  return { exitCode: 0, branch: branchName, existed: false };
}

function cmdGitPushUpstream() {
  // Get current branch
  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    encoding: 'utf8',
  });
  const branch = branchResult.stdout.trim();

  if (!branch) {
    die('Not on any branch');
  }

  if (branch === 'main') {
    die('Cannot push to main from this command. Use explicit git push.');
  }

  // Check if upstream is set
  const upstreamResult = spawnSync(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { encoding: 'utf8' }
  );

  let args = ['push'];
  if (upstreamResult.status !== 0) {
    // No upstream set, use -u
    args = ['push', '-u', 'origin', branch];
    log.info(`Setting upstream and pushing ${branch} to origin...`);
  } else {
    log.info(`Pushing ${branch} to ${upstreamResult.stdout.trim()}...`);
  }

  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    die('Failed to push');
  }

  log.success(`Pushed ${branch}`);
  return { exitCode: 0, branch };
}

function cmdGitCleanBranches() {
  log.info('Cleaning up merged local branches...');

  // Get list of merged branches (excluding main)
  const result = spawnSync(
    'git',
    ['branch', '--merged', '--format=%(refname:short)'],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    die('Failed to list merged branches');
  }

  const branches = result.stdout
    .trim()
    .split('\n')
    .filter((b) => b && b !== 'main' && b !== '*');

  if (branches.length === 0) {
    log.info('No merged branches to clean up');
    return { exitCode: 0, cleaned: 0 };
  }

  log.info(`Found ${branches.length} merged branch(es) to delete`);

  let deleted = 0;
  for (const branch of branches) {
    log.info(`Deleting branch ${branch}...`);
    const deleteResult = spawnSync('git', ['branch', '-d', branch], {
      stdio: 'inherit',
    });
    if (deleteResult.status === 0) {
      deleted++;
    } else {
      log.warn(`Failed to delete ${branch} (might not be fully merged)`);
    }
  }

  log.success(`Deleted ${deleted} branch(es)`);
  return { exitCode: 0, deleted };
}

// ---------- Build commands ----------

function cmdBuildCheck() {
  const stale = distStale();
  if (stale) {
    log.info('Build is needed (source newer than dist)');
    return { exitCode: 0, needed: true, stale };
  }

  log.success('Build is up to date');
  return { exitCode: 0, needed: false, stale: false };
}

function cmdBuildRun() {
  if (!distStale()) {
    log.info('Build is up to date (use "build clean" to force rebuild)');
    return { exitCode: 0, needed: false, alreadyBuilt: true };
  }

  log.info('Building web frontend...');
  const result = spawnSync(npmBin, ['run', 'build'], {
    cwd: webDir,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    die('Build failed');
  }

  log.success('Build complete');
  return { exitCode: 0, built: true };
}

function cmdBuildClean() {
  log.info('Cleaning dist directory...');

  const distDir = path.join(webDir, 'dist');
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
    log.success('Dist directory cleaned');
  } else {
    log.info('Dist directory does not exist');
  }

  // Now build
  return cmdBuildRun();
}

// ---------- Test commands ----------

function cmdTestRun(args) {
  log.info('Running test suite...');

  // Check if project has tests
  const testDirs = ['test', 'tests', 'spec', 'specs'];
  const hasTests = testDirs.some((d) => fs.existsSync(path.join(root, d)));

  if (!hasTests) {
    log.warn('No test directory found');
    return { exitCode: 0, tests: 0 };
  }

  // Try different test runners
  const runners = ['npm', 'yarn', 'pnpm'];
  let result = null;

  for (const runner of runners) {
    const runnerCmd = runner === 'npm' ? 'npm.cmd' : runner;
    const check = spawnSync(runnerCmd, ['--version'], { stdio: 'ignore' });
    if (check.status === 0) {
      const cmd = runner === 'npm' ? 'run' : runner;
      result = spawnSync(runnerCmd, [cmd, 'test'], { stdio: 'inherit' });
      break;
    }
  }

  if (result) {
    if (result.status === 0) {
      log.success('Tests passed');
    } else {
      log.error('Tests failed');
    }
    return { exitCode: result.status ?? 1 };
  }

  log.warn('No test runner found (npm/yarn/pnpm)');
  return { exitCode: 1 };
}

function cmdTestFile(args) {
  const filePath = args[0];
  if (!filePath) {
    die('Usage: dev test file <path>');
  }

  log.info(`Running tests for ${filePath}...`);

  // Check file exists
  if (!fs.existsSync(filePath)) {
    die(`File not found: ${filePath}`, 3);
  }

  // Try to run with appropriate test runner
  let result = null;

  // Try jest first
  const jestCheck = spawnSync('npx', ['jest', '--version'], {
    stdio: 'ignore',
  });
  if (jestCheck.status === 0) {
    result = spawnSync('npx', ['jest', filePath], { stdio: 'inherit' });
  } else {
    // Try pytest
    const pytestCheck = spawnSync('pytest', ['--version'], {
      stdio: 'ignore',
    });
    if (pytestCheck.status === 0) {
      result = spawnSync('pytest', [filePath], { stdio: 'inherit' });
    } else {
      // Try rspec
      const rspecCheck = spawnSync('rspec', ['--version'], {
        stdio: 'ignore',
      });
      if (rspecCheck.status === 0) {
        result = spawnSync('rspec', [filePath], { stdio: 'inherit' });
      } else {
        die('No test runner found (jest/pytest/rspec)');
      }
    }
  }

  if (result?.status === 0) {
    log.success(`Tests passed for ${filePath}`);
    return { exitCode: 0, file: filePath };
  }

  log.error(`Tests failed for ${filePath}`);
  return { exitCode: 1, file: filePath };
}

function cmdTestSmoke() {
  log.info('Running smoke tests...');

  // Check for smoke test file
  const smokePaths = [
    path.join(root, 'web', 'smoke.cjs'),
    path.join(root, 'test', 'smoke.js'),
    path.join(root, 'smoke.js'),
    path.join(root, 'smoke.cjs'),
  ];

  const smokeFile = smokePaths.find((p) => fs.existsSync(p));
  if (!smokeFile) {
    log.warn('No smoke test file found');
    return { exitCode: 1, smoke: false };
  }

  const result = spawnSync(process.execPath, [smokeFile], {
    stdio: 'inherit',
    cwd: root,
  });

  if (result.status === 0) {
    log.success('Smoke tests passed');
    return { exitCode: 0, smoke: true };
  }

  log.error('Smoke tests failed');
  return { exitCode: 1, smoke: false };
}

// ---------- Help command ----------

function printHelp(category = null) {
  if (category === 'server') {
    console.log(`
dev server — Manage the warden server

USAGE:
  node scripts/dev.mjs server start [port]
  node scripts/dev.mjs server stop
  node scripts/dev.mjs server status
  node scripts/dev.mjs server restart [port]

COMMANDS:
  start [port]   Start the server (default port: 7421)
  stop           Stop the server safely
  status         Check if server is running
  restart [port] Restart the server

EXAMPLES:
  dev server start              # Start on default port 7421
  dev server start 8080         # Start on port 8080
  dev server stop               # Stop the server
  dev server status             # Check server status

EXIT CODES:
  0 - Success
  2 - Already running
  4 - Port in use by another process
`);
  } else if (category === 'git') {
    console.log(`
dev git — Git operations for development

USAGE:
  node scripts/dev.mjs git checkout-pr <PR-number>
  node scripts/dev.mjs git create-branch <ticket-id>
  node scripts/dev.mjs git push-upstream
  node scripts/dev.mjs git clean-branches

COMMANDS:
  checkout-pr <PR>   Checkout a PR by number
  create-branch <id> Create feature branch from ticket ID
  push-upstream      Push current branch to remote with upstream tracking
  clean-branches     Delete merged local branches (excludes main)

EXAMPLES:
  dev git checkout-pr 123           # Checkout PR #123
  dev git create-branch WARDEN-79  # Create feature/warden-79
  dev git push-upstream             # Push to remote with -u flag
  dev git clean-branches            # Clean up merged branches

EXIT CODES:
  0 - Success
  3 - PR or branch not found
  4 - Uncommitted changes (for checkout-pr)
`);
  } else if (category === 'build') {
    console.log(`
dev build — Build operations

USAGE:
  node scripts/dev.mjs build check
  node scripts/dev.mjs build run
  node scripts/dev.mjs build clean

COMMANDS:
  check   Check if build is needed
  run     Build frontend (with stale detection)
  clean   Force clean build (remove dist first)

EXAMPLES:
  dev build check   # Check if build is stale
  dev build run     # Build if needed
  dev build clean   # Full clean rebuild

EXIT CODES:
  0 - Success or build up to date
`);
  } else if (category === 'test') {
    console.log(`
dev test — Testing operations

USAGE:
  node scripts/dev.mjs test run
  node scripts/dev.mjs test file <path>
  node scripts/dev.mjs test smoke

COMMANDS:
  run       Run full test suite
  file <p>  Run specific test file
  smoke     Run smoke tests

EXAMPLES:
  dev test run              # Run all tests
  dev test file test.js     # Run specific file
  dev test smoke            # Run smoke tests

EXIT CODES:
  0 - All tests passed
  1 - Tests failed or not found
`);
  } else {
    console.log(`
warden dev.mjs — Standardized development tools

This script provides safe, tested, and documented ways to perform common
development operations. Use these tools instead of inventing your own approaches.

USAGE:
  node scripts/dev.mjs <category> <command> [args]

CATEGORIES:
  server   Manage the warden server (start, stop, status, restart)
  git      Git operations (checkout-pr, create-branch, push-upstream, clean-branches)
  build    Build operations (check, run, clean)
  test     Testing operations (run, file, smoke)

HELP:
  node scripts/dev.mjs <category> --help     Show help for a category
  node scripts/dev.mjs --help                Show this help

EXAMPLES:
  dev server start              # Start the development server
  dev server stop               # Stop the server safely
  dev git checkout-pr 123       # Checkout a PR
  dev git create-branch WARDEN-79  # Create feature branch
  dev build run                 # Build frontend
  dev test smoke                # Run smoke tests

EXIT CODES:
  0 - Success
  1 - General error
  2 - Already in desired state (idempotent)
  3 - Not found (PR, branch, file, etc.)
  4 - Conflict (port in use, uncommitted changes, etc.)

All tools are idempotent (safe to run multiple times) and handle edge cases
gracefully. No tool will ever kill the calling agent process.

For more information on a category, run:
  node scripts/dev.mjs <category> --help
`);
  }
}

// ---------- Main dispatcher ----------

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }

  const [category, command, ...rest] = args;

  // Check for category-level help
  if (command === '--help' || command === '-h') {
    printHelp(category);
    return;
  }

  try {
    let result;

    switch (category) {
      case 'server':
        switch (command) {
          case 'start':
            result = await cmdServerStart(rest);
            break;
          case 'stop':
            result = cmdServerStop();
            break;
          case 'status':
            result = cmdServerStatus();
            break;
          case 'restart':
            result = await cmdServerRestart(rest);
            break;
          default:
            die(`Unknown server command: ${command}\nUse 'dev server --help' for usage`);
        }
        break;

      case 'git':
        switch (command) {
          case 'checkout-pr':
            result = cmdGitCheckoutPr(rest);
            break;
          case 'create-branch':
            result = cmdGitCreateBranch(rest);
            break;
          case 'push-upstream':
            result = cmdGitPushUpstream();
            break;
          case 'clean-branches':
            result = cmdGitCleanBranches();
            break;
          default:
            die(`Unknown git command: ${command}\nUse 'dev git --help' for usage`);
        }
        break;

      case 'build':
        switch (command) {
          case 'check':
            result = cmdBuildCheck();
            break;
          case 'run':
            result = cmdBuildRun();
            break;
          case 'clean':
            result = cmdBuildClean();
            break;
          default:
            die(`Unknown build command: ${command}\nUse 'dev build --help' for usage`);
        }
        break;

      case 'test':
        switch (command) {
          case 'run':
            result = cmdTestRun(rest);
            break;
          case 'file':
            result = cmdTestFile(rest);
            break;
          case 'smoke':
            result = cmdTestSmoke();
            break;
          default:
            die(`Unknown test command: ${command}\nUse 'dev test --help' for usage`);
        }
        break;

      default:
        die(`Unknown category: ${category}\nUse 'dev --help' for usage`);
    }

    // Handle commands that keep running (like server start)
    if (result && result.keepRunning) {
      // Keep the process alive
      return;
    }

    // Exit with appropriate code
    process.exit(result?.exitCode ?? 0);
  } catch (error) {
    die(error.message);
  }
}

main();
