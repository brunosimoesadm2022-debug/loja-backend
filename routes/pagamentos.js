const express = require("express");
const { run } = require("../database");
const { requireAuth } = require("../middlewares/auth");
const {
  getOrderById,
  findOrderByGatewayReferenceId,
  findOrderByGatewayPaymentId,
  canAccessOrder,
  syncOrderInventoryReservation
} = require("../utils/orders");
const { normalizePaymentInput } = require("../utils/payment-rules");
const { deriveOrderStatusFromPayment, normalizeOrderStatus } = require("../utils/order-status");
const { handleOrderNotifications } = require("../services/order-notifications");
const {
  createPixCharge,
  getPixChargeById,
  getPixChargeByReferenceId,
  isPixProviderConfigured,
  isSandboxMode,
  getPixProviderName,
  mapPixChargeData,
  normalizeChargeStatus,
  verifyPixWebhookSignature,
  extractWebhookChargeIdentifiers,
  extractWebhookChargeReference,
  buildChargeCorrelationId,
  getPixWebhookUrl
} = require("../services/pix-provider");

const router = express.Router();

function sendSuccess(res, message, data, status = 200) {
  res.status(status).json({
    success: true,
    message,
    data
  });
}

function sendError(res, status, message, data = null) {
  res.status(status).json({
    success: false,
    message,
    data
  });
}

function getRequestedPaymentSelection(body, fallback) {
  const payload = body || {};
  const defaults = fallback || {};

  return normalizePaymentInput({
    pagamento: {
      metodo:
        payload.metodo ||
        defaults.metodo ||
        payload.formaPagamento ||
        (payload.pagamento && payload.pagamento.metodo) ||
        payload.pagamentoMetodo ||
        defaults.formaPagamento ||
        "",
      parcelas:
        payload.parcelas ||
        (payload.pagamento && payload.pagamento.parcelas) ||
        payload.pagamentoParcelas ||
        defaults.parcelas ||
        1
    }
  });
}

function isOrderPayable(order) {
  const paymentStatus = String((order && order.statusPagamento) || "").toLowerCase();
  const orderStatus = normalizeOrderStatus(order && order.status);

  return paymentStatus !== "aprovado" &&
    paymentStatus !== "estornado" &&
    orderStatus !== "cancelado" &&
    orderStatus !== "entregue";
}

async function updateOrderPaymentFields(orderId, fields) {
  const sets = [];
  const values = [];

  Object.keys(fields).forEach(key => {
    sets.push(`${key} = ?`);
    values.push(fields[key]);
  });

  sets.push("atualizado_em = CURRENT_TIMESTAMP");
  values.push(orderId);

  await run(`UPDATE pedidos SET ${sets.join(", ")} WHERE id = ?`, values);
}

function getFrontendBaseUrl() {
  return String(process.env.BASE_URL_FRONTEND || "").trim().replace(/\/+$/, "");
}

function buildPixPageUrl(orderId) {
  const frontendBase = getFrontendBaseUrl();
  const target = `pix.html?pedido=${encodeURIComponent(orderId)}`;

  if (!frontendBase) {
    return target;
  }

  return `${frontendBase}/${target}`;
}

async function buildPixResponseData(order, charge) {
  const pix = await mapPixChargeData(charge);

  return {
    pedido: order,
    paymentId: pix.paymentId,
    qrCodeImage: pix.qrCodeImage,
    qrCode: pix.qrCode,
    status: pix.status,
    pagamento: {
      gateway: getPixProviderName(),
      type: "pix",
      sandbox: isSandboxMode(),
      status: pix.status,
      paymentId: pix.paymentId,
      gatewayPaymentId: pix.gatewayPaymentId,
      referenceId: pix.referenceId,
      qrCodeImage: pix.qrCodeImage,
      qrCode: pix.qrCode,
      qrCodeBase64: pix.qrCodeBase64,
      codigoCopiaECola: pix.codigoCopiaECola,
      copiaECola: pix.copiaECola,
      ticketUrl: pix.ticketUrl,
      pix
    },
    pixPageUrl: buildPixPageUrl(order.id),
    webhookUrl: getPixWebhookUrl()
  };
}

