const crypto = require("crypto");
const http = require("http");
const https = require("https");

const OPENPIX_PRODUCTION_BASE = "https://api.openpix.com.br";
const OPENPIX_SANDBOX_BASE = "https://api.woovi-sandbox.com";

function normalizeUrlBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getOpenPixAppId() {
  // Defina o OPENPIX_APP_ID real no backend/.env para ativar a cobranca Pix.
  return String(process.env.OPENPIX_APP_ID || "").trim();
}

function getOpenPixWebhookSecret() {
  // Defina o OPENPIX_WEBHOOK_SECRET real no backend/.env para validar o webhook.
  return String(process.env.OPENPIX_WEBHOOK_SECRET || "").trim();
}

function isOpenPixConfigured() {
  return !!getOpenPixAppId();
}

function getOpenPixApiBase() {
  const configuredBase = normalizeUrlBase(process.env.OPENPIX_API_BASE);

  if (configuredBase) {
    return configuredBase;
  }

  return isOpenPixSandboxMode() ? OPENPIX_SANDBOX_BASE : OPENPIX_PRODUCTION_BASE;
}

function isOpenPixSandboxMode() {
  const explicitValue = String(process.env.OPENPIX_SANDBOX || "").trim().toLowerCase();

  if (explicitValue) {
    return ["1", "true", "yes", "on"].includes(explicitValue);
  }

  return getOpenPixApiBase().includes("sandbox");
}

function getOpenPixWebhookUrl() {
  const backendBase = normalizeUrlBase(process.env.BASE_URL_BACKEND);

  if (!backendBase) {
    return "";
  }

  return `${backendBase}/api/pagamentos/webhook`;
}

function getAuthorizationHeader() {
  const appId = getOpenPixAppId();

  if (!appId) {
    throw new Error("Pix provider nao configurado. Defina OPENPIX_APP_ID no backend.");
  }

  return `App ${appId}`;
}

function buildProviderUrl(endpointOrUrl) {
  const target = String(endpointOrUrl || "").trim();

  if (!target) {
    throw new Error("Endpoint OpenPix invalido.");
  }

  if (/^https?:\/\//i.test(target)) {
    return target;
  }

  const normalizedPath = target.startsWith("/") ? target : `/${target}`;
  return `${getOpenPixApiBase()}${normalizedPath}`;
}

function performHttpRequest(method, endpointOrUrl, body, extraHeaders = {}, expectBinary = false) {
  const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
  const url = new URL(buildProviderUrl(endpointOrUrl));
  const transport = url.protocol === "http:" ? http : https;
  const headers = {
    Authorization: getAuthorizationHeader(),
    Accept: expectBinary ? "*/*" : "application/json",
    ...extraHeaders
  };

  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = payload.length;
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers
      },
      response => {
        const chunks = [];

        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);

          if (response.statusCode >= 200 && response.statusCode < 300) {
            if (expectBinary) {
              resolve(buffer);
              return;
            }

            const raw = buffer.toString("utf8");

            try {
              resolve(raw ? JSON.parse(raw) : null);
            } catch (error) {
              resolve(raw);
            }

            return;
          }

          const raw = buffer.toString("utf8");
          let data = null;

          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (error) {
            data = raw;
          }

          const message =
            data?.message ||
            data?.error ||
            data?.errors?.[0]?.message ||
            "Falha ao comunicar com a OpenPix.";

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

