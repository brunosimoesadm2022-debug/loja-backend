const ORDER_STATUS_SEQUENCE = [
  "aguardando_pagamento",
  "pagamento_aprovado",
  "em_preparacao",
  "enviado",
  "entregue",
  "cancelado"
];

const ORDER_STATUS_LABELS = {
  aguardando_pagamento: "Aguardando pagamento",
  pagamento_aprovado: "Pagamento aprovado",
  em_preparacao: "Em preparação",
  enviado: "Enviado",
  entregue: "Entregue",
  cancelado: "Cancelado"
};

const ORDER_STATUS_ALIASES = {
  pendente: "aguardando_pagamento",
  confirmado: "pagamento_aprovado",
  cancelado: "cancelado",
  aguardando_pagamento: "aguardando_pagamento",
  pagamento_aprovado: "pagamento_aprovado",
  em_preparacao: "em_preparacao",
  enviado: "enviado",
  entregue: "entregue"
};

const ALLOWED_STATUS_TRANSITIONS = {
  aguardando_pagamento: ["pagamento_aprovado", "cancelado"],
  pagamento_aprovado: ["em_preparacao", "cancelado"],
  em_preparacao: ["enviado", "cancelado"],
  enviado: ["entregue", "cancelado"],
  entregue: [],
  cancelado: []
};

function normalizeOrderStatus(value, fallback = "aguardando_pagamento") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ORDER_STATUS_ALIASES[normalized] || fallback;
}

function getOrderStatusLabel(status) {
  const normalized = normalizeOrderStatus(status);
  return ORDER_STATUS_LABELS[normalized] || ORDER_STATUS_LABELS.aguardando_pagamento;
}

function getAllowedNextStatuses(status, paymentStatus = "") {
  const normalized = normalizeOrderStatus(status);
  const nextStatuses = [...(ALLOWED_STATUS_TRANSITIONS[normalized] || [])];

  if (!paymentAllowsFulfillment(paymentStatus)) {
    return nextStatuses.filter(nextStatus => nextStatus !== "pagamento_aprovado");
  }

  return nextStatuses;
}

function paymentAllowsFulfillment(paymentStatus) {
  return String(paymentStatus || "").trim().toLowerCase() === "aprovado";
}

function validateOrderStatusTransition(currentStatus, nextStatus, paymentStatus) {
  const current = normalizeOrderStatus(currentStatus);
  const next = normalizeOrderStatus(nextStatus, "");

  if (!next) {
    return {
      valid: false,
      message: "Informe um status de pedido válido."
    };
  }

  if (current === next) {
    return { valid: true };
  }

  const allowedNextStatuses = getAllowedNextStatuses(current);

  if (!allowedNextStatuses.includes(next)) {
    return {
      valid: false,
      message: `Não é permitido mudar o pedido de ${getOrderStatusLabel(current)} para ${getOrderStatusLabel(next)}.`
    };
  }

  if (
    ["pagamento_aprovado", "em_preparacao", "enviado", "entregue"].includes(next) &&
    !paymentAllowsFulfillment(paymentStatus)
  ) {
    return {
      valid: false,
      message: "O pedido só pode avançar após o pagamento ser aprovado."
    };
  }

  return { valid: true };
}

function deriveOrderStatusFromPayment(currentStatus, paymentStatus) {
  const current = normalizeOrderStatus(currentStatus);
  const payment = String(paymentStatus || "").trim().toLowerCase();

  if (payment === "aprovado") {
    if (["em_preparacao", "enviado", "entregue", "cancelado"].includes(current)) {
      return current;
    }

    return "pagamento_aprovado";
  }

  if (payment === "cancelado" || payment === "estornado") {
    return "cancelado";
  }

  if (["aguardando_pagamento", "pendente", "recusado"].includes(payment)) {
    if (["em_preparacao", "enviado", "entregue", "cancelado"].includes(current)) {
      return current;
    }

    return "aguardando_pagamento";
  }

  return current || "aguardando_pagamento";
}

module.exports = {
  ORDER_STATUS_SEQUENCE,
  ORDER_STATUS_LABELS,
  normalizeOrderStatus,
  getOrderStatusLabel,
  getAllowedNextStatuses,
  validateOrderStatusTransition,
  deriveOrderStatusFromPayment
};
