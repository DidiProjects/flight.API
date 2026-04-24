---
name: Preferências e estilo de desenvolvimento do Diego
description: Como o Diego quer trabalhar, autonomia, iteração, diagnóstico, comunicação
type: feedback
---
Trabalhar com máxima autonomia. Não interromper para confirmações a não ser em risco real de perda de dados irreversível.

**Why:** O usuário quer iteração rápida sem ter que aprovar cada ação.

**How to apply:** Executar diretamente. Só pausar se houver risco real (ex: apagar branch remota, deletar dados de produção).

---

Ao encontrar erros de automação, sempre salvar snapshots HTML + screenshot PNG na pasta `results/.../errors/` (ou `snapshots/`) para diagnóstico posterior.

**Why:** O usuário usa esses arquivos para analisar problemas com o Claude.

**How to apply:** Nunca remover lógica de snapshot/debug do scraper. Adicionar snapshots em pontos-chave do fluxo.

---

O usuário fornece informações sobre a estrutura do DOM no README.md do projeto.

**Why:** É a forma dele comunicar o que viu no DevTools sem precisar explicar verbalmente.

**How to apply:** Sempre ler o README.md completo ao iniciar sessão, pode conter instruções técnicas novas sobre seletores, fluxos ou comportamento do site.

---

Respostas curtas e diretas em português brasileiro. Não explicar o que foi feito, o usuário vê o diff.

**Why:** Preferência explícita do usuário.

**How to apply:** Uma ou duas frases no máximo ao terminar uma tarefa.
