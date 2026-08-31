import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import {
  buildPushScanResponse,
  parsePushScanRequest,
  createPushScanServer,
  parseCapabilityIns,
  parsePushScanRequestKind,
  computeActionFromId,
  resolveEffectiveAction,
  type PushScanInfo,
} from "./pushscan.js";

describe("buildPushScanResponse default x-uid (xuid=1)", () => {
  const response = buildPushScanResponse("1");

  it("starts with HTTP/1.0 200 OK", () => {
    expect(response.startsWith("HTTP/1.0 200 OK\r\n")).toBe(true);
  });

  it("contains the required Epson headers with spaces before colons", () => {
    expect(response).toContain("Server : Epson Net Scan Monitor/2.0");
    expect(response).toContain("x-protocol-name : Epson Network Service Protocol");
    expect(response).toContain("x-protocol-version : 2.00");
    expect(response).toContain("x-status : 0001");
  });

  it("has correct Content-Length matching the body", () => {
    const parts = response.split("\r\n\r\n");
    const body = parts[1];
    const bodyLength = Buffer.byteLength(body, "utf-8");
    expect(response).toContain(`Content-Length : ${bodyLength}`);
  });

  it("contains the SOAP PushScanResponse with StatusOut OK", () => {
    expect(response).toContain("<StatusOut>OK</StatusOut>");
  });
});

describe("buildPushScanResponse", () => {
  it("includes the given x-uid value in the response", () => {
    const response = buildPushScanResponse("7");
    expect(response).toContain("x-uid : 7\r\n");
  });

  it("echoes arbitrary numeric x-uid values", () => {
    for (const xuid of ["0", "1", "2", "42", "255"]) {
      const response = buildPushScanResponse(xuid);
      expect(response).toContain(`x-uid : ${xuid}\r\n`);
    }
  });

  it("still contains all the other required fixed headers regardless of x-uid", () => {
    const response = buildPushScanResponse("42");
    expect(response).toContain("Server : Epson Net Scan Monitor/2.0");
    expect(response).toContain("x-protocol-name : Epson Network Service Protocol");
    expect(response).toContain("x-protocol-version : 2.00");
    expect(response).toContain("x-status : 0001");
    expect(response).toContain("<StatusOut>OK</StatusOut>");
  });

  it("defaults x-protocol-version to 2.00 (the pre-FF-680W fleet value)", () => {
    expect(buildPushScanResponse("1")).toContain("x-protocol-version : 2.00\r\n");
  });

  it("echoes a provided protocolVersion (3.00 for the FF-680W)", () => {
    const response = buildPushScanResponse("1", { protocolVersion: "3.00" });
    expect(response).toContain("x-protocol-version : 3.00\r\n");
    expect(response).not.toContain("x-protocol-version : 2.00");
  });
});

