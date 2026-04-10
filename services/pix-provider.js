const crypto = require("crypto");
const {
  createCharge,
  extractChargeFromPayload,
  fetchBinaryAsBase64,
  getChargeStatus,
  getOpenPixApiBase,
  getOpenPixWebhookUrl,
  isOpenPixConfigured,
  isOpenPixSandboxMode,
  verifyWebhookSignature
} = require("./openpixService");

function isPixProviderConfigured() {
  return isOpenPixConfigured();
}

function getPixProviderName() {
  return String(process.env.PIX_PROVIDER || "openpix").trim().toLowerCase() || "openpix";
}

function isSandboxMode() {
  return isOpenPixSandboxMode();
}

function getPixApiBase() {
  return getOpenPixApiBase();
}

function getPixWebhookUrl() {
  return getOpenPixWebhookUrl();
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function toCents(value) {
  return Math.round(roundCurrency(value) * 100);
}

function sanitizeTaxId(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildChargeCorrelationId(orderId) {
  const suffix =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().split("-")[0]
      : crypto.randomBytes(8).toString("hex");

  return `pedido-${orderId}-${suffix}`;
}

function buildCustomerPayload(user, paymentSelection = {}) {
  const taxId = sanitizeTaxId(
    paymentSelection.cpf ||
    paymentSelection.taxId ||
    paymentSelection.document ||
    paymentSelection.identificationNumber
  );
  const name = String(
    paymentSelection.nome ||
    paymentSelection.nomeCliente ||
    paymentSelection.customerName ||
    user?.nome ||
    "Cliente Loja do Garimpo"
  ).trim();
  const email = String(
    paymentSelection.email ||
    paymentSelection.clienteEmail ||
    paymentSelection.customerEmail ||
    user?.email ||
    ""
  ).trim();
  const customer = {
    name
  };

  if (email) {
    customer.email = email;
  }

  if (taxId) {
    if (![11, 14].includes(taxId.length)) {
      throw new Error("Informe um CPF ou CNPJ valido para gerar a cobranca Pix.");
    }

    customer.taxID = taxId;
  }

  if (user?.id) {
    customer.correlationID = `usuario-${user.id}`;
  }

  return customer;
}

async function fetchQrCodeBase64(charge) {
  return fetchBinaryAsBase64(charge?.qrCodeImage || "");
}

function normalizeChargeStatus(statusOrCharge, explicitEvent = "") {
  const rawStatus = String(
    typeof statusOrCharge === "string"
      ? statusOrCharge
      : statusOrCharge?.status || ""
  ).trim().toUpperCase();
  const eventName = String(
    explicitEvent ||
    (typeof statusOrCharge === "object" ? statusOrCharge?.event : "")
  ).trim().toUpperCase();

  if (rawStatus === "COMPLETED" || eventName.includes("CHARGE_COMPLETED")) {
    return {
      orderStatus: "pagamento_aprovado",
      paymentStatus: "aprovado",
      rawStatus: rawStatus || "COMPLETED"
    };
  }

  if (rawStatus === "EXPIRED" || eventName.includes("CHARGE_EXPIRED")) {
    return {
      orderStatus: "aguardando_pagamento",
      paymentStatus: "cancelado",
      rawStatus: rawStatus || "EXPIRED"
    };
  }

  if (rawStatus === "ACTIVE" || rawStatus === "CREATED" || eventName.includes("CHARGE_CREATED")) {
    return {
      orderStatus: "aguardando_pagamento",
      paymentStatus: "aguardando_pagamento",
      rawStatus: rawStatus || "ACTIVE"
    };
  }

  return {
    orderStatus: "aguardando_pagamento",
    paymentStatus: "pendente",
    rawStatus: rawStatus || "UNKNOWN"
  };
}

async function mapPixChargeData(charge) {
  const normalized = normalizeChargeStatus(charge);
  const qrCodeBase64 = await fetchQrCodeBase64(charge);
  const paymentId = String(
    charge?.identifier ||
    charge?.transactionID ||
    charge?.paymentLinkID ||
    charge?.correlationID ||
    ""
  );

  return {
    paymentId,
    gatewayPaymentId: paymentId,
    referenceId: String(charge?.correlationID || ""),
    paymentLinkId: String(charge?.paymentLinkID || ""),
    status: normalized.paymentStatus,
    gatewayStatus: normalized.rawStatus,
    qrCode: String(charge?.brCode || ""),
    qrCodeBase64,
    qrCodeImage: qrCodeBase64,
    codigoCopiaECola: String(charge?.brCode || ""),
    copiaECola: String(charge?.brCode || ""),
    ticketUrl: String(charge?.paymentLinkUrl || ""),
    expiresDate: charge?.expiresDate || null,
    createdAt: charge?.createdAt || null,
    updatedAt: charge?.updatedAt || null,
    paidAt: charge?.paidAt || null
  };
}

async function createPixCharge(config) {
  const order = config?.order;
  const user = config?.user;
  const paymentSelection = config?.paymentSelection || {};
  const totalCents = toCents(order?.total);

  if (totalCents <= 0) {
    throw new Error("O pedido nao possui valor valido para gerar o Pix.");
  }

  const requestedAmount = Number(paymentSelection.valor ?? paymentSelection.amount);

  if (
    Number.isFinite(requestedAmount) &&
    Math.abs(roundCurrency(requestedAmount) - roundCurrency(order?.total)) >= 0.01
  ) {
    console.warn(
      "[pagamentos:pix] valor recebido no frontend foi ignorado",
      JSON.stringify({
        pedidoId: order?.id || 0,
        valorRecebido: roundCurrency(requestedAmount),
        valorPedido: roundCurrency(order?.total)
      })
    );
  }

  const correlationID = String(config?.correlationId || buildChargeCorrelationId(order?.id)).trim();
  const charge = await createCharge({
    correlationId: correlationID,
    valueCents: totalCents,
    comment: `Pedido Loja do Garimpo #${order.id}`,
    customer: buildCustomerPayload(user, paymentSelection)
  });

  return {
    ...charge,
    correlationID: charge.correlationID || correlationID
  };
}

async function getPixChargeById(chargeId) {
  return getChargeStatus({ chargeId });
}

async function getPixChargeByReferenceId(referenceId) {
  return getChargeStatus({ correlationId: referenceId });
}

function verifyPixWebhookSignature(config) {
  return verifyWebhookSignature(config);
}

function extractWebhookChargeIdentifiers(payload) {
  const charge = extractChargeFromPayload(payload);

  return {
    referenceId: String(charge?.correlationID || "").trim(),
    chargeId: String(
      charge?.identifier ||
      charge?.transactionID ||
      charge?.paymentLinkID ||
      charge?.chargeId ||
      ""
    ).trim()
  };
}

function extractWebhookChargeReference(payload) {
  const identifiers = extractWebhookChargeIdentifiers(payload);
  return identifiers.referenceId || identifiers.chargeId;
}

module.exports = {
  buildChargeCorrelationId,
  createPixCharge,
  extractWebhookChargeIdentifiers,
  extractWebhookChargeReference,
  getPixApiBase,
  getPixChargeById,
  getPixChargeByReferenceId,
  getPixProviderName,
  getPixWebhookUrl,
  isPixProviderConfigured,
  isSandboxMode,
  mapPixChargeData,
  normalizeChargeStatus,
  verifyPixWebhookSignature
};
