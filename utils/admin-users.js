const BOOTSTRAP_ADMIN_EMAILS = [
  "bruno.simoesadm2022@gmail.com"
];

function normalizeAdminEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getBootstrapAdminEmails() {
  return BOOTSTRAP_ADMIN_EMAILS.map(normalizeAdminEmail).filter(Boolean);
}

function isBootstrapAdminEmail(email) {
  return getBootstrapAdminEmails().includes(normalizeAdminEmail(email));
}

module.exports = {
  getBootstrapAdminEmails,
  isBootstrapAdminEmail
};
