function createPublicSync({ backendUrl, syncToken }) {
  const normalizedBackendUrl = String(backendUrl || "").trim().replace(/\/+$/, "");
  const token = String(syncToken || "").trim();

  if (!normalizedBackendUrl || !token) {
    return {
      enqueueSync() {}
    };
  }

  let timer = null;
  let inFlight = false;
  let pendingPayload = null;

  async function flush() {
    if (inFlight || !pendingPayload) {
      return;
    }
    inFlight = true;
    const payload = pendingPayload;
    pendingPayload = null;

    try {
      const response = await fetch(`${normalizedBackendUrl}/api/admin/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-sync-token": token
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`[public-sync] failed: ${response.status} ${body}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[public-sync] request error: ${message}`);
    } finally {
      inFlight = false;
      if (pendingPayload) {
        setTimeout(() => {
          flush().catch(() => {});
        }, 250);
      }
    }
  }

  return {
    enqueueSync(payload) {
      pendingPayload = {
        ...(pendingPayload || {}),
        ...(payload && typeof payload === "object" ? payload : {}),
        admin: {
          lastSeenAt: new Date().toISOString()
        }
      };
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        flush().catch(() => {});
      }, 350);
    }
  };
}

module.exports = {
  createPublicSync
};
