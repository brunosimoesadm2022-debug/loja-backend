const express = require("express");
const { all, run, withTransaction } = require("../database");
const { requireAuth } = require("../middlewares/auth");
const { requireAdmin } = require("../middlewares/admin");
const {
  calculateFinalTotal,
  normalizePaymentInput,
  roundCurrency
} = require("../utils/payment-rules");
const {
  canAccessOrder,
  findReusableOrderForUser,
  findProduct,
  getOrderById,
  getProductSalePrice,
  mapOrder,
  normalizeComparableItems,
  reserveInventoryForItems,
  syncOrderInventoryReservation
} = require("../utils/orders");
const router = express.Router();

function sendSuccess(res, message, data, status = 200) {
  res.status(status).json({
    success: true,
    message,
    data
  });
}

function sendError(res, status, message) {
  res.status(status).json({
    success: false,
    message,
    data: null
  });
}

async function normalizeOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("O pedido precisa ter pelo menos um item.");
  }

  const aggregatedItems = normalizeComparableItems(items);

  if (aggregatedItems.length === 0) {
    throw new Error("O pedido precisa ter pelo menos um item válido.");
  }

  const normalizedItems = [];

  for (const item of aggregatedItems) {
    const product = await findProduct(item.produtoId);

    if (!product) {
      throw new Error(`Produto ${item.produtoId} não encontrado.`);
    }

    const estoqueDisponivel = Number(product.estoque || 0);

    if (item.quantidade > estoqueDisponivel) {
      throw new Error(`Estoque insuficiente para ${product.nome}.`);
    }

    normalizedItems.push({
      produto_id: item.produtoId,
      produto_nome: product.nome,
      produto_imagem: product.imagem || "",
      quantidade: item.quantidade,
      preco_unitario: roundCurrency(getProductSalePrice(product))
    });
  }

  return normalizedItems;
}

async function listOrders(whereClause = "", params = []) {
  const rows = await all(
    `SELECT
      pedidos.id,
      pedidos.usuario_id,
      pedidos.subtotal,
      pedidos.total,
      pedidos.status,
      pedidos.forma_pagamento,
      pedidos.status_pagamento,
      pedidos.codigo_rastreio,
      pedidos.observacoes,
      pedidos.gateway_pagamento,
      pedidos.gateway_payment_id,
      pedidos.gateway_reference_id,
      pedidos.gateway_preference_id,
      pedidos.estoque_reservado,
      pedidos.atualizado_em,
      pedidos.pagamento_metodo,
      pedidos.pagamento_parcelas,
      pedidos.pagamento_ajuste_tipo,
      pedidos.pagamento_ajuste_percentual,
      pedidos.data_criacao,
      usuarios.nome AS usuario_nome,
      usuarios.email AS usuario_email,
      COUNT(pedido_itens.id) AS itens_count
    FROM pedidos
    LEFT JOIN usuarios ON usuarios.id = pedidos.usuario_id
    LEFT JOIN pedido_itens ON pedido_itens.pedido_id = pedidos.id
    ${whereClause}
    GROUP BY pedidos.id
    ORDER BY datetime(COALESCE(pedidos.atualizado_em, pedidos.data_criacao)) DESC, pedidos.id DESC`,
    params
  );

  return rows.map(row => mapOrder(row));
}

async function updateOpenOrderPricing(orderId, payment, subtotal, total) {
  await run(
    `UPDATE pedidos SET
      subtotal = ?,
      total = ?,
      status = 'aguardando_pagamento',
      forma_pagamento = ?,
      status_pagamento = 'pendente',
      gateway_pagamento = '',
      gateway_payment_id = '',
      gateway_reference_id = '',
      gateway_preference_id = '',
      pagamento_metodo = ?,
      pagamento_parcelas = ?,
      pagamento_ajuste_tipo = ?,
      pagamento_ajuste_percentual = ?,
      atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [
      subtotal,
      total,
      payment.metodo,
      payment.metodo,
      payment.parcelas,
      payment.ajusteTipo,
      payment.ajustePercentual,
      orderId
    ]
  );
}

router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const pedidos = await listOrders();

    sendSuccess(res, "Pedidos listados com sucesso.", {
      pedidos
    });
  } catch (error) {
    sendError(res, 500, "Não foi possível listar os pedidos.");
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const pedidos = await listOrders("WHERE pedidos.usuario_id = ?", [req.user.id]);

    sendSuccess(res, "Pedidos do usuário carregados com sucesso.", {
      pedidos
    });
  } catch (error) {
    sendError(res, 500, "Não foi possível carregar seus pedidos.");
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      sendError(res, 400, "Informe um pedido válido.");
      return;
    }

    const order = await getOrderById(orderId);

    if (!order) {
      sendError(res, 404, "Pedido não encontrado.");
      return;
    }

    if (!canAccessOrder(req.user, order)) {
      sendError(res, 403, "Você não tem permissão para acessar este pedido.");
      return;
    }

    sendSuccess(res, "Pedido carregado com sucesso.", { pedido: order });
  } catch (error) {
    sendError(res, 500, "Não foi possível carregar o pedido.");
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const items = await normalizeOrderItems(req.body?.itens ?? req.body?.items);
    const payment = normalizePaymentInput(req.body);
    const subtotal = roundCurrency(
      items.reduce((sum, item) => sum + (item.quantidade * item.preco_unitario), 0)
    );
    const total = calculateFinalTotal(subtotal, payment);
    const reusableOrder = await findReusableOrderForUser(req.user.id, items);

    if (reusableOrder) {
      let orderReadyToUse = reusableOrder;

      if (!reusableOrder.estoqueReservado) {
        orderReadyToUse = await syncOrderInventoryReservation({
          ...reusableOrder,
          status: "aguardando_pagamento",
          statusPagamento: "pendente"
        });
      }

      await updateOpenOrderPricing(orderReadyToUse.id, payment, subtotal, total);

      const updatedReusableOrder = await getOrderById(orderReadyToUse.id);

      sendSuccess(res, "Pedido pendente reutilizado com sucesso.", {
        pedido: updatedReusableOrder
      }, 200);
      return;
    }

    const createdOrder = await withTransaction(async () => {
      const orderResult = await run(
        `INSERT INTO pedidos (
          usuario_id,
          subtotal,
          total,
          status,
          forma_pagamento,
          status_pagamento,
          codigo_rastreio,
          observacoes,
          gateway_pagamento,
          estoque_reservado,
          atualizado_em,
          pagamento_metodo,
          pagamento_parcelas,
          pagamento_ajuste_tipo,
          pagamento_ajuste_percentual
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
        [
          req.user.id,
          subtotal,
          total,
          "aguardando_pagamento",
          payment.metodo,
          "pendente",
          "",
          "",
          "",
          1,
          payment.metodo,
          payment.parcelas,
          payment.ajusteTipo,
          payment.ajustePercentual
        ]
      );

      for (const item of items) {
        await run(
          `INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, preco_unitario)
           VALUES (?, ?, ?, ?)`,
          [orderResult.id, item.produto_id, item.quantidade, item.preco_unitario]
        );
      }

      await reserveInventoryForItems(items);

      return getOrderById(orderResult.id);
    });

    sendSuccess(res, "Pedido criado com sucesso.", {
      pedido: createdOrder
    }, 201);
  } catch (error) {
    sendError(res, 400, error.message || "Não foi possível criar o pedido.");
  }
});

module.exports = router;
