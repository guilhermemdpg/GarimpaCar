# GarimpaCar

Aplicação para pesquisar e classificar anúncios reais de veículos. A primeira fonte implementada é a API oficial do Mercado Livre.

## Fontes

| Fonte | Situação |
| --- | --- |
| Mercado Livre | Adaptador de busca implementado; requer access token oficial. |
| OLX | Depende de credenciamento como integrador/parceiro e homologação. |
| Webmotors | Depende da contratação/liberação da API Site e homologação. |

Não usamos scraping. Cada nova fonte deve ser adicionada por uma API autorizada e normalizada para o mesmo formato interno de oferta.
