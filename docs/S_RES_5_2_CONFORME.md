# Checklist de Conformidade — SBIS S-RES Segurança da Informação v5.2

> **Sistema avaliado:** fhir-soap-record  
> **Data da avaliação:** 2026-06-23  
> **Evidências revisadas em:** 2026-09-07 (migração para PostgreSQL e projeção OMOP).
> Apenas o texto das evidências foi atualizado; nenhum veredito de conformidade
> foi reavaliado.  
> **Referência:** [S_RES_5_2.md](./S_RES_5_2.md) — SBIS Versão 5.2 (10/11/2021)  
> **Escopo:** Requisitos NGS1 (obrigatórios) + NGS2 (opcional, não priorizado)

## Legenda

| Status | Significado |
|--------|-------------|
| ✅ CONFORME | Implementado e atende ao requisito |
| ⚠️ PARCIAL | Implementado parcialmente; requer complemento |
| ❌ PENDENTE | Não implementado |
| N/A | Não aplicável a esta arquitetura/modalidade |

---

## Contexto do Sistema

O **fhir-soap-record** é uma aplicação web (React Router + Node.js) com banco PostgreSQL (Prisma ORM) e armazenamento de arquivos em S3. Uma projeção analítica OMOP CDM 5.4.2, derivada e somente leitura,
vive em schema separado do mesmo banco. A autenticação é feita via **token Bearer** (sem login usuário/senha na interface; tokens são gerados por scripts CLI). O sistema é de **instância única** (não SaaS multi-tenant). A gestão de usuários está restrita a scripts no servidor — não há interface administrativa na aplicação.

---

## 3.1 NGS1 — Nível de Garantia de Segurança 1 (Obrigatório)

### NGS1.01 — Controle de versão do software

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.01.01 | Versão do software | ❌ PENDENTE | Não há exibição de versão/build na UI (tela inicial, módulos, impressões, trilha de auditoria). Requer: adicionar versão no `package.json` e expô-la na interface e nos documentos gerados. |

---

### NGS1.02 — Identificação e autenticação de pessoas

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.02.01 | Método de autenticação de pessoa | ⚠️ PARCIAL | Autenticação via token Bearer (gerado por CLI) com validação no servidor (`auth.server.ts`). Não há interface de login usuário/senha — o requisito exige ao menos um método reconhecido (usuário/senha, certificado+PIN ou biometria+PIN). O modelo de token atual não se enquadra diretamente. |
| NGS1.02.02 | Proteção dos parâmetros de autenticação | ✅ CONFORME | Tokens armazenados como SHA-256 hash (`hashToken` em `auth.server.ts`); acesso ao DB restrito. |
| NGS1.02.03 | Qualidade da senha | N/A | Sem autenticação por senha. |
| NGS1.02.04 | Impedimento de senhas com dados de identificação | N/A | Sem autenticação por senha. |
| NGS1.02.05 | Parametrização da qualidade da senha | N/A | Sem autenticação por senha. |
| NGS1.02.06 | Geração de senha pelo administrador | N/A | Sem autenticação por senha. (Scripts CLI geram tokens, o que é análogo, mas fora de conformidade formal.) |
| NGS1.02.07 | Geração automática de senha | N/A | Sem autenticação por senha. |
| NGS1.02.08 | Troca de senha pelo usuário | N/A | Sem autenticação por senha. |
| NGS1.02.09 | Troca forçada de senha | N/A | Sem autenticação por senha. |
| NGS1.02.10 | Periodicidade de troca de senhas | N/A | Sem autenticação por senha. |
| NGS1.02.11 | Igualdade de senhas | N/A | Sem autenticação por senha. |
| NGS1.02.12 | Obtenção de nova senha | N/A | Sem autenticação por senha. |
| NGS1.02.13 | Controle de tentativas de login | ❌ PENDENTE | Não há proteção contra brute-force nos endpoints de autenticação. Tokens são longos (256 bits) mas sem rate-limiting ou bloqueio por tentativas. |
| NGS1.02.14 | Autenticação para operações críticas | ❌ PENDENTE | Requer Estágio 3. Nenhuma operação exige reautenticação explícita. |
| NGS1.02.15 | Informações na autenticação | ❌ PENDENTE | Requer Estágio 2. Não há exibição de último login ou tentativas falhas ao usuário. `lastUsedAt` é salvo em `AuthToken`, mas não exibido. |
| NGS1.02.16 | Informações em autenticação inválida | ✅ CONFORME | Resposta de auth inválida retorna erro genérico sem especificar o motivo (token inválido vs. usuário inativo). |
| NGS1.02.17 | Revelação de credenciais na interface | N/A | Sem formulário de senha na UI. |
| NGS1.02.18 | Autenticação de dois fatores | N/A | Requer Estágio 3. Não implementado. |
| NGS1.02.19 | Uso de SALT para a senha | N/A | Sem autenticação por senha. |
| NGS1.02.20 | Bloqueio ou encerramento por inatividade | ❌ PENDENTE | Cookie tem `maxAge` de 30 dias fixo (`auth.server.ts:8`), mas sem detecção de inatividade. Não há timeout de sessão configurável no servidor. |
| NGS1.02.21 | Bloqueio por inatividade (sem encerramento) | ❌ PENDENTE | Requer Estágio 2. Não implementado. |
| NGS1.02.22 | Aviso de bloqueio ou encerramento de sessão | ❌ PENDENTE | Requer Estágio 2. Não implementado. |
| NGS1.02.23 | Segurança contra roubo de sessão | ⚠️ PARCIAL | Cookie `httpOnly`, `sameSite: lax`, `secure` em produção (`auth.server.ts:29-35`). Não há rotação explícita de identificadores de sessão ou proteção contra replay de token além do hash. |

