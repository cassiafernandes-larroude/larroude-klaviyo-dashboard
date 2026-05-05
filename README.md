# Larroudé · Klaviyo Journey Dashboard

Dashboard de jornada do perfil + performance dos flows + audiências + conflitos + oportunidades, alimentado pela API real da Klaviyo. Deploy direto na Vercel com refresh diário automático.

## O que tem dentro

- `index.html` — frontend (vanilla HTML+JS+Mermaid). Lê de `/api/data` e `/api/performance`.
- `api/data.js` — Edge Function que busca account, flows, segments, revenue. Cache 24h.
- `api/performance.js` — Edge Function que busca flow performance por período (7/14/28d). Cache 24h.
- `api/cron.js` — disparado uma vez ao dia (3am ET) para aquecer o cache.
- `vercel.json` — configura o cron job.

## Como subir (passo-a-passo)

### 1. Criar a API key no Klaviyo

1. Acesse [klaviyo.com/settings/account/api-keys](https://www.klaviyo.com/settings/account/api-keys)
2. Clique em **Create Private API Key**
3. Dê um nome tipo "Dashboard Vercel"
4. Em **Scopes**, marque READ ONLY em:
   - Accounts
   - Flows
   - Segments
   - Metrics
   - Events
   - Profiles
5. Salve. Copie a chave (começa com `pk_`).

### 2. Subir no GitHub

```bash
cd larroude-klaviyo-dashboard
git init
git add .
git commit -m "Initial commit · Klaviyo journey dashboard"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/larroude-klaviyo-dashboard.git
git push -u origin main
```

### 3. Deploy na Vercel

1. Acesse [vercel.com/new](https://vercel.com/new) e importe o repositório
2. Em **Environment Variables**, adicione:
   - `KLAVIYO_API_KEY` = sua chave do passo 1
   - (opcional) `CRON_SECRET` = um valor random qualquer (pra autenticar o cron)
3. Clique em **Deploy**

Em ~2 minutos seu dashboard fica em `https://seu-projeto.vercel.app`.

### 4. Verificar o cron

- Vá em **Settings → Cron Jobs** no projeto Vercel
- Você deve ver `/api/cron` agendado para rodar diariamente às 07:00 UTC (3am ET)
- Pra rodar manualmente uma vez agora: clique nos `...` do cron → **Run now**

## Como funciona o refresh diário

- `/api/data` e `/api/performance` retornam com header `Cache-Control: s-maxage=86400` (24h)
- A Vercel cacheia automaticamente as responses no edge
- O cron diário hits os endpoints com `cache-control: no-cache` para forçar refresh
- Resultado: o primeiro usuário do dia vê dados frescos sem esperar 30s

## Customização

### Trocar conta Klaviyo (BR/EU/etc)

A API key define a conta. Crie uma key na conta diferente e troque o env var na Vercel.

### Adicionar/remover segmentos featured

Edite `FEATURED_SEGMENTS` em `api/data.js`. Cada item precisa de:
- `id` — ID do segmento no Klaviyo (URL: `/lists/<id>`)
- `name`, `health` (`good` / `warning` / `alert`), `desc`

### Mudar período do Revenue strip

Em `api/data.js`, função `fetchPlacedOrderL3M` — troque o range de 90 dias para o que quiser.

### Trocar timezone do cron

Em `vercel.json`, edite `"schedule": "0 7 * * *"` (formato cron UTC).

## Troubleshooting

### Dashboard mostra "Erro ao carregar dados"
- Confirme que `KLAVIYO_API_KEY` está nas env vars da Vercel (Settings → Environment Variables)
- Re-deploy depois de adicionar a env var (Vercel não recarrega automaticamente)
- Veja o log da function em **Vercel Dashboard → Logs**

### Função timeout
- Edge functions têm 25s no Hobby tier
- Se o Klaviyo estiver lento, considere upgrade pro tier ou splitar a função
- O `/api/performance` é o mais pesado — pode demorar mais que `/api/data`

### Métrica "Placed Order" não bate
- Verifique se o ID `RWb2qv` (PLACED_ORDER_METRIC_ID) é o mesmo na sua conta
- Confirme em `/api/metrics` no Klaviyo procurando por "Placed Order"
- Se for diferente, edite a constante em `api/data.js` e `api/performance.js`

## Limites

- Klaviyo API: 75 requests/min para a maioria dos endpoints
- Com cache de 24h + cron, o dashboard usa ~30 requests/dia (bem dentro do limite)
- Edge functions: 25s timeout no Hobby, 60s+ no Pro
- Se precisar de dados mais frequentes que 1x/dia, reduza `s-maxage` nas API responses

## Estrutura do projeto

```
larroude-klaviyo-dashboard/
├── index.html              # Frontend (lê de /api/...)
├── api/
│   ├── data.js             # Account + flows + segments + revenue
│   ├── performance.js      # Flow performance por período
│   └── cron.js             # Refresh diário do cache
├── vercel.json             # Config Vercel + cron
├── package.json
├── .env.example
├── .gitignore
└── README.md
```
