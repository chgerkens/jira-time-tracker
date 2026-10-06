// ─── Test certificates ─────────────────────────────────────────────
//
// A company-style setup: a root CA plus a server certificate for
// 127.0.0.1 signed by it (generated with openssl, fresh keys each time).
//
// CI generates them up front, installs ca.pem into the OS trust store
// and points the tests at them via JTT_CERT_DIR:
//   node test/certs.js <dir>
// ────────────────────────────────────────────────────────────────────

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const OPENSSL_CNF = [
  "[req]", "distinguished_name=dn", "[dn]",
  "[ca_ext]", "basicConstraints=critical,CA:TRUE",
  "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash",
  "[leaf_ext]", "basicConstraints=CA:FALSE", "subjectAltName=IP:127.0.0.1",
  "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth",
  "authorityKeyIdentifier=keyid",
  "[self_ext]", "basicConstraints=CA:FALSE", "subjectAltName=IP:127.0.0.1",
  "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth",
].join("\n");

// Writes into dir: ca.pem (root), leaf.pem/key (signed by root),
// int.pem (intermediate CA, signed by root), leaf2.pem/key (signed by the
// intermediate), self.pem/key (self-signed). Throws if openssl fails.
function generate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (name) => path.join(dir, name);
  fs.writeFileSync(f("openssl.cnf"), OPENSSL_CNF);
  const openssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl("req", "-x509", "-config", f("openssl.cnf"), "-extensions", "ca_ext",
    "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/O=Test Company/CN=Test Company Root CA",
    "-keyout", f("ca.key"), "-out", f("ca.pem"));
  openssl("req", "-new", "-config", f("openssl.cnf"), "-newkey", "rsa:2048", "-nodes",
    "-subj", "/CN=127.0.0.1", "-keyout", f("leaf.key"), "-out", f("leaf.csr"));
  openssl("x509", "-req", "-in", f("leaf.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"),
    "-set_serial", "1", "-days", "1", "-extfile", f("openssl.cnf"), "-extensions", "leaf_ext",
    "-out", f("leaf.pem"));
  openssl("req", "-new", "-config", f("openssl.cnf"), "-newkey", "rsa:2048", "-nodes",
    "-subj", "/O=Test Company/CN=Test Company Issuing CA", "-keyout", f("int.key"), "-out", f("int.csr"));
  openssl("x509", "-req", "-in", f("int.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"),
    "-set_serial", "2", "-days", "1", "-extfile", f("openssl.cnf"), "-extensions", "ca_ext",
    "-out", f("int.pem"));
  openssl("req", "-new", "-config", f("openssl.cnf"), "-newkey", "rsa:2048", "-nodes",
    "-subj", "/CN=127.0.0.1", "-keyout", f("leaf2.key"), "-out", f("leaf2.csr"));
  openssl("x509", "-req", "-in", f("leaf2.csr"), "-CA", f("int.pem"), "-CAkey", f("int.key"),
    "-set_serial", "3", "-days", "1", "-extfile", f("openssl.cnf"), "-extensions", "leaf_ext",
    "-out", f("leaf2.pem"));
  openssl("req", "-x509", "-config", f("openssl.cnf"), "-extensions", "self_ext",
    "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-keyout", f("self.key"), "-out", f("self.pem"));
}

// Loads certs from JTT_CERT_DIR, or generates them into a temp dir.
// Returns null if openssl isn't available.
function companyCerts() {
  const given = process.env.JTT_CERT_DIR;
  const dir = given || fs.mkdtempSync(path.join(os.tmpdir(), "jtt-test-"));
  if (!given) {
    try {
      generate(dir);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      return null;
    }
  }
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf-8");
  const ca = read("ca.pem");
  const leaf = read("leaf.pem");
  const key = read("leaf.key");
  return {
    dir,
    caFile: path.join(dir, "ca.pem"),
    ca,
    withRoot: { key, cert: leaf + ca }, // Jira sends leaf + root
    leafOnly: { key, cert: leaf },      // Jira sends only its own cert
    selfSigned: { key: read("self.key"), cert: read("self.pem") },
    // leaf + intermediate, without the root (common in company setups)
    withIntermediate: { key: read("leaf2.key"), cert: read("leaf2.pem") + read("int.pem") },
    cleanup: () => { if (!given) fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node test/certs.js <dir>");
    process.exit(1);
  }
  generate(dir);
  console.log(`Test CA written to ${path.join(dir, "ca.pem")}`);
}

module.exports = { companyCerts };
