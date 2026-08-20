# Scope: E2E Testing Track (T1)

## Architecture
Comprehensive, opaque-box, requirement-driven 4-tier E2E testing framework designed independently from implementation internals. Evaluates headless Minecraft server arena, pathfinding & autonomous recovery benchmarks (Levels 1-4), PostgreSQL telemetry & movement logging, DeepSeek AI brain multi-step task execution (zombie farming, chest sorting, trash incineration), Express/WebSocket dashboard, and UI localization.

## Feature Inventory Mapping
All 14 features from `PROJECT.md § Feature Inventory` are covered across all 4 tiers:
| # | Feature | Description | Target Test Files | Source |
|---|---------|-------------|-------------------|--------|
| 1 | Headless Test Server Arena | Zero-Java Node.js in-process headless server & mock arena | `test/e2e/tier1_feature_coverage.test.js`, `tier2_boundary_corner.test.js` | ORIGINAL_REQUEST §R1 |
| 2 | Level 1 Benchmark (Flat Ground) | 30m sprint flat terrain A->B (5 consecutive 100%) | `test/e2e/tier1_feature_coverage.test.js`, `e2e_level1_test.js` | ORIGINAL_REQUEST §R2 |
| 3 | Level 2 Benchmark (Obstacles & Elevation) | 50m course with 1-block steps & detours | `test/e2e/tier1_feature_coverage.test.js`, `e2e_level2_test.js` | ORIGINAL_REQUEST §R2 |
| 4 | Level 3 Benchmark (Stairs, Ladders & Bridges) | Vertical stairs, ladder shafts, 1-block narrow bridges | `test/e2e/tier1_feature_coverage.test.js`, `e2e_level3_test.js` | ORIGINAL_REQUEST §R2 |
| 5 | Level 4 Benchmark (Underground Spawner Farm) | Long-distance surface down to `[-256, -20, -432]` | `test/e2e/tier1_feature_coverage.test.js`, `e2e_level4_test.js` | ORIGINAL_REQUEST §R2 |
| 6 | Autonomous Self-Correction & Stuck Detection | Per-tick sliding window stuck detector & 4-phase recovery | `test/e2e/tier1_feature_coverage.test.js`, `tier2_boundary_corner.test.js` | ORIGINAL_REQUEST §R3 |
| 7 | PostgreSQL Telemetry Logging | `minecraft_companion` schema, `telemetry_logs`, `movement_action_logs` | `test/e2e/tier1_feature_coverage.test.js`, `e2e_telemetry_test.js` | ORIGINAL_REQUEST §R3 |
| 8 | DeepSeek AI Brain (`deepseek-chat`) | AI prompt engine & multi-step function calling | `test/e2e/tier1_feature_coverage.test.js`, `e2e_ai_tasks_test.js` | ORIGINAL_REQUEST §R4 |
| 9 | Zombie Spawner Farming Task | Zombie mob farming with >=625ms attack weapon cooldown | `test/e2e/tier1_feature_coverage.test.js`, `e2e_ai_tasks_test.js` | ORIGINAL_REQUEST §R4 |
| 10 | Multi-Chest Item Sorting Task | Category-based multi-chest inventory sorting | `test/e2e/tier1_feature_coverage.test.js`, `e2e_ai_tasks_test.js` | ORIGINAL_REQUEST §R4 |
| 11 | Trash Incineration Task | Incinerate toxic potatoes / excess rotten flesh safely | `test/e2e/tier1_feature_coverage.test.js`, `e2e_ai_tasks_test.js` | ORIGINAL_REQUEST §R4 |
| 12 | Web Dashboard & Real-Time Terminal | Port 8080 Express + WebSocket real-time telemetry & terminal | `test/e2e/tier1_feature_coverage.test.js`, `e2e_telemetry_test.js` | ORIGINAL_REQUEST §Acceptance |
| 13 | UI Localization & Poppins Font | Bahasa Indonesia labels and Poppins font typography | `test/e2e/tier1_feature_coverage.test.js`, `tier2_boundary_corner.test.js` | RULE[user_global] |
| 14 | E2E Autonomous Test Suite | Master runner, comprehensive assertions, exit code semantics | `test/runner.js` | ORIGINAL_REQUEST §Acceptance |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E1 | Test Infra & Runner Setup | `TEST_INFRA.md`, `test/runner.js`, test harness & assertion library | none | IN_PROGRESS |
| E2 | Tier 1 Feature Coverage Suite | >=5 test cases per feature (70+ tests total for 14 features) | E1 | PLANNED |
| E3 | Tier 2 Boundary & Corner Suite | >=5 boundary/corner test cases per feature (70+ tests total) | E1 | PLANNED |
| E4 | Tier 3 & Tier 4 Suites + TEST_READY.md | Pairwise cross-feature interactions, real-world workloads, and `TEST_READY.md` | E2, E3 | PLANNED |
