import dgram from "node:dgram";

/**
 * Determines which local IP address can reach the given target IP.
 * Opens a temporary UDP socket aimed at the target and checks which
 * local address the OS selects — no packet is actually sent.
 */
export function getLocalIpForTarget(targetIp: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    // connect() on a UDP socket just sets the default destination —
    // it doesn't send anything. The OS picks the right local interface.
    sock.connect(1, targetIp, () => {
      const addr = sock.address();
      sock.close();
      resolve(addr.address);
    });
    sock.on("error", (err) => {
      sock.close();
      reject(new Error(`Cannot determine local IP for target ${targetIp}: ${err.message}`));
    });
  });
}
