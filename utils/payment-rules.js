const CREDIT_INSTALLMENT_ADJUSTMENTS = {
  1: 0,
  2: 3,
  3: 5,
  4: 7,
  5: 9,
  6: 12,
  7: 14,
  8: 16,
  9: 18,
  10: 20
};

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeOrderStatus(value) {
  const status = String(value || "pendente").trim().toLowerCase();
  return ["pendente", "confirmado", "cancelado"].includes(status)
    ? status
    : "pendente";
}

function normalizePaymentMethod(value) {
  const raw = String(value || "").trim().toLowerCase();

  const aliases = {
    pix: "pix",
    cartao_credito: "cartao_credito",
    "cartão de crédito": "cartao_credito",
    "cartao de credito": "cartao_credito",
    credito: "cartao_credito",
    cartao_debito: "cartao_debito",
    "cartão de débito": "cartao_debito",
    "cartao de debito": "cartao_debito",
    debito: "cartao_debito"
  };

  return aliases[raw] || null;
}

function normalizePaymentInput(body = {}) {
  const rawMethod =
    body?.pagamento?.metodo ??
    body?.pagamentoMetodo ??
    body?.metodoPagamento ??
    body?.formaPagamento ??
    body?.pagamento ??
    "";

  const metodo = normalizePaymentMethod(rawMethod);

  if (!metodo) {
    throw new Error("Informe uma forma de pagamento válida.");
  }

  if (metodo === "pix") {
    return {
      metodo,
      parcelas: null,
      ajusteTipo: "desconto",
      ajustePercentual: 20
    };
  }

  if (metodo === "cartao_debito") {
    return {
      metodo,
      parcelas: null,
      ajusteTipo: "desconto",
      ajustePercentual: 15
    };
  }

  const parcelas = Number(
    body?.pagamento?.parcelas ??
    body?.pagamentoParcelas ??
    body?.parcelas ??
    1
  );

  if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 10) {
    throw new Error("Informe um parcelamento válido.");
  }

  const ajustePercentual = CREDIT_INSTALLMENT_ADJUSTMENTS[parcelas] ?? 0;

  return {
    metodo,
    parcelas,
    ajusteTipo: ajustePercentual > 0 ? "acrescimo" : "sem_ajuste",
    ajustePercentual
  };
}

function calculateFinalTotal(subtotal, payment) {
  if (payment.ajusteTipo === "desconto") {
    return roundCurrency(subtotal - (subtotal * payment.ajustePercentual / 100));
  }

  if (payment.ajusteTipo === "acrescimo") {
    return roundCurrency(subtotal + (subtotal * payment.ajustePercentual / 100));
  }

  return roundCurrency(subtotal);
}

module.exports = {
  CREDIT_INSTALLMENT_ADJUSTMENTS,
  roundCurrency,
  normalizeOrderStatus,
  normalizePaymentMethod,
  normalizePaymentInput,
  calculateFinalTotal
};