function sanitizeDocument(value) {
  return String(value || "").replace(/\D/g, "");
}

function extractCpfFromCharge(charge) {
  return sanitizeDocument(charge?.customer?.taxID || "");
}

function buildNextPaymentFields(order, charge, explicitEvent = "") {
  const mappedStatus = normalizeChargeStatus(charge, explicitEvent);
  const nextOrderStatus = mappedStatus.orderStatus ||
    deriveOrderStatusFromPayment(order.status, mappedStatus.paymentStatus);

  return {
    status: nextOrderStatus,
    status_pagamento: mappedStatus.paymentStatus,
    gateway_pagamento: getPixProviderName(),
    gateway_payment_id: String(
      charge?.identifier ||
      charge?.transactionID ||
      charge?.paymentLinkID ||
      order.gatewayPaymentId ||
      ""
    ),
    gateway_reference_id: String(charge?.correlationID || order.gatewayReferenceId || ""),
    gateway_preference_id: String(charge?.paymentLinkID || order.gatewayPreferenceId || ""),
    forma_pagamento: "pix",
    pagamento_metodo: "pix",
    pagamento_parcelas: 1
  };
}

function isOrderAlreadySynchronized(order, nextFields) {
  return normalizeOrderStatus(order.status) === normalizeOrderStatus(nextFields.status) &&
    String(order.statusPagamento || "") === String(nextFields.status_pagamento || "") &&
    String(order.gatewayPagamento || "") === String(nextFields.gateway_pagamento || "") &&
    String(order.gatewayPaymentId || "") === String(nextFields.gateway_payment_id || "") &&
    String(order.gatewayReferenceId || "") === String(nextFields.gateway_reference_id || "") &&
    String(order.gatewayPreferenceId || "") === String(nextFields.gateway_preference_id || "") &&
    String(order.formaPagamento || order.pagamentoMetodo || "") === String(nextFields.forma_pagamento || "");
}

async function syncOrderWithCharge(order, charge, explicitEvent = "") {
  const previousOrder = order;
  const nextFields = buildNextPaymentFields(order, charge, explicitEvent);

  if (isOrderAlreadySynchronized(order, nextFields)) {
    console.info(
      "[pagamentos:pix] pedido ja sincronizado",
      JSON.stringify({
        pedidoId: order.id,
        paymentId: nextFields.gateway_payment_id,
        statusPagamento: nextFields.status_pagamento
      })
    );

    return syncOrderInventoryReservation(order);
  }

  await updateOrderPaymentFields(order.id, nextFields);

  const updatedOrder = await syncOrderInventoryReservation(await getOrderById(order.id));

  console.info(
    "[pagamentos:pix] status do pedido atualizado",
    JSON.stringify({
      pedidoId: updatedOrder?.id || order.id,
      status: updatedOrder?.status || nextFields.status,
      statusPagamento: updatedOrder?.statusPagamento || nextFields.status_pagamento,
      paymentId: updatedOrder?.gatewayPaymentId || nextFields.gateway_payment_id
    })
  );

  await handleOrderNotifications({
    trigger: "pagamento_gateway",
    previousOrder,
    nextOrder: updatedOrder
  });

  return updatedOrder;
}

async function fetchGatewayCharge(order, explicitPaymentId = "", explicitReferenceId = "") {
  if (!isPixProviderConfigured()) {
    return null;
  }

  const referenceId = String(explicitReferenceId || order?.gatewayReferenceId || "").trim();
  const paymentId = String(explicitPaymentId || order?.gatewayPaymentId || "").trim();

  if (referenceId) {
    try {
      return await getPixChargeByReferenceId(referenceId);
    } catch (error) {
      if (!paymentId) {
        throw error;
      }
    }
  }

  if (!paymentId) {
    return null;
  }

  return getPixChargeById(paymentId);
}

