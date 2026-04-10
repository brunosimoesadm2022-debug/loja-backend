const express = require("express");
const bcrypt = require("bcrypt");
const { all, get, run, withTransaction } = require("../database");
const { requireAuth } = require("../middlewares/auth");
const { formatAuthResponse, sanitizeUser, validateEmail } = require("../utils/auth");
const { isBootstrapAdminEmail } = require("../utils/admin-users");

const router = express.Router();
const PASSWORD_MIN_LENGTH = 6;
const BCRYPT_ROUNDS = 10;

function normalizeRegisterInput(body = {}) {
  return {
    nome: String(body.nome || "").trim(),
    email: String(body.email || "").trim().toLowerCase(),
    senha: String(body.senha || "")
  };
}

function normalizeProfileInput(body = {}) {
  return {
    nome: String(body.nome || "").trim(),
    telefone: String(body.telefone || "").trim(),
    documento: String(body.documento || "").trim(),
    cidade: String(body.cidade || "").trim(),
    estado: String(body.estado || "").trim().toUpperCase().slice(0, 2)
  };
}

function normalizePasswordInput(body = {}) {
  return {
    senhaAtual: String(body.senhaAtual || ""),
    novaSenha: String(body.novaSenha || "")
  };
}

function normalizeAddressInput(body = {}) {
  return {
    titulo: String(body.titulo || "").trim(),
    destinatario: String(body.destinatario || "").trim(),
    telefone: String(body.telefone || "").trim(),
    cep: String(body.cep || "").trim(),
    rua: String(body.rua || "").trim(),
    numero: String(body.numero || "").trim(),
    complemento: String(body.complemento || "").trim(),
    bairro: String(body.bairro || "").trim(),
    cidade: String(body.cidade || "").trim(),
    estado: String(body.estado || "").trim().toUpperCase().slice(0, 2),
    referencia: String(body.referencia || "").trim(),
    principal: Boolean(body.principal)
  };
}

function sanitizeAddress(address) {
  if (!address) {
    return null;
  }

  return {
    id: address.id,
    usuarioId: address.usuario_id,
    titulo: address.titulo,
    destinatario: address.destinatario,
    telefone: address.telefone || "",
    cep: address.cep,
    rua: address.rua,
    numero: address.numero,
    complemento: address.complemento || "",
    bairro: address.bairro,
    cidade: address.cidade,
    estado: address.estado,
    referencia: address.referencia || "",
    principal: !!address.principal,
    dataCriacao: address.data_criacao,
    atualizadoEm: address.atualizado_em
  };
}

function validateAddressPayload(address) {
  if (!address.titulo) {
    return "Defina um titulo para identificar o endereco.";
  }

  if (!address.destinatario) {
    return "Informe o nome do destinatario.";
  }

  if (!address.cep) {
    return "Informe o CEP do endereco.";
  }

  if (!address.rua) {
    return "Informe a rua do endereco.";
  }

  if (!address.numero) {
    return "Informe o numero do endereco.";
  }

  if (!address.bairro) {
    return "Informe o bairro do endereco.";
  }

  if (!address.cidade) {
    return "Informe a cidade do endereco.";
  }

  if (!address.estado) {
    return "Informe o estado do endereco.";
  }

  return "";
}

async function findUserByEmail(email) {
  return get(
    `SELECT id, nome, email, senha, telefone, documento, cidade, estado, is_admin, email_verificado, token_verificacao, token_verificacao_expira_em, data_criacao
     FROM usuarios
     WHERE email = ?`,
    [email]
  );
}

async function findUserById(userId) {
  return get(
    `SELECT id, nome, email, senha, telefone, documento, cidade, estado, is_admin, email_verificado, token_verificacao, token_verificacao_expira_em, data_criacao
     FROM usuarios
     WHERE id = ?`,
    [userId]
  );
}

async function findAddressById(addressId, userId) {
  return get(
    `SELECT *
     FROM enderecos
     WHERE id = ? AND usuario_id = ?`,
    [addressId, userId]
  );
}

async function listAddressesByUserId(userId) {
  const rows = await all(
    `SELECT *
     FROM enderecos
     WHERE usuario_id = ?
     ORDER BY principal DESC, atualizado_em DESC, id DESC`,
    [userId]
  );

  return rows.map(sanitizeAddress);
}

async function ensureBootstrapAdminUser(user) {
  if (!user || !isBootstrapAdminEmail(user.email) || user.is_admin) {
    return user;
  }

  await run("UPDATE usuarios SET is_admin = 1 WHERE id = ?", [user.id]);
  return findUserById(user.id);
}

