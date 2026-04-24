# Memory Index, flight.API

## Geral
- [Perfil do usuário](user-profile.md), Diego: dev TypeScript, iterativo, PT-BR, headless false, respostas curtas
- [Preferências de desenvolvimento](feedback-dev-style.md), autonomia total, snapshots de diagnóstico, README como canal de instruções técnicas

## Novos projetos (design aprovado)
- [Design flight.API + flight.DB](flight-api-design.md), schema, rotas, fluxo de scrape, decisões aprovadas

## Projeto legado (branch antiga, antes da separação)
- [flight.API legado](flight-api-legacy.md), state.json completo, lógica de notificação, template de email, deep-link Azul, o que muda no novo sistema

## scraping.API (servidor)
- [Contrato da API e tipos](scraping-api-server.md), rotas, ScrapeRequest/ScrapeResult/FlightOffer completos, callback assíncrono, env vars, estrutura de logs

## Azul (voeazul.com.br)
- [Arquitetura do scraper](azul/scraper-architecture.md), stack, ordem exata do fluxo, arquitetura de buscas, coleta de dados, estado atual do código
- [Seletores DOM confirmados](azul/dom-structure.md), HTML real de cada elemento interativo, campo datas DDMMYYYY, booking-calendar, botões moeda, tsx/esbuild __name warning
