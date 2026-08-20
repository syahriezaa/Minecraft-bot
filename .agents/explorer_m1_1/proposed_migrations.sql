-- ==============================================================================
-- SKEMA DATABASE: minecraft_companion (PostgreSQL 17)
-- Milestone 1: Database Schema & Telemetry Service
-- ==============================================================================

-- 1. Ekstensi UUID jika diperlukan untuk uuid_generate_v4() (atau gunakan bawaan gen_random_uuid())
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Tabel Pelacak Versi Migrasi
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tabel Riwayat Benchmark (benchmark_runs)
CREATE TABLE IF NOT EXISTS benchmark_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level VARCHAR(50) NOT NULL, -- 'LEVEL_1', 'LEVEL_2', 'LEVEL_3', 'LEVEL_4'
    status VARCHAR(50) NOT NULL, -- 'RUNNING', 'SUCCESS', 'FAILED'
    start_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMPTZ,
    duration_ms INTEGER,
    obstacle_count INTEGER DEFAULT 0,
    stuck_recovery_count INTEGER DEFAULT 0,
    success_rate FLOAT DEFAULT 0.0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Tabel Ringkasan Log Telemetri (telemetry_logs)
CREATE TABLE IF NOT EXISTS telemetry_logs (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    level VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    travel_duration_ms INTEGER,
    obstacle_count INTEGER DEFAULT 0,
    start_pos JSONB,
    end_pos JSONB,
    coordinate_delta FLOAT,
    path_history JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Tabel Log Pergerakan & Aksi Berfrekuensi Tinggi 20 Hz (movement_action_logs)
CREATE TABLE IF NOT EXISTS movement_action_logs (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    tick BIGINT NOT NULL,
    x FLOAT NOT NULL,
    y FLOAT NOT NULL,
    z FLOAT NOT NULL,
    velocity_xz FLOAT DEFAULT 0.0,
    action VARCHAR(100) NOT NULL,
    is_stuck BOOLEAN DEFAULT FALSE,
    recovery_phase INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Tabel Log Audit Aksi AI Brain & Bot (action_audit_logs)
CREATE TABLE IF NOT EXISTS action_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID REFERENCES benchmark_runs(id) ON DELETE SET NULL,
    task VARCHAR(100) NOT NULL,
    action_type VARCHAR(100) NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    result JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. Indeks Kueri Performa Tinggi
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs (status);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_created_at ON benchmark_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_level ON benchmark_runs (level);

CREATE INDEX IF NOT EXISTS idx_telemetry_logs_run_id ON telemetry_logs (run_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_logs_created_at ON telemetry_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_movement_action_logs_run_tick ON movement_action_logs (run_id, tick);
CREATE INDEX IF NOT EXISTS idx_movement_action_logs_is_stuck ON movement_action_logs (run_id, is_stuck);
CREATE INDEX IF NOT EXISTS idx_movement_action_logs_created_at ON movement_action_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_action_audit_logs_run_id ON action_audit_logs (run_id);
CREATE INDEX IF NOT EXISTS idx_action_audit_logs_created_at ON action_audit_logs (created_at DESC);
