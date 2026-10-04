#!/usr/bin/env python3
"""Read-only inotify observer of the OWNED local fixture (not an I/O mock).
ACCESS/OPEN/write events only: NOT proof that stat() never happened. No external paths watched.
"""
import ctypes
import json
import os
import select
import struct
import sys
import time

root = os.path.realpath(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
if fd < 0:
    raise OSError(ctypes.get_errno(), "inotify_init1")
mask = 0x00000001 | 0x00000002 | 0x00000004 | 0x00000008 | 0x00000010 | 0x00000020 | 0x00000100 | 0x00000200
watches = {}
for directory, dirs, files in os.walk(root, followlinks=False):
    for path in [directory] + [os.path.join(directory, name) for name in files]:
        if os.path.islink(path):
            continue
        wd = libc.inotify_add_watch(fd, os.fsencode(path), mask)
        if wd < 0:
            raise OSError(ctypes.get_errno(), "inotify_add_watch", path)
        watches[wd] = path
print(json.dumps({"at": time.time_ns() // 1000000, "event": "ready", "root": root, "watches": len(watches)}), flush=True)
while True:
    select.select([fd], [], [], 1)
    try:
        data = os.read(fd, 65536)
    except BlockingIOError:
        continue
    offset = 0
    while offset + 16 <= len(data):
        wd, flags, cookie, size = struct.unpack_from("iIII", data, offset)
        name = data[offset + 16:offset + 16 + size].split(b"\0", 1)[0].decode("utf8", errors="replace")
        offset += 16 + size
        print(json.dumps({"at": time.time_ns() // 1000000, "event": "inotify", "path": watches.get(wd), "name": name, "mask": flags, "cookie": cookie}), flush=True)
