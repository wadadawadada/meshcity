const { spawn } = require("child_process");
const path = require("path");
const { createMeshcityGame } = require("./game");

function createMeshtasticService({ store }) {
  let bridgeProcess = null;
  let bridgeBuffer = "";
  let bridgeState = {
    mode: "simulation",
    port: null
  };

  const game = createMeshcityGame({
    store,
    async sendDirectMessage(target, text) {
      const destinationId = typeof target === "string" ? target : target.from;
      const destinationNum = typeof target === "object" ? target.fromNum || null : null;
      const device = store.getDeviceState();
      device.lastMessageAt = new Date().toISOString();
      store.saveDeviceState(device);

      if (device.transport === "serial" && bridgeProcess) {
        try {
          bridgeProcess.stdin.write(`${JSON.stringify({
            action: "send_text",
            destinationId,
            destinationNum,
            text
          })}\n`);
        } catch (error) {
          store.appendLog("error", `Failed to queue DM to ${destinationId}: ${error.message}`);
        }
      } else if (device.transport === "serial") {
        store.appendLog("error", `Cannot send DM to ${destinationId}: serial bridge is not running`);
      }

      store.appendLog("tx", `DM queued to ${destinationId}: ${text}`);
    }
  });

  function bootstrapDeviceState() {
    const current = store.getDeviceState();
    if (current.status === "connected" || current.status === "connecting") {
      store.saveDeviceState({
        ...current,
        status: "disconnected"
      });
      store.appendLog("device", "Recovered from stale startup state: set to disconnected");
    }
  }

  bootstrapDeviceState();

  function setDisconnected(message) {
    const nextState = {
      ...store.getDeviceState(),
      status: "disconnected",
      connectedAt: null
    };
    store.saveDeviceState(nextState);
    if (message) {
      store.appendLog("device", message);
    }
    bridgeProcess = null;
    bridgeBuffer = "";
    bridgeState = {
      mode: "simulation",
      port: null
    };
    return nextState;
  }

  async function handleIncomingMessage(message) {
    const device = store.getDeviceState();
    device.lastMessageAt = new Date().toISOString();
    store.saveDeviceState(device);

    if (message.channel === "public") {
      store.appendLog("rx", `Public message ignored from ${message.from}: ${message.text}`);
      return { ignored: true };
    }

    if (message.channel !== "direct") {
      store.appendLog("rx", `Unknown channel ignored from ${message.from}`);
      return { ignored: true };
    }

    store.appendLog("rx", `Direct message from ${message.from}: ${message.text}`);
    await game.handleDirectMessage(message);
    return { ok: true };
  }

  function handleBridgeEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "connected") {
      const nextState = {
        ...store.getDeviceState(),
        status: "connected",
        transport: "serial",
        connectedAt: new Date().toISOString(),
        deviceName: event.deviceName || "Heltec V3",
        localNodeId: event.localNodeId || null,
        localNodeNum: event.localNodeNum || null,
        port: event.port || bridgeState.port
      };
      store.saveDeviceState(nextState);
      store.appendLog("device", `Serial connection established on ${nextState.port || "auto"}`);
      return;
    }

    if (event.type === "log") {
      store.appendLog(event.scope || "bridge", event.message || "bridge event");
      return;
    }

    if (event.type === "receive_text") {
      void handleIncomingMessage({
        from: event.fromId || String(event.from || "!unknown"),
        fromNum: event.from || null,
        fromName: event.fromName || "Unknown traveler",
        text: event.text || "",
        channel: event.channel || "public"
      });
      return;
    }

    if (event.type === "error") {
      store.appendLog("error", event.message || "Meshtastic bridge error");
      return;
    }

    if (event.type === "connection_lost") {
      setDisconnected("Connection to device lost");
    }
  }

  function connectSerial(port) {
    if (bridgeProcess) {
      throw new Error("Device is already connected");
    }

    const scriptPath = path.join(process.cwd(), "scripts", "meshtastic_bridge.py");
    const args = [scriptPath];
    if (port) {
      args.push("--port", port);
    }

    bridgeProcess = spawn("python", args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    bridgeState = {
      mode: "serial",
      port: port || null
    };

    bridgeProcess.stdout.on("data", (chunk) => {
      bridgeBuffer += chunk.toString("utf8");
      const lines = bridgeBuffer.split(/\r?\n/);
      bridgeBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          handleBridgeEvent(JSON.parse(line));
        } catch (error) {
          store.appendLog("error", `Bridge JSON parse error: ${line}`);
        }
      }
    });

    bridgeProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        store.appendLog("bridge", message);
      }
    });

    bridgeProcess.on("exit", (code) => {
      if (bridgeProcess) {
        setDisconnected(`Bridge process exited with code ${code}`);
      }
    });

    const pendingState = {
      ...store.getDeviceState(),
      status: "connecting",
      transport: "serial",
      connectedAt: null,
      port: port || null
    };
    store.saveDeviceState(pendingState);
    store.appendLog("device", `Opening serial connection ${port || "auto-detect"}`);
    return pendingState;
  }

  return {
    getStatus() {
      return store.getDeviceState();
    },

    connect(transport = "simulation", options = {}) {
      if (transport === "serial") {
        return connectSerial(options.port || null);
      }

      const nextState = {
        ...store.getDeviceState(),
        status: "connected",
        transport,
        connectedAt: new Date().toISOString(),
        port: null
      };
      store.saveDeviceState(nextState);
      store.appendLog("device", `Connected using ${transport} transport`);
      return nextState;
    },

    disconnect() {
      if (bridgeProcess) {
        try {
          bridgeProcess.stdin.write(`${JSON.stringify({ action: "disconnect" })}\n`);
        } catch (error) {
          store.appendLog("error", `Failed to signal bridge disconnect: ${error.message}`);
        }

        try {
          bridgeProcess.kill();
        } catch (error) {
          store.appendLog("error", `Failed to stop bridge process: ${error.message}`);
        }
      }

      return setDisconnected("Disconnected from device");
    },

    async receiveMessage(message) {
      return handleIncomingMessage(message);
    }
  };
}

module.exports = {
  createMeshtasticService
};
