# Carteira Acções: PWA para Android

## 1. Chaves grátis (5 min)
- **Twelve Data** (obrigatória, dá cotações e histórico diário para os EUA e para a Euronext Lisboa): regista-te em https://twelvedata.com e copia a chave em *API Keys*. O plano grátis dá 8 pedidos/min e 800/dia.
- **Finnhub** (opcional, dá notícias de ações dos EUA): https://finnhub.io, e a chave está no *Dashboard*.

Confirma no teu plano Twelve Data que o PSI20 (mic_code XLIS) está incluído. Se não estiver, a app mostra o erro devolvido pela API.

## 2. Pôr a app online grátis (GitHub Pages)
1. Cria uma conta em https://github.com e um repositório novo, por exemplo `accoes` (público).
2. Em *Add file → Upload files* arrasta todos os ficheiros desta pasta (index.html, app.js, engine.js, model.js, adaptive.js, sw.js, manifest.webmanifest, icon-192.png, icon-512.png) e faz *Commit*.
3. Vai a *Settings → Pages*, escolhe *Branch: main / root* e depois *Save*. Em 1–2 min fica em `https://<utilizador>.github.io/accoes/`.

## 3. Instalar no Android
Abre esse link no Chrome, toca em ⋮ e depois em **Instalar app** (ou *Adicionar ao ecrã principal*). A app abre em ecrã inteiro com ícone próprio.

## 4. Usar
1. Em **Definições**, cola as chaves e define a liquidez (EUR), o risco por operação, o peso máximo e o stop-loss.
2. Em **Carteira**, usa *+ Posição* (ticker, quantidade, preço médio). Para o PSI20 usa o sufixo `:XLIS` (ex. `GALP:XLIS`, `EDP:XLIS`, `BCP:XLIS`, `JMT:XLIS`). Depois toca em **Analisar carteira**.
3. Em **Top 5**, edita a watchlist e toca em **Calcular Top 5**.
4. Em **🤖 Claude**, toca em *Partilhar* e escolhe a app Claude (ou *Copiar* e colar). O pedido leva os indicadores, as notícias e a decisão das regras, e pede ao Claude que confirme com notícias atuais e escreva os sumários das Top 5.

## Modelo histórico (separador 🧪 Modelo) — versão 2
Faz o treino uma vez por semana. A app descarrega ~4 anos por ação da carteira, da watchlist e do **universo de controlo** (Definições), mais o QQQ (1 crédito cada).
- **Validação walk-forward:** a cada 20 sessões, o modelo é re-treinado só com o passado (janela de ~3 anos, com 20 sessões de intervalo) e prevê o período seguinte. Isto dá ~20–25 períodos independentes em vez de um único ano.
- **Indicadores comparados entre ações no mesmo dia:** o modelo aprende quem vai render mais do que as outras, não o nível do mercado. Saíram 3 indicadores redundantes (EMA50 vs EMA200, EMA13 vs EMA50, largura de Bollinger).
- **Veredicto exigente:** só é **moderado** com IC > 0,03, t ≥ 2 (simples e Newey-West) em ≥ 12 períodos e quintis ordenados. Só nesse caso o modelo trava compras em Q1–Q2 e ordena o Top 5. **Fraco** e **nulo** ficam só como informação.
- **Carteira simulada** do top 20% com custos, comparada com o universo em igual peso e com o QQQ.
- **Limiares calibrados:** o botão *Aplicar* só fica ativo se a validação melhorar o Sharpe em ≥ 0,1.
- **Universo de controlo:** junta em Definições ações que não escolheste (incluindo algumas que caíram). Reduz o enviesamento de sobrevivência e torna o veredicto mais confiável.

Um modelo treinado na versão anterior é descartado automaticamente: treina de novo depois de atualizar.