router.post("/register", async (req, res) => {
  try {
    const { nome, email, senha } = normalizeRegisterInput(req.body);

    if (!nome) {
      res.status(400).json({ success: false, message: "O nome é obrigatório." });
      return;
    }

    if (!email) {
      res.status(400).json({ success: false, message: "O e-mail é obrigatório." });
      return;
    }

    if (!validateEmail(email)) {
      res.status(400).json({ success: false, message: "Informe um e-mail válido." });
      return;
    }

    if (!senha) {
      res.status(400).json({ success: false, message: "A senha é obrigatória." });
      return;
    }

    if (senha.length < PASSWORD_MIN_LENGTH) {
      res.status(400).json({
        success: false,
        message: `A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`
      });
      return;
    }

    const existingUser = await findUserByEmail(email);

    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "Já existe uma conta cadastrada com este e-mail."
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(senha, BCRYPT_ROUNDS);
    const shouldStartAsAdmin = isBootstrapAdminEmail(email) ? 1 : 0;

    // Preparado para futura confirmação por e-mail:
    // o token de verificação e sua expiração podem ser gerados aqui quando essa etapa for ativada.
    const result = await run(
      `INSERT INTO usuarios (
        nome,
        email,
        senha,
        is_admin,
        email_verificado,
        token_verificacao,
        token_verificacao_expira_em
      )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nome, email, hashedPassword, shouldStartAsAdmin, 0, null, null]
    );

    const createdUser = await ensureBootstrapAdminUser(await findUserById(result.id));

    res.status(201).json(
      formatAuthResponse(createdUser, "Conta criada com sucesso.")
    );
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Não foi possível concluir o cadastro agora."
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const senha = String(req.body.senha || "");

    if (!email || !validateEmail(email)) {
      res.status(400).json({
        success: false,
        message: "Informe um e-mail válido."
      });
      return;
    }

    if (!senha) {
      res.status(400).json({
        success: false,
        message: "Informe sua senha para continuar."
      });
      return;
    }

    const user = await findUserByEmail(email);

    if (!user) {
      res.status(401).json({
        success: false,
        message: "E-mail ou senha inválidos."
      });
      return;
    }

    const passwordMatches = await bcrypt.compare(senha, user.senha);

    if (!passwordMatches) {
      res.status(401).json({
        success: false,
        message: "E-mail ou senha inválidos."
      });
      return;
    }

    const resolvedUser = await ensureBootstrapAdminUser(user);
    res.json(formatAuthResponse(resolvedUser, "Login realizado com sucesso."));
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Não foi possível realizar o login agora."
    });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  res.json({
    success: true,
    message: "Usuário autenticado com sucesso.",
    data: {
      user: sanitizeUser(req.user)
    }
  });
});

router.put("/profile", requireAuth, async (req, res) => {
  try {
    const payload = normalizeProfileInput(req.body);

    if (!payload.nome) {
      res.status(400).json({
        success: false,
        message: "O nome da conta nao pode ficar vazio."
      });
      return;
    }

    await run(
      `UPDATE usuarios
       SET nome = ?, telefone = ?, documento = ?, cidade = ?, estado = ?
       WHERE id = ?`,
      [
        payload.nome,
        payload.telefone,
        payload.documento,
        payload.cidade,
        payload.estado,
        req.user.id
      ]
    );

    const updatedUser = await findUserById(req.user.id);

    res.json({
      success: true,
      message: "Dados da conta atualizados com sucesso.",
      data: {
        user: sanitizeUser(updatedUser)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Nao foi possivel atualizar os dados da conta agora."
    });
  }
});

router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = normalizePasswordInput(req.body);

    if (!senhaAtual || !novaSenha) {
      res.status(400).json({
        success: false,
        message: "Informe a senha atual e a nova senha para continuar."
      });
      return;
    }

    if (novaSenha.length < PASSWORD_MIN_LENGTH) {
      res.status(400).json({
        success: false,
        message: `A nova senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`
      });
      return;
    }

    const user = await findUserById(req.user.id);

    if (!user) {
      res.status(404).json({
        success: false,
        message: "Conta nao encontrada."
      });
      return;
    }

    const passwordMatches = await bcrypt.compare(senhaAtual, user.senha);

    if (!passwordMatches) {
      res.status(401).json({
        success: false,
        message: "A senha atual informada nao confere."
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(novaSenha, BCRYPT_ROUNDS);
    await run("UPDATE usuarios SET senha = ? WHERE id = ?", [hashedPassword, user.id]);

    res.json({
      success: true,
      message: "Senha atualizada com sucesso.",
      data: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Nao foi possivel atualizar a senha agora."
    });
  }
});

router.get("/addresses", requireAuth, async (req, res) => {
  try {
    const addresses = await listAddressesByUserId(req.user.id);

    res.json({
      success: true,
      message: "Enderecos carregados com sucesso.",
      data: {
        addresses
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Nao foi possivel carregar os enderecos agora."
    });
  }
});

router.post("/addresses", requireAuth, async (req, res) => {
  try {
    const payload = normalizeAddressInput(req.body);
    const validationMessage = validateAddressPayload(payload);

    if (validationMessage) {
      res.status(400).json({
        success: false,
        message: validationMessage
      });
      return;
    }

    await withTransaction(async () => {
      const existingAddresses = await all(
        `SELECT id, principal
         FROM enderecos
         WHERE usuario_id = ?`,
        [req.user.id]
      );
      const shouldBePrimary = payload.principal || existingAddresses.length === 0;

      if (shouldBePrimary) {
        await run("UPDATE enderecos SET principal = 0 WHERE usuario_id = ?", [req.user.id]);
      }

      await run(
        `INSERT INTO enderecos (
          usuario_id,
          titulo,
          destinatario,
          telefone,
          cep,
          rua,
          numero,
          complemento,
          bairro,
          cidade,
          estado,
          referencia,
          principal,
          atualizado_em
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          req.user.id,
          payload.titulo,
          payload.destinatario,
          payload.telefone,
          payload.cep,
          payload.rua,
          payload.numero,
          payload.complemento,
          payload.bairro,
          payload.cidade,
          payload.estado,
          payload.referencia,
          shouldBePrimary ? 1 : 0
        ]
      );
    });

    const addresses = await listAddressesByUserId(req.user.id);

    res.status(201).json({
      success: true,
      message: "Endereco salvo com sucesso.",
      data: {
        addresses
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Nao foi possivel salvar o endereco agora."
    });
  }
});

