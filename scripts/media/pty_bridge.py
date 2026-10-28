"""Run a command in a pseudo-terminal of a fixed size and bridge it to pipes.

    python3 pty_bridge.py <cols> <rows> <command> [args...]

Bytes on our stdin go to the terminal as keystrokes; everything the program
writes to the terminal comes out on our stdout, unchanged. Exits with the
program's exit code. Used by build.ts to record the interactive CLI (Node has
no pty without a native module). Standard library only.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios

cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
stdin = sys.stdin.fileno()
stdout = sys.stdout.fileno()
inputs = [fd, stdin]
while True:
    ready, _, _ = select.select(inputs, [], [])
    if stdin in ready:
        data = os.read(stdin, 1024)
        if data:
            os.write(fd, data)
        else:
            inputs.remove(stdin)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(stdout, data)

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