## Como decide
- Pontuação de −100 a +100, que soma: EMA13/50/100/200 diárias (posição do preço, cruzamentos, inclinação), RSI14, MACD 12/26/9, Bollinger 20/2 (%B, squeeze), volume vs média de 20 dias e sentimento das notícias. Com a **pontuação adaptativa** ativa, o peso de cada regra é reajustado todos os dias (ver abaixo).
- **Comprar** quando a pontuação é ≥ ao limiar de compra (35). A quantidade é o menor destes três valores: risco % da carteira ÷ (2×ATR14), espaço até ao peso máximo, liquidez. Com convicção moderada (< limiar+25) fica meia posição.
- **Vender 1/3** quando a pontuação é ≤ ao limiar de venda (−35). **Vender tudo** quando é ≤ 1,7× o limiar, ou quando a perda passa o stop-loss com o preço abaixo da EMA200.
- **Realizar 25%** quando o ganho passa o limite com RSI > 75 e o preço está acima da banda superior.
- Nos restantes casos, **Manter** (com a posição) ou **Aguardar** (sem posição).

## Pontuação adaptativa (v5.1)
- Os 16 componentes da pontuação (EMA200, EMA50, cruzamentos, RSI, MACD, Bollinger, volume…) têm pesos que a app **reajusta todos os dias** com os últimos 3 anos de histórico: cada novo fecho completa o resultado a 20 sessões de um dia passado, que entra no cálculo. Os indicadores de hoje entram na pontuação de hoje.
- Há pesos **comuns** e pesos **por ação**. Os pesos por ação partem dos comuns e só se afastam quando o histórico da ação o justifica (em 3 anos cada ação tem só ~37 períodos independentes de 20 dias, pouco para 16 pesos).
- A app testa 6 variantes em walk-forward contra os pontos originais. Em modo **Automático** (Definições), só usa a pontuação adaptativa se a melhor variante previr melhor do que a original com t ≥ 2. A validação repete-se sozinha a cada 5 sessões.
- No cartão de cada ação vês a pontuação adaptativa e a original. Em *Componentes da pontuação* vês cada regra com os pontos originais → ajustados.
- As notícias entram com peso fixo (não há histórico de notícias para as ajustar).

## Histórico guardado no telemóvel (v5.1)
- A app guarda o histórico diário de cada ação (IndexedDB, até ~6 anos) e **só descarrega as sessões em falta**. Depois do fecho, não volta a pedir nada até à sessão seguinte; com o mercado aberto, atualiza no máximo a cada 15 minutos.
- Treinar o modelo usa o histórico guardado: se já analisaste as ações nesse dia, não gasta créditos.
- Se a Twelve Data ajustar o histórico (por exemplo, um split), a app deteta a diferença e volta a descarregar essa ação.
- Sem rede, a app usa o histórico guardado e avisa.
- Definições → *Apagar histórico* obriga a descarregar tudo de novo.

## Versão
O número da versão aparece no topo da app, ao lado do título (ex. **v5.1**), e em Definições. Se algum ficheiro ficou por atualizar, aparece a vermelho com ⚠ e Definições diz qual. Se continuares a ver a versão antiga, fecha e volta a abrir a app (a primeira abertura depois de atualizar ainda pode usar a cópia guardada).

## Novidades nas decisões (versão 4)
Ao atualizar no GitHub, substitui todos os ficheiros (index.html, app.js, engine.js, model.js, adaptive.js, sw.js).
- **Stop fixo duro:** vende quando a perda atinge o stop-loss (já não exige também o preço abaixo da EMA200).
- **Stop móvel:** indica a *data de entrada* (✎ na posição) e a app vende se o preço cair X% abaixo do máximo desde essa data (Definições → Stop móvel).
- **Stop manual:** em ✎ podes definir o nível do stop de cada posição (ex. um suporte). Substitui o stop fixo; o stop móvel só o pode subir.
- **REVER TESE:** se uma posição já estava abaixo do stop quando a app a começou a acompanhar, a app não manda vender automaticamente — a perda já aconteceu. Mostra REVER TESE até decidires: vendes, ou manténs com um stop manual abaixo do preço atual. As posições que já tinhas passam a ser acompanhadas a partir do dia da atualização.
- **Alerta** quando uma posição está a menos de 3% do stop.
- **Peso máximo:** vende o excesso quando uma posição passa o peso máximo (+5% de tolerância).
- **Filtro de regime:** com o QQQ abaixo da EMA200 (risk-off), a app não propõe compras novas.

Os dados ficam só no teu telemóvel (localStorage). Usa *Exportar dados* para ter uma cópia de segurança.
Esta ferramenta é apoio à decisão e não é aconselhamento financeiro. Os dados grátis podem vir com atraso, por isso confirma sempre no TradingView/broker.
