const path = require("path");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3").verbose();
const { getBootstrapAdminEmails } = require("./utils/admin-users");

function normalizeConfiguredPath(value) {
  return String(value || "").trim();
}

function getWorkspaceDatabasePath() {
  return path.join(__dirname, "database.db");
}

function getSafeLocalDatabasePath() {
  const localRoot =
    normalizeConfiguredPath(process.env.LOCALAPPDATA) ||
    path.join(os.homedir(), "AppData", "Local");

  return path.join(localRoot, "Loja do Garimpo", "database.db");
}

function getDatabasePathCandidates() {
  const configuredPath = normalizeConfiguredPath(process.env.DATABASE_PATH);
  const workspaceDatabasePath = getWorkspaceDatabasePath();
  const safeLocalDatabasePath = getSafeLocalDatabasePath();
  const isWorkspaceInsideOneDrive = __dirname.toLowerCase().includes("\\onedrive\\");

  if (configuredPath) {
    return [path.resolve(configuredPath), workspaceDatabasePath];
  }

  return isWorkspaceInsideOneDrive
    ? [safeLocalDatabasePath, workspaceDatabasePath]
    : [workspaceDatabasePath, safeLocalDatabasePath];
}

function ensureDatabaseDirectory(targetPath) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
}

function ensureSeedDatabaseFile(targetPath) {
  const workspaceDatabasePath = getWorkspaceDatabasePath();

  if (
    targetPath === workspaceDatabasePath ||
    !fs.existsSync(workspaceDatabasePath) ||
    fs.existsSync(targetPath)
  ) {
    return;
  }

  try {
    fs.copyFileSync(workspaceDatabasePath, targetPath);
  } catch (error) {
    console.warn(
      `[database] nao foi possivel copiar o banco inicial para ${targetPath}: ${error.message}`
    );
  }
}

function resolveDatabasePath() {
  const candidates = getDatabasePathCandidates();

  for (const candidatePath of candidates) {
    try {
      ensureDatabaseDirectory(candidatePath);
      ensureSeedDatabaseFile(candidatePath);
      return candidatePath;
    } catch (error) {
      console.warn(
        `[database] caminho indisponivel para o SQLite (${candidatePath}): ${error.message}`
      );
    }
  }

  throw new Error("Nao foi possivel preparar nenhum caminho local para o banco SQLite.");
}

const databasePath = resolveDatabasePath();

const db = new sqlite3.Database(databasePath);
db.configure("busyTimeout", 5000);
let transactionQueue = Promise.resolve();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        id: this.lastID,
        changes: this.changes
      });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows || []);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function withTransaction(callback) {
  const previousTransaction = transactionQueue;
  let releaseQueue = () => {};

  transactionQueue = new Promise(resolve => {
    releaseQueue = resolve;
  });

  await previousTransaction;

  try {
    await exec("BEGIN TRANSACTION;");

    try {
      const result = await callback();
      await exec("COMMIT;");
      return result;
    } catch (error) {
      await exec("ROLLBACK;");
      throw error;
    }
  } finally {
    releaseQueue();
  }
}