async function performFetchRequest(method, endpointOrUrl, body, extraHeaders = {}, expectBinary = false) {
  const targetUrl = buildProviderUrl(endpointOrUrl);
  const response = await fetch(targetUrl, {
    method,
    headers: {
      Authorization: getAuthorizationHeader(),
      Accept: expectBinary ? "*/*" : "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.ok) {
    if (expectBinary) {
      return Buffer.from(await response.arrayBuffer());
    }

    const raw = await response.text();

    try {
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return raw;
    }
  }

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (error) {
    data = raw;
  }

  const message =
    data?.message ||
    data?.error ||
    data?.errors?.[0]?.message ||
    "Falha ao comunicar com a OpenPix.";

  const requestError = new Error(message);
  requestError.status = response.status;
  requestError.response = data;
  throw requestError;
}

async function requestOpenPix(method, endpointOrUrl, body, extraHeaders = {}, expectBinary = false) {
  if (typeof fetch === "function") {
    return performFetchRequest(method, endpointOrUrl, body, extraHeaders, expectBinary);
  }

  return performHttpRequest(method, endpointOrUrl, body, extraHeaders, expectBinary);
}

function extractChargeFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (payload.charge) {
    return payload.charge;
  }

  if (payload.data?.charge) {
    return payload.data.charge;
  }

  if (payload.data && payload.data.correlationID) {
    return payload.data;
  }

  if (payload.correlationID || payload.identifier || payload.transactionID) {
    return payload;
  }

  return null;
}

async function fetchBinaryAsBase64(resourceUrl) {
  const target = String(resourceUrl || "").trim();

  if (!target) {
    return "";
  }

  try {
    const buffer = await requestOpenPix("GET", target, null, {}, true);
    return buffer.toString("base64");
  } catch (error) {
    return "";
  }
}

async function createCharge({ correlationId, valueCents, customer, comment }) {
  const payload = {
    correlationID: String(correlationId || "").trim(),
    value: Number(valueCents || 0),
    comment: String(comment || "").trim(),
    customer: customer || {}
  };
  const webhookUrl = getOpenPixWebhookUrl();

  console.info(
    "[openpix:createCharge] iniciando cobranca",
    JSON.stringify({
      correlationId: payload.correlationID,
      valueCents: payload.value,
      webhookUrl,
      sandbox: isOpenPixSandboxMode()
    })
  );

  const response = await requestOpenPix(
    "POST",
    "/api/v1/charge?return_existing=true",
    payload
  );
  const charge = extractChargeFromPayload(response);

  if (!charge) {
    throw new Error("A OpenPix nao retornou os dados da cobranca.");
  }

  console.info(
    "[openpix:createCharge] cobranca criada",
    JSON.stringify({
      correlationId: charge.correlationID || payload.correlationID,
      chargeId: charge.identifier || charge.transactionID || charge.paymentLinkID || ""
    })
  );

  return charge;
}

async function getChargeStatus({ chargeId, correlationId }) {
  const identifier = String(chargeId || correlationId || "").trim();

  if (!identifier) {
    throw new Error("Informe um chargeId ou correlationId para consultar a cobranca Pix.");
  }

  const response = await requestOpenPix(
    "GET",
    `/api/v1/charge/${encodeURIComponent(identifier)}`
  );
  const charge = extractChargeFromPayload(response);

  if (!charge) {
    throw new Error("Cobranca Pix nao encontrada na OpenPix.");
  }

  return charge;
}

function verifyWebhookSignature({ signatureHeader, rawBody }) {
  const secret = getOpenPixWebhookSecret();
  const signature = String(signatureHeader || "").trim();
  const payload = String(rawBody || "");

  if (!secret) {
    return { valid: true, reason: "secret_not_configured" };
  }

  if (!signature || !payload) {
    return { valid: false, reason: "missing_signature_or_body" };
  }

  const expectedSignature = crypto
    .createHmac("sha1", secret)
    .update(payload)
    .digest("base64");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const providedBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    return { valid: false, reason: "signature_length_mismatch" };
  }

  return {
    valid: crypto.timingSafeEqual(expectedBuffer, providedBuffer),
    reason: "validated"
  };
}

module.exports = {
  OPENPIX_PRODUCTION_BASE,
  OPENPIX_SANDBOX_BASE,
  createCharge,
  extractChargeFromPayload,
  fetchBinaryAsBase64,
  getChargeStatus,
  getOpenPixApiBase,
  getOpenPixWebhookUrl,
  isOpenPixConfigured,
  isOpenPixSandboxMode,
  verifyWebhookSignature
};
