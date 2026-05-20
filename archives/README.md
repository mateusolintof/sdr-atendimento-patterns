# archives/ — snapshots históricos

Esta pasta guarda documentos arquivados por desatualização ou refator. Não consultar como fonte de verdade.

| Arquivo | Snapshot de | Por que arquivado |
|---|---|---|
| `IMPLEMENTATION_PLAN.md` | 2026-05-15 (Fase C — 13 workflows IGOR_01-13) | Topologia inteira reescrita em 2026-05-18: IGOR_01+02+03+AUX consolidados em `IGOR_Inbound`; IGOR_05 virou `IGOR_Handoff`; IGOR_06 renomeado `IGOR_Chatwoot_Logger`; IGOR_10-13 cancelados, substituídos por `IGOR_Campaign_Sender`. Contratos/diagramas/migrations dessa versão NÃO valem mais. |
| `REFACTOR_FLUXO_1_2026-05-16.md` | 2026-05-16 (refator v2 — IGOR_01_v2 + IGOR_05_v2) | Snapshot intermediário. Foi superseded pelo refator v3 em 2026-05-18 (IGOR_Inbound/IGOR_Handoff). |
| `VALIDATION_REPORT.md` | 2026-05-15 (Fase C — pré-refator) | Lista workflows IGOR_01-08 + AUX (todos arquivados no n8n). Mencionava BYPASS em business hours e gates `dry_run_send`/`allow_real_whatsapp_send` que foram REMOVIDOS. |

Fonte de verdade ATUAL:
- `../AGENTS.md` — regras de trabalho
- `../tasks.md` — estado vivo das tarefas
- `../docs/ARCHITECTURE.md` — arquitetura técnica
- `../docs/logica-fluxo-*.md` — specs funcionais
- `../docs/RUNBOOK.md` — comandos operacionais