async function ensureColumnExists(tableName, columnName, definition) {
  const columns = await all(`PRAGMA table_info(${tableName})`);
  const columnExists = columns.some(column => column.name === columnName);

  if (!columnExists) {
    await exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

async function initializeDatabase() {
  await exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha TEXT NOT NULL,
      telefone TEXT,
      documento TEXT,
      cidade TEXT,
      estado TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      email_verificado INTEGER NOT NULL DEFAULT 0,
      token_verificacao TEXT,
      token_verificacao_expira_em TEXT,
      data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      preco REAL NOT NULL,
      preco_promocional REAL,
      estoque INTEGER NOT NULL DEFAULT 0,
      categoria TEXT,
      subcategoria TEXT,
      descricao TEXT,
      imagem TEXT,
      destaque INTEGER NOT NULL DEFAULT 0,
      promocao INTEGER NOT NULL DEFAULT 0,
      novidade INTEGER NOT NULL DEFAULT 0,
      alta_procura INTEGER NOT NULL DEFAULT 0,
      data_cadastro TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      subtotal REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'aguardando_pagamento',
      forma_pagamento TEXT,
      status_pagamento TEXT NOT NULL DEFAULT 'pendente',
      codigo_rastreio TEXT,
      observacoes TEXT,
      gateway_pagamento TEXT,
      gateway_payment_id TEXT,
      gateway_reference_id TEXT,
      gateway_preference_id TEXT,
      estoque_reservado INTEGER NOT NULL DEFAULT 0,
      atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      pagamento_metodo TEXT,
      pagamento_parcelas INTEGER,
      pagamento_ajuste_tipo TEXT,
      pagamento_ajuste_percentual REAL NOT NULL DEFAULT 0,
      data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS pedido_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade INTEGER NOT NULL,
      preco_unitario REAL NOT NULL,
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
      FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS enderecos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      titulo TEXT NOT NULL,
      destinatario TEXT NOT NULL,
      telefone TEXT,
      cep TEXT NOT NULL,
      rua TEXT NOT NULL,
      numero TEXT NOT NULL,
      complemento TEXT,
      bairro TEXT NOT NULL,
      cidade TEXT NOT NULL,
      estado TEXT NOT NULL,
      referencia TEXT,
      principal INTEGER NOT NULL DEFAULT 0,
      data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria);
    CREATE INDEX IF NOT EXISTS idx_pedidos_usuario_id ON pedidos(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido_id ON pedido_itens(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_enderecos_usuario_id ON enderecos(usuario_id);
  `);

  await ensureColumnExists("usuarios", "nome", "TEXT");
  await ensureColumnExists("usuarios", "email", "TEXT");
  await ensureColumnExists("usuarios", "senha", "TEXT");
  await ensureColumnExists("usuarios", "telefone", "TEXT");
  await ensureColumnExists("usuarios", "documento", "TEXT");
  await ensureColumnExists("usuarios", "cidade", "TEXT");
  await ensureColumnExists("usuarios", "estado", "TEXT");
  await ensureColumnExists("usuarios", "is_admin", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("usuarios", "email_verificado", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("usuarios", "token_verificacao", "TEXT");
  await ensureColumnExists("usuarios", "token_verificacao_expira_em", "TEXT");
  await ensureColumnExists("usuarios", "data_criacao", "TEXT DEFAULT CURRENT_TIMESTAMP");
  await exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);");

  await ensureColumnExists("produtos", "nome", "TEXT");
  await ensureColumnExists("produtos", "preco", "REAL NOT NULL DEFAULT 0");
  await ensureColumnExists("produtos", "preco_promocional", "REAL");
  await ensureColumnExists("produtos", "estoque", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("produtos", "categoria", "TEXT");
  await ensureColumnExists("produtos", "subcategoria", "TEXT");
  await ensureColumnExists("produtos", "descricao", "TEXT");
  await ensureColumnExists("produtos", "imagem", "TEXT");
  await ensureColumnExists("produtos", "destaque", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("produtos", "promocao", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("produtos", "novidade", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("produtos", "alta_procura", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("produtos", "data_cadastro", "TEXT DEFAULT CURRENT_TIMESTAMP");

  await ensureColumnExists("pedidos", "subtotal", "REAL NOT NULL DEFAULT 0");
  await ensureColumnExists("pedidos", "status", "TEXT NOT NULL DEFAULT 'aguardando_pagamento'");
  await ensureColumnExists("pedidos", "forma_pagamento", "TEXT");
  await ensureColumnExists("pedidos", "status_pagamento", "TEXT NOT NULL DEFAULT 'pendente'");
  await ensureColumnExists("pedidos", "codigo_rastreio", "TEXT");
  await ensureColumnExists("pedidos", "observacoes", "TEXT");
  await ensureColumnExists("pedidos", "gateway_pagamento", "TEXT");
  await ensureColumnExists("pedidos", "gateway_payment_id", "TEXT");
  await ensureColumnExists("pedidos", "gateway_reference_id", "TEXT");
  await ensureColumnExists("pedidos", "gateway_preference_id", "TEXT");
  await ensureColumnExists("pedidos", "estoque_reservado", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("pedidos", "atualizado_em", "TEXT");
  await ensureColumnExists("pedidos", "pagamento_metodo", "TEXT");
  await ensureColumnExists("pedidos", "pagamento_parcelas", "INTEGER");
  await ensureColumnExists("pedidos", "pagamento_ajuste_tipo", "TEXT");
  await ensureColumnExists("pedidos", "pagamento_ajuste_percentual", "REAL NOT NULL DEFAULT 0");

  await ensureColumnExists("enderecos", "titulo", "TEXT");
  await ensureColumnExists("enderecos", "destinatario", "TEXT");
  await ensureColumnExists("enderecos", "telefone", "TEXT");
  await ensureColumnExists("enderecos", "cep", "TEXT");
  await ensureColumnExists("enderecos", "rua", "TEXT");
  await ensureColumnExists("enderecos", "numero", "TEXT");
  await ensureColumnExists("enderecos", "complemento", "TEXT");
  await ensureColumnExists("enderecos", "bairro", "TEXT");
  await ensureColumnExists("enderecos", "cidade", "TEXT");
  await ensureColumnExists("enderecos", "estado", "TEXT");
  await ensureColumnExists("enderecos", "referencia", "TEXT");
  await ensureColumnExists("enderecos", "principal", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumnExists("enderecos", "data_criacao", "TEXT DEFAULT CURRENT_TIMESTAMP");
  await ensureColumnExists("enderecos", "atualizado_em", "TEXT DEFAULT CURRENT_TIMESTAMP");

  await exec(`
    UPDATE pedidos
    SET
      status = CASE
        WHEN LOWER(COALESCE(status, '')) IN ('aguardando_pagamento', 'pagamento_aprovado', 'em_preparacao', 'enviado', 'entregue', 'cancelado')
          THEN LOWER(status)
        WHEN LOWER(COALESCE(status, '')) = 'confirmado'
          THEN 'pagamento_aprovado'
        WHEN LOWER(COALESCE(status, '')) = 'cancelado'
          THEN 'cancelado'
        WHEN LOWER(COALESCE(status_pagamento, '')) = 'aprovado'
          THEN 'pagamento_aprovado'
        WHEN LOWER(COALESCE(status_pagamento, '')) IN ('cancelado', 'estornado')
          THEN 'cancelado'
        ELSE 'aguardando_pagamento'
      END,
      forma_pagamento = COALESCE(forma_pagamento, pagamento_metodo),
      status_pagamento = COALESCE(status_pagamento, 'pendente'),
      codigo_rastreio = COALESCE(codigo_rastreio, ''),
      observacoes = COALESCE(observacoes, ''),
      atualizado_em = COALESCE(atualizado_em, data_criacao, CURRENT_TIMESTAMP)
  `);

  await exec(`
    UPDATE usuarios
    SET
      telefone = COALESCE(telefone, ''),
      documento = COALESCE(documento, ''),
      cidade = COALESCE(cidade, ''),
      estado = COALESCE(estado, '')
  `);

  await exec(`
    UPDATE enderecos
    SET
      telefone = COALESCE(telefone, ''),
      complemento = COALESCE(complemento, ''),
      referencia = COALESCE(referencia, ''),
      atualizado_em = COALESCE(atualizado_em, data_criacao, CURRENT_TIMESTAMP)
  `);

  for (const email of getBootstrapAdminEmails()) {
    await run(
      "UPDATE usuarios SET is_admin = 1 WHERE LOWER(email) = ?",
      [email]
    );
  }
}

module.exports = {
  db,
  databasePath,
  initializeDatabase,
  run,
  get,
  all,
  exec,
  withTransaction
};
