Essa projeto foi feito com intuito de separarmos responsabilidades, de forma que a scraping.API seja responsável por receber comandos para raspagem de dados e devolver suas resoluções.

Agora precisamos projetar a flight.API e o flight.DB. Vamos criar um documento ? se necessário te mostrar como estava a versão antiga desse projeto me avise que troco de branch.


A flight.API será uma aplicação node, com autenticação via apikey, sustentará as seguintes funcionalidades:

1. Gestão de usuário;
Os usuários poderam solicitar cadástro informando o email, o admin poderá autorizar esse cadástro especificando as roles (inicialmente admin e user) e o usuário receberá um email com uma senha provisória, que deverá ser alterada antes de liberarmos o acesso a todas as funcionalidades. Podemos fazer um controle de estado no banco de dados. vamos ter um link para recuperar a senha que refaz esse processo.

2. O Usuário deve conseguir criar rotinas para análise de pressos das passagens.
Devemos listar as companias aérias que temos disponíveis, para que ele possa selecionar;
Um usuário pode criar mais de uma rotina, podemos limitar inicialmente 10 por usuário;
ele poderá selecionar o tipo de notificação:
frequência de notificação (campo obrigatório):
  1. se vai ser por hora, dia, mês.
  2. target: ser notificado apenas quando target for superado (melhor preço em dinheiro, pontos, ou híbrido)
  3. O usuário vai poder definir a prioridade entre os trés.
  4. O usuário pode fornecer as duas opções:
    1.  receber um email com o melhor preço do dia em relação ao target (informando os dois) + um aviso quando o target for superado;
    2.  receber um email sempre que o target e melhor preço for superado;
    3.  receber um email apenas no final do período informado, quando tatermos um determinado horário (não mais após 20 análises)
definir emails em cc, o disparo vai para o email principal.

sempre que enviarmos um email, ele irá com um link para desinscrever, com um token na rota. esse token deve autorizar apenas a rota de desinscrever email e ele deve vencer após o período de uma hora do envio. deve ser possível desinscrever o email principal e as cópias separadamente.

independênte do período de notificação, a solicitação da análise dos dados aérios ocorrerá em um período determinado (via .env, default uma hora). porém para evitar detecção de bot, vamos adicionar margens randômicas nesse período. Como foi definido pela arquitetura, vamos mandar essas requests pro scraping.API com identificador e quando o scraping responder vamos armazenar as informações.

Quero configurações de rotinas de notificações segregadas dos dasdos de análise do melhor preço. porém ambos amarrados ao usuário.
Quando mandarmos uma análise pro scraping, vamos ficar com seus parâmetros armazenados em banco com ststus de pendente e criar um fallback para remove-lo caso não seja concluído no período de uma hora. A api deve ter inteligência para determinar se uma raspagem foi concluída com sucesso ou não. por exemplo, uma passagem com valor vazio não deve significar de graça e sim que o valor não foi obtido, se não for possível obter nenhum valor (dinheiro, ponto ou híbrido) essa pasagem deve ser descartada.

vamos manter um histórioco de análise, armazenando as 100 melhores passágens.

vamos armazenar todos os dados das passágens que salvávamos no state.json. incluindo as informações necessárias para compor o email.

vamos manter o mesmo layout do email, informando o melhor preço.

cada passágem deve ter um registro específico, podendo ser de ída ou de volta, de acordo com a análise;
vamos segregar a melhor massagem do histórico, mantendo um estado.

quero meu banco de dados em postgree.