---

### NGS1.03 — Autorização e controle de acesso

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.03.01 | Impedir acesso por pessoas não autorizadas | ✅ CONFORME | `requireUserSession` / `requireApiUser` em todas as rotas protegidas. |
| NGS1.03.02 | Perfis mínimos de usuário | ❌ PENDENTE | Existe apenas o modelo `AuthUser` com CRM. Não há distinção entre administrador, profissional de saúde e profissional administrativo. Roles/perfis não implementados. |
| NGS1.03.07 | Atribuição de mais de um perfil | ❌ PENDENTE | Sem sistema de perfis. |
| NGS1.03.08 | Gerenciamento de usuários pela aplicação | ❌ PENDENTE | Gerenciamento de usuários é feito apenas via scripts CLI (`scripts/create-auth-user.ts`, `scripts/revoke-token.ts`). Não há UI administrativa. |
| NGS1.03.09 | Identidade única da pessoa e responsabilização | ⚠️ PARCIAL | `AuthUser` tem `(crm, crmUf)` como chave única — não há CPF. `soapNotes` vincula `authorUserId`, garantindo rastreabilidade. Sem CPF e sem mecanismo de justificativa em alteração cadastral. |
| NGS1.03.10 | Usuário mínimo ativo | ❌ PENDENTE | Nenhum mecanismo impede a inativação do último administrador. |

---

### NGS1.04 — Disponibilidade do RES

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.04.01 | Geração de cópia de segurança | ⚠️ PARCIAL | `scripts/backup-v2-postgres.sh` gera dump `pg_dump` com SHA-256 de verificação (`pnpm v2:backup`). Não há agendamento nem rotina de backup automática no `docker-compose`. **Veredito a reavaliar.** |
| NGS1.04.03 | Sigilo da cópia de segurança | ❌ PENDENTE | Os dumps são gravados em texto plano sob `backups/`, sem encriptação. O SHA-256 garante integridade, não sigilo. |
| NGS1.04.04 | Restauração de cópia de segurança | ❌ PENDENTE | Não há rotina de restauração do PostgreSQL canônico no projeto. |
| NGS1.04.05 | Integridade na restauração | ❌ PENDENTE | Sem verificação de integridade na restauração. |
| NGS1.04.06 | Alerta de limiar de ocupação | ❌ PENDENTE | Sem monitoramento de espaço em disco ou alertas de limiar na aplicação. |

---