async function syncPixOrderFromGateway(order, explicitPaymentId = "", explicitReferenceId = "") {
  const charge = await fetchGatewayCharge(order, explicitPaymentId, explicitReferenceId);

  if (!charge) {
    return {
      order,
      charge: null
    };
  }

  const syncedOrder = await syncOrderWithCharge(order, charge);

  return {
    order: syncedOrder,
    charge
  };
}

function canReusePixCharge(order, charge) {
  const mappedStatus = normalizeChargeStatus(charge);
  const paymentStatus = String(mappedStatus.paymentStatus || "").toLowerCase();
  const orderPaymentMethod = String(order?.formaPagamento || order?.pagamentoMetodo || "").toLowerCase();

  return orderPaymentMethod === "pix" &&
    ["aguardando_pagamento", "pendente", "aprovado"].includes(paymentStatus);
}

function normalizePixRequestData(data) {
  if (typeof data === "string") {
    return { cpf: data };
  }

  return {
    cpf:
      data?.cpf ||
      data?.documento ||
      data?.document ||
      "",
    nome:
      data?.nome ||
      data?.nomeCliente ||
      data?.clienteNome ||
      "",
    email:
      data?.email ||
      data?.clienteEmail ||
      "",
    valor:
      data?.valor ||
      data?.amount ||
      ""
  };
}

async function createOrReusePixChargeForOrder(order, user, pixRequestInput) {
  const pixRequest = normalizePixRequestData(pixRequestInput);
  let currentOrder = order;
  let currentCpf = sanitizeDocument(pixRequest.cpf);

  if (currentOrder.gatewayReferenceId || currentOrder.gatewayPaymentId) {
    try {
      const existingCharge = await fetchGatewayCharge(currentOrder);
      const syncedOrder = existingCharge
        ? await syncOrderWithCharge(currentOrder, existingCharge)
        : currentOrder;

      if (!currentCpf) {
        currentCpf = extractCpfFromCharge(existingCharge);
      }

      if (existingCharge && canReusePixCharge(syncedOrder, existingCharge)) {
        return {
          order: syncedOrder,
          charge: existingCharge,
          reused: true
        };
      }

      currentOrder = syncedOrder;
    } catch (error) {
      currentOrder = await getOrderById(currentOrder.id);
    }
  }

  await updateOrderPaymentFields(currentOrder.id, {
    status: "aguardando_pagamento",
    forma_pagamento: "pix",
    status_pagamento: "aguardando_pagamento",
    gateway_pagamento: getPixProviderName(),
    gateway_payment_id: "",
    gateway_reference_id: "",
    gateway_preference_id: "",
    pagamento_metodo: "pix",
    pagamento_parcelas: 1
  });

  const refreshedOrder = await getOrderById(currentOrder.id);
  const charge = await createPixCharge({
    order: refreshedOrder,
    user,
    correlationId: buildChargeCorrelationId(refreshedOrder.id),
    paymentSelection: {
      method: "pix",
      cpf: currentCpf,
      nome: pixRequest.nome,
      email: pixRequest.email,
      valor: pixRequest.valor
    }
  });
  const syncedOrder = await syncOrderWithCharge(
    {
      ...refreshedOrder,
      formaPagamento: "pix",
      pagamentoMetodo: "pix",
      gatewayReferenceId: String(charge?.correlationID || ""),
      gatewayPaymentId: String(charge?.identifier || charge?.transactionID || charge?.paymentLinkID || "")
    },
    charge
  );

  return {
    order: syncedOrder,
    charge,
    reused: false
  };
}