describe("parsePushScanRequest", () => {
  const body = (id: string) =>
    `<?xml version="1.0" ?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><p:PushScan xmlns:p="http://schema.epson.net/EpsonNet/Scan/2004/pushscan"><ProductNameIn>PID 11D1</ProductNameIn><IPAddressIn>C0A8013A</IPAddressIn><PushScanIDIn>${id}</PushScanIDIn></p:PushScan></s:Body></s:Envelope>`;

  it("extracts PushScanIDIn and classifies '01' as simplex", () => {
    const result = parsePushScanRequest(body("01"));
    expect(result.pushScanId).toBe("01");
    expect(result.productName).toBe("PID 11D1");
    expect(result.ipAddress).toBe("C0A8013A");
    expect(result.duplex).toBe(false);
  });

  it("canonicalises a variant-cased ProductNameIn PID at the parse point", () => {
    // Every downstream PID consumer (dialect resolution, job-control routing,
    // the probe hint) exact-matches on canonical `PID XXXX`, so casing and
    // spacing variance is absorbed here, once.
    const soap = `<s:Body><p:PushScan><ProductNameIn>  pid 11d1 </ProductNameIn><PushScanIDIn>01</PushScanIDIn></p:PushScan></s:Body>`;
    expect(parsePushScanRequest(soap).productName).toBe("PID 11D1");
  });

  it("passes a non-PID ProductNameIn through raw for diagnosability", () => {
    const soap = `<s:Body><p:PushScan><ProductNameIn>ET-7700 Series</ProductNameIn><PushScanIDIn>01</PushScanIDIn></p:PushScan></s:Body>`;
    expect(parsePushScanRequest(soap).productName).toBe("ET-7700 Series");
  });

  it("classifies '11' as duplex", () => {
    const result = parsePushScanRequest(body("11"));
    expect(result.pushScanId).toBe("11");
    expect(result.duplex).toBe(true);
  });

  it("classifies '02' (simplex PDF, unvalidated) as simplex", () => {
    // Digit 1 isn't decoded in this spec; only digit 0 matters for duplex.
    const result = parsePushScanRequest(body("02"));
    expect(result.duplex).toBe(false);
  });

  it("classifies '12' (duplex PDF, unvalidated) as duplex", () => {
    const result = parsePushScanRequest(body("12"));
    expect(result.duplex).toBe(true);
  });

  it("returns duplex=false and nulls when all fields are missing (silent)", () => {
    const result = parsePushScanRequest("<xml>nothing</xml>");
    expect(result.pushScanId).toBeNull();
    expect(result.productName).toBeNull();
    expect(result.ipAddress).toBeNull();
    expect(result.duplex).toBe(false);
  });

  it("defaults to duplex=false for empty PushScanIDIn (warning-worthy)", () => {
    const result = parsePushScanRequest(body(""));
    // The XML regex matches <PushScanIDIn></PushScanIDIn> → empty string,
    // not null. This is a malformed-ish case and should warn, but we don't
    // assert on the warning log here — duplex=false is the observable contract.
    expect(result.pushScanId).toBe("");
    expect(result.duplex).toBe(false);
  });

  it("defaults to duplex=false for unexpected first character 'X'", () => {
    const result = parsePushScanRequest(body("X1"));
    expect(result.pushScanId).toBe("X1");
    expect(result.duplex).toBe(false);
  });

  it("sets action='jpg' for PushScanIDIn='01'", () => {
    const result = parsePushScanRequest(body("01"));
    expect(result.action).toBe("jpg");
  });

  it("sets action='pdf' for PushScanIDIn='02'", () => {
    const result = parsePushScanRequest(body("02"));
    expect(result.action).toBe("pdf");
  });

  it("sets action='preview' for PushScanIDIn='04'", () => {
    const result = parsePushScanRequest(body("04"));
    expect(result.action).toBe("preview");
  });

  it("sets action='jpg' and duplex=true for PushScanIDIn='11'", () => {
    const result = parsePushScanRequest(body("11"));
    expect(result.duplex).toBe(true);
    expect(result.action).toBe("jpg");
  });

  it("sets action='pdf' and duplex=true for PushScanIDIn='12'", () => {
    const result = parsePushScanRequest(body("12"));
    expect(result.duplex).toBe(true);
    expect(result.action).toBe("pdf");
  });

  it("sets action='unknown' for missing PushScanIDIn", () => {
    const result = parsePushScanRequest("<xml>nothing</xml>");
    expect(result.action).toBe("unknown");
  });

  it("extracts FF-680W JobNumberIn when PushScanIDIn is absent", () => {
    const result = parsePushScanRequest(
      `<s:Body><p:PushScan><ProductNameIn>PID 016B</ProductNameIn><JobNumberIn>0</JobNumberIn></p:PushScan></s:Body>`,
    );
    expect(result.productName).toBe("PID 016B");
    expect(result.pushScanId).toBeNull();
    expect(result.jobNumber).toBe("0");
    expect(result.action).toBe("unknown");
  });

  it("sets action='unknown' for too-short PushScanIDIn", () => {
    const result = parsePushScanRequest(body("0"));
    expect(result.action).toBe("unknown");
  });
});

describe("parsePushScanRequestKind", () => {
  it("classifies FF-680W JobList requests and extracts capabilities", () => {
    const body =
      `<?xml version="1.0" ?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
      `<p:JobList xmlns:p="http://schema.epson.net/EpsonNet/Scan/2004/pushscan">` +
      `<CapabilityIn>OfficeFormat</CapabilityIn><CapabilityIn>PanelData=0110</CapabilityIn>` +
      `</p:JobList></s:Body></s:Envelope>`;

    expect(parsePushScanRequestKind(body)).toBe("jobList");
    expect(parseCapabilityIns(body)).toEqual(["OfficeFormat", "PanelData=0110"]);
  });

  it("extracts namespaced JobList capabilities", () => {
    const body =
      `<?xml version="1.0" ?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
      `<p:JobList xmlns:p="http://schema.epson.net/EpsonNet/Scan/2004/pushscan">` +
      `<p:CapabilityIn>OfficeFormat</p:CapabilityIn><p:CapabilityIn>PanelData=0110</p:CapabilityIn>` +
      `</p:JobList></s:Body></s:Envelope>`;

    expect(parsePushScanRequestKind(body)).toBe("jobList");
    expect(parseCapabilityIns(body)).toEqual(["OfficeFormat", "PanelData=0110"]);
  });

  it("classifies PushScan, ScanEnd, and unknown requests", () => {
    expect(
      parsePushScanRequestKind("<s:Body><p:PushScan><JobNumberIn>0</JobNumberIn></p:PushScan>"),
    ).toBe("pushScan");
    expect(parsePushScanRequestKind("<s:Body><p:ScanEnd></p:ScanEnd>")).toBe("scanEnd");
    expect(parsePushScanRequestKind("<xml>nothing</xml>")).toBe("unknown");
  });
});

