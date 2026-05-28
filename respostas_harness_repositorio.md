# Consolidação das duas respostas anteriores - Harness Engineering e arquitetura de repositório

Este documento contém, por inteiro, as duas respostas anteriores solicitadas.

---

# Resposta 1 - Revalidação da arquitetura e explicação dos conceitos operacionais

Sim — sua crítica procede. Minha resposta anterior ficou correta na **macroarquitetura**, mas velha na **ancoragem operacional**. Eu tratei **CI/CD + IaC + GitOps** como espinha dorsal, quando em repositórios AI-native/agentic eles deveriam ser apenas **atuadores** ou **runners**. O centro da arquitetura moderna é outro:

> **Repository Knowledge + Agent Harness + Evals + Tracing + Workers + Memory + Policy + Human/LLM Review Loops.**

CI/CD ainda existe, mas como mecanismo de execução. GitOps ainda pode existir, mas como mecanismo de sincronização. IaC ainda existe, mas como definição de ambiente. Nenhum deles deveria ser o cérebro do repositório.

---

# 1. Revalidação da arquitetura: o que estava ultrapassado

A tese revisada é esta:

> O repositório ideal moderno não é “um repo com pipeline”.  
> É um **sistema de controle agentic** que usa o Git apenas como fonte versionada, e usa evals, judges, traces, memória e workers para validar continuamente se o produto, os agentes, as skills e as automações continuam coerentes.

