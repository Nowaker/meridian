#!/usr/bin/env node
// This build keeps the session store and lifecycle journal in sessions.db and
// never runs the SQLite bookkeeping backend these commands maintain. Refusing
// here, before any journal is written, keeps a migration from leaving a
// directory the proxy would then refuse to start on.
console.error("meridian-bookkeeping: not supported by this build; sessions are kept in sessions.db (MERIDIAN_SESSION_DIR).")
process.exitCode = 3
