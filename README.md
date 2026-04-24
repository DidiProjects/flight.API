Novas instruções:

procurar pelo elemento:
<input placeholder="Digite" role="combobox" aria-expanded="false" aria-label="Origem" aria-autocomplete="none" autocomplete="off" data-cy="autocomplete-desktop-input" id=":r3:" title="" required="" class="sc-hIUJlX hXJaFA" value="">

clicar nele e digitar e digitar o código do aeroporto

após digitar o código deve ser encontrado em uma das opções, mo meu exemplo o código é o "LIS":

<button type="button" role="option" aria-selected="false" tabindex="-1" data-cy="autocomplete-options-item-2" class="sc-brPLxw bJuQVm"><div class="sc-iMWBiJ cqQfaE"><b class="sc-fvtFIe ievJRl">LIS</b><div class="sc-bBeLUv bekRhU"><span class="sc-ihgnxF jkqciY">Lisboa</span></div></div></button>

encontrado o button que contém o código vamos clicar nele

para selecionar o destino faremos a mesma coisa:

<input placeholder="Digite" role="combobox" aria-expanded="false" aria-label="Destino" aria-autocomplete="none" autocomplete="off" data-cy="autocomplete-desktop-input" id=":r4:" title="" required="" class="sc-hIUJlX hXJaFA" value="">

<button type="button" role="option" aria-selected="false" tabindex="-1" data-cy="autocomplete-options-item-2" class="sc-brPLxw bJuQVm"><div class="sc-iMWBiJ cqQfaE"><b class="sc-fvtFIe ievJRl">PLU</b><div class="sc-bBeLUv bekRhU"><span class="sc-ihgnxF jkqciY">Belo Horizonte - Pampulha</span></div></div></button>

selecionados a origem e destino, vamos para data:


temos como entrada um range de datas e voos de ida e volta, porém em nossa pesquisa vamos considerar apenas voos de ída, dessa forma vamos procurar e clicar no campo:

<input placeholder="Selecione" id=":r8:" aria-label="Datas (Ida e volta)" aria-autocomplete="none" title="" required="" class="sc-hIUJlX hXJaFA" value="">

digitar a data no formato Brasileiro, apenas númveros (exmplo pro dia 11/15/1993 seria 11151993 digitado!)


clique no botão que contém o texto: "Buscar passagens":

<button type="button" class="sc-eqUAAy iNxtop sc-lnrzcU iouhCu sc-gEvEer iSglkT">Buscar passagens</button>

após vamos te rum estado de loading, que vai se encerrar quando encontrarmos um:
<p class="results">10 voos encontrados</p>
com os resultados, lembrando que o valor numérico pode mudar.

Nesse momento vamos visualizar as passagen mas primeiramente, vamos ter um 

<div class="booking-calendar__cards css-77i9f"><div height="96" class="styles__CarouselWrapper-sc-3qprdy-0 fcjoTQ"><div height="96" class="styles__Carousel-sc-3qprdy-1 ktAbfz"><div><button type="button" aria-hidden="true" aria-label="sex  01/05 valor da menor tarifa do dia , selecionar" class="css-17h89v5"><span aria-hidden="true">sex  01/05</span><span aria-hidden="true" class="item-value"></span></button></div><div><button type="button" aria-hidden="true" aria-label="sáb  02/05 valor da menor tarifa do dia , selecionar" class="css-17h89v5"><span aria-hidden="true">sáb  02/05</span><span aria-hidden="true" class="item-value"></span></button></div><div><button type="button" aria-hidden="true" aria-label="dom  03/05 valor da menor tarifa do dia , selecionar" class="css-17h89v5"><span aria-hidden="true">dom  03/05</span><span aria-hidden="true" class="item-value"></span></button></div><div><button type="button" aria-hidden="true" aria-label="seg  04/05 valor da menor tarifa do dia , selecionar" class="css-bxfdb3"><span aria-hidden="true">seg  04/05</span><span aria-hidden="true" class="item-value"></span></button></div><div><button type="button" aria-hidden="true" aria-label="ter  05/05 valor da menor tarifa do dia , selecionar" class="css-17h89v5"><span aria-hidden="true">ter  05/05</span><span aria-hidden="true" class="item-value"></span></button></div><div><button type="button" aria-hidden="true" aria-label="qua  06/05 valor da menor tarifa do dia , selecionar" class="css-17h89v5"><span aria-hidden="true">qua  06/05</span><span aria-hidden="true" class="item-value"></span></button></div><div><button type="button" aria-hidden="true" aria-label="qui  07/05 valor da menor tarifa do dia , selecionar" class="css-17h89v5"><span aria-hidden="true">qui  07/05</span><span aria-hidden="true" class="item-value"></span></button></div></div></div></div>

onde cada button será para mudarmos a data de consulta, será últil para consultarmos diferentes dias no período de pesquisa definido

mais a baixo temos: 

<button type="button" aria-label="Pontos" value="score" class="css-6fpksg">Pontos</button>
<button type="button" aria-label="Reais" value="currency" class="css-6fpksg">Reais</button>

para alterar na view entre Pontos e Real, sendo possível obter ambas as informações.

Eu quero que você obtenha os valores pertinentes de cada passagem, como valor em R$, em pontos pontos (apenas em pontos e o híbrido pontos e reais)
Eu quero a duração
hora de embarque e desembarque
número de escalas.

Armazene todas as informações das passágens visíveis em arquivos js e armazene nos nossos resultados. depois vamos tomar a decisão do que fazer com eles.

continue versionando meus resultados, quero que leia os snapshots em hmtl para chegarmos em nossos resultados;

mudanças de todas:

  vamos realizar pesquisa de preço para ida e volta separadamente, primeira a de ída como passagem sem volta, depois a de volta como passagem sem volta. dessa forma não vamos utilizar o campo Data de volta (opcional) por enquanto,

  Vamos mudar os campos de entrada: 
  
  target: Valor inteiro;
  currency: pode reser especificação da moeda ou pontos (para milhas), campo obrigatório e por default será Real;

  vamos manter esses parâmetros mas não mais precisamos especificar pontos, apenas moeda, isso pois para todas as pesquisas vamos devolver valor em real (no caso da azul) em pontos e híbrido pontos e real.

  Como pela azul temos opções de navegar entre diferentes datas, vamos explorar após a pesquisa inicial (selecionando no datapicker o começo do período de interesse para a ída e o fim do período de interesse para a volta) as demais datas de interesse, uma por uma e armazenando os resultados, através do booking-calendar. Muita atenção nesse ajuste, temos como entrada um range de datas de ida e um range para a volta, eu quero pequisar as datas limites e pela tela ir navegando nas demais opções. se meu range de ída é: (2026-05-25 e 2026-05-27), eu vou pesquisar 2026-05-25 e vou navegar até a data "qui 27/05" armazenando os resultados. ao pesquisar o voo de volta seria exatamente a mesma coisa.

  após coletar todos os dados da passagem de ída, devemos prosseguir para data de volta, para tanto vamos refazer a pesquisa, considerando a passágem de volta como ida.


tentar solução playwright-camoufox
