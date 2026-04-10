const { all, get } = require("../database");
const { roundCurrency } = require("./payment-rules");
const { getAllowedNextStatuses, normalizeOrderStatus } = require("./order-status");
const { run, withTransaction } = require("../database");

function mapOrderItem(row) {
  return {
    id: row.id,
    pedidoId: row.pedido_id,
    produtoId: row.produto_id,
    produtoNome: row.produto_nome || "Produto indisponível",
    produtoImagem: row.produto_imagem || "",
    quantidade: Number(row.quantidade || 0),
    precoUnitario: Number(row.preco_unitario || 0),
    subtotal: roundCurrency(Number(row.quantidade || 0) * Number(row.preco_unitario || 0))
  };
}

function mapOrder(row, items = []) {
  if (!row) {
    return null;
  }

  const normalizedStatus = normalizeOrderStatus(row.status);

  return {
    id: row.id,
    usuarioId: row.usuario_id,
    clienteNome: row.usuario_nome || "",
    clienteEmail: row.usuario_email || "",
    subtotal: Number(row.subtotal || 0),
    total: Number(row.total || 0),
    status: normalizedStatus,
    formaPagamento: row.forma_pagamento || row.pagamento_metodo || "",
    statusPagamento: row.status_pagamento || "pendente",
    codigoRastreio: row.codigo_rastreio || "",
    observacoes: row.observacoes || "",
    gatewayPagamento: row.gateway_pagamento || "",
    gatewayPaymentId: row.gateway_payment_id || "",
    gatewayReferenceId: row.gateway_reference_id || "",
    gatewayPreferenceId: row.gateway_preference_id || "",
    estoqueReservado: !!row.estoque_reservado,
    atualizadoEm: row.atualizado_em || row.data_criacao || null,
    pagamentoMetodo: row.pagamento_metodo || "",
    pagamentoParcelas:
      row.pagamento_parcelas === null || row.pagamento_parcelas === undefined
        ? null
        : Number(row.pagamento_parcelas),
    pagamentoAjusteTipo: row.pagamento_ajuste_tipo || "sem_ajuste",
    pagamentoAjustePercentual: Number(row.pagamento_ajuste_percentual || 0),
    dataCriacao: row.data_criacao || null,
    itensCount: Number(row.itens_count || items.length || 0),
    allowedNextStatuses: getAllowedNextStatuses(normalizedStatus, row.status_pagamento),
    itens: items
  };
}

function normalizeComparableItems(items = []) {
  const aggregated = new Map();

  items.forEach(item => {
    const productId = Number(item?.produto_id ?? item?.produtoId);
    const quantity = Number(item?.quantidade ?? item?.qtd);

    if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
      return;
    }

    aggregated.set(productId, (aggregated.get(productId) || 0) + quantity);
  });

  return [...aggregated.entries()]
    .map(([produtoId, quantidade]) => ({ produtoId, quantidade }))
    .sort((a, b) => a.produtoId - b.produtoId);
}

function orderItemsMatch(firstItems = [], secondItems = []) {
  const first = normalizeComparableItems(firstItems);
  const second = normalizeComparableItems(secondItems);

  if (first.length !== second.length) {
    return false;
  }

  return first.every((item, index) => {
    const compare = second[index];
    return compare && item.produtoId === compare.produtoId && item.quantidade === compare.quantidade;
  });
}

function shouldOrderReserveInventory(order) {
  const orderStatus = normalizeOrderStatus(order?.status);
  const paymentStatus = String(order?.statusPagamento || "").trim().toLowerCase();

  if (orderStatus === "cancelado") {
    return false;
  }

  return !["recusado", "cancelado", "estornado"].includes(paymentStatus);
}

async function getOrderItems(orderId) {
  const rows = await all(
    `SELECT
      pedido_itens.id,
      pedido_itens.pedido_id,
      pedido_itens.produto_id,
      produtos.nome AS produto_nome,
      produtos.imagem AS produto_imagem,
      pedido_itens.quantidade,
      pedido_itens.preco_unitario
    FROM pedido_itens
    LEFT JOIN produtos ON produtos.id = pedido_itens.produto_id
    WHERE pedido_itens.pedido_id = ?
    ORDER BY pedido_itens.id ASC`,
    [orderId]
  );

  return rows.map(mapOrderItem);
}