router.put("/addresses/:addressId", requireAuth, async (req, res) => {
  try {
    const addressId = Number(req.params.addressId);

    if (!Number.isInteger(addressId) || addressId <= 0) {
      res.status(400).json({
        success: false,
        message: "Endereco informado e invalido."
      });
      return;
    }

    const existingAddress = await findAddressById(addressId, req.user.id);

    if (!existingAddress) {
      res.status(404).json({
        success: false,
        message: "Endereco nao encontrado."
      });
      return;
    }

    const payload = normalizeAddressInput(req.body);
    const validationMessage = validateAddressPayload(payload);

    if (validationMessage) {
      res.status(400).json({
        success: false,
        message: validationMessage
      });
      return;
    }

    await withTransaction(async () => {
      const shouldBePrimary = payload.principal || !!existingAddress.principal;

      if (shouldBePrimary) {
        await run("UPDATE enderecos SET principal = 0 WHERE usuario_id = ?", [req.user.id]);
      }

      await run(
        `UPDATE enderecos
         SET
           titulo = ?,
           destinatario = ?,
           telefone = ?,
           cep = ?,
           rua = ?,
           numero = ?,
           complemento = ?,
           bairro = ?,
           cidade = ?,
           estado = ?,
           referencia = ?,
           principal = ?,
           atualizado_em = CURRENT_TIMESTAMP
         WHERE id = ? AND usuario_id = ?`,
        [
          payload.titulo,
          payload.destinatario,
          payload.telefone,
          payload.cep,
          payload.rua,
          payload.numero,
          payload.complemento,
          payload.bairro,
          payload.cidade,
          payload.estado,
          payload.referencia,
          shouldBePrimary ? 1 : 0,
          addressId,
          req.user.id
        ]
      );
    });

    const addresses = await listAddressesByUserId(req.user.id);

    res.json({
      success: true,
      message: "Endereco atualizado com sucesso.",
      data: {
        addresses
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Nao foi possivel atualizar o endereco agora."
    });
  }
});

router.delete("/addresses/:addressId", requireAuth, async (req, res) => {
  try {
    const addressId = Number(req.params.addressId);

    if (!Number.isInteger(addressId) || addressId <= 0) {
      res.status(400).json({
        success: false,
        message: "Endereco informado e invalido."
      });
      return;
    }

    const existingAddress = await findAddressById(addressId, req.user.id);

    if (!existingAddress) {
      res.status(404).json({
        success: false,
        message: "Endereco nao encontrado."
      });
      return;
    }

    await withTransaction(async () => {
      await run("DELETE FROM enderecos WHERE id = ? AND usuario_id = ?", [addressId, req.user.id]);

      if (existingAddress.principal) {
        const nextAddress = await get(
          `SELECT id
           FROM enderecos
           WHERE usuario_id = ?
           ORDER BY atualizado_em DESC, id DESC
           LIMIT 1`,
          [req.user.id]
        );

        if (nextAddress?.id) {
          await run(
            "UPDATE enderecos SET principal = 1, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?",
            [nextAddress.id]
          );
        }
      }
    });

    const addresses = await listAddressesByUserId(req.user.id);

    res.json({
      success: true,
      message: "Endereco removido com sucesso.",
      data: {
        addresses
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Nao foi possivel remover o endereco agora."
    });
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  res.json({
    success: true,
    message: "Logout realizado. Remova o token salvo no frontend.",
    data: null
  });
});

module.exports = router;
