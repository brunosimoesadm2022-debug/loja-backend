function requireAdmin(req, res, next) {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Usuário não autenticado."
    });
    return;
  }

  if (!req.user.is_admin) {
    res.status(403).json({
      success: false,
      message: "Acesso restrito a administradores."
    });
    return;
  }

  next();
}

module.exports = {
  requireAdmin
};
