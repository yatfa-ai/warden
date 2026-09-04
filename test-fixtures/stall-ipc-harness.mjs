// Test harness for src/server-stall-ipc.test.js (WARDEN-1278).
//
// Forked in place of src/server.js so the IPC test can drive REAL stalls without
// blocking the child's event loop for multiple real seconds and waiting out a
// 5-minute flush window. It imports the REAL server module — same process, same
// module instance, same `process.send` the parent's `fork(..., stdio: [...,
// 'ipc'])` supplies — and exposes exactly two operations:
//
//   1. deliver a pre-built stall record through the PRODUCTION setOnStall sink
//      (the same sink a real heartbeat detection would call), and
//   2. close the telemetry window (the same call the production 5-minute
//      interval makes).
//
// Everything under test is production code running in a real forked child: the
// sink wiring, the bounded fold, the live consent gate, and the
// `process.send({ type: 'telemetry-stalls', snapshot })` forward. Only the
// TRIGGER is synthetic.
//
// This lives in test-fixtures/ rather than as a gated branch inside server.js on
// purpose: production code should not carry a drive-my-diagnostics IPC handler,
// even one behind an env flag.

const serverPath = process.argv[2];
const server = await import(serverPath);

// Arm the REAL setOnStall sink — the same callback startLoopMonitor() wires
// (stderr line → durable append → telemetry fold). The heartbeat timer and the
// process-wide fs / child_process patching are deliberately NOT started: this
// harness supplies the detections itself.
server.__startLoopMonitorForTest();

process.on('message', (msg) => {
  if (!msg || msg.type !== 'test-drive-stalls') return;
  const records = Array.isArray(msg.records) ? msg.records : [];
  // Deliver each record through the production sink...
  for (const record of records) {
    server.__loopMonitorForTest._deliverStall(record);
  }
  // ...then close the window, exactly as the 5-minute interval does. The
  // producer's own consent gate decides whether anything is forwarded.
  server.serverStallTelemetry.flushNow();
  // Ack so the parent knows the drive completed and can assert on what did (or
  // deliberately did not) arrive, rather than racing a timeout.
  process.send({ type: 'test-stalls-driven', delivered: records.length });
});

// Start the real HTTP server so PUT /api/config is reachable — that is how the
// test flips consent at runtime, through the production path.
server.startServer(Number(process.env.PORT) || 0, '127.0.0.1');