### NGS1.05 — Comunicação entre componentes do S-RES

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.05.01 | Segurança da comunicação com o usuário | ✅ CONFORME | Cookie `secure` em produção; aplicação serve HTTPS quando devidamente configurada. |
| NGS1.05.02 | Processamento de dados no lado servidor | ✅ CONFORME | Arquitetura React Router com SSR — todo processamento e validação no servidor. |
| NGS1.05.03 | Segurança da comunicação entre componentes | ⚠️ PARCIAL | Conexão PostgreSQL via `DATABASE_URL` sem configuração explícita de TLS no `.env.example`. S3 usa HTTPS. Requer: definir `sslmode` na string de conexão do PostgreSQL. |
| NGS1.05.04 | Integridade e origem de componentes dinâmicos | N/A | Sem componentes que exijam download para execução (ActiveX, Applet, etc.). |

---

### NGS1.06 — Segurança de dados

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.06.01 | Utilização de SGBD | ✅ CONFORME | PostgreSQL via Prisma para todos os dados. Arquivos em S3 com chave `sha256` como `s3Key` — sem identificação por nome/conteúdo. |
| NGS1.06.02 | Segurança de componentes que manipulam dados | ⚠️ PARCIAL | Requer Estágio 3. Não há evidência de limpeza explícita de arquivos temporários em todas as operações (ex.: OCR, importação). |
| NGS1.06.03 | Validação de dados de entrada | ✅ CONFORME | Prisma ORM previne SQL injection. React Router valida FormData no servidor. Sem evidência de uso de `eval` ou concatenação de SQL. |
| NGS1.06.04 | Segregação dos dados por organização | N/A | Sistema não opera em modo SaaS multi-tenant. |
| NGS1.06.05 | Criptografia de documentos exportados | ❌ PENDENTE | Requer Estágio 2. Sem criptografia de documentos exportados. |

---

### NGS1.07 — Auditoria

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.07.01 | Auditoria contínua | ✅ CONFORME | `AuditLog` model existe; `writeAuditLog` utilizado em operações de autenticação. Não desativável pelo usuário. |
| NGS1.07.02 | Proteção dos registros de auditoria | ⚠️ PARCIAL | Registros em DB protegidos pelo SGBD. Não há role de "auditor" — o modelo de usuário único (`AuthUser`) não distingue perfis. Qualquer usuário autenticado pode tecnicamente acessar via API. |
| NGS1.07.03 | Eventos registrados na trilha (básicos) | ⚠️ PARCIAL | Registrados: criação de usuário, criação/uso/revogação de token. **Faltam:** consulta/criação/inativação de registros clínicos (SoapNote, NarrativeNote); impressão; importação/exportação de dados; troca de senha (N/A); registro de consentimentos. |
| NGS1.07.04 | Eventos avançados na trilha | ❌ PENDENTE | Requer Estágio 3. Encerramento/bloqueio de sessão, acesso à trilha, configurações de sistema não registrados. |
| NGS1.07.05 | Informações do registro de auditoria | ⚠️ PARCIAL | `AuditLog` tem: `id`, `createdAt`, `action`, `category`, `entityType`, `entityId`, `metadata`, `userId`. **Faltam:** IP/endereço MAC do componente gerador. |
| NGS1.07.06 | Privacidade do paciente na trilha | ✅ CONFORME | Trilha armazena apenas IDs (entityId), não dados clínicos ou de identificação do paciente. |
| NGS1.07.07 | Visualização dos registros da trilha | ❌ PENDENTE | Nenhuma interface na aplicação para visualizar ou filtrar registros de auditoria. |
| NGS1.07.08 | Exportação dos registros da trilha | ❌ PENDENTE | Requer Estágio 3. Sem funcionalidade de exportação da trilha em formato aberto. |

---

