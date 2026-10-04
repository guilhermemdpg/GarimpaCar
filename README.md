# GarimpaCar

Aplicação local para pesquisar e classificar anúncios reais de veículos. A primeira fonte implementada é a API oficial do Mercado Livre.

## Rodar localmente

Requisitos: Node.js 20 ou superior.

1. Copie `.env.example` para `.env`.
2. Preencha `MERCADO_LIVRE_ACCESS_TOKEN` com um token válido.
3. Execute `npm run dev`.
4. Abra `http://127.0.0.1:4173`.

O token fica somente no servidor local. Ele nunca é enviado para o navegador nem deve ser versionado.

## Obter acesso ao Mercado Livre

1. Crie uma aplicação no [DevCenter do Mercado Livre](https://developers.mercadolivre.com.br/pt_br/realizacao-de-testes/crie-uma-aplicacao-no-mercado-livre).
2. Siga o [fluxo oficial de OAuth e obtenção do token](https://developers.mercadolivre.com.br/pt_br/obtencao-do-access-token).
3. Salve o token apenas no arquivo local `.env`.

Nesta primeira integração, o token é configurado manualmente para simplificar o desenvolvimento. O próximo passo de produção é implementar OAuth com renovação automática e armazenamento seguro.

## Fontes

| Fonte | Situação |
| --- | --- |
| Mercado Livre | Adaptador de busca implementado; requer access token oficial. |
| OLX | Depende de credenciamento como integrador/parceiro e homologação. |
| Webmotors | Depende da contratação/liberação da API Site e homologação. |

Não usamos scraping. Cada nova fonte deve ser adicionada por uma API autorizada e normalizada para o mesmo formato interno de oferta.