describe("computeActionFromId", () => {
  // This helper is internal to parsePushScanRequest but exported for testing.
  // It decodes the second character of PushScanIDIn as a bitmask:
  //   1 (0b001) → jpg
  //   2 (0b010) → pdf
  //   4 (0b100) → preview
  //   anything else → unknown

  it("decodes '01' → 'jpg'", () => {
    expect(computeActionFromId("01")).toBe("jpg");
  });

  it("decodes '02' → 'pdf'", () => {
    expect(computeActionFromId("02")).toBe("pdf");
  });

  it("decodes '04' → 'preview'", () => {
    expect(computeActionFromId("04")).toBe("preview");
  });

  it("decodes '11' → 'jpg' (duplex doesn't affect byte-1)", () => {
    expect(computeActionFromId("11")).toBe("jpg");
  });

  it("decodes '12' → 'pdf' (duplex doesn't affect byte-1)", () => {
    expect(computeActionFromId("12")).toBe("pdf");
  });

  it("decodes '14' → 'preview' (duplex doesn't affect byte-1)", () => {
    expect(computeActionFromId("14")).toBe("preview");
  });

  it("returns 'unknown' for null input", () => {
    expect(computeActionFromId(null)).toBe("unknown");
  });

  it("returns 'unknown' for empty string", () => {
    expect(computeActionFromId("")).toBe("unknown");
  });

  it("returns 'unknown' for single-char input", () => {
    expect(computeActionFromId("0")).toBe("unknown");
  });

  it("returns 'unknown' for unknown bit combination '03'", () => {
    // 0b011 — both jpg and pdf bits set, not a real panel state
    expect(computeActionFromId("03")).toBe("unknown");
  });

  it("returns 'unknown' for an unexpected character '0X'", () => {
    expect(computeActionFromId("0X")).toBe("unknown");
  });
});