### NGS1.08 — Documentação

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.08.01 | Tópicos dos manuais | ⚠️ PARCIAL | `README.md` existe com instruções básicas. Faltam: manual de usuário por perfil, manual de administração, manual de segurança, manual de instalação de componentes. |
| NGS1.08.02 | Referência à versão na documentação | ❌ PENDENTE | O `README.md` não especifica versão do software. |
| NGS1.08.03 | Operações de backup | ❌ PENDENTE | O runbook de migração (`docs/migration/README.md`) descreve os dumps do cutover, mas não há manual de backup/restauração de rotina. |
| NGS1.08.04 | Restrição de acesso a entidades não autenticadas | ❌ PENDENTE | Não documentado formalmente. |
| NGS1.08.05 | Configuração da segurança da comunicação entre componentes | ❌ PENDENTE | Não documentado (TLS entre app e PostgreSQL, S3). |
| NGS1.08.06 | Sincronização de relógio | ❌ PENDENTE | Não documentado no README. |
| NGS1.08.07 | Guarda da cópia de segurança | ❌ PENDENTE | Não documentado. |
| NGS1.08.08 | Segregação dos componentes | ⚠️ PARCIAL | `compose.yml` e `compose.dev.yml` mostram separação de serviços, mas sem diagrama de comunicação formal. |
| NGS1.08.09 | Importação de dados de dispositivos externos | N/A | Sistema não importa dados de dispositivos externos de saúde automaticamente. |
| NGS1.08.10 | Idioma | ⚠️ PARCIAL | `README.md` está parcialmente em inglês/português. Requer versão completa em pt-BR. |
| NGS1.08.11 | Recomendações de segurança | ❌ PENDENTE | Sem documentação de recomendações de configurações de segurança. |
| NGS1.08.12 | Histórico de alteração | ⚠️ PARCIAL | Histórico via commits Git e mensagens de commit. Sem `CHANGELOG.md` formal com data, responsável e impacto. |

---

### NGS1.09 — Tempo

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.09.01 | Fonte temporal | ✅ CONFORME | Todos os timestamps usam `new Date()` no servidor (Node.js). Prisma gerencia `createdAt`/`updatedAt` no servidor. |
| NGS1.09.02 | Uniformidade para exportação (RFC 3339) | ⚠️ PARCIAL | Prisma retorna objetos `Date` do Node.js. Não há verificação explícita de que todas as exportações usam formato RFC 3339. |
| NGS1.09.03 | Registro de tempo no banco de dados | ✅ CONFORME | PostgreSQL armazena `timestamp` com referência UTC. Campos `createdAt`/`updatedAt` em todos os modelos. |
| NGS1.09.04 | Uniformidade para entrada de tempo | ⚠️ PARCIAL | Não verificado na UI — necessita auditoria dos componentes de seleção de data. |
| NGS1.09.05 | Uniformidade para exibição de tempo | ⚠️ PARCIAL | Não verificado na UI — necessita auditoria dos componentes de exibição de data. |
| NGS1.09.06 | Time zone e local da instituição | ✅ CONFORME | `CLINIC_TIMEZONE_OFFSET` configurável via env. |

---

### NGS1.11 — Privacidade

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.11.01 | Concordância com termos de uso | ❌ PENDENTE | Nenhuma tela de termos de uso/privacidade na aplicação. Exigida para todos os estágios. |
| NGS1.11.08 | Contestação do paciente | ❌ PENDENTE | Requer Estágio 3. Sem funcionalidade de registro de queixas/contestações do paciente. |
| NGS1.11.11 | Anonimização | ❌ PENDENTE | Requer Estágio 2. Sem funcionalidade de anonimização. |
| NGS1.11.12 | Pseudonimização | ❌ PENDENTE | Requer Estágio 3. Sem funcionalidade de pseudonimização. |

---

### NGS1.12 — Integridade

| ID | Título | Status | Evidência / Notas |
|----|--------|:------:|-------------------|
| NGS1.12.01 | Regras para correção de dados finalizados | ❌ PENDENTE | `SoapNote` e `NarrativeNote` não possuem versionamento, controle de autor na correção, justificativa ou status de ativo/inativo. Correções sobrescrevem o registro (via `updatedAt`). |
| NGS1.12.03 | Inativação de registros clínicos finalizados | ❌ PENDENTE | Não há campo de status/inativação em `SoapNote` ou `NarrativeNote`. Sem justificativa de inativação ou exibição destacada de registros inativos. |

---

## 3.2 NGS2 — Nível de Garantia de Segurança 2 (Opcional)

