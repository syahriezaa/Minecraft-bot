# Scope: Milestone 1 — Database Schema & Telemetry Service

## Architecture & Responsibilities
Milestone 1 is the persistence and real-time telemetry foundation for the Minecraft Autonomous Companion.
It provides:
1. Base configuration and dependency definitions in `package.json`.
2. Environment configuration and PostgreSQL connection pool in `src/config/database.js` and `src/config/environment.js`.
3. Schema migration manager in `src/database/migrations.js` supporting transactional DDL creation of:
   - `schema_migrations`: Version tracking table
   - `benchmark_runs`: Run-level benchmark metadata, statuses, durations, obstacle counts, and success rates
   - `telemetry_logs`: Summary telemetry data per benchmark run with coordinate deltas, path histories (JSONB)
   - `movement_action_logs`: High-frequency tick telemetry (20 Hz) with x, y, z, velocity, stuck flags, recovery phase
   - `action_audit_logs`: AI Brain and bot action audits
4. High-performance batch ingestion ring buffer in `src/database/batchIngestion.js` (20 Hz push, 250ms batch flushes with unnest/multi-row INSERT, and graceful termination flush).
5. Parameterized telemetry repository in `src/database/telemetryRepository.js` for CRUD queries and historical telemetry extraction.
6. Comprehensive test suite in `test/database/telemetry_db_test.js` validating schema migration, batch ingestion under load, and repository query methods.

## Milestones Breakdown
| # | Component | Scope | Dependencies | Status |
|---|-----------|-------|-------------|--------|
| 1.1 | Environment & Pool Config | `src/config/database.js`, `src/config/environment.js` | none | DONE |
| 1.2 | DDL Migrations | `src/database/migrations.js` (5 tables + indexes) | 1.1 | DONE |
| 1.3 | Batch Ingestion Buffer | `src/database/batchIngestion.js` (20 Hz, 250ms interval) | 1.1 | DONE |
| 1.4 | Telemetry Repository | `src/database/telemetryRepository.js` | 1.1, 1.2 | DONE |
| 1.5 | Verification Test Suite | `test/database/telemetry_db_test.js` | 1.1-1.4 | DONE |

## Interface Contracts
### Tables
- `benchmark_runs (id UUID PK, level VARCHAR, status VARCHAR, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, duration_ms INT, obstacle_count INT, stuck_recovery_count INT, success_rate FLOAT, metadata JSONB, created_at TIMESTAMPTZ)`
- `telemetry_logs (id BIGSERIAL PK, run_id UUID FK, level VARCHAR, status VARCHAR, travel_duration_ms INT, obstacle_count INT, start_pos JSONB, end_pos JSONB, coordinate_delta FLOAT, path_history JSONB, created_at TIMESTAMPTZ)`
- `movement_action_logs (id BIGSERIAL PK, run_id UUID FK, tick BIGINT, x FLOAT, y FLOAT, z FLOAT, velocity_xz FLOAT, action VARCHAR, is_stuck BOOLEAN, recovery_phase INT, created_at TIMESTAMPTZ)`
- `action_audit_logs (id BIGSERIAL PK, run_id UUID FK, task VARCHAR, action_type VARCHAR, payload JSONB, result JSONB, created_at TIMESTAMPTZ)`

## Code Layout Ownership
- `package.json`
- `.env.example`
- `src/config/database.js`
- `src/config/environment.js`
- `src/config/constants.js`
- `src/database/migrations.js`
- `src/database/batchIngestion.js`
- `src/database/telemetryRepository.js`
- `test/database/telemetry_db_test.js`
