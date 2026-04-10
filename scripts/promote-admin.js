require("dotenv").config();

const { initializeDatabase, get, run } = require("../database");
const { getBootstrapAdminEmails } = require("../utils/admin-users");

async function promoteUserToAdmin() {
  const defaultEmail = getBootstrapAdminEmails()[0] || "";
  const email = String(process.argv[2] || defaultEmail).trim().toLowerCase();

  if (!email) {
    console.error("Uso: node scripts/promote-admin.js email@exemplo.com");
    process.exit(1);
  }

  await initializeDatabase();

  const user = await get(
    "SELECT id, nome, email, is_admin FROM usuarios WHERE email = ?",
    [email]
  );

  if (!user) {
    console.error(`Nenhum usuário encontrado com o e-mail ${email}.`);
    process.exit(1);
  }

  if (user.is_admin) {
    console.log(`O usuário ${email} já está marcado como administrador.`);
    process.exit(0);
  }

  await run("UPDATE usuarios SET is_admin = 1 WHERE id = ?", [user.id]);
  console.log(`Usuário ${email} promovido para administrador com sucesso.`);
}

promoteUserToAdmin().catch(error => {
  console.error("Não foi possível promover o usuário para administrador.", error);
  process.exit(1);
});
