const { execFile } = require("child_process");

function listSerialPorts() {
  return new Promise((resolve, reject) => {
    const command = [
      "import json",
      "import serial.tools.list_ports as lp",
      "ports = [{'device': p.device, 'description': p.description, 'hwid': p.hwid} for p in lp.comports()]",
      "print(json.dumps({'ports': ports}))"
    ].join("; ");

    execFile("python", ["-c", command], { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.ports || []);
      } catch (parseError) {
        reject(new Error(`Failed to parse serial ports: ${stdout}`));
      }
    });
  });
}

module.exports = {
  listSerialPorts
};
