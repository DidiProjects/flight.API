# flight.API

REST API Fastify do monitoramento de voos. Arquitetura completa — scheduler,
webhook, ciclo de avaliação, env vars — em `docs/architecture.md`.

Regras gerais (autonomia, commits, testes, comentários) vivem em `~/.claude/`.
Aqui só o que é armadilha **deste** repositório.

## Padrão de módulo

Módulo novo segue exatamente esta forma, e é registrado no `container.ts` e no
`app.ts`:

```
interfaces/I<Domain>Repository.ts
interfaces/I<Domain>Service.ts
<Domain>Repository.ts    ← implements a interface, recebe Pool no construtor
<Domain>Service.ts       ← implements a interface, recebe repositórios no construtor
route.ts                 ← factory(service) → plugin Fastify
schema.ts                ← Zod
```

Repositório não fala com a rede. Quem abre socket é service.

## Armadilhas medidas

- **`NUMERIC` volta do pg como string.** `"4921.00" + "7627.00"` concatena, vira
  `NaN` e some do JSON. Coagir com `Number()` antes de somar ou comparar.
- **Senhas só com `bcryptjs` (12 rounds)** via `src/utils/crypto.ts`. Nunca
  PBKDF2 — o banco usa pgcrypto/bcrypt e os hashes precisam bater.
- **`tsconfig.json` exclui `**/*.test.ts`**: erro de tipo em teste não aparece
  no `npm run typecheck`. Só rodando os testes.
- **Zod 3 aqui, Zod 4 no flight.FRONT.** A forma de função no 2º argumento do
  `.refine` vale aqui e **não** vale lá — portar validação sem ajustar devolve
  "Invalid input".

## Variável de ambiente nova

Adicionar nos três lugares, senão quebra em produção: `src/config/env.ts` (Zod),
`.env` e o step `docker run` do `deploy.yml`.

## Banco

O schema é do projeto `flight.DB`. Mudança de coluna ou índice se resolve lá
primeiro — ver `~/.claude/` e o `CLAUDE.md` daquele repo.