async function getOrderRowById(orderId) {
  return get(
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
    WHERE pedidos.id = ?
    GROUP BY pedidos.id`,
    [orderId]
  );
}

async function getOrderById(orderId) {
  const row = await getOrderRowById(orderId);

  if (!row) {
    return null;
  }

  const items = await getOrderItems(orderId);
  return mapOrder(row, items);
}

async function findOrderByGatewayReferenceId(referenceId) {
  const normalizedReference = String(referenceId || "").trim();

  if (!normalizedReference) {
    return null;
  }

  const row = await get(
    `SELECT id
     FROM pedidos
     WHERE gateway_reference_id = ?
     ORDER BY datetime(COALESCE(atualizado_em, data_criacao)) DESC, id DESC
     LIMIT 1`,
    [normalizedReference]
  );

  if (!row?.id) {
    return null;
  }

  return getOrderById(row.id);
}

async function findOrderByGatewayPaymentId(paymentId) {
  const normalizedPaymentId = String(paymentId || "").trim();

  if (!normalizedPaymentId) {
    return null;
  }

  const row = await get(
    `SELECT id
     FROM pedidos
     WHERE gateway_payment_id = ?
     ORDER BY datetime(COALESCE(atualizado_em, data_criacao)) DESC, id DESC
     LIMIT 1`,
    [normalizedPaymentId]
  );

  if (!row?.id) {
    return null;
  }

  return getOrderById(row.id);
}

function canAccessOrder(user, order) {
  if (!user || !order) {
    return false;
  }

  return !!user.is_admin || Number(order.usuarioId) === Number(user.id);
}

async function findProduct(productId) {
  return get(
    `SELECT id, nome, imagem, preco, preco_promocional, estoque
     FROM produtos
     WHERE id = ?`,
    [productId]
  );
}

async function reserveInventoryForItems(items = []) {
  for (const item of items) {
    const productId = Number(item?.produto_id ?? item?.produtoId);
    const quantidade = Number(item?.quantidade ?? item?.qtd);

    if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantidade) || quantidade <= 0) {
      throw new Error("Os itens do pedido precisam ser válidos para reservar estoque.");
    }

    const result = await run(
      `UPDATE produtos
       SET estoque = estoque - ?
       WHERE id = ? AND estoque >= ?`,
      [quantidade, productId, quantidade]
    );

    if (!result.changes) {
      const product = await findProduct(productId);
      throw new Error(`Estoque insuficiente para ${product?.nome || `o produto ${productId}`}.`);
    }
  }
}

async function releaseInventoryForItems(items = []) {
  for (const item of items) {
    const productId = Number(item?.produto_id ?? item?.produtoId);
    const quantidade = Number(item?.quantidade ?? item?.qtd);

    if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantidade) || quantidade <= 0) {
      continue;
    }

    await run(
      `UPDATE produtos
       SET estoque = estoque + ?
       WHERE id = ?`,
      [quantidade, productId]
    );
  }
}

async function syncOrderInventoryReservation(order) {
  if (!order) {
    return null;
  }

  const shouldReserve = shouldOrderReserveInventory(order);
  const isReserved = !!order.estoqueReservado;

  if (shouldReserve === isReserved) {
    return order;
  }

  const items = Array.isArray(order.itens) && order.itens.length > 0
    ? order.itens
    : await getOrderItems(order.id);

  await withTransaction(async () => {
    if (shouldReserve) {
      await reserveInventoryForItems(items);
    } else {
      await releaseInventoryForItems(items);
    }

    await run(
      `UPDATE pedidos
       SET estoque_reservado = ?, atualizado_em = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [shouldReserve ? 1 : 0, order.id]
    );
  });

  return getOrderById(order.id);
}

async function findReusableOrderForUser(userId, items = []) {
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) {
    return null;
  }

  const rows = await all(
    `SELECT id
     FROM pedidos
     WHERE usuario_id = ?
       AND LOWER(COALESCE(status, '')) = 'aguardando_pagamento'
       AND LOWER(COALESCE(status_pagamento, '')) IN ('pendente', 'aguardando_pagamento', 'recusado')
     ORDER BY datetime(COALESCE(atualizado_em, data_criacao)) DESC, id DESC`,
    [userId]
  );

  for (const row of rows) {
    const order = await getOrderById(row.id);

    if (order && orderItemsMatch(order.itens, items)) {
      return order;
    }
  }

  return null;
}

function getProductSalePrice(product) {
  const promotionalPrice = Number(product?.preco_promocional);
  const regularPrice = Number(product?.preco || 0);

  if (Number.isFinite(promotionalPrice) && promotionalPrice > 0 && promotionalPrice < regularPrice) {
    return promotionalPrice;
  }

  return regularPrice;
}

module.exports = {
  mapOrder,
  mapOrderItem,
  normalizeComparableItems,
  orderItemsMatch,
  shouldOrderReserveInventory,
  reserveInventoryForItems,
  releaseInventoryForItems,
  syncOrderInventoryReservation,
  findReusableOrderForUser,
  getOrderItems,
  getOrderRowById,
  getOrderById,
  findOrderByGatewayReferenceId,
  findOrderByGatewayPaymentId,
  canAccessOrder,
  findProduct,
  getProductSalePrice
};