async function resolveAuthorizedOrder(req, pedidoId) {
  const order = await getOrderById(pedidoId);

  if (!order) {
    return {
      error: {
        status: 404,
        message: "Pedido não encontrado."
      }
    };
  }

  if (!canAccessOrder(req.user, order)) {
    return {
      error: {
        status: 403,
        message: "Você não tem permissão para acessar este pedido."
      }
    };
  }

  return { order };
}

async function handleCreatePix(req, res) {
  if (!isPixProviderConfigured()) {
    sendError(
      res,
      503,
      "Pagamento Pix indisponível. Configure OPENPIX_APP_ID no backend para continuar."
    );
    return;
  }

  const pedidoId = Number(req.body && (req.body.pedido_id || req.body.pedidoId));

  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    sendError(res, 400, "Informe um pedido válido para gerar o Pix.");
    return;
  }

  const resolved = await resolveAuthorizedOrder(req, pedidoId);

  if (resolved.error) {
    sendError(res, resolved.error.status, resolved.error.message);
    return;
  }

  const order = resolved.order;
  const requestedAmount = Number(
    req.body?.valor ??
    req.body?.amount ??
    req.body?.pix?.valor ??
    ""
  );
  const pixRequest = {
    cpf:
      req.body?.cpf ||
      req.body?.pix?.cpf ||
      req.body?.documento ||
      req.body?.document ||
      "",
    nome:
      req.body?.nome ||
      req.body?.nomeCliente ||
      req.body?.clienteNome ||
      req.body?.payerName ||
      req.body?.pix?.nome ||
      req.user?.nome ||
      "",
    email:
      req.body?.email ||
      req.body?.clienteEmail ||
      req.body?.payerEmail ||
      req.body?.pix?.email ||
      req.user?.email ||
      "",
    valor: Number.isFinite(requestedAmount) ? requestedAmount : ""
  };

  if (!isOrderPayable(order)) {
    sendError(res, 409, "Este pedido já possui pagamento finalizado e não pode receber uma nova cobrança Pix.");
    return;
  }

  console.info(
    "[pagamentos:pix] solicitacao de cobranca",
    JSON.stringify({
      pedidoId: order.id,
      usuarioId: req.user?.id || 0,
      valorPedido: order.total,
      valorRecebido: Number.isFinite(requestedAmount) ? requestedAmount : null
    })
  );

  const pixFlow = await createOrReusePixChargeForOrder(
    order,
    req.user,
    pixRequest
  );

  console.info(
    "[pagamentos:pix] cobranca pronta para o frontend",
    JSON.stringify({
      pedidoId: pixFlow.order?.id || order.id,
      reused: !!pixFlow.reused,
      paymentId:
        pixFlow.charge?.identifier ||
        pixFlow.charge?.transactionID ||
        pixFlow.charge?.paymentLinkID ||
        "",
      referenceId: pixFlow.charge?.correlationID || ""
    })
  );

  sendSuccess(
    res,
    pixFlow.reused ? "Cobrança Pix reutilizada com sucesso." : "Cobrança Pix criada com sucesso.",
    await buildPixResponseData(pixFlow.order, pixFlow.charge),
    pixFlow.reused ? 200 : 201
  );
}

