# flight.API — Instruções para Claude

## Arquitetura

- **Deploy:** GitHub Actions → build Docker image local → push via Tailscale SSH → `docker run` no servidor Linux
- **Banco:** gerenciado pelo projeto `flight.DB` (schema + seed via init-scripts do PostgreSQL)
- **Rede Docker:** `flight-network` conecta `flight-api` e `flight-db`

## Início de cada sessão

1. Ler `memory/MEMORY.md`
2. Ler os arquivos de memória relevantes ao trabalho da sessão

## Final de cada sessão

Atualizar memória com o que foi aprendido — preferências, decisões de arquitetura não óbvias, contexto de projeto.

## Regras permanentes

### Dados sensíveis na memória
NUNCA armazenar na memória: credenciais, senhas, tokens, API keys, dados pessoais ou qualquer informação que identifique pessoas reais. A memória fica versionada no git.

### Autonomia
Operar com máxima autonomia. Não pedir confirmação a não ser em risco real de perda de dados irreversível.

### Padrão de módulo
Ao adicionar novos módulos seguir sempre:
```
interfaces/I<Domain>Repository.ts
interfaces/I<Domain>Service.ts
<Domain>Repository.ts    ← implements interface, recebe Pool via construtor
<Domain>Service.ts       ← implements interface, recebe repositórios via construtor
route.ts                 ← factory function(service) → Fastify plugin
schema.ts                ← Zod schemas
```
Registrar no `container.ts` e no `app.ts`.

### Senhas
Usar sempre `bcryptjs` (12 rounds) via `src/utils/crypto.ts`. Nunca PBKDF2 — o banco usa pgcrypto/bcrypt e os hashes precisam ser compatíveis.

### Variáveis de ambiente
Toda nova variável deve ser adicionada ao `src/config/env.ts` (Zod), ao `.env`, e ao step `docker run` do `deploy.yml`.
