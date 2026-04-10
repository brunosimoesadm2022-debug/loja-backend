const express = require("express");
const { run } = require("../database");
const { requireAuth } = require("../middlewares/auth");
const { requireAdmin } = require("../middlewares/admin");
const { getOrderById, syncOrderInventoryReservation } = require("../utils/orders");
const { validateOrderStatusTransition, normalizeOrderStatus } = require("../utils/order-status");
const { handleOrderNotifications } = require("../services/order-notifications");

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

function sanitizeNotes(value) {
  return String(value || "").trim().slice(0, 1000);
}

function sanitizeTrackingCode(value) {
  return String(value || "").trim().slice(0, 80);
}

async function updateOrderFields(orderId, fields) {
  const assignments = [];
  const values = [];

  Object.entries(fields).forEach(([key, value]) => {
    assignments.push(`${key} = ?`);
    values.push(value);
  });

  assignments.push("atualizado_em = CURRENT_TIMESTAMP");
  values.push(orderId);

  await run(`UPDATE pedidos SET ${assignments.join(", ")} WHERE id = ?`, values);
}

async function loadAdminOrder(orderId) {
  const order = await getOrderById(orderId);

  if (!order) {
    return {
      error: {
        status: 404,
        message: "Pedido não encontrado."
      }
    };
  }

  return { order };
}

router.put("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      sendError(res, 400, "Informe um pedido válido.");
      return;
    }

    const resolved = await loadAdminOrder(orderId);

    if (resolved.error) {
      sendError(res, resolved.error.status, resolved.error.message);
      return;
    }

    const previousOrder = resolved.order;
    const nextStatus = normalizeOrderStatus(req.body?.status, "");
    const observacoes = sanitizeNotes(req.body?.observacoes ?? previousOrder.observacoes);
    const validation = validateOrderStatusTransition(previousOrder.status, nextStatus, previousOrder.statusPagamento);

    if (!validation.valid) {
      sendError(res, 400, validation.message);
      return;
    }

    await updateOrderFields(orderId, {
      status: nextStatus,
      observacoes
    });

    const updatedOrder = await syncOrderInventoryReservation(await getOrderById(orderId));

    await handleOrderNotifications({
      trigger: "admin_status_update",
      previousOrder,
      nextOrder: updatedOrder
    });

    sendSuccess(res, "Status do pedido atualizado com sucesso.", {
      pedido: updatedOrder
    });
  } catch (error) {
    sendError(res, 500, error.message || "Não foi possível atualizar o status do pedido.");
  }
});

router.put("/:id/rastreio", requireAuth, requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      sendError(res, 400, "Informe um pedido válido.");
      return;
    }

    const resolved = await loadAdminOrder(orderId);

    if (resolved.error) {
      sendError(res, resolved.error.status, resolved.error.message);
      return;
    }

    const previousOrder = resolved.order;
    const codigoRastreio = sanitizeTrackingCode(req.body?.codigoRastreio ?? req.body?.codigo_rastreio);
    const observacoes = sanitizeNotes(req.body?.observacoes ?? previousOrder.observacoes);

    await updateOrderFields(orderId, {
      codigo_rastreio: codigoRastreio,
      observacoes
    });

    const updatedOrder = await getOrderById(orderId);

    await handleOrderNotifications({
      trigger: "admin_tracking_update",
      previousOrder,
      nextOrder: updatedOrder
    });

    sendSuccess(res, "Código de rastreio atualizado com sucesso.", {
      pedido: updatedOrder
    });
  } catch (error) {
    sendError(res, 500, error.message || "Não foi possível atualizar o rastreio do pedido.");
  }
});

module.exports = router;