router.post("/criar", requireAuth, async (req, res) => {
  try {
    const pedidoId = Number(req.body && (req.body.pedido_id || req.body.pedidoId));

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      sendError(res, 400, "Informe um pedido válido para gerar o pagamento.");
      return;
    }

    const resolved = await resolveAuthorizedOrder(req, pedidoId);

    if (resolved.error) {
      sendError(res, resolved.error.status, resolved.error.message);
      return;
    }

    let order = resolved.order;

    if (!isOrderPayable(order)) {
      sendError(res, 409, "Este pedido já possui pagamento finalizado e não pode ser pago novamente.");
      return;
    }

    order = await syncOrderInventoryReservation({
      ...order,
      status: "aguardando_pagamento",
      statusPagamento: "pendente"
    });

    const orderMethod = String(order.formaPagamento || order.pagamentoMetodo || "").trim();
    const requestedPayment = getRequestedPaymentSelection(req.body, {
      metodo: orderMethod,
      parcelas: order.pagamentoParcelas || 1
    });

    if (orderMethod && requestedPayment.metodo !== orderMethod) {
      sendError(
        res,
        409,
        "Este pedido já foi calculado com outra forma de pagamento. Gere um novo pedido para mudar a condição."
      );
      return;
    }

    const resolvedMethod = String(orderMethod || requestedPayment.metodo || "").trim().toLowerCase();

    if (resolvedMethod !== "pix") {
      sendError(
        res,
        422,
        "Nesta configuração da Loja do Garimpo, o pagamento online disponível no próprio site é apenas o Pix."
      );
      return;
    }

    req.body = {
      ...req.body,
      pedidoId: order.id,
      metodo: "pix"
    };

    await handleCreatePix(req, res);
  } catch (error) {
    sendError(res, error.status || 500, error.message || "Não foi possível iniciar o pagamento.");
  }
});

router.post("/pix/criar", requireAuth, async (req, res) => {
  try {
    await handleCreatePix(req, res);
  } catch (error) {
    sendError(res, error.status || 500, error.message || "Não foi possível gerar a cobrança Pix.");
  }
});

router.post("/pix", requireAuth, async (req, res) => {
  try {
    await handleCreatePix(req, res);
  } catch (error) {
    sendError(res, error.status || 500, error.message || "Não foi possível gerar a cobrança Pix.");
  }
});

router.post("/webhook", async (req, res) => {
  try {
    const webhookIdentifiers = extractWebhookChargeIdentifiers(req.body);
    console.info(
      "[pagamentos:pix:webhook] webhook recebido",
      JSON.stringify({
        event: req.body?.event || "",
        referenceId: webhookIdentifiers.referenceId,
        chargeId: webhookIdentifiers.chargeId
      })
    );

    const signatureCheck = verifyPixWebhookSignature({
      signatureHeader: req.headers["x-openpix-signature"] || "",
      rawBody: req.rawBody || JSON.stringify(req.body || {})
    });

    if (!signatureCheck.valid) {
      sendError(res, 401, "Assinatura do webhook inválida.");
      return;
    }

    if (!isPixProviderConfigured()) {
      sendSuccess(res, "Webhook recebido, mas o provedor Pix não está configurado neste ambiente.", null);
      return;
    }

    const referenceId = webhookIdentifiers.referenceId || extractWebhookChargeReference(req.body);
    const chargeId = webhookIdentifiers.chargeId || "";

    if (!referenceId && !chargeId) {
      sendSuccess(res, "Webhook recebido sem referência de cobrança, nenhuma ação executada.", null);
      return;
    }

    let order = referenceId
      ? await findOrderByGatewayReferenceId(referenceId)
      : null;

    if (!order && chargeId) {
      order = await findOrderByGatewayPaymentId(chargeId);
    }

    if (!order) {
      sendSuccess(res, "Webhook recebido, mas o pedido relacionado não foi localizado.", null);
      return;
    }

    const charge = await fetchGatewayCharge(order, chargeId, referenceId);
    const updatedOrder = await syncOrderWithCharge(order, charge, req.body?.event || "");

    sendSuccess(res, "Pagamento Pix sincronizado com sucesso.", {
      pedido: updatedOrder
    });
  } catch (error) {
    sendError(res, error.status || 500, error.message || "Não foi possível processar o webhook Pix.");
  }
});

