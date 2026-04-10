const crypto = require("crypto");
const https = require("https");

const MERCADO_PAGO_API_BASE = "https://api.mercadopago.com";

function isMercadoPagoConfigured() {
  return !!String(process.env.MERCADO_PAGO_ACCESS_TOKEN || "").trim();
}

function isSandboxMode() {
  const token = String(process.env.MERCADO_PAGO_ACCESS_TOKEN || "").trim().toUpperCase();
  return token.startsWith("TEST-");
}

function getAccessToken() {
  const token = String(process.env.MERCADO_PAGO_ACCESS_TOKEN || "").trim();

  if (!token) {
    throw new Error("Mercado Pago nao configurado. Defina MERCADO_PAGO_ACCESS_TOKEN no backend.");
  }

  return token;
}

function mercadoPagoRequest(method, endpoint, body, extraHeaders = {}) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    Authorization: `Bearer ${getAccessToken()}`,
    Accept: "application/json",
    ...extraHeaders
  };

  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      `${MERCADO_PAGO_API_BASE}${endpoint}`,
      { method, headers },
      response => {
        const chunks = [];

        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = null;

          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (error) {
            data = raw;
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(data);
            return;
          }

          const message =
            (data && data.message) ||
            (data && data.error) ||
            (data && data.cause && data.cause[0] && data.cause[0].description) ||
            "Falha ao comunicar com o Mercado Pago.";

          const requestError = new Error(message);
          requestError.status = response.statusCode;
          requestError.response = data;
          reject(requestError);
        });
      }
    );

    request.on("error", reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function splitFullName(name) {
  const normalized = String(name || "").trim().replace(/\s+/g, " ");

  if (!normalized) {
    return {
      firstName: "Cliente",
      lastName: "Loja do Garimpo"
    };
  }

  const parts = normalized.split(" ");

  return {
    firstName: parts.shift() || "Cliente",
    lastName: parts.join(" ") || "Loja do Garimpo"
  };
}

function sanitizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildAdjustedPreferenceItems(order) {
  const items = Array.isArray(order && order.itens) ? order.itens : [];
  const subtotal = Number((order && order.subtotal) || 0);
  const total = Number((order && order.total) || 0);

  if (!items.length || total <= 0) {
    throw new Error("O pedido nao possui itens validos para pagamento.");
  }

  if (subtotal <= 0) {
    return items.map((item, index) => ({
      id: `${item.produtoId || "item"}-${index + 1}`,
      title: Number(item.quantidade || 0) > 1
        ? `${item.produtoNome} (${item.quantidade}x)`
        : item.produtoNome,
      quantity: 1,
      currency_id: "BRL",
      unit_price: roundCurrency(item.subtotal)
    }));
  }

  const factor = total / subtotal;
  let allocated = 0;

  return items.map((item, index) => {
    const originalLine = Number(item.subtotal || 0);
    const isLastItem = index === items.length - 1;
    const adjustedLine = isLastItem
      ? roundCurrency(total - allocated)
      : roundCurrency(originalLine * factor);

    allocated = roundCurrency(allocated + adjustedLine);

    return {
      id: `${item.produtoId || "item"}-${index + 1}`,
      title: Number(item.quantidade || 0) > 1
        ? `${item.produtoNome} (${item.quantidade}x)`
        : item.produtoNome,
      quantity: 1,
      currency_id: "BRL",
      unit_price: adjustedLine
    };
  });
}

function buildPaymentMethodsConfig(selection) {
  const method = String((selection && selection.method) || "").trim().toLowerCase();

  if (method === "pix") {
    return {
      installments: 1,
      default_installments: 1,
      excluded_payment_types: [
        { id: "credit_card" },
        { id: "debit_card" },
        { id: "ticket" }
      ]
    };
  }

  if (method === "cartao_debito") {
    return {
      installments: 1,
      default_installments: 1,
      excluded_payment_types: [
        { id: "bank_transfer" },
        { id: "credit_card" },
        { id: "ticket" }
      ]
    };
  }

  const installments = Number((selection && selection.installments) || 1);
  const validInstallments = Number.isInteger(installments) && installments >= 1 && installments <= 10
    ? installments
    : 1;

  return {
    installments: validInstallments,
    default_installments: validInstallments,
    excluded_payment_types: [
      { id: "bank_transfer" },
      { id: "debit_card" },
      { id: "ticket" }
    ]
  };
}

async function createCheckoutPreference(config) {
  const order = config.order;
  const user = config.user;
  const paymentSelection = config.paymentSelection || {};
  const frontendBaseUrl = String(process.env.BASE_URL_FRONTEND || "").trim();
  const backendBaseUrl = String(process.env.BASE_URL_BACKEND || "").trim();

  if (!frontendBaseUrl || !backendBaseUrl) {
    throw new Error("Defina BASE_URL_FRONTEND e BASE_URL_BACKEND para usar o pagamento real.");
  }

  const cleanFrontendBase = frontendBaseUrl.replace(/\/+$/, "");
  const cleanBackendBase = backendBaseUrl.replace(/\/+$/, "");

  const preferencePayload = {
    items: buildAdjustedPreferenceItems(order),
    payer: {
      name: (user && user.nome) || "Cliente Loja do Garimpo",
      email: (user && user.email) || undefined
    },
    external_reference: String(order.id),
    metadata: {
      pedido_id: String(order.id),
      usuario_id: String((user && user.id) || ""),
      forma_pagamento: String(paymentSelection.method || "")
    },
    notification_url: `${cleanBackendBase}/api/pagamentos/webhook`,
    back_urls: {
      success: `${cleanFrontendBase}/sucesso.html?pedido=${encodeURIComponent(order.id)}`,
      pending: `${cleanFrontendBase}/sucesso.html?pedido=${encodeURIComponent(order.id)}`,
      failure: `${cleanFrontendBase}/sucesso.html?pedido=${encodeURIComponent(order.id)}`
    },
    auto_return: "approved",
    payment_methods: buildPaymentMethodsConfig(paymentSelection)
  };

  return mercadoPagoRequest("POST", "/checkout/preferences", preferencePayload);
}

function mapPixPaymentData(payment) {
  const transactionData =
    (payment && payment.point_of_interaction && payment.point_of_interaction.transaction_data) || {};
  const qrCode = String(transactionData.qr_code || "");
  const qrCodeBase64 = String(transactionData.qr_code_base64 || "");
  const ticketUrl = String(transactionData.ticket_url || "");

  return {
    paymentId: String((payment && payment.id) || ""),
    status: String((payment && payment.status) || ""),
    qrCode,
    qrCodeBase64,
    ticketUrl,
    codigoCopiaECola: qrCode,
    copiaECola: qrCode
  };
}

async function createPixPayment(config) {
  const order = config.order;
  const user = config.user;
  const paymentSelection = config.paymentSelection || {};
  const frontendBaseUrl = String(process.env.BASE_URL_FRONTEND || "").trim();
  const backendBaseUrl = String(process.env.BASE_URL_BACKEND || "").trim();
  const total = roundCurrency(order && order.total);
  const cpf = sanitizeCpf(
    paymentSelection.cpf ||
    paymentSelection.document ||
    paymentSelection.identificationNumber
  );

  if (!frontendBaseUrl || !backendBaseUrl) {
    throw new Error("Defina BASE_URL_FRONTEND e BASE_URL_BACKEND para usar o pagamento real.");
  }

  if (total <= 0) {
    throw new Error("O pedido nao possui um valor valido para gerar o Pix.");
  }

  if (cpf.length !== 11) {
    throw new Error("Informe um CPF valido para gerar o Pix.");
  }

  const cleanFrontendBase = frontendBaseUrl.replace(/\/+$/, "");
  const cleanBackendBase = backendBaseUrl.replace(/\/+$/, "");
  const payerName = splitFullName((user && user.nome) || "");
  const paymentPayload = {
    transaction_amount: total,
    description: `Pedido Loja do Garimpo #${order.id}`,
    payment_method_id: "pix",
    notification_url: `${cleanBackendBase}/api/pagamentos/webhook`,
    external_reference: String(order.id),
    metadata: {
      pedido_id: String(order.id),
      usuario_id: String((user && user.id) || ""),
      forma_pagamento: "pix",
      origem_frontend: cleanFrontendBase
    },
    payer: {
      email: (user && user.email) || undefined,
      first_name: payerName.firstName,
      last_name: payerName.lastName,
      identification: {
        type: "CPF",
        number: cpf
      }
    }
  };

  return mercadoPagoRequest(
    "POST",
    "/v1/payments",
    paymentPayload,
    { "X-Idempotency-Key": crypto.randomBytes(16).toString("hex") }
  );
}

async function getPaymentById(paymentId) {
  return mercadoPagoRequest("GET", `/v1/payments/${encodeURIComponent(paymentId)}`);
}

function parseWebhookSignature(signatureHeader) {
  const parts = String(signatureHeader || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  const values = {};

  parts.forEach(part => {
    const separatorIndex = part.indexOf("=");

    if (separatorIndex === -1) {
      return;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    values[key] = value;
  });

  return {
    ts: values.ts || "",
    v1: values.v1 || ""
  };
}

function verifyWebhookSignature(config) {
  const signatureHeader = config.signatureHeader;
  const requestId = config.requestId;
  const dataId = config.dataId;
  const secret = String(process.env.MERCADO_PAGO_WEBHOOK_SECRET || "").trim();

  if (!secret) {
    return { valid: true, reason: "secret_not_configured" };
  }

  const signature = parseWebhookSignature(signatureHeader);

  if (!signature.ts || !signature.v1 || !requestId || !dataId) {
    return { valid: false, reason: "missing_signature_parts" };
  }

  const manifest = `id:${dataId};request-id:${requestId};ts:${signature.ts};`;
  const expectedHash = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  const providedBuffer = Buffer.from(signature.v1, "utf8");
  const expectedBuffer = Buffer.from(expectedHash, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) {
    return { valid: false, reason: "signature_length_mismatch" };
  }

  return {
    valid: crypto.timingSafeEqual(providedBuffer, expectedBuffer),
    reason: "validated"
  };
}

function mapMercadoPagoStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();

  if (normalized === "approved") {
    return { orderStatus: "pagamento_aprovado", paymentStatus: "aprovado" };
  }

  if (normalized === "authorized" || normalized === "pending" || normalized === "action_required") {
    return { orderStatus: "aguardando_pagamento", paymentStatus: "aguardando_pagamento" };
  }

  if (normalized === "in_process" || normalized === "in_mediation" || normalized === "processing") {
    return { orderStatus: "aguardando_pagamento", paymentStatus: "pendente" };
  }

  if (normalized === "rejected") {
    return { orderStatus: "aguardando_pagamento", paymentStatus: "recusado" };
  }

  if (normalized === "cancelled" || normalized === "expired") {
    return { orderStatus: "cancelado", paymentStatus: "cancelado" };
  }

  if (normalized === "refunded" || normalized === "charged_back") {
    return { orderStatus: "cancelado", paymentStatus: "estornado" };
  }

  return { orderStatus: "aguardando_pagamento", paymentStatus: "pendente" };
}

module.exports = {
  isMercadoPagoConfigured,
  isSandboxMode,
  createCheckoutPreference,
  createPixPayment,
  getPaymentById,
  mapPixPaymentData,
  verifyWebhookSignature,
  mapMercadoPagoStatus
};
