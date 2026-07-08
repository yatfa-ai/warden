# Warden Development Tools

This directory contains standardized development tools for the Warden project. These tools provide safe, tested, and documented ways to perform common development operations.

## Overview

The main tool is `dev.mjs`, which provides a unified CLI interface for all development operations. Agents should use these tools instead of inventing their own approaches.

## Installation

No installation required - these are Node.js scripts that run directly:

```bash
node scripts/dev.mjs <category> <command> [args]
```

For convenience, npm script aliases are also available:

```bash
npm run dev:server <command> [args]    # Server operations
npm run dev:git <command> [args]       # Git operations
npm run dev:build <command> [args]     # Build operations
npm run dev:test <command> [args]      # Test operations
```

## Categories

### Server Management

Manage the Warden server safely without killing your own agent process.

```bash
# Start the server (default port: 7421)
node scripts/dev.mjs server start [port]

# Stop the server safely (NEVER kills the calling agent)
node scripts/dev.mjs server stop

# Check server status
node scripts/dev.mjs server status

# Restart the server
node scripts/dev.mjs server restart [port]
```

**Why this matters:** The naive `pkill -f "warden"` pattern **kills your own agent process** because the agent's command line contains "warden" (e.g., "warden: /workspace/warden"). These tools use specific process matching to avoid this.

### Git Operations

Standardized git workflows for common development tasks.

```bash
# Checkout a PR by number
node scripts/dev.mjs git checkout-pr <PR-number>

# Create a feature branch from a ticket ID
node scripts/dev.mjs git create-branch <ticket-id>

# Push to remote with upstream tracking
node scripts/dev.mjs git push-upstream

# Clean up merged local branches
node scripts/dev.mjs git clean-branches
```

### Build Operations

Build and check the frontend.

```bash
# Check if build is needed
node scripts/dev.mjs build check

# Build frontend (with stale detection)
node scripts/dev.mjs build run

# Force clean build
node scripts/dev.mjs build clean
```

### Testing Operations

Run tests with proper filtering and error handling.

```bash
# Run full test suite
node scripts/dev.mjs test run

# Run specific test file
node scripts/dev.mjs test file <path>

# Run smoke tests
node scripts/dev.mjs test smoke
```

## Exit Codes

All tools use consistent exit codes:

- `0` - Success
- `1` - General error
- `2` - Already in desired state (idempotent)
- `3` - Not found (PR, branch, file, etc.)
- `4` - Conflict (port in use, uncommitted changes, etc.)

## Design Principles

1. **Idempotent**: Safe to run multiple times
2. **Safe**: No tool will ever kill the calling agent process
3. **Consistent**: All tools use the same CLI interface and exit codes
4. **Documented**: Every tool has help text and examples
5. **Edge-case aware**: Handle conflicts, missing dependencies, and errors gracefully

## Examples

### Starting development work

```bash
# 1. Create a feature branch for your ticket
node scripts/dev.mjs git create-branch WARDEN-79

# 2. Start the server
node scripts/dev.mjs server start

# 3. Build the frontend if needed
node scripts/dev.mjs build run

# 4. Run tests
node scripts/dev.mjs test smoke
```

### Cleaning up after a ticket

```bash
# 1. Stop the server
node scripts/dev.mjs server stop

# 2. Push your changes
node scripts/dev.mjs git push-upstream

# 3. Go back to main
git checkout main

# 4. Clean up merged branches
node scripts/dev.mjs git clean-branches
```

### Working with PRs

```bash
# 1. Checkout a PR for review
node scripts/dev.mjs git checkout-pr 123

# 2. Start the server to test
node scripts/dev.mjs server start

# 3. Run tests
node scripts/dev.mjs test run

# 4. Stop the server when done
node scripts/dev.mjs server stop
```

## Getting Help

Help is available at multiple levels:

```bash
# General help
node scripts/dev.mjs --help

# Category-specific help
node scripts/dev.mjs server --help
node scripts/dev.mjs git --help
node scripts/dev.mjs build --help
node scripts/dev.mjs test --help
```

## Architecture

The tools are organized as:

- `dev.mjs` - Main CLI tool with all operations
- `start.mjs` - Original server startup script (for user manual startup)
- `README.md` - This documentation

All tools are written in Node.js (ES modules) for consistency with the rest of the project.

## Safety Features

### Process Management

The server management tools use specific process matching to avoid killing the calling agent:

```javascript
// GOOD - Matches only the actual server process
pgrep -f "^node /workspace/warden/src/server.js"

// BAD - Would match the agent's own command line
pkill -f "warden"
```

### Dependency Checking

Tools automatically check for:
- Missing node_modules (installs if needed)
- Stale builds (rebuilds if needed)
- Port conflicts (fails with clear error)
- Uncommitted changes (warns before destructive operations)

### Error Handling

All tools provide:
- Clear error messages
- Appropriate exit codes
- Graceful degradation when dependencies are missing
- Idempotent operations (safe to retry)

## Related Documentation

- `../CLAUDE.md` - Project architecture and stack
- `../PRODUCT.md` - Product vision and features
- Agent knowledge articles (WARDEN-1 through WARDEN-5) - Agent-specific guidance

## Contributing

When adding new operations:

1. Follow the existing CLI pattern: `dev <category> <command> [args]`
2. Use the same exit codes (0=success, 1=error, 2=idempotent, etc.)
3. Add help text for the new command
4. Handle edge cases gracefully
5. Make operations idempotent when possible
6. Update this README with examples

## History

These tools were created in response to agents repeatedly encountering the same issues:
- Using `pkill -f "warden"` which killed their own process
- Inventing different approaches to common operations
- Not handling edge cases (already running, conflicts, etc.)

The standardized tools prevent these issues and provide a reliable foundation for all agents to use.
