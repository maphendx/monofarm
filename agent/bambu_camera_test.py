#!/usr/bin/env python3
"""Test Bambu A1/P1 camera protocol (binary TLS, port 6000).
Run on a PC/Pi on the same network as the printer.

Usage: python bambu_camera_test.py 192.168.31.39 41434469
"""
import socket, ssl, struct, sys, time

ip          = sys.argv[1] if len(sys.argv) > 1 else "192.168.31.39"
access_code = sys.argv[2] if len(sys.argv) > 2 else "41434469"
port        = 6000

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.check_hostname = False
ctx.verify_mode    = ssl.CERT_NONE

# 80-byte auth packet (binary, not HTTP)
# Reference: github.com/Doridian/OpenBambuAPI/blob/main/video.md
auth = bytearray(80)
struct.pack_into('<I', auth,  0, 0x40)    # payload size = 64
struct.pack_into('<I', auth,  4, 0x3000)  # type identifier
struct.pack_into('<I', auth,  8, 0)       # flags
struct.pack_into('<I', auth, 12, 0)       # reserved
auth[16:16+4] = b'bblp'                  # username (32 bytes, null-padded)
pw = access_code.encode()
auth[48:48+len(pw)] = pw                  # password (32 bytes, null-padded)

print(f"Connecting to {ip}:{port} ...")
try:
    raw  = socket.create_connection((ip, port), timeout=10)
    sock = ctx.wrap_socket(raw, server_hostname=ip)
    print("TLS connected OK")

    sock.sendall(bytes(auth))
    print("Auth sent. Waiting for frame header ...")

    sock.settimeout(10)
    buf = b''
    t   = time.monotonic()

    while time.monotonic() - t < 9:
        try:
            d = sock.recv(65536)
            if d:
                buf += d
                print(f"  received {len(d)} bytes (total {len(buf)})")
                if len(buf) >= 16:
                    break
        except socket.timeout:
            break

    if len(buf) >= 16:
        payload_size = struct.unpack('<I', buf[0:4])[0]
        itrack       = struct.unpack('<I', buf[4:8])[0]
        flags        = struct.unpack('<I', buf[8:12])[0]
        print(f"\n=== FRAME HEADER ===")
        print(f"  payload_size = {payload_size}")
        print(f"  itrack       = {itrack}")
        print(f"  flags        = {flags}")
        print(f"\n✅ SUCCESS! Camera protocol works. Ready to stream JPEG frames.")
    else:
        print(f"\n❌ No frame header received ({len(buf)} bytes). Auth may be wrong.")

    sock.close()
except Exception as e:
    print(f"Error: {e}")
