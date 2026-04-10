const { get } = require("../database");
const { sanitizeUser, verifyToken } = require("../utils/auth");

async function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        message: "Token de acesso não informado."
      });
      return;
    }

    const token = authorization.slice("Bearer ".length).trim();

    if (!token) {
      res.status(401).json({
        success: false,
        message: "Token de acesso inválido."
      });
      return;
    }

    const payload = verifyToken(token);
    const userId = Number(payload.sub);

    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(401).json({
        success: false,
        message: "Token de acesso inválido."
      });
      return;
    }

    const user = await get(
      `SELECT id, nome, email, telefone, documento, cidade, estado, is_admin, email_verificado, data_criacao
       FROM usuarios
       WHERE id = ?`,
      [userId]
    );

    if (!user) {
      res.status(401).json({
        success: false,
        message: "Usuário da sessão não encontrado."
      });
      return;
    }

    req.user = sanitizeUser(user);
    req.auth = payload;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: "Token expirado ou inválido."
    });
  }
}

module.exports = {
  requireAuth
};
