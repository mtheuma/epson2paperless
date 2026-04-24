import * as tls from "node:tls";

const ip = process.argv[2] ?? process.env.PRINTER_IP;
if (!ip) {
  console.error("Usage: npm run printer-fingerprint -- <printer-ip>");
  console.error("       PRINTER_IP=<ip> npm run printer-fingerprint");
  process.exit(1);
}

const socket = tls.connect(
  {
    host: ip,
    port: 1865,
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  },
  () => {
    const cert = socket.getPeerCertificate(true);
    if (!cert?.fingerprint256) {
      console.error("Connected but no peer certificate available");
      process.exit(1);
    }
    console.log(cert.fingerprint256);
    socket.end();
  },
);

socket.on("error", (err) => {
  console.error(`Connection failed: ${err.message}`);
  process.exit(1);
});