describe("createPushScanServer", () => {
  function buildSoapBody(id: string, product: string, ip: string): string {
    return (
      `<?xml version="1.0" ?>` +
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
      `<s:Body>` +
      `<p:PushScan xmlns:p="http://schema.epson.net/EpsonNet/Scan/2004/pushscan">` +
      `<ProductNameIn>${product}</ProductNameIn>` +
      `<IPAddressIn>${ip}</IPAddressIn>` +
      `<PushScanIDIn>${id}</PushScanIDIn>` +
      `</p:PushScan>` +
      `</s:Body>` +
      `</s:Envelope>`
    );
  }

  // Resolve with the full HTTP response once Content-Length bytes of body
  // have arrived, or on socket close — used by each test to wait for the
  // server's reply without racing the socket teardown.
  function readFullHttpResponse(client: net.Socket): Promise<string> {
    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      client.on("data", (chunk) => {
        chunks.push(chunk);
        const so_far = Buffer.concat(chunks).toString("utf-8");
        const hdrEnd = so_far.indexOf("\r\n\r\n");
        if (hdrEnd === -1) return;
        const clMatch = so_far.substring(0, hdrEnd).match(/Content-Length\s*:\s*(\d+)/i);
        const cl = clMatch ? parseInt(clMatch[1], 10) : 0;
        const bodyReceived = Buffer.byteLength(so_far.substring(hdrEnd + 4), "utf-8");
        if (bodyReceived >= cl) resolve(so_far);
      });
      client.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      client.on("close", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
  }

  it("accepts a SOAP POST, responds with the fixed XML, invokes the callback", async () => {
    let callbackInfo: PushScanInfo | null = null;
    const server = createPushScanServer(0, (info) => {
      callbackInfo = info;
    });

    // createPushScanServer already called listen() internally — wait for it
    // to actually be listening before we try to connect.
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });

    const port = (server.address() as AddressInfo).port;

    const body = buildSoapBody("42", "PID 11D1", "C0A8013A");
    const request =
      `POST /PushScan HTTP/1.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n` +
      `\r\n` +
      body;

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", () => r()));

    const responsePromise = readFullHttpResponse(client);

    client.write(request);

    const response = await responsePromise;
    expect(response).toContain("HTTP/1.0 200 OK");
    expect(response).toContain("<StatusOut>OK</StatusOut>");
    expect(callbackInfo).not.toBeNull();
    expect(callbackInfo!.pushScanId).toBe("42");
    expect(callbackInfo!.productName).toBe("PID 11D1");
    expect(callbackInfo!.ipAddress).toBe("C0A8013A");

    client.destroy();
    server.close();
  });

  it("handles body arriving in multiple TCP chunks", async () => {
    let callbackInfo: PushScanInfo | null = null;
    const server = createPushScanServer(0, (info) => {
      callbackInfo = info;
    });
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
    const port = (server.address() as AddressInfo).port;

    const body = buildSoapBody("99", "PID 11D1", "C0A80101");
    const contentLength = Buffer.byteLength(body, "utf-8");
    const headers =
      `POST /PushScan HTTP/1.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${contentLength}\r\n` +
      `\r\n`;

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", () => r()));

    const responsePromise = readFullHttpResponse(client);

    // Send headers + first half of body
    const halfLen = Math.floor(body.length / 2);
    client.write(headers + body.slice(0, halfLen));
    // Small delay then the rest — forces the server to handle boundary detection
    await new Promise((r) => setTimeout(r, 20));
    client.write(body.slice(halfLen));

    const response = await responsePromise;
    expect(response).toContain("<StatusOut>OK</StatusOut>");
    expect(callbackInfo).not.toBeNull();
    expect(callbackInfo!.pushScanId).toBe("99");

    client.destroy();
    server.close();
  });

  it("responds to JobList with capabilities and does not invoke the scan callback", async () => {
    let callbackCount = 0;
    const server = createPushScanServer(0, () => {
      callbackCount += 1;
    });
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
    const port = (server.address() as AddressInfo).port;

    const body =
      `<?xml version="1.0" ?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
      `<p:JobList xmlns:p="http://schema.epson.net/EpsonNet/Scan/2004/pushscan">` +
      `<ProductNameIn>PID 016B</ProductNameIn><IPAddressIn>C0A80A76</IPAddressIn>` +
      `<CapabilityIn>OfficeFormat</CapabilityIn><CapabilityIn>PanelData=0110</CapabilityIn>` +
      `</p:JobList></s:Body></s:Envelope>`;
    const request =
      `POST /PushScan HTTP/1.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n` +
      `x-uid: 4\r\n` +
      `\r\n` +
      body;

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", () => r()));

    const responsePromise = readFullHttpResponse(client);
    client.write(request);

    const response = await responsePromise;
    expect(response).toContain("x-uid : 4\r\n");
    expect(response).toContain("Content-Length : 380\r\n");
    expect(response).toContain("<CapabilityOut>OfficeFormat</CapabilityOut>");
    expect(response).toContain("<CapabilityOut>PanelData=0110</CapabilityOut>");
    expect(callbackCount).toBe(0);

    client.destroy();
    server.close();
  });

  it("waits for beforeResponse before sending the HTTP response", async () => {
    let releaseHook!: () => void;
    let hookStarted = false;
    let hookFinished = false;
    let response = "";

    const server = createPushScanServer(0, () => {}, {
      beforeResponse: async () => {
        hookStarted = true;
        await new Promise<void>((resolve) => {
          releaseHook = resolve;
        });
        hookFinished = true;
      },
    });
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
    const port = (server.address() as AddressInfo).port;

    const body = buildSoapBody("01", "PID 11D1", "C0A8013A");
    const request =
      `POST /PushScan HTTP/1.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n` +
      `x-uid: 9\r\n` +
      `\r\n` +
      body;

    const client = net.createConnection(port, "127.0.0.1");
    client.on("data", (chunk) => {
      response += chunk.toString("utf-8");
    });
    await new Promise<void>((r) => client.once("connect", () => r()));

    const responsePromise = readFullHttpResponse(client);
    client.write(request);
    await new Promise((r) => setTimeout(r, 20));

    expect(hookStarted).toBe(true);
    expect(response).toBe("");

    releaseHook();
    await responsePromise;

    expect(hookFinished).toBe(true);
    expect(response).toContain("HTTP/1.0 200 OK");
    expect(response).toContain("x-uid : 9\r\n");

    client.destroy();
    server.close();
  });

  it("echoes the request's x-uid header into the response", async () => {
    const server = createPushScanServer(0, () => {});
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
    const port = (server.address() as AddressInfo).port;

    const body = buildSoapBody("01", "PID 11D1", "C0A8013A");
    const request =
      `POST /PushScan HTTP/1.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n` +
      `x-uid: 42\r\n` +
      `\r\n` +
      body;

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", () => r()));

    const responsePromise = readFullHttpResponse(client);

    client.write(request);

    const response = await responsePromise;
    expect(response).toContain("x-uid : 42\r\n");
    expect(response).not.toContain("x-uid : 1\r\n");

    client.destroy();
    server.close();
  });

  it("echoes the request's x-protocol-version (3.00 for the FF-680W)", async () => {
    const server = createPushScanServer(0, () => {});
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
    const port = (server.address() as AddressInfo).port;

    const body = buildSoapBody("01", "PID 016B", "C0A80A08");
    const request =
      `POST /PushScan HTTP/1.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n` +
      `x-uid: 5\r\n` +
      `x-protocol-version: 3.00\r\n` +
      `\r\n` +
      body;

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", () => r()));
    const responsePromise = readFullHttpResponse(client);
    client.write(request);

    const response = await responsePromise;
    expect(response).toContain("x-protocol-version : 3.00\r\n");
    expect(response).not.toContain("x-protocol-version : 2.00");

    client.destroy();
    server.close();
  });

  it("defaults the response x-protocol-version to 2.00 when the request omits it", async () => {
    const server = createPushScanServer(0, () => {});
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
    const port = (server.address() as AddressInfo).port;

    const body = buildSoapBody("01", "PID 11D1", "C0A8013A");
    const request =
      `POST /PushScan HTTP/1.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n` +
      `x-uid: 6\r\n` +
      `\r\n` +
      body;

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", () => r()));
    const responsePromise = readFullHttpResponse(client);
    client.write(request);

    const response = await responsePromise;
    expect(response).toContain("x-protocol-version : 2.00\r\n");

    client.destroy();
    server.close();
  });

  it("falls back to x-uid : 1 when request has no x-uid header", async () => {
    const server = createPushScanServer(0, () => {});
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
    const port = (server.address() as AddressInfo).port;

    const body = buildSoapBody("01", "PID 11D1", "C0A8013A");
    const request =
      `POST /PushScan HTTP/1.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n` +
      `\r\n` +
      body;

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", () => r()));

    const responsePromise = readFullHttpResponse(client);

    client.write(request);

    const response = await responsePromise;
    expect(response).toContain("x-uid : 1\r\n");

    client.destroy();
    server.close();
  });
});

describe("resolveEffectiveAction", () => {
  // Maps (action from panel, PREVIEW_ACTION config) → 'jpg' | 'pdf' | null.
  // null signals "do not start a scan — skip this push-scan event entirely".

  it("passes 'jpg' through regardless of previewAction", () => {
    expect(resolveEffectiveAction("jpg", "reject")).toBe("jpg");
    expect(resolveEffectiveAction("jpg", "jpg")).toBe("jpg");
    expect(resolveEffectiveAction("jpg", "pdf")).toBe("jpg");
  });

  it("passes 'pdf' through regardless of previewAction", () => {
    expect(resolveEffectiveAction("pdf", "reject")).toBe("pdf");
    expect(resolveEffectiveAction("pdf", "jpg")).toBe("pdf");
    expect(resolveEffectiveAction("pdf", "pdf")).toBe("pdf");
  });

  it("maps 'preview' with previewAction='reject' to null", () => {
    expect(resolveEffectiveAction("preview", "reject")).toBeNull();
  });

  it("maps 'preview' with previewAction='jpg' to 'jpg'", () => {
    expect(resolveEffectiveAction("preview", "jpg")).toBe("jpg");
  });

  it("maps 'preview' with previewAction='pdf' to 'pdf'", () => {
    expect(resolveEffectiveAction("preview", "pdf")).toBe("pdf");
  });

  it("maps 'unknown' to null regardless of previewAction", () => {
    expect(resolveEffectiveAction("unknown", "reject")).toBeNull();
    expect(resolveEffectiveAction("unknown", "jpg")).toBeNull();
    expect(resolveEffectiveAction("unknown", "pdf")).toBeNull();
  });
});