router.get("/status/:pedidoId", requireAuth, async (req, res) => {
  try {
    const pedidoId = Number(req.params.pedidoId);

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      sendError(res, 400, "Informe um pedido válido.");
      return;
    }

    const resolved = await resolveAuthorizedOrder(req, pedidoId);

    if (resolved.error) {
      sendError(res, resolved.error.status, resolved.error.message);
      return;
    }

    let syncedOrder = resolved.order;
    let charge = null;
    const referenceId = String(
      (req.query && (req.query.reference_id || req.query.referenceId)) ||
      syncedOrder.gatewayReferenceId ||
      ""
    ).trim();
    const paymentId = String(
      (req.query && (req.query.payment_id || req.query.paymentId || req.query.charge_id || req.query.chargeId)) ||
      syncedOrder.gatewayPaymentId ||
      ""
    ).trim();

    if (referenceId && referenceId !== syncedOrder.gatewayReferenceId) {
      await updateOrderPaymentFields(syncedOrder.id, {
        gateway_reference_id: referenceId,
        gateway_pagamento: getPixProviderName()
      });
      syncedOrder = await getOrderById(syncedOrder.id);
    }

    if (isPixProviderConfigured() && (referenceId || paymentId)) {
      try {
        charge = await fetchGatewayCharge(syncedOrder, paymentId, referenceId);

        if (charge) {
          syncedOrder = await syncOrderWithCharge(syncedOrder, charge);
        }
      } catch (error) {
        syncedOrder = await getOrderById(syncedOrder.id);
      }
    }

    const pix = charge ? await mapPixChargeData(charge) : null;

    sendSuccess(res, "Status do pagamento carregado com sucesso.", {
      pedido: syncedOrder,
      paymentId: pix?.paymentId || syncedOrder.gatewayPaymentId || "",
      qrCodeImage: pix?.qrCodeImage || pix?.qrCodeBase64 || "",
      qrCode: pix?.qrCode || "",
      status: syncedOrder.statusPagamento,
      pagamento: {
        status: syncedOrder.statusPagamento,
        gateway: syncedOrder.gatewayPagamento || getPixProviderName(),
        type: "pix",
        paymentId: pix?.paymentId || syncedOrder.gatewayPaymentId || "",
        gatewayPaymentId: pix?.gatewayPaymentId || syncedOrder.gatewayPaymentId || "",
        referenceId: pix?.referenceId || syncedOrder.gatewayReferenceId || "",
        qrCodeImage: pix?.qrCodeImage || pix?.qrCodeBase64 || "",
        qrCode: pix?.qrCode || "",
        qrCodeBase64: pix?.qrCodeBase64 || "",
        codigoCopiaECola: pix?.codigoCopiaECola || "",
        copiaECola: pix?.copiaECola || "",
        ticketUrl: pix?.ticketUrl || "",
        pix
      },
      webhookUrl: getPixWebhookUrl()
    });
  } catch (error) {
    sendError(res, error.status || 500, error.message || "Não foi possível consultar o status do pagamento.");
  }
});

router.get("/pix/status/:pedidoId", requireAuth, async (req, res) => {
  try {
    const pedidoId = Number(req.params.pedidoId);

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      sendError(res, 400, "Informe um pedido válido.");
      return;
    }

    const resolved = await resolveAuthorizedOrder(req, pedidoId);

    if (resolved.error) {
      sendError(res, resolved.error.status, resolved.error.message);
      return;
    }

    let order = resolved.order;
    const paymentSync = await syncPixOrderFromGateway(
      order,
      String((req.query && (req.query.payment_id || req.query.paymentId)) || "").trim(),
      String((req.query && (req.query.reference_id || req.query.referenceId)) || "").trim()
    );
    order = paymentSync.order;

    if (String(order.formaPagamento || order.pagamentoMetodo || "").toLowerCase() !== "pix") {
      sendError(res, 409, "Este pedido não possui uma cobrança Pix vinculada.");
      return;
    }

    if (!paymentSync.charge) {
      sendError(res, 404, "A cobrança Pix deste pedido ainda não foi gerada.");
      return;
    }

    sendSuccess(res, "Status do Pix carregado com sucesso.", await buildPixResponseData(order, paymentSync.charge));
  } catch (error) {
    sendError(res, error.status || 500, error.message || "Não foi possível consultar o status do Pix.");
  }
});

module.exports = router;
