Novas regras para best_fares.

Toda vez que uma rotina for executada, manualmente ou por horário agendado, ela será responsável por atualizar a referência de melhores preços:
1. Devemos consultar os melhores preços amarrados a rotina;
2. Todos os melhores preços não contidos no resultado da análise, não terão sua data atualizada e por isso serão ignorados nas notificações de melhor preço;
  a. Aqui poderíamos filtrar os melhores preços por código do voo também, não só pela data. Para garantirmos que vamos atualizar a fares certas e descartar as expiradas;
  b. Para a notificação. a ideia é agrupar os melhores preços por momento de última análise e notificar os resultados de análises mais recentes;
  c. Para consultas vazias, esperamos não atualizar nada e dessa forma a notificação será da análise que obteve resultados;
3. Para as notificações, caso o best_fares mais recente não seja atualizado por mais de um dia, vamos ignora-lo.
4. Qeuro uma análise crítica de negócio dessa solução, de acordo com os modelos do mercado. Qual seria a melhor experiência para esse fluxo?