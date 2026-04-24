# flight.API, Instruções para Claude

## Arquitetura atual (2026-04-21)

- **Sem Docker**, scraper roda direto com Node.js 22 no servidor via SSH
- **Deploy:** GitHub Actions → rsync → `npm ci` → `npm start`
- **AI Fallback:** quando `npm start` falha com erro real (não consulta vazia) →
  GHA executa `npm run ai-fix` → `src/agent.ts` usa Claude API (claude-sonnet-4-6)
  para diagnosticar, corrigir `azul.ts`, retestar e commitar automaticamente
- **Secret necessário no GHA:** `ANTHROPIC_API_KEY`
- **Servidor:** precisa de git configurado com push access ao repo

## Início de cada sessão

1. Ler `memory/MEMORY.md` (índice da memória persistente)
2. Ler os arquivos de memória relevantes ao trabalho da sessão:
   - `memory/azul/scraper-architecture.md`, fluxo e arquitetura da Azul
   - `memory/azul/dom-structure.md`, seletores DOM confirmados da Azul
   - `memory/feedback-dev-style.md`, preferências de autonomia/diagnóstico
3. Ler `README.md` completo, pode conter novas instruções técnicas sobre DOM, seletores ou fluxo

## Final de cada sessão (ou quando tokens estiverem acabando)

Atualizar a memória com tudo que foi aprendido na sessão:
- Novos seletores DOM da Azul → `memory/azul/dom-structure.md`
- Mudanças de arquitetura ou fluxo da Azul → `memory/azul/scraper-architecture.md`
- Para nova companhia aérea → criar `memory/<companhia>/` com seus próprios arquivos
- Preferências ou feedbacks do usuário → `memory/feedback-dev-style.md`
- Atualizar `memory/MEMORY.md` se novos arquivos foram criados

## Regras permanentes deste projeto

### Dados sensíveis na memória
NUNCA armazenar na memória: credenciais, senhas, tokens, API keys, dados pessoais (CPF, passaporte, cartão), ou qualquer informação que possa identificar pessoas reais.
A memória fica versionada no git, dados sensíveis não devem entrar no histórico.

### tsx + page.evaluate
NUNCA usar `function nomeFuncao()` dentro de callbacks de `page.evaluate` ou `page.waitForFunction`.
tsx 4.x compila com `keepNames:true` → injeta `__name` que não existe no contexto do browser.
**Usar:** abordagem iterativa com `stack` array, ou arrow functions anônimas sem nome de variável.

### Diagnóstico
Sempre salvar snapshots HTML em `results/RUN_DIR/snapshots/` após cada etapa importante.
Em falha: salvar `debug-*.png` + `dom-*.html` em `results/RUN_DIR/errors/`.
Nunca remover lógica de snapshot, é essencial para depurar seletores.

### Autonomia
Operar com máxima autonomia. Não pedir confirmação a não ser em risco real de perda de dados irreversível.

### Seletores
Não reinventar seletores. Usar os do `memory/azul/dom-structure.md` confirmados via DevTools.
Se o README tiver novos seletores, eles têm prioridade, são observações diretas do site.
