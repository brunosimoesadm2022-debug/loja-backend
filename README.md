# Backend da Loja do Garimpo

Backend em Node.js + Express + SQLite que sustenta autenticação, produtos, pedidos e cobrança Pix dinâmica dentro do próprio site.

## Como rodar

1. Entre na pasta `backend`
2. Instale as dependências com `npm install`
3. Configure o arquivo `.env`
4. Inicie o servidor com `node server.js`, `npm start` ou `npm run dev`

O banco `database.db` é criado automaticamente na primeira execução.

## Publicar o backend depois

O projeto já está pronto para uma publicação simples do backend quando você quiser colocar o login online.

### Render

Na raiz do projeto existe um arquivo `render.yaml` preparado para subir o serviço web com a pasta `backend`.

Depois da API pública existir:

1. Preencha as variáveis secretas no provedor:
   - `JWT_SECRET`
   - `OPENPIX_APP_ID`
   - `OPENPIX_WEBHOOK_SECRET` se for usar webhook
   - `BASE_URL_FRONTEND`
   - `BASE_URL_BACKEND`
2. No frontend publicado, configure a URL da API em `site-config.js`:

```js
window.LOJA_GARIMPO_API_BASE = "https://sua-api-publica.exemplo.com/api";
```

3. Faça novo deploy do frontend para o Firebase Hosting.

## Como definir um administrador

O backend já possui um e-mail bootstrap configurado como administrador:

- `bruno.simoesadm2022@gmail.com`

Sempre que o backend inicia, ele garante `is_admin = 1` para esse usuário no banco, caso a conta já exista.

1. Crie a conta normalmente pela tela de cadastro ou pela API.
2. Na pasta `backend`, rode:

```bash
npm run promote-admin -- email@exemplo.com
```

Isso marca o usuário informado com `is_admin = 1` no banco SQLite.

Se você rodar o script sem informar e-mail, ele usa o e-mail bootstrap acima por padrão.

## Variáveis de ambiente

Arquivo `.env`:

```env
PORT=3001
JWT_SECRET=CHANGE_ME
PIX_PROVIDER=openpix
OPENPIX_APP_ID=YOUR_APP_ID
OPENPIX_API_BASE=https://api.woovi-sandbox.com
OPENPIX_WEBHOOK_SECRET=YOUR_WEBHOOK_SECRET
BASE_URL_FRONTEND=http://127.0.0.1:5500
BASE_URL_BACKEND=http://localhost:3001
```

Observações importantes:

- `PIX_PROVIDER`: hoje o projeto está preparado para `openpix` como implementação principal.
- `OPENPIX_APP_ID`: credencial privada usada apenas no backend.
- `OPENPIX_API_BASE`: base da API do provedor Pix. Para sandbox, use a URL do ambiente de testes do PSP.
- `OPENPIX_WEBHOOK_SECRET`: segredo opcional para validar a assinatura HMAC do webhook.
- `BASE_URL_FRONTEND`: URL HTTP do frontend. Para Pix real, evite abrir o site como `file:///`; use um servidor local.
- `BASE_URL_BACKEND`: URL pública ou local do backend.

## Endpoints

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### Produtos

- `GET /api/produtos`
- `GET /api/produtos/:id`
- `POST /api/produtos`
- `PUT /api/produtos/:id`
- `DELETE /api/produtos/:id`

Observações:

- `GET /api/produtos` e `GET /api/produtos/:id` continuam públicos para a vitrine
- `POST`, `PUT` e `DELETE` exigem usuário autenticado com `is_admin = 1`

### Pedidos

- `POST /api/pedidos`
- `GET /api/pedidos/me`
- `GET /api/pedidos/:id`
- `GET /api/pedidos`

Observações:

- `POST /api/pedidos` exige autenticação e vincula o pedido ao usuário do token
- o total do pedido é calculado no backend a partir dos produtos do banco e da forma de pagamento escolhida
- `GET /api/pedidos/me` lista apenas os pedidos do usuário autenticado
- `GET /api/pedidos/:id` só permite acesso ao dono do pedido ou a administradores
- `GET /api/pedidos` fica reservado para administradores

### Pagamentos Pix

- `POST /api/pagamentos/criar`
- `POST /api/pagamentos/pix`
- `POST /api/pagamentos/pix/criar`
- `GET /api/pagamentos/status/:pedidoId`
- `GET /api/pagamentos/pix/status/:pedidoId`
- `POST /api/pagamentos/webhook`

Observações:

- `POST /api/pagamentos/criar` e `POST /api/pagamentos/pix/criar` exigem autenticação
- o fluxo online disponível nesta integração é o Pix dentro do próprio site
- o backend cria a cobrança dinâmica a partir do pedido salvo no banco
- o status do pagamento é persistido em `pedidos.status_pagamento`
- a referência da cobrança fica salva em `pedidos.gateway_reference_id`
- o webhook pode atualizar o pedido automaticamente
- as rotas de status também conseguem sincronizar a cobrança consultando o PSP em tempo real

## Como testar Pix em sandbox

1. Configure as credenciais do PSP Pix no `.env`
2. Rode o backend com `npm start`
3. Sirva o frontend em HTTP, por exemplo com Live Server ou outro servidor local, usando a URL definida em `BASE_URL_FRONTEND`
4. Faça login, adicione itens ao carrinho e avance até `pagamento.html`
5. Escolha `Pix`, informe o CPF do pagador e gere a cobrança
6. A página `pix.html` deve abrir com QR Code, código copia e cola e status inicial
7. Após pagar no ambiente sandbox do PSP, o status deve mudar para `aprovado` por polling e/ou webhook
8. Consulte `historico.html` e `sucesso.html` para validar a atualização do pedido

### Health check

- `GET /api/health`
