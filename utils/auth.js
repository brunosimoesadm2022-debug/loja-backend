const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "loja_do_garimpo_dev_secret_trocar_em_producao";
const JWT_EXPIRES_IN = "7d";

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    telefone: user.telefone || "",
    documento: user.documento || "",
    cidade: user.cidade || "",
    estado: user.estado || "",
    cidade_estado:
      [String(user.cidade || "").trim(), String(user.estado || "").trim()]
        .filter(Boolean)
        .join(" / "),
    is_admin: !!user.is_admin,
    email_verificado: !!user.email_verificado,
    data_criacao: user.data_criacao
  };
}

function generateToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      email: user.email,
      is_admin: !!user.is_admin
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function formatAuthResponse(user, message) {
  const safeUser = sanitizeUser(user);

  return {
    success: true,
    message,
    data: {
      token: generateToken(safeUser),
      user: safeUser
    }
  };
}

module.exports = {
  sanitizeUser,
  generateToken,
  verifyToken,
  validateEmail,
  formatAuthResponse
};
