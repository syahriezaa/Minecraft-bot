# Dispatch: Sub-Orchestrator for Milestone 1 (Database Schema & Telemetry Service)

## Mission
Orchestrate the complete implementation and verification of Milestone 1:
1. PostgreSQL database connection pool (`pg.Pool`) connecting to local `minecraft_companion` database.
2. Complete schema migrations (`migrations.js` / DDL scripts) for tables:
   - `benchmark_runs`
   - `telemetry_logs`
   - `movement_action_logs`
   - `action_audit_logs`
   - `schema_migrations`
   with proper primary keys, foreign keys, cascades, indexes, and timestamps.
3. In-memory high-throughput 20 Hz batch telemetry ingestion ring buffer (`batchIngestion.js`) with automatic 250ms batch flushing and graceful shutdown handling.
4. Telemetry repository service (`telemetryRepository.js`) providing parameterized CRUD operations for benchmark runs and log queries.
5. Verification: Execute migrations against local PostgreSQL database `minecraft_companion`, run unit/integration tests to verify insertion, batch flushing, and querying.

## Authoritative Inputs
- Project Scope: `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/PROJECT.md`
- User Request: `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/ORIGINAL_REQUEST.md`
- Working Directory: `/Users/syahriezas/teamwork_projects/minecraft_autonomous_companion/.agents/sub_orch_m1`
- Output: Deliver `handoff.md` in your working directory and notify parent via `send_message`.
