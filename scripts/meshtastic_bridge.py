import argparse
import json
import logging
import sys
import threading
from pubsub import pub
from meshtastic.serial_interface import SerialInterface


logging.getLogger().setLevel(logging.WARNING)
write_lock = threading.Lock()
iface = None


def emit(event):
    with write_lock:
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def node_name_from_packet(packet):
    decoded = packet.get("decoded", {})
    user = decoded.get("user", {})
    if isinstance(user, dict):
        return user.get("longName") or user.get("shortName")
    return None


def classify_channel(packet, interface):
    packet_to = packet.get("to")
    local_num = getattr(getattr(interface, "myInfo", None), "my_node_num", None)
    if local_num is not None and packet_to == local_num:
        return "direct"
    if packet.get("toId") == "^all" or packet_to == 4294967295:
        return "public"
    return "public"


def on_receive_text(packet, interface):
    try:
        emit(
            {
                "type": "receive_text",
                "from": packet.get("from"),
                "fromId": packet.get("fromId"),
                "fromName": node_name_from_packet(packet),
                "to": packet.get("to"),
                "toId": packet.get("toId"),
                "text": packet.get("decoded", {}).get("text", ""),
                "channel": classify_channel(packet, interface),
            }
        )
    except Exception as exc:
        emit({"type": "error", "message": f"Receive handler failed: {exc}"})


def on_connection_lost(interface=None, topic=pub.AUTO_TOPIC):
    emit({"type": "connection_lost", "message": "Serial link lost"})


def connect(port):
    global iface
    iface = SerialInterface(devPath=port or None)

    local_id = None
    local_num = None
    try:
        local_num = iface.myInfo.my_node_num
        local_id = iface._nodeNumToId(local_num)
    except Exception:
        pass

    emit(
        {
            "type": "connected",
            "port": port,
            "deviceName": "Heltec V3",
            "localNodeId": local_id,
            "localNodeNum": local_num,
        }
    )


def handle_command(command):
    global iface
    action = command.get("action")

    if action == "send_text":
        destination_id = command.get("destinationId")
        destination_num = command.get("destinationNum")
        text = command.get("text", "")
        destination = destination_id if destination_id else destination_num
        if destination is None:
            emit({"type": "error", "message": "Send failed: missing destination"})
            return True
        try:
            iface.sendText(text, destinationId=destination, wantAck=True)
            emit({"type": "log", "scope": "bridge", "message": f"Sent text to {destination}"})
        except Exception as exc:
            emit({"type": "error", "message": f"Send failed for {destination}: {exc}"})
        return True

    if action == "disconnect":
        emit({"type": "log", "scope": "bridge", "message": "Disconnect requested"})
        return False

    emit({"type": "error", "message": f"Unknown action: {action}"})
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default=None)
    args = parser.parse_args()

    pub.subscribe(on_receive_text, "meshtastic.receive.text")
    pub.subscribe(on_connection_lost, "meshtastic.connection.lost")

    try:
        connect(args.port)
    except Exception as exc:
        emit({"type": "error", "message": f"Failed to connect: {exc}"})
        return 1

    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            command = json.loads(line)
            should_continue = handle_command(command)
            if not should_continue:
                break
    except Exception as exc:
        emit({"type": "error", "message": f"Bridge loop failed: {exc}"})
        return 1
    finally:
        if iface is not None:
            try:
                iface.close()
            except Exception:
                pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
