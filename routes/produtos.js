const express = require("express");
const { all, get, run } = require("../database");
const { requireAuth } = require("../middlewares/auth");
const { requireAdmin } = require("../middlewares/admin");

const router = express.Router();

function toBooleanValue(value) {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

function mapProduct(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    nome: row.nome,
    preco: Number(row.preco || 0),
    precoPromocional:
      row.preco_promocional === null || row.preco_promocional === undefined
        ? null
        : Number(row.preco_promocional),
    estoque: Number(row.estoque || 0),
    categoria: row.categoria || "",
    subcategoria: row.subcategoria || "",
    descricao: row.descricao || "",
    imagem: row.imagem || "",
    destaque: !!row.destaque,
    promocao: !!row.promocao,
    novidade: !!row.novidade,
    alta_procura: !!row.alta_procura,
    dataCadastro: row.data_cadastro || null
  };
}

function sendSuccess(res, message, data, status = 200) {
  res.status(status).json({
    success: true,
    message,
    data
  });
}

function sendError(res, status, message) {
  res.status(status).json({
    success: false,
    message,
    data: null
  });
}

function normalizeDate(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function normalizeProductInput(body = {}, currentProduct = {}) {
  const nome = String(body.nome ?? currentProduct.nome ?? "").trim();
  const preco = Number(body.preco ?? currentProduct.preco);
  const estoque = Number(body.estoque ?? currentProduct.estoque ?? 0);
  const categoria = String(body.categoria ?? currentProduct.categoria ?? "").trim() || null;
  const subcategoria = String(body.subcategoria ?? currentProduct.subcategoria ?? "").trim() || null;
  const descricao = String(body.descricao ?? currentProduct.descricao ?? "").trim() || null;
  const imagem = String(body.imagem ?? currentProduct.imagem ?? "").trim() || null;

  const promotionalInput =
    body.preco_promocional ??
    body.precoPromocional ??
    currentProduct.preco_promocional ??
    currentProduct.precoPromocional ??
    null;

  const precoPromocional =
    promotionalInput === null || promotionalInput === undefined || promotionalInput === ""
      ? null
      : Number(promotionalInput);

  const dataCadastro = normalizeDate(
    body.data_cadastro ??
      body.dataCadastro ??
      currentProduct.data_cadastro ??
      currentProduct.dataCadastro,
    currentProduct.data_cadastro ?? currentProduct.dataCadastro ?? null
  );

  if (!nome) {
    throw new Error("O nome do produto é obrigatório.");
  }

  if (!Number.isFinite(preco) || preco < 0) {
    throw new Error("O preço do produto deve ser válido.");
  }

  if (!Number.isInteger(estoque) || estoque < 0) {
    throw new Error("O estoque deve ser um número inteiro maior ou igual a zero.");
  }

  if (precoPromocional !== null) {
    if (!Number.isFinite(precoPromocional) || precoPromocional < 0) {
      throw new Error("O preço promocional deve ser válido.");
    }

    if (precoPromocional >= preco) {
      throw new Error("O preço promocional deve ser menor que o preço normal.");
    }
  }

  return {
    nome,
    preco,
    preco_promocional: precoPromocional,
    estoque,
    categoria,
    subcategoria,
    descricao,
    imagem,
    destaque: toBooleanValue(body.destaque ?? currentProduct.destaque),
    promocao: toBooleanValue(body.promocao ?? currentProduct.promocao),
    novidade: toBooleanValue(body.novidade ?? currentProduct.novidade),
    alta_procura: toBooleanValue(
      body.alta_procura ?? body.altaProcura ?? currentProduct.alta_procura ?? currentProduct.altaProcura
    ),
    data_cadastro: dataCadastro
  };
}

async function findProductById(id) {
  return get(
    `SELECT
      id,
      nome,
      preco,
      preco_promocional,
      estoque,
      categoria,
      subcategoria,
      descricao,
      imagem,
      destaque,
      promocao,
      novidade,
      alta_procura,
      data_cadastro
    FROM produtos
    WHERE id = ?`,
    [id]
  );
}

router.get("/", async (req, res) => {
  try {
    const rows = await all(
      `SELECT
        id,
        nome,
        preco,
        preco_promocional,
        estoque,
        categoria,
        subcategoria,
        descricao,
        imagem,
        destaque,
        promocao,
        novidade,
        alta_procura,
        data_cadastro
      FROM produtos
      ORDER BY datetime(data_cadastro) DESC, id DESC`
    );

    sendSuccess(res, "Produtos listados com sucesso.", {
      produtos: rows.map(mapProduct)
    });
  } catch (error) {
    sendError(res, 500, "Não foi possível listar os produtos.");
  }
});

router.get("/:id", async (req, res) => {
  try {
    const productId = Number(req.params.id);

    if (!Number.isInteger(productId) || productId <= 0) {
      sendError(res, 400, "Informe um id de produto válido.");
      return;
    }

    const product = await findProductById(productId);

    if (!product) {
      sendError(res, 404, "Produto não encontrado.");
      return;
    }

    sendSuccess(res, "Produto encontrado com sucesso.", {
      produto: mapProduct(product)
    });
  } catch (error) {
    sendError(res, 500, "Não foi possível carregar o produto.");
  }
});

router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const product = normalizeProductInput(req.body);

    const result = await run(
      `INSERT INTO produtos (
        nome,
        preco,
        preco_promocional,
        estoque,
        categoria,
        subcategoria,
        descricao,
        imagem,
        destaque,
        promocao,
        novidade,
        alta_procura,
        data_cadastro
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      [
        product.nome,
        product.preco,
        product.preco_promocional,
        product.estoque,
        product.categoria,
        product.subcategoria,
        product.descricao,
        product.imagem,
        product.destaque,
        product.promocao,
        product.novidade,
        product.alta_procura,
        product.data_cadastro
      ]
    );

    const createdProduct = await findProductById(result.id);

    sendSuccess(
      res,
      "Produto cadastrado com sucesso.",
      { produto: mapProduct(createdProduct) },
      201
    );
  } catch (error) {
    sendError(res, 400, error.message || "Não foi possível cadastrar o produto.");
  }
});

router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const productId = Number(req.params.id);

    if (!Number.isInteger(productId) || productId <= 0) {
      sendError(res, 400, "Informe um id de produto válido.");
      return;
    }

    const currentProduct = await findProductById(productId);

    if (!currentProduct) {
      sendError(res, 404, "Produto não encontrado.");
      return;
    }

    const product = normalizeProductInput(req.body, currentProduct);

    await run(
      `UPDATE produtos SET
        nome = ?,
        preco = ?,
        preco_promocional = ?,
        estoque = ?,
        categoria = ?,
        subcategoria = ?,
        descricao = ?,
        imagem = ?,
        destaque = ?,
        promocao = ?,
        novidade = ?,
        alta_procura = ?,
        data_cadastro = COALESCE(?, data_cadastro)
      WHERE id = ?`,
      [
        product.nome,
        product.preco,
        product.preco_promocional,
        product.estoque,
        product.categoria,
        product.subcategoria,
        product.descricao,
        product.imagem,
        product.destaque,
        product.promocao,
        product.novidade,
        product.alta_procura,
        product.data_cadastro,
        productId
      ]
    );

    const updatedProduct = await findProductById(productId);
    sendSuccess(res, "Produto atualizado com sucesso.", {
      produto: mapProduct(updatedProduct)
    });
  } catch (error) {
    sendError(res, 400, error.message || "Não foi possível atualizar o produto.");
  }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const productId = Number(req.params.id);

    if (!Number.isInteger(productId) || productId <= 0) {
      sendError(res, 400, "Informe um id de produto válido.");
      return;
    }

    const result = await run("DELETE FROM produtos WHERE id = ?", [productId]);

    if (!result.changes) {
      sendError(res, 404, "Produto não encontrado.");
      return;
    }

    sendSuccess(res, "Produto removido com sucesso.", null);
  } catch (error) {
    sendError(res, 500, "Não foi possível remover o produto.");
  }
});

module.exports = router;
