require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { initializeDatabase, databasePath } = require("./database.js");
const authRoutes = require("./routes/auth");
const produtosRoutes = require("./routes/produtos");
const pedidosRoutes = require("./routes/pedidos");
const pagamentosRoutes = require("./routes/pagamentos");
const adminPedidosRoutes = require("./routes/admin-pedidos");

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const configuredFrontendOrigin = (() => {
  try {
    const value = String(process.env.BASE_URL_FRONTEND || "").trim();
    return value ? new URL(value).origin : "";
  } catch {
    return "";
  }
})();

function allowLocalFrontend(origin, callback) {
  if (!origin || origin === "null") {
    callback(null, true);
    return;
  }

  const allowedPatterns = [
    /^http:\/\/localhost(?::\d+)?$/i,
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i,
    /^https:\/\/localhost(?::\d+)?$/i,
    /^https:\/\/127\.0\.0\.1(?::\d+)?$/i
  ];

  if (allowedPatterns.some(pattern => pattern.test(origin))) {
    callback(null, true);
    return;
  }

  if (configuredFrontendOrigin && origin === configuredFrontendOrigin) {
    callback(null, true);
    return;
  }

  callback(new Error(`CORS bloqueado para a origem ${origin}`));
}

const corsOptions = {
  origin: allowLocalFrontend,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({
  limit: "20mb",
  verify: (req, res, buffer) => {
    req.rawBody = buffer ? buffer.toString("utf8") : "";
  }
}));
app.use("/api", (req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend ativo.",
    status: "ok",
    service: "loja-do-garimpo-backend",
    database: databasePath
  });
});

app.get("/health", (req, res) => {
  res.redirect(302, "/api/health");
});

app.use("/api/auth", authRoutes);
app.use("/api/produtos", produtosRoutes);
app.use("/api/pedidos", pedidosRoutes);
app.use("/api/pagamentos", pagamentosRoutes);
app.use("/api/admin/pedidos", adminPedidosRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Rota não encontrada." });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ success: false, message: "Erro interno no servidor." });
});

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(`Servidor rodando em http://localhost:${PORT}`);
      console.log(`Backend da Loja do Garimpo rodando em http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
      console.log("CORS habilitado para requisições do frontend local.");
      console.log(`Banco SQLite em: ${databasePath}`);
    });
  } catch (error) {
    console.error("Falha ao iniciar o backend:", error);
    process.exit(1);
  }
}

startServer();

