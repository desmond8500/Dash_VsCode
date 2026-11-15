"""Zips a macOS .app keeping the executable bit: zipapp.py OUT.zip PATH.app"""
import os, sys, zipfile, stat

def main(out, app):
    base = os.path.dirname(app)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(app):
            dirs.sort()
            rel = os.path.relpath(root, base)
            zi = zipfile.ZipInfo(rel + '/')
            zi.external_attr = (stat.S_IFDIR | 0o755) << 16
            z.writestr(zi, '')
            for f in sorted(files):
                p = os.path.join(root, f)
                zi = zipfile.ZipInfo(os.path.relpath(p, base))
                mode = os.stat(p).st_mode & 0o777
                zi.external_attr = (stat.S_IFREG | mode) << 16
                zi.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(zi, open(p, 'rb').read())

main(*sys.argv[1:])
