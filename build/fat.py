"""Joins thin Mach-O binaries into one universal (fat) binary: fat.py OUT IN...
Slices are copied byte for byte, so their code signatures stay valid."""
import struct, sys

CPU = {0x01000007: 3, 0x0100000C: 0}  # x86_64, arm64 -> default subtype

def main(out, *ins):
    slices = []
    for path in ins:
        data = open(path, 'rb').read()
        magic, cputype, subtype = struct.unpack('<III', data[:12])
        assert magic == 0xFEEDFACF, path + ' is not a 64-bit Mach-O'
        slices.append((cputype, subtype, data))
    align = 14  # 16 KiB, required for arm64
    header = struct.pack('>II', 0xCAFEBABE, len(slices))
    offset = len(header) + 20 * len(slices)
    entries, body = b'', b''
    for cputype, subtype, data in slices:
        pad = (-offset) % (1 << align)
        body += b'\0' * pad
        offset += pad
        entries += struct.pack('>iiIII', cputype, subtype & 0x00FFFFFF, offset, len(data), align)
        body += data
        offset += len(data)
    with open(out, 'wb') as f:
        f.write(header + entries + body)
    import os
    os.chmod(out, 0o755)

main(*sys.argv[1:])