Essa visão está mais alinhada com o que OpenAI chama de **harness engineering**: o `AGENTS.md` não deve ser uma enciclopédia, mas um mapa curto para uma base de conhecimento versionada em `docs/`; eles relatam que um `AGENTS.md` gigante apodrece, consome contexto e vira uma “attractive nuisance”. ([openai.com](https://openai.com/index/harness-engineering/))

Também está alinhada com o padrão da Anthropic para desenvolvimento agentic longo: decompor o trabalho em partes tratáveis e usar uma arquitetura **planner → generator → evaluator**, com artefatos estruturados para handoff entre sessões. ([anthropic.com](https://www.anthropic.com/engineering/harness-design-long-running-apps))

E está alinhada com a filosofia de **12-factor agents**: controlar prompts, janela de contexto, ferramentas, estado, fluxo de controle, humanos no loop e agentes pequenos/focados. ([github.com](https://github.com/humanlayer/12-factor-agents))

## A correção principal

A arquitetura antiga fica assim:

```txt
Repo
  ↓
PR
  ↓
CI
  ↓
Testes
  ↓
Deploy
  ↓
Observabilidade
```

A arquitetura moderna deveria ser assim:

```txt
Intenção / mudança
  ↓
Context builder
  ↓
Planner
  ↓
Generator
  ↓
Static validators
  ↓
LLM-as-judge
  ↓
Specialist evaluators
  ↓
Trace-aware reviewer
  ↓
Human approval quando necessário
  ↓
Merge / release
  ↓
Production tracing
  ↓
Online evals
  ↓
Feedback-to-dataset
  ↓
Knowledge/memory update
```

Ou seja: CI/CD não some. Ele vira só uma das formas de executar os gates.

## O erro de priorização

Na resposta anterior, eu sugeri:

```txt
CI/CD + IaC + GitOps
```

como se isso fosse “a camada operacional ideal”.

O modelo melhor é:

```txt
Agentic Quality Control Plane
├── evals
├── LLM-as-judge
├── tracing
├── prompt/version management
├── skill validation
├── agent validation
├── memory governance
├── production replay
├── security/risk gates
├── human review queues
└── release actuators
    ├── CI runner
    ├── deploy runner
    ├── infra runner
    └── feature flag runner
```

Langfuse, por exemplo, posiciona tracing, prompt management, evals, experimentos, anotações humanas, custo e latência como um ciclo integrado de desenvolvimento e produção. ([langfuse.com](https://langfuse.com/docs)) LangSmith também se define como plataforma framework-agnostic para construir, depurar, avaliar e implantar agentes/LLM apps, juntando tracing, evals, prompt testing e deployment. ([docs.langchain.com](https://docs.langchain.com/langsmith/home))

## Sobre GitHub

Concordo com sua crítica quando o GitHub vira o centro do sistema. GitHub como **remote Git** ou superfície de PR até pode servir. GitHub como **control plane de qualidade agentic** é fraco.

O problema não é “Git”. O problema é usar GitHub Issues, GitHub Actions e PR comments como se fossem suficientes para:

```txt
traces
eval datasets
prompt versions
agent runs
tool calls
judge scores
approval trails
memory mutations
production replay
skill contracts
risk register
semantic ownership
```

Eles não são.

O ideal é tratar GitHub/GitLab/Forgejo/Harness Code/Gerrit como **adaptadores SCM**, não como núcleo arquitetural.

## Sobre “Julie”

Eu não encontrei uma fonte primária confiável chamada exatamente “Julie” nesse contexto. Encontrei **Google Jules**, que parece ser provavelmente o que você quis dizer, e também **JetBrains Junie**. Jules é descrito pela Google como um agente assíncrono que se conecta ao GitHub, clona o repositório em uma VM, entende o código, cria plano, modifica arquivos, roda testes e gera diff/PR. ([blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/jules/?utm_source=chatgpt.com))

A arquitetura correta não deveria depender do nome da ferramenta. Ela deveria ter uma porta assim:

```txt
post_pr_agents/
├── jules/
├── junie/
├── codex/
├── claude-code/
├── cursor/
├── custom-reviewer/
└── adapters/
```

Ou seja: qualquer agente pós-PR precisa passar pelos mesmos contratos de tracing, eval, evidência, permissões e rollback.

---

# 2. O que cada ponto significa e por que importa

## Runbooks

**Runbook** é um manual operacional executável por humanos ou agentes. Ele diz o que fazer quando algo acontece.

Não é documentação genérica. É instrução operacional.

Exemplo ruim:

```txt
Se o deploy falhar, investigar logs.
```

Exemplo bom:

```txt
Runbook: aumento de erro em agent-tool-calls

Sintoma:
- tool_call_success_rate < 98%
- aumento de timeout no MCP database-readonly

Passos:
1. Verificar traces em Langfuse/LangSmith pelo campo tool_name.
2. Comparar versão atual do tool schema com a versão anterior.
3. Rodar production replay com os últimos 100 traces falhos.
4. Se regressão confirmar, desativar feature flag agent.tool.db_v2.
5. Abrir incidente com links para traces, evals e diff.
6. Adicionar os casos falhos ao dataset regression/tool-use.
```

**Importância:** sem runbook, cada incidente vira improviso. Com agentes, isso é ainda mais crítico, porque falhas podem estar em prompt, ferramenta, memória, retrieval, modelo, schema, permissões ou orquestração.

---

## SLOs

**SLO** significa **Service Level Objective**. É uma meta mensurável de qualidade ou confiabilidade.

No mundo clássico:

```txt
99.9% das requisições devem responder com sucesso em 30 dias.
p95 latency < 500ms.
```

No mundo agentic:

```txt
task_success_rate >= 92%
grounded_answer_rate >= 97%
tool_call_success_rate >= 99%
unsafe_action_block_rate = 100%
p95_agent_latency <= 8s
cost_per_successful_task <= R$ X
human_escalation_precision >= 85%
```

SLOs são importantes porque transformam “está bom?” em uma decisão objetiva. Google SRE defende SLOs e error budgets como mecanismo para equilibrar confiabilidade e velocidade de mudança; tentar 100% de confiabilidade pode reduzir inovação e gerar arquitetura excessivamente conservadora. ([sre.google](https://sre.google/sre-book/service-level-objectives/?utm_source=chatgpt.com))

Para agentes, SLO não pode ser só uptime. Tem que incluir **qualidade comportamental**.

---

## Postmortems

**Postmortem** é a análise depois de um incidente ou regressão relevante.

Não é para achar culpado. É para descobrir:

```txt
o que aconteceu
por que aconteceu
por que não detectamos antes
quais controles falharam
quais novos gates/evals/runbooks precisamos
```

Exemplo:

```txt
Incidente:
Agente passou a usar uma tool errada após mudança no prompt.

Causa:
Prompt v18 favorecia autonomia, mas não reforçava regra de menor privilégio.

Por que os testes não pegaram:
Dataset de eval não tinha casos envolvendo múltiplas tools com nomes parecidos.

Ações:
1. Adicionar 30 casos ao dataset tool-selection-regression.
2. Criar judge específico para "tool appropriateness".
3. Atualizar policy de tool allowlist.
4. Criar alerta para aumento de tool_call_retries.
```

**Importância:** postmortems fecham o ciclo de aprendizagem. Sem eles, o repo não acumula inteligência operacional.

---

## Rollback

**Rollback** é voltar para uma versão anterior segura.

No software tradicional, rollback é voltar código ou deploy. Em sistemas agentic, rollback precisa cobrir mais coisas:

```txt
código
prompt
modelo
tool schema
MCP server
retrieval config
vector index
embedding model
memory policy
agent graph
feature flag
guardrail
judge rubric
```

Exemplo prático:

```txt
Prompt v42 aumentou taxa de resposta incompleta.
Rollback:
1. Reapontar label production para prompt v41.
2. Desativar planner_v2 via feature flag.
3. Reexecutar 50 traces falhos contra v41.
4. Confirmar recuperação do SLO.
5. Abrir postmortem.
```

Langfuse suporta versionamento/deploy de prompts e rollback por labels sem exigir mudança de código. ([langfuse.com](https://langfuse.com/docs))

---

## Production replay

**Production replay** é pegar casos reais de produção, normalmente anonimizados/sanitizados, e reexecutar contra uma nova versão antes ou depois do release.

Exemplo:

```txt
Antes de trocar o modelo do agente:
1. Selecionar 500 traces reais da última semana.
2. Remover PII.
3. Reexecutar com model_config_vNext.
4. Comparar:
   - qualidade
   - custo
   - latência
   - tool calls
   - violações de política
   - divergência de resposta
5. Bloquear release se regressão > limite.
```

Isso é mais forte do que testar só exemplos inventados. Braintrust descreve exatamente esse princípio: transformar traces de produção em evals e datasets de regressão. ([braintrust.dev](https://www.braintrust.dev/)) Phoenix também descreve o uso de traces, evals, produção real e experimentos para comparar mudanças nos mesmos inputs. ([arize.com](https://arize.com/docs/phoenix))

---

## Feature flags

**Feature flag** permite ativar, desativar ou alterar comportamento sem alterar o código-fonte.

Exemplo clássico:

```txt
checkout_v2_enabled = true para 5% dos usuários
```

Exemplo agentic:

```txt
agent.planner_v2 = enabled para time interno
agent.tool.web_search = disabled em produção
agent.model.gpt5_5 = enabled para 10% dos casos low-risk
rag.retriever.hybrid_v2 = enabled apenas em staging
```

OpenFeature define feature flags como técnica para habilitar, desabilitar ou alterar comportamento de recursos/caminhos de código sem modificar o código-fonte, e oferece uma API vendor-neutral para evitar lock-in. ([openfeature.dev](https://openfeature.dev/))

**Importância:** em agentes, feature flag é também mecanismo de segurança. Você precisa de kill switch para ferramenta, modelo, prompt, agente e memória.

---

## Observability

**Observability** é a capacidade de entender o que aconteceu dentro do sistema a partir de seus sinais externos.

No software tradicional:

```txt
logs
metrics
traces
errors
latency
throughput
```

Em agentes:

```txt
input do usuário
prompt final
prompt version
model version
retrieved documents
tool calls
tool args
tool results
latency por etapa
tokens
custo
guardrail decisions
judge scores
human approvals
final answer
```

Langfuse define tracing para LLM apps como logs estruturados de cada request, incluindo prompt, resposta, uso de tokens, latência, ferramentas e etapas de retrieval. ([langfuse.com](https://langfuse.com/docs/observability/overview)) LangSmith descreve traces como registro completo de cada passo executado durante uma request, do input ao output final. ([docs.langchain.com](https://docs.langchain.com/langsmith/observability-quickstart))

OpenTelemetry continua importante, mas como camada vendor-neutral de telemetria. Ele fornece APIs, SDKs, agents e collectors para capturar traces e métricas, com instrumentação neutra em relação a fornecedor. ([opentelemetry.io](https://opentelemetry.io/))

---

## Security evidence

**Security evidence** é a coleção de provas de que controles de segurança foram executados.

Não é “dizer que é seguro”. É ter evidência versionada e auditável.

Exemplos:

```txt
SAST report
SCA report
secret scan report
SBOM
container scan
dependency approval
MCP permission review
red-team report
prompt injection eval report
human approval log
model config approval
security exception with expiration date
```

Em agentes, evidência de segurança também inclui:

```txt
quais tools o agente pode chamar
quais permissões cada tool tem
quais ações exigem aprovação humana
quais traces foram auditados
quais evals de segurança passaram
quais riscos ainda estão aceitos
```

O NIST SSDF estrutura desenvolvimento seguro em práticas para preparar a organização, proteger software, produzir software seguro e responder a vulnerabilidades; isso justifica manter evidências de build, análise, teste, release e resposta no repositório ou em sistemas vinculados ao repositório. ([nist.gov](https://www.nist.gov/news-events/news/2025/12/secure-software-development-framework-ssdf-version-12-available-public?utm_source=chatgpt.com))

---

## Compliance

**Compliance** é demonstrar aderência a políticas, normas ou regulações.

Exemplos:

```txt
LGPD
SOC 2
ISO 27001
NIST SSDF
NIST AI RMF
OWASP LLM Top 10
OWASP Agentic Top 10
políticas internas de segurança
políticas internas de IA
```

No repositório, compliance aparece como:

```txt
compliance/
├── controls-map.md
├── evidence-index.md
├── exceptions/
├── ai-governance/
├── data-retention/
├── model-usage-policy.md
└── audit-exports/
```

NIST AI RMF organiza gestão de risco de IA em funções como **Govern, Map, Measure, Manage**, e o playbook oficial deixa claro que as ações devem ser adaptadas ao caso de uso. ([nist.gov](https://www.nist.gov/itl/ai-risk-management-framework))

---

## Agent evals

**Agent evals** são testes sistemáticos de comportamento de agentes.

Não são apenas testes unitários. Eles avaliam se o agente escolhe boas ações em cenários variáveis.

Exemplos:

```txt
O agente escolheu a tool correta?
O agente pediu aprovação humana quando deveria?
O agente citou fontes válidas?
O agente respeitou limite de custo?
O agente resolveu a tarefa completa?
O agente falhou de forma segura?
O agente não usou memória proibida?
O agente não inventou saída de ferramenta?
```

LangSmith define evals como forma quantitativa de medir performance de LLM apps, com três componentes: dataset, target function e evaluators. ([docs.langchain.com](https://docs.langchain.com/langsmith/evaluation-quickstart)) Langfuse suporta LLM-as-a-judge, feedback de usuário, labeling manual e evals customizadas em produção ou desenvolvimento. ([langfuse.com](https://langfuse.com/docs)) Promptfoo também se posiciona como ferramenta open-source para evals, red teaming e test-driven LLM development. ([promptfoo.dev](https://www.promptfoo.dev/docs/intro/))

Exemplo de eval:

```yaml
name: agent_tool_selection_eval
dataset: datasets/tool-selection-golden.jsonl
target: agents/support-agent
judges:
  - tool_appropriateness
  - policy_compliance
  - task_success
thresholds:
  tool_appropriateness: 0.95
  policy_compliance: 1.00
  task_success: 0.90
```

OpenAI recomenda LLM-as-a-judge como alternativa mais escalável que avaliação humana, mas alerta para vieses como preferência por respostas longas e posição das respostas; também recomenda rubricas claras e thresholds de pass/fail. ([developers.openai.com](https://developers.openai.com/api/docs/guides/evaluation-best-practices))

---

## AI risk register

**AI risk register** é o inventário vivo de riscos de IA.

Exemplo:

```txt
Risco: agente executar tool destrutiva sem aprovação
Categoria: agent identity / privilege abuse
Severidade: alta
Probabilidade: média
Controles:
- allowlist de tools
- human approval para write/delete
- MCP scopes por ambiente
- eval de tool misuse
- audit log obrigatório
Owner: platform security
Status: mitigado parcialmente
Próxima revisão: 2026-06-15
```

É importante porque riscos de agentes não são só bugs. São riscos de autonomia, ferramenta, memória, privacidade, custo, confiabilidade, supply chain e segurança.

OWASP Top 10 for Agentic Applications 2026 é um framework revisado globalmente para riscos de sistemas autônomos/agentic que planejam, agem e tomam decisões em workflows complexos. ([genai.owasp.org](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/))

---

# 3. Arquitetura de repositório revisada e ancorada

A lógica correta é começar pelo objetivo macro:

```txt
O que o repositório precisa garantir ao longo do tempo?
```

Minha resposta revisada:

```txt
1. O repositório precisa explicar intenção.
2. Precisa tornar conhecimento legível para humanos e agentes.
3. Precisa permitir mudanças por humanos e agentes.
4. Precisa validar mudanças antes do merge.
5. Precisa observar comportamento depois do merge.
6. Precisa transformar falhas reais em novos testes/evals.
7. Precisa controlar autonomia, ferramentas, memória e risco.
8. Precisa permitir rollback de código, prompt, modelo, tool, memória e config.
```

A partir disso, a estrutura ideal deixa de ser uma árvore genérica e vira uma arquitetura com critérios de aceite.

---

## Estrutura proposta

```txt
repo/
├── AGENTS.md
├── README.md
├── CONTRIBUTING.md
├── ARCHITECTURE.md
├── RISK.md
├── CODEOWNERS
│
├── docs/
│   ├── index.md
│   ├── product/
│   │   ├── goals.md
│   │   ├── current-behavior.md
│   │   ├── user-journeys.md
│   │   ├── acceptance-criteria.md
│   │   └── roadmap.md
│   ├── architecture/
│   │   ├── system-map.md
│   │   ├── module-boundaries.md
│   │   ├── agent-boundaries.md
│   │   ├── tool-boundaries.md
│   │   ├── memory-boundaries.md
│   │   └── dependency-rules.md
│   ├── adr/
│   ├── runbooks/
│   ├── postmortems/
│   ├── slo/
│   └── references/
│
├── product/
│   ├── specs/
│   ├── scenarios/
│   ├── personas/
│   └── examples/
│
├── agents/
│   ├── registry.yaml
│   ├── specs/
│   │   └── support-agent.agent.yaml
│   ├── prompts/
│   │   ├── system/
│   │   ├── developer/
│   │   └── tool/
│   ├── graphs/
│   ├── tools/
│   │   ├── mcp/
│   │   ├── schemas/
│   │   ├── permissions/
│   │   └── contracts/
│   ├── memory/
│   │   ├── policy.md
│   │   ├── schemas/
│   │   ├── retention.md
│   │   ├── retrieval-config.yaml
│   │   └── kb-index-config.yaml
│   ├── guardrails/
│   ├── model-configs/
│   └── handoff-artifacts/
│
├── skills/
│   ├── registry.yaml
│   ├── create-agent/
│   │   ├── SKILL.md
│   │   ├── contract.yaml
│   │   ├── examples/
│   │   └── evals/
│   ├── create-skill/
│   ├── review-pr/
│   ├── run-evals/
│   ├── debug-agent/
│   ├── update-knowledge-base/
│   └── incident-response/
│
├── harness/
│   ├── context/
│   │   ├── context-builder.yaml
│   │   ├── retrieval-policy.md
│   │   └── compression-policy.md
│   ├── judges/
│   │   ├── correctness.judge.yaml
│   │   ├── architecture.judge.yaml
│   │   ├── tool-use.judge.yaml
│   │   ├── safety.judge.yaml
│   │   └── skill-quality.judge.yaml
│   ├── evals/
│   │   ├── offline/
│   │   ├── online/
│   │   ├── regression/
│   │   ├── red-team/
│   │   ├── production-replay/
│   │   └── golden/
│   ├── datasets/
│   │   ├── golden/
│   │   ├── regression/
│   │   ├── failures/
│   │   └── synthetic/
│   ├── tracing/
│   │   ├── span-schema.yaml
│   │   ├── trace-contract.md
│   │   └── dashboards.md
│   ├── workers/
│   │   ├── validate-agent-spec/
│   │   ├── validate-skill-spec/
│   │   ├── stale-doc-detector/
│   │   ├── trace-to-eval/
│   │   ├── post-pr-reviewer/
│   │   ├── production-babysitter/
│   │   └── memory-garbage-collector/
│   ├── policies/
│   │   ├── merge-policy.yaml
│   │   ├── tool-permission-policy.yaml
│   │   ├── human-approval-policy.yaml
│   │   ├── model-policy.yaml
│   │   └── data-policy.yaml
│   └── reports/
│       ├── eval-runs/
│       ├── judge-runs/
│       ├── risk-reports/
│       └── release-evidence/
│
├── src/
│   └── ...
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── e2e/
│   └── agent-runtime/
│
├── ops/
│   ├── runbooks/
│   ├── rollback/
│   ├── incidents/
│   ├── slo/
│   ├── production-replay/
│   └── feature-flags/
│
├── security/
│   ├── threat-models/
│   ├── ai-risk-register.yaml
│   ├── evidence/
│   ├── exceptions/
│   ├── sbom/
│   └── compliance/
│
├── release/
│   ├── gates/
│   ├── rollout/
│   ├── rollback/
│   ├── changelogs/
│   └── evidence/
│
├── infra/
│   ├── envs/
│   ├── modules/
│   └── policies/
│
└── adapters/
    ├── scm/
    ├── langfuse/
    ├── langsmith/
    ├── promptfoo/
    ├── braintrust/
    ├── phoenix/
    ├── jules/
    ├── codex/
    └── harness/
```

---

# 4. Critérios de aceite para cada camada

A regra mental é:

> Uma pasta só deveria existir se ela melhora uma decisão futura, uma validação futura, um rollback futuro ou uma automação futura.

## `AGENTS.md`

**Por que existe:** para dar ao agente um mapa curto do repositório.

**Critérios de aceite:**

```txt
Tem menos de ~150 linhas.
Aponta para docs específicas.
Não duplica conhecimento profundo.
Explica como navegar no repo.
Define o que o agente nunca deve fazer.
Define onde encontrar padrões de skills, agentes, evals e segurança.
```

**Erro comum:** transformar `AGENTS.md` em bíblia gigante.

OpenAI validou exatamente o contrário: `AGENTS.md` curto como índice e `docs/` como fonte de verdade. ([openai.com](https://openai.com/index/harness-engineering/))

---

## `docs/`

**Por que existe:** para ser a base de conhecimento versionada.

**Critérios de aceite:**

```txt
Cada documento tem owner.
Cada documento tem data de revisão.
Cada documento tem links para código/evals relacionados.
Documentos críticos têm stale-check automático.
Docs não contradizem architecture rules.
```

**Cenário prático:** um agente vai alterar autenticação. Ele não deveria inferir regras olhando só código local. Ele deveria buscar:

```txt
docs/architecture/auth.md
docs/adr/
security/threat-models/auth.md
harness/evals/security/
```

---

## `product/`

**Por que existe:** para separar objetivo de implementação.

**Critérios de aceite:**

```txt
Toda feature importante tem cenário esperado.
Todo cenário tem critério de aceite.
Toda mudança agentic consegue apontar para uma intenção de produto.
```

**Exemplo:**

```txt
Scenario: usuário pede reembolso
Expected:
- agente deve checar política
- deve consultar pedido
- deve explicar elegibilidade
- deve escalar para humano se valor > limite
```

Isso vira dataset de eval depois.

---

## `agents/`

**Por que existe:** agentes são produto, não scripts soltos.

**Critérios de aceite para cada agente:**

```yaml
id: support-agent
owner: ai-platform
purpose: Resolver dúvidas de suporte nível 1
allowed_tools:
  - kb.search
  - order.read
  - ticket.create
forbidden_tools:
  - payment.refund
  - user.delete
requires_human_approval:
  - refund_request
memory:
  read: customer_context
  write: support_summary
evals_required:
  - task_success
  - tool_use
  - safety
  - grounding
rollback:
  previous_prompt_label: support-agent-prod-stable
```

Sem isso, um agente vira uma entidade sem contrato.

---

## `skills/`

**Por que existe:** skills são workflows de conhecimento operacional reutilizáveis.

O próprio Harness trata skills como templates de prompt especializados, com instruções estruturadas para ensinar assistentes de código a interagir com a plataforma; a documentação diz que o repositório de skills é um sistema de workflow, não apenas uma pasta de prompts. ([developer.harness.io](https://developer.harness.io/docs/platform/harness-ai/harness-skills))

**Critérios de aceite para cada skill:**

```txt
Tem SKILL.md.
Tem frontmatter com nome, versão, owner e dependências.
Tem exemplos bons e ruins.
Tem contrato de input/output.
Tem evals próprias.
Não inventa schema; descobre schema quando possível.
Declara ferramentas necessárias.
Declara ações proibidas.
```

Exemplo:

```txt
skills/create-agent/
├── SKILL.md
├── contract.yaml
├── examples/
│   ├── valid-agent.yaml
│   └── invalid-agent.yaml
└── evals/
    ├── follows-agent-contract.yaml
    └── refuses-unsafe-tooling.yaml
```

**Cenário prático:** alguém cria uma skill nova. O worker `validate-skill-spec` precisa verificar:

```txt
Existe frontmatter?
Existe owner?
A skill tem objetivo único?
Usa ferramentas permitidas?
Tem exemplos?
Tem eval?
Tem rollback ou modo seguro?
```

---

## `harness/judges/`

**Por que existe:** LLM-as-judge precisa ser versionado e auditável.

**Critérios de aceite:**

```txt
Cada judge tem rubrica clara.
Cada judge tem exemplos de nota boa/ruim.
Cada judge tem threshold.
Cada judge tem dataset de calibração.
Cada judge tem comparação periódica com humano.
```

Exemplo:

```yaml
judge: architecture.judge
checks:
  - respects_module_boundaries
  - avoids_cross_layer_imports
  - preserves_public_contracts
  - updates_docs_when_architecture_changes
threshold: 0.90
blocking: true
```

**Erro comum:** pedir “revise esse PR” para um LLM sem rubrica, sem dataset e sem histórico.

---

## `harness/evals/`

**Por que existe:** comportamento de LLM/agente é probabilístico; precisa de teste sistemático.

**Critérios de aceite:**

```txt
Há evals offline antes do merge.
Há evals online em produção.
Há evals de regressão baseadas em falhas reais.
Há evals específicas para tool use.
Há evals de segurança.
Há thresholds objetivos.
```

Promptfoo descreve esse uso como CI/CD moderno para LLM apps: rodar evals, red teaming, quality gates, compliance reports e controle de custo antes do deployment. ([promptfoo.dev](https://www.promptfoo.dev/docs/integrations/ci-cd/))

---

## `harness/datasets/`

**Por que existe:** eval sem dataset vira opinião.

**Critérios de aceite:**

```txt
golden dataset existe.
failure dataset existe.
production traces viram regression cases.
dados sensíveis são removidos.
cada caso tem origem e motivo.
```

Exemplo:

```json
{
  "id": "refund_edge_case_014",
  "source": "production_trace",
  "risk": "wrong_policy_application",
  "input": "Cliente pede reembolso fora do prazo mas com exceção médica",
  "expected_behavior": "Escalar para humano; não negar automaticamente",
  "tags": ["refund", "edge-case", "human-approval"]
}
```

---

## `harness/tracing/`

**Por que existe:** sem tracing, você não sabe por que o agente fez algo.

**Critérios de aceite:**

```txt
Todo agent run tem trace_id.
Todo prompt tem version.
Toda tool call é registrada.
Todo retrieval registra documentos usados.
Toda decisão de guardrail é registrada.
Todo judge score é vinculado ao trace.
```

Langfuse e LangSmith cobrem essa camada; Phoenix também aceita traces via OpenTelemetry e mostra chamadas de modelo, retrieval, tool use e lógica customizada. ([langfuse.com](https://langfuse.com/docs/observability/overview))

---

## `harness/workers/`

**Por que existe:** o repo moderno precisa de robôs cuidando da qualidade continuamente.

Workers importantes:

```txt
validate-agent-spec
validate-skill-spec
stale-doc-detector
trace-to-eval
post-pr-reviewer
production-babysitter
memory-garbage-collector
risk-register-updater
```

Exemplo: `trace-to-eval`.

```txt
Quando production-babysitter detecta uma resposta ruim:
1. pega trace
2. anonimiza
3. cria caso em harness/datasets/failures
4. adiciona ao regression suite
5. abre issue/tarefa
6. vincula ao postmortem se houver incidente
```

Esse é o ponto que faltou na resposta anterior: **o repositório vivo precisa de automações que cuidam do próprio repositório**.

---

## `harness/policies/`

**Por que existe:** agentes não podem depender só de bom comportamento do modelo.

**Critérios de aceite:**

```txt
Ações destrutivas exigem aprovação humana.
Tools têm menor privilégio.
MCP servers são separados por domínio.
Ambiente de produção é read-only por padrão.
Mudanças de prompt/modelo passam por eval.
Mudanças de memória passam por política de retenção.
```

O MCP oficial alerta que ferramentas podem representar execução arbitrária de código e devem ser tratadas com cautela; hosts devem obter consentimento explícito do usuário antes de invocar tools, e usuários devem entender o que a tool faz. ([modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-06-18?utm_source=chatgpt.com))

---

## `ops/`

**Por que existe:** produção não é um lugar; é um ciclo de feedback.

**Critérios de aceite:**

```txt
Runbooks existem para falhas críticas.
Rollback é documentado por tipo de artefato.
SLOs existem para software e agentes.
Production replay é repetível.
Incidentes viram postmortems.
Postmortems viram evals.
```

---

## `security/ai-risk-register.yaml`

**Por que existe:** riscos de IA precisam ser explícitos, priorizados e rastreáveis.

**Critérios de aceite:**

```txt
Cada risco tem owner.
Cada risco tem severidade.
Cada risco tem controles.
Cada controle tem evidência.
Cada exceção tem expiração.
Cada risco é vinculado a evals/policies/runbooks.
```

Exemplo:

```yaml
- id: AIRISK-004
  title: Agent calls write tool without proper approval
  category: tool_misuse
  severity: high
  likelihood: medium
  controls:
    - human_approval_policy
    - tool_allowlist
    - mcp_scope_separation
    - tool_use_eval
  evidence:
    - harness/reports/eval-runs/tool-use/latest.json
    - security/evidence/mcp-permissions-review.md
  owner: ai-platform-security
  status: mitigated
```

---

# 5. Cenários de ação ao longo do tempo

Aqui está o exercício mental mais importante: uma boa arquitetura de repo precisa se justificar por cenários reais de mudança.

## Cenário A — Criar uma nova skill

Fluxo ideal:

```txt
developer/agent cria skills/create-x/
  ↓
validate-skill-spec worker roda
  ↓
skill-quality.judge avalia clareza, escopo e segurança
  ↓
evals da skill rodam exemplos válidos/inválidos
  ↓
policy verifica tools permitidas
  ↓
PR reviewer agent comenta riscos
  ↓
merge
  ↓
skill entra no registry
```

Camadas impactadas:

```txt
skills/
harness/judges/
harness/evals/
harness/workers/
harness/policies/
security/ai-risk-register.yaml
```

Critérios de aceite:

```txt
Skill tem objetivo único.
Skill tem contrato.
Skill tem exemplos.
Skill não pede permissões excessivas.
Skill passa eval.
Skill atualiza registry.
```

Sem isso, o repositório vira um cemitério de prompts.

---

## Cenário B — Criar um novo agente

Fluxo ideal:

```txt
criar agents/specs/new-agent.agent.yaml
  ↓
validar contrato
  ↓
validar tools
  ↓
validar memória
  ↓
rodar golden evals
  ↓
rodar safety evals
  ↓
rodar tool-use evals
  ↓
aprovação humana se agente tiver ação externa
  ↓
deploy gradual via flag
  ↓
online evals em produção
```

Critérios de aceite:

```txt
Agente tem owner.
Agente tem propósito.
Agente declara tools permitidas/proibidas.
Agente declara memória.
Agente tem SLO.
Agente tem evals mínimas.
Agente tem rollback.
```

Camadas impactadas:

```txt
agents/
harness/evals/
harness/tracing/
harness/policies/
ops/slo/
security/
release/
```

---

## Cenário C — Trocar prompt de produção

Fluxo ideal:

```txt
alterar prompt
  ↓
rodar eval offline
  ↓
rodar judge de qualidade
  ↓
rodar production replay
  ↓
comparar contra baseline
  ↓
se passar, promover label staging
  ↓
canary por feature flag
  ↓
online evals monitoram drift
  ↓
promover label production
```

Critérios de aceite:

```txt
Prompt é versionado.
Prompt está ligado a traces.
Prompt tem rollback.
Prompt não piora qualidade/custo/latência acima do limite.
Prompt passa safety eval.
```

Langfuse permite vincular prompts a traces, comparar versões por latência, custo e métricas de avaliação, além de testar versões em datasets. ([langfuse.com](https://langfuse.com/docs))

---

## Cenário D — Alterar tool ou MCP server

Fluxo ideal:

```txt
alterar tool schema
  ↓
contract tests
  ↓
permission diff
  ↓
tool-use eval
  ↓
security review se permissão aumentou
  ↓
sandbox run
  ↓
staging
  ↓
canary
  ↓
produção
```

Critérios de aceite:

```txt
Tool schema é validado.
Tool permission diff é explícito.
Tool tem least privilege.
Tool tem logs.
Tool tem rollback.
Tool tem eval de misuse.
```

Risco principal: uma pequena alteração de tool pode ampliar muito o poder real do agente. Por isso a tool precisa ser tratada como superfície crítica, não como helper function.

---

## Cenário E — Regressão pós-merge

Fluxo ideal:

```txt
production-babysitter detecta queda de SLO
  ↓
coleta traces ruins
  ↓
online judge confirma regressão
  ↓
feature flag reduz rollout
  ↓
rollback se necessário
  ↓
trace-to-eval cria novos regression cases
  ↓
postmortem gera action items
```

Critérios de aceite:

```txt
Regressão é detectada automaticamente.
Existe trace suficiente para explicar.
Rollback é possível.
Falha vira dataset.
Dataset vira gate futuro.
```

Esse é o ciclo de melhoria real.

---

## Cenário F — Documento ficou velho

Fluxo ideal:

```txt
stale-doc-detector roda
  ↓
detecta docs que referenciam arquivos removidos
  ↓
detecta ADR contradizendo código atual
  ↓
abre PR ou task
  ↓
agent atualiza docs
  ↓
doc-quality judge valida
```

Critérios de aceite:

```txt
Docs críticas têm owner.
Docs críticas têm last_reviewed.
Docs linkam para código/evals.
Docs stale bloqueiam mudanças críticas.
```

Sem isso, a base de conhecimento vira ruído para agentes.

---

## Cenário G — Incidente de segurança agentic

Exemplo:

```txt
Agente tentou chamar tool sensível em situação errada.
```

Fluxo ideal:

```txt
guardrail bloqueia
  ↓
trace registra tentativa
  ↓
security event é criado
  ↓
risk register é atualizado
  ↓
eval de tool misuse ganha novo caso
  ↓
policy é ajustada
  ↓
postmortem se houve impacto
```

Critérios de aceite:

```txt
Ação insegura é bloqueada.
Bloqueio é rastreável.
Risco é registrado.
Controle é melhorado.
Novo caso entra em eval.
```

---

# 6. A arquitetura final reancorada

A estrutura ideal não é mais:

```txt
repo + CI + deploy
```

É:

```txt
repo como sistema de memória, decisão e validação
```

A arquitetura final:

```txt
                    ┌──────────────────────────┐
                    │ Objetivos de produto     │
                    │ specs, cenários, metas   │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Conhecimento versionado  │
                    │ AGENTS, docs, ADRs       │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Context builder          │
                    │ retrieval, compression   │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Agent/Skill Registry     │
                    │ specs, contracts, tools  │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Workers                  │
                    │ validators, babysitters  │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Evals + Judges           │
                    │ offline, online, replay  │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Tracing + Evidence       │
                    │ Langfuse/LangSmith/etc.  │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Policies + Risk          │
                    │ approvals, MCP, memory   │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Release actuators        │
                    │ CI, deploy, flags, infra │
                    └─────────────┬────────────┘
                                  ↓
                    ┌──────────────────────────┐
                    │ Production feedback      │
                    │ traces → evals → fixes   │
                    └──────────────────────────┘
```

---

# 7. Minha recomendação revisada

Eu não colocaria **CI/CD + IaC + GitOps** como camada estratégica principal.

Eu colocaria assim:

```txt
Camada 1: Product Intent
Camada 2: Repository Knowledge
Camada 3: Context Engineering
Camada 4: Agent & Skill Contracts
Camada 5: Tool/MCP Governance
Camada 6: Memory & Knowledge Base Governance
Camada 7: Evals, Judges & Regression Datasets
Camada 8: Tracing, Observability & Evidence
Camada 9: Workers & Automations
Camada 10: Risk, Security & Compliance
Camada 11: Release, Rollout & Rollback
Camada 12: Infra/Delivery Actuators
```

CI/CD, IaC e GitOps entram apenas na camada 12. Importantes, mas não centrais.

A arquitetura perfeita para repositórios modernos é a que responde, automaticamente e com evidência, a estas perguntas:

```txt
Por que essa mudança existe?
Qual contexto o agente usou?
Qual skill/agente executou?
Quais tools foram chamadas?
Quais evals passaram?
Qual judge aprovou?
Qual humano aprovou?
Qual risco foi alterado?
Qual trace prova o comportamento?
Como faço rollback?
Como uma falha real vira teste futuro?
```

Esse é o ponto de virada: **o repositório deixa de ser uma pasta de código e vira um organismo de validação contínua para humanos e agentes.**

---

# Resposta 2 - Como usar as perguntas para validar a estrutura

Use essas perguntas como um **teste de rastreabilidade** da sua estrutura.

A regra é simples:

> Para cada pergunta, sua estrutura precisa apontar para um arquivo, contrato, trace, relatório, eval, política ou evidência.  
> Se a resposta depende de “alguém sabe”, “está no Slack”, “está no PR”, “o agente deveria entender” ou “a gente vê depois”, a estrutura falhou.

Ou seja: as perguntas viram um **scorecard de arquitetura do repositório**.

---

# 1. Transforme as perguntas em gates

As perguntas eram estas:

```txt
1. Por que essa mudança existe?
2. Qual contexto o agente usou?
3. Qual skill/agente executou?
4. Quais tools foram chamadas?
5. Quais evals passaram?
6. Qual judge aprovou?
7. Qual humano aprovou?
8. Qual risco foi alterado?
9. Qual trace prova o comportamento?
10. Como faço rollback?
11. Como uma falha real vira teste futuro?
```

Para validar sua estrutura, cada pergunta precisa ter:

```txt
uma camada responsável
um artefato esperado
um critério de aceite
um validador automático ou semiautomático
```

Exemplo:

| Pergunta | O que ela valida | Onde deveria estar |
|---|---|---|
| Por que essa mudança existe? | intenção, meta, problema, requisito | `product/specs/`, `docs/product/`, `PRD`, `scenario` |
| Qual contexto o agente usou? | qualidade do context engineering | `AGENTS.md`, `harness/context/`, traces |
| Qual skill/agente executou? | rastreabilidade de execução | `agents/registry.yaml`, `skills/registry.yaml`, trace |
| Quais tools foram chamadas? | governança de ferramentas | `agents/tools/`, `harness/tracing/`, MCP logs |
| Quais evals passaram? | validação de comportamento | `harness/evals/`, `harness/reports/eval-runs/` |
| Qual judge aprovou? | qualidade semântica da avaliação | `harness/judges/`, `judge-runs/` |
| Qual humano aprovou? | accountability | `CODEOWNERS`, `harness/policies/human-approval-policy.yaml` |
| Qual risco foi alterado? | gestão de risco | `security/ai-risk-register.yaml` |
| Qual trace prova o comportamento? | observabilidade e auditoria | LangSmith, Langfuse, Phoenix, `harness/tracing/` |
| Como faço rollback? | recuperabilidade | `release/rollback/`, `ops/rollback/` |
| Como uma falha real vira teste futuro? | aprendizado contínuo | `harness/datasets/failures/`, `production-replay/`, `postmortems/` |

A estrutura está boa quando essas respostas são fáceis de encontrar e difíceis de burlar.

---

# 2. Use as perguntas como “contrato mínimo” de cada mudança

Toda mudança relevante deveria carregar um pequeno manifesto.

Exemplo:

```yaml
change:
  id: CHG-2026-051
  title: Improve support-agent refund handling
  reason:
    product_spec: product/specs/refund-flow.md
    scenario: product/scenarios/refund-edge-cases.yaml

  context_used:
    - AGENTS.md
    - docs/architecture/agent-boundaries.md
    - agents/specs/support-agent.agent.yaml
    - security/ai-risk-register.yaml

  affected:
    agents:
      - support-agent
    prompts:
      - agents/prompts/system/support-agent.md
    tools:
      - kb.search
      - order.read
    memory:
      - customer_context

  validation:
    eval_reports:
      - harness/reports/eval-runs/support-agent-refund-2026-05-26.json
    judge_reports:
      - harness/reports/judge-runs/tool-use-judge-2026-05-26.json
    production_replay:
      - harness/reports/eval-runs/refund-production-replay.json

  approvals:
    human:
      - ai-platform-owner
      - security-reviewer
    policies:
      - human-approval-policy.yaml
      - tool-permission-policy.yaml

  risk:
    changed_risks:
      - AIRISK-004
    new_risks: []

  rollback:
    prompt_previous_label: support-agent-prod-stable
    feature_flag: agent.support.refund_v2
    rollback_runbook: ops/rollback/support-agent.md

  learning_loop:
    failure_dataset_updated: harness/datasets/failures/refund-edge-cases.jsonl
```

Esse manifesto pode viver como:

```txt
.harness/change-manifest.yaml
release/change-manifest.yaml
PR template
comentário gerado por worker
artefato de pipeline
```

O ponto não é o nome do arquivo. O ponto é que a mudança precisa ser **explicável, testável, rastreável e reversível**.

---

# 3. Valide sua estrutura com uma matriz

Pegue a estrutura do seu repo e pergunte: “onde essa pergunta é respondida?”

Exemplo de matriz:

| Pergunta | Resposta existe? | Evidência | Status |
|---|---:|---|---|
| Por que essa mudança existe? | Sim | `product/specs/refund-flow.md` | Passa |
| Qual contexto o agente usou? | Parcial | existe `AGENTS.md`, mas não há trace de context builder | Fraco |
| Qual skill/agente executou? | Sim | `agents/registry.yaml` + trace | Passa |
| Quais tools foram chamadas? | Sim | Langfuse trace + `agents/tools/contracts/` | Passa |
| Quais evals passaram? | Parcial | eval manual, sem report versionado | Fraco |
| Qual judge aprovou? | Não | não há rubrica versionada | Falha |
| Qual humano aprovou? | Sim | CODEOWNERS + approval policy | Passa |
| Qual risco foi alterado? | Não | não há AI risk register | Falha |
| Qual trace prova o comportamento? | Parcial | trace existe, mas não linka prompt version | Fraco |
| Como faço rollback? | Sim | feature flag + prompt label | Passa |
| Como falha vira teste futuro? | Não | não há `trace-to-eval` | Falha |

Depois disso, você não precisa “achar” que a arquitetura é boa. Você vê os buracos.

---

# 4. Use uma pontuação de maturidade

Eu usaria uma escala de 0 a 4 para cada pergunta.

```txt
0 = não existe
1 = existe de forma manual/documentada
2 = existe como artefato versionado
3 = existe com validação automática
4 = existe com feedback de produção fechando o ciclo
```

Exemplo:

| Pergunta | Nota 0-4 | Interpretação |
|---|---:|---|
| Por que essa mudança existe? | 2 | tem spec versionada, mas não está conectada ao PR automaticamente |
| Qual contexto o agente usou? | 1 | existe documentação, mas não há context trace |
| Quais evals passaram? | 3 | eval roda como gate automático |
| Qual trace prova o comportamento? | 4 | trace conecta input, prompt version, tools, output, judge score e produção |
| Como falha vira teste futuro? | 0 | não existe loop de aprendizagem |

Minha régua seria:

```txt
Repo experimental:
média >= 2

Repo de produto sério:
média >= 3

Repo agentic em produção:
nenhuma pergunta crítica abaixo de 3
e tracing/evals/rollback/risk >= 4
```

Perguntas críticas para sistemas de agentes:

```txt
Quais tools foram chamadas?
Quais evals passaram?
Qual judge aprovou?
Qual risco foi alterado?
Qual trace prova o comportamento?
Como faço rollback?
Como uma falha real vira teste futuro?
```

Se essas estiverem fracas, o produto pode até funcionar, mas não está governado.

---

# 5. Valide por cenários, não só por pastas

Uma estrutura pode parecer bonita e ainda ser inútil. Para validar de verdade, rode cenários.

## Cenário 1: criar uma nova skill

Perguntas aplicadas:

```txt
Por que essa skill existe?
Qual problema ela resolve?
Onde está o contrato da skill?
Quais ferramentas ela pode usar?
Ela tem exemplos bons e ruins?
Ela tem evals?
Existe um judge para qualidade da skill?
Quem aprova a skill?
Como removo ou desativo a skill se ela estiver ruim?
```

A estrutura passa se existir algo como:

```txt
skills/create-agent/
├── SKILL.md
├── contract.yaml
├── examples/
├── evals/
└── README.md
```

E também:

```txt
skills/registry.yaml
harness/workers/validate-skill-spec/
harness/judges/skill-quality.judge.yaml
harness/evals/skill-quality/
```

Se você consegue criar uma skill sem `contract.yaml`, sem eval e sem registry, sua estrutura permite entropia.

---

## Cenário 2: criar um novo agente

Perguntas aplicadas:

```txt
Por que esse agente existe?
Qual objetivo ele tem?
Quais tools ele pode chamar?
Quais tools ele nunca pode chamar?
Que memória ele pode ler?
Que memória ele pode escrever?
Quais evals mínimas ele precisa passar?
Qual SLO ele tem?
Qual rollback existe?
Qual risco novo ele introduz?
```

Estrutura esperada:

```txt
agents/specs/new-agent.agent.yaml
agents/prompts/system/new-agent.md
agents/tools/permissions/new-agent.yaml
agents/memory/policy.md
harness/evals/new-agent/
harness/judges/tool-use.judge.yaml
ops/slo/new-agent.md
security/ai-risk-register.yaml
release/rollback/new-agent.md
```

Se o agente pode nascer só como um prompt solto, a arquitetura falhou.

---

## Cenário 3: alterar um prompt em produção

Perguntas aplicadas:

```txt
Por que mudar o prompt?
Qual versão anterior estava em produção?
Quais traces motivaram a mudança?
Quais evals compararam prompt antigo vs novo?
Qual judge avaliou?
O custo aumentou?
A latência aumentou?
O comportamento ficou mais seguro?
Como volto para o prompt anterior?
```

Estrutura esperada:

```txt
agents/prompts/
harness/evals/regression/
harness/evals/production-replay/
harness/reports/eval-runs/
harness/reports/judge-runs/
harness/tracing/
release/rollback/prompts.md
```

Critério de aceite:

```txt
Nenhum prompt de produção muda sem:
- versão
- baseline
- eval de regressão
- trace ou dataset associado
- rollback explícito
```

---

## Cenário 4: adicionar uma tool ou MCP server

Perguntas aplicadas:

```txt
Por que a tool existe?
Qual agente pode usar?
Qual permissão ela tem?
É read-only ou write?
Ela acessa dados sensíveis?
Exige aprovação humana?
Existe contract test?
Existe tool-use eval?
Como audito chamadas?
Como desativo?
```

Estrutura esperada:

```txt
agents/tools/schemas/
agents/tools/contracts/
agents/tools/permissions/
harness/policies/tool-permission-policy.yaml
harness/evals/tool-use/
harness/tracing/span-schema.yaml
security/threat-models/tools.md
security/ai-risk-register.yaml
```

Critério de aceite:

```txt
Toda tool precisa ter:
- schema
- owner
- permissões
- logs/tracing
- eval de uso correto
- política de aprovação se for sensível
```

Se uma tool pode ser adicionada como função auxiliar sem governança, a estrutura está fraca.

---

## Cenário 5: falha em produção

Perguntas aplicadas:

```txt
Qual trace mostra a falha?
Qual agente executou?
Qual prompt version estava ativa?
Qual tool foi chamada?
Qual contexto foi recuperado?
Qual judge ou online eval detectou?
Qual SLO foi violado?
Qual rollback foi usado?
O caso virou dataset de regressão?
O postmortem gerou mudança estrutural?
```

Estrutura esperada:

```txt
ops/incidents/
ops/postmortems/
ops/rollback/
ops/slo/
harness/tracing/
harness/datasets/failures/
harness/evals/regression/
harness/workers/trace-to-eval/
security/ai-risk-register.yaml
```

Critério de aceite:

```txt
Toda falha importante precisa virar:
- trace analisável
- postmortem
- novo caso de eval
- melhoria de policy, prompt, tool, memória ou runbook
```

Se a falha é corrigida só com “ajustei o prompt”, a estrutura não está aprendendo.

---

# 6. Faça cada pasta “pagar aluguel”

Uma boa regra:

> Cada pasta precisa responder pelo menos uma pergunta crítica.

Exemplo:

| Pasta | Pergunta que ela deve responder |
|---|---|
| `product/` | Por que essa mudança existe? |
| `docs/` | Qual conhecimento orienta a mudança? |
| `agents/` | Qual agente existe, com qual contrato? |
| `skills/` | Qual workflow reutilizável existe? |
| `harness/context/` | Qual contexto foi montado? |
| `harness/evals/` | Quais validações passaram? |
| `harness/judges/` | Qual rubrica aprovou? |
| `harness/tracing/` | Qual execução prova o comportamento? |
| `harness/workers/` | O que valida e corrige continuamente? |
| `harness/policies/` | Quais limites não podem ser violados? |
| `security/` | Qual risco foi criado, mitigado ou aceito? |
| `ops/` | Como operar, recuperar e aprender? |
| `release/` | Como liberar, pausar, reverter e evidenciar? |
| `infra/` | Onde a execução vive? |

Se uma pasta não responde nada, provavelmente é cosmética.

Se uma pergunta não tem pasta responsável, falta uma camada.

---

# 7. Crie regras automáticas por tipo de mudança

Esse é o ponto que torna a validação real.

Exemplo:

```yaml
rules:
  - when_changed: "agents/prompts/**"
    require:
      - eval_report
      - judge_report
      - rollback_plan
      - prompt_version
      - trace_or_dataset_reference

  - when_changed: "agents/tools/**"
    require:
      - tool_schema
      - permission_diff
      - contract_tests
      - tool_use_eval
      - security_review_if_permission_increased

  - when_changed: "skills/**"
    require:
      - SKILL.md
      - contract.yaml
      - examples
      - skill_eval
      - registry_update

  - when_changed: "agents/memory/**"
    require:
      - data_policy_review
      - retention_policy
      - retrieval_eval
      - privacy_risk_check

  - when_changed: "harness/judges/**"
    require:
      - rubric
      - calibration_dataset
      - threshold
      - examples_good_bad

  - when_changed: "security/ai-risk-register.yaml"
    require:
      - owner
      - severity
      - mitigation
      - evidence
      - review_date
```

Com isso, sua estrutura deixa de ser uma organização de arquivos e vira um **sistema de controle**.

---

# 8. Modelo prático de validação da sua arquitetura

Você pode validar sua estrutura com este processo:

```txt
1. Liste as principais ações que vão acontecer no repo.
2. Para cada ação, responda as 11 perguntas.
3. Para cada resposta, aponte para um artefato real.
4. Onde não houver artefato, crie ou ajuste uma camada.
5. Onde houver artefato manual demais, crie worker/gate.
6. Onde houver gate sem produção, conecte tracing e feedback loop.
```

As ações mínimas que eu testaria:

```txt
Criar skill
Criar agente
Alterar prompt
Adicionar tool/MCP
Alterar memória/RAG
Alterar judge
Alterar eval
Fazer release
Fazer rollback
Responder incidente
Transformar trace ruim em teste
```

Se sua estrutura aguenta esses cenários, ela é forte.

---

# 9. O sinal de que sua estrutura está madura

Sua estrutura está madura quando, para qualquer mudança relevante, você consegue responder rapidamente:

```txt
Essa mudança existe por causa deste objetivo.
Ela usou este contexto.
Foi feita por este agente/skill/humano.
Chamou estas tools.
Passou nestas evals.
Foi julgada por estas rubricas.
Foi aprovada por estes owners.
Alterou estes riscos.
Gerou estes traces.
Pode ser revertida por este caminho.
Se falhar, vira este tipo de teste futuro.
```

A validação final é esta:

> Uma arquitetura de repositório é boa quando transforma intenção em mudança, mudança em evidência, evidência em confiança, falha em aprendizado e aprendizado em novos gates.
