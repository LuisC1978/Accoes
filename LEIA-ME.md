# Carteira Acções: PWA para Android

## 1. Chaves grátis (5 min)
- **Twelve Data** (obrigatória, dá cotações e histórico diário para os EUA e para a Euronext Lisboa): regista-te em https://twelvedata.com e copia a chave em *API Keys*. O plano grátis dá 8 pedidos/min e 800/dia.
- **Finnhub** (opcional, dá notícias de ações dos EUA): https://finnhub.io, e a chave está no *Dashboard*.

Confirma no teu plano Twelve Data que o PSI20 (mic_code XLIS) está incluído. Se não estiver, a app mostra o erro devolvido pela API.

## 2. Pôr a app online grátis (GitHub Pages)
1. Cria uma conta em https://github.com e um repositório novo, por exemplo `accoes` (público).
2. Em *Add file → Upload files* arrasta todos os ficheiros desta pasta (index.html, app.js, engine.js, sw.js, manifest.webmanifest, icon-192.png, icon-512.png) e faz *Commit*.
3. Vai a *Settings → Pages*, escolhe *Branch: main / root* e depois *Save*. Em 1–2 min fica em `https://<utilizador>.github.io/accoes/`.

## 3. Instalar no Android
Abre esse link no Chrome, toca em ⋮ e depois em **Instalar app** (ou *Adicionar ao ecrã principal*). A app abre em ecrã inteiro com ícone próprio.

## 4. Usar
1. Em **Definições**, cola as chaves e define a liquidez (EUR), o risco por operação, o peso máximo e o stop-loss.
2. Em **Carteira**, usa *+ Posição* (ticker, quantidade, preço médio). Para o PSI20 usa o sufixo `:XLIS` (ex. `GALP:XLIS`, `EDP:XLIS`, `BCP:XLIS`, `JMT:XLIS`). Depois toca em **Analisar carteira**.
3. Em **Top 5**, edita a watchlist e toca em **Calcular Top 5**.
4. Em **🤖 Claude**, toca em *Partilhar* e escolhe a app Claude (ou *Copiar* e colar). O pedido leva os indicadores, as notícias e a decisão das regras, e pede ao Claude que confirme com notícias atuais e escreva os sumários das Top 5.

## Radar de risco (separador 🚨 Risco)
Mede a fragilidade de cada grupo de ações (Semicondutores, Infraestrutura IA, etc., mais "Mercado EUA" e "PSI20" automáticos) e dá uma pontuação de 0 a 100: Baixo, Moderado (≥20), Elevado (≥40), Alto (≥60).
- **Sinais:** grupo abaixo da EMA50/EMA200, poucas ações acima da EMA50 (amplitude), amplitude a cair depressa, divergência (índice perto do máximo com amplitude fraca), dias de distribuição, volatilidade a expandir, correlação a subir, fraqueza face ao mercado, queda rápida em 5 sessões.
- **Teste histórico:** para cada nível mostra quantas vezes o grupo caiu a seguir, as quedas passadas e quando surgiu o alerta, e que sinais funcionaram.
- **Efeito nas decisões** (desliga-se em Config): risco Elevado corta as compras a metade; risco Alto suspende compras, tira a ação do Top 5 e sugere apertar o stop. Só se aplica se o teste histórico do grupo mostrar que o radar distinguiu as quedas, e só com radar calculado há menos de 4 dias.
- **Atualizar radar** descarrega a carteira, a watchlist e os grupos (1 crédito por ação ainda não descarregada hoje). Depois de "Calcular Top 5" o radar recalcula-se sozinho com o que já está em cache.
- Os grupos editam-se em **Config → Grupos do radar**.
- O radar não prevê a notícia que desencadeia a queda. Avisa quando o grupo está frágil, normalmente nos primeiros dias da queda.

Ao atualizar, carrega também o **risk.js**, que é um ficheiro novo.

## Modelo histórico (separador 🧪 Modelo)
Faz o treino uma vez por semana. A app descarrega ~4 anos por ação da carteira e da watchlist (1 crédito cada; com 44 ações demora ~6 min). O primeiro ano serve de aquecimento da EMA200, os ~2 anos seguintes servem para treinar e o último ano para validar sem batota.
- **Veredicto** moderado / fraco / nulo, conforme o modelo ordenou as ações melhor do que o acaso no ano de validação.
- Com veredicto moderado ou fraco, o modelo **suspende compras** em ações do quintil 1–2 e **ordena o Top 5** pela sua previsão. Com veredicto nulo, fica só como informação.
- **Aplicar limiares calibrados**: substitui 35/−35 pelos limiares com melhor Sharpe no treino. Confirma primeiro que a linha "validação" também melhora.
- **🤖 Claude** envia as métricas, as previsões e a carteira para uma análise crítica com notícias.

Ao atualizar, carrega também o **model.js**, que é um ficheiro novo.

## Como decide
- Pontuação de −100 a +100, que soma: EMA13/50/100/200 diárias (posição do preço, cruzamentos, inclinação), RSI14, MACD 12/26/9, Bollinger 20/2 (%B, squeeze), volume vs média de 20 dias e sentimento das notícias.
- **Comprar** quando a pontuação é ≥ ao limiar de compra (35). A quantidade é o menor destes três valores: risco % da carteira ÷ (2×ATR14), espaço até ao peso máximo, liquidez. Com convicção moderada (< limiar+25) fica meia posição.
- **Vender 1/3** quando a pontuação é ≤ ao limiar de venda (−35). **Vender tudo** quando é ≤ 1,7× o limiar, ou quando a perda passa o stop-loss com o preço abaixo da EMA200.
- **Realizar 25%** quando o ganho passa o limite com RSI > 75 e o preço está acima da banda superior.
- Nos restantes casos, **Manter** (com a posição) ou **Aguardar** (sem posição).

Os dados ficam só no teu telemóvel (localStorage). Usa *Exportar dados* para ter uma cópia de segurança.
Esta ferramenta é apoio à decisão e não é aconselhamento financeiro. Os dados grátis podem vir com atraso, por isso confirma sempre no TradingView/broker.