> O NGS2 é opcional para a categoria Segurança da Informação. O sistema **não implementa assinaturas digitais ICP-Brasil**, portanto todos os requisitos NGS2 estão pendentes. Avaliação listada apenas para referência futura.

| Grupo | Status Geral | Notas |
|-------|:------------:|-------|
| NGS2.01 — Certificado Digital | ❌ PENDENTE | Sem integração com ICP-Brasil. |
| NGS2.02 — Assinatura Digital | ❌ PENDENTE | Sem geração de assinaturas CAdES/XAdES/PAdES. |
| NGS2.03 — Validação da Assinatura | ❌ PENDENTE | Sem validação de assinaturas digitais. |
| NGS2.04 — Carimbo de Tempo | ❌ PENDENTE | Sem integração com ACT ICP-Brasil. |
| NGS2.05 — Certificado de Atributo | ❌ PENDENTE | Sem suporte a certificados de atributo. |
| NGS2.06 — Importação, Exportação e Impressão | ❌ PENDENTE | Sem exportação de registros assinados. |
| NGS2.07 — Autenticação com Certificado Digital | ❌ PENDENTE | Sem autenticação por certificado digital. |

---

## Resumo Executivo

### Conformidade NGS1 por grupo (Estágio 1)

| Grupo | ✅ Conforme | ⚠️ Parcial | ❌ Pendente | N/A |
|-------|:-----------:|:----------:|:-----------:|:---:|
| NGS1.01 — Controle de versão | 0 | 0 | 1 | 0 |
| NGS1.02 — Autenticação | 2 | 2 | 5 | 14 |
| NGS1.03 — Controle de acesso | 1 | 1 | 4 | 0 |
| NGS1.04 — Disponibilidade | 0 | 1 | 4 | 0 |
| NGS1.05 — Comunicação | 2 | 1 | 0 | 1 |
| NGS1.06 — Segurança de dados | 2 | 1 | 1 | 1 |
| NGS1.07 — Auditoria | 2 | 3 | 3 | 0 |
| NGS1.08 — Documentação | 0 | 3 | 8 | 1 |
| NGS1.09 — Tempo | 3 | 3 | 0 | 0 |
| NGS1.11 — Privacidade | 0 | 0 | 4 | 0 |
| NGS1.12 — Integridade | 0 | 0 | 2 | 0 |
| **Total** | **12** | **15** | **32** | **17** |

---

## Prioridades para Certificação Estágio 1

### 🔴 Crítico — Bloqueante para qualquer estágio

1. **NGS1.02.01** — Implementar tela de login com usuário/senha (ou outra modalidade reconhecida)
2. **NGS1.01.01** — Exibir versão do software na UI e nos documentos
3. **NGS1.02.20** — Implementar timeout de sessão por inatividade (configurável)
4. **NGS1.03.02** — Implementar sistema de perfis (admin, profissional de saúde, administrativo)
5. **NGS1.03.08** — Interface de gerenciamento de usuários na aplicação
6. **NGS1.07.03** — Expandir trilha de auditoria para cobrir operações clínicas
7. **NGS1.07.07** — Interface de visualização da trilha de auditoria
8. **NGS1.11.01** — Implementar tela de termos de uso e privacidade
9. **NGS1.12.01** — Implementar versionamento e correção com justificativa em registros clínicos
10. **NGS1.12.03** — Implementar inativação (não exclusão) de registros clínicos com justificativa

### 🟡 Importante — Necessário para estágio 1/2

11. **NGS1.03.09** — Adicionar CPF como identificador único de usuário
12. **NGS1.07.05** — Adicionar IP de origem aos registros de auditoria
13. **NGS1.08.01** — Criar documentação completa (manuais de usuário, admin, segurança)
14. **NGS1.05.03** — Configurar TLS (`sslmode`) na conexão PostgreSQL

### 🟢 Complementar — Para estágio 2/3

15. **NGS1.02.15** — Exibir informações de último login
16. **NGS1.06.05** — Criptografia de documentos exportados
17. **NGS1.07.08** — Exportação da trilha de auditoria
18. **NGS1.11.11** — Anonimização de pacientes
