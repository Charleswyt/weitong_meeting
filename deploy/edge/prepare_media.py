#!/usr/bin/python3
import ctypes as ct
import ctypes.util
import json
import os
import pwd
import re
import stat
import subprocess as sp
import time
import urllib.request
from pathlib import Path
account = 'weitong-edge'
libdir = Path('/opt/rtsp_roi/runtime/ffmpeg-rockchip/prefix/lib')
binaries = Path('/opt/rtsp_roi/app/bin')
paths = [binaries / 'mpp_dec_roi_bench', binaries / 'h264_whip_publisher']
devices = [Path('/dev/mpp_service'), Path('/dev/rga'), Path('/dev/dma_heap/system'), Path('/dev/dma_heap/system-uncached')]
env = dict(os.environ, LD_LIBRARY_PATH=str(libdir), LC_ALL='C')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def ready():
    try:
        with opener.open('http://127.0.0.1:19997/v3/config/global/get', timeout=3) as r:
            config = json.load(r)
        with opener.open('http://127.0.0.1:19997/v3/config/paths/list', timeout=3) as r:
            paths = json.load(r)['items']
        return config['webrtc'] and config['webrtcAddress'].endswith(':18689') and any(('conference_input/' in item['name'] for item in paths))
    except (OSError, KeyError, ValueError):
        return False

def allowed(path, mode):
    test = {'--x': ['-x'], 'r--': ['-r'], 'r-x': ['-r', '-x'], 'rw-': ['-r', '-w']}[mode]
    return all((sp.run(['setpriv', '--reuid=' + account, '--regid=' + account, '--groups=video,render', 'test', m, str(path)]).returncode == 0 for m in test))

def grant(path, mode):
    """Grant this service access while preserving effective permissions of other ACL entries."""
    if allowed(path, mode):
        return
    lib = ct.CDLL(ctypes.util.find_library('acl') or 'libacl.so.1', use_errno=True)
    arg = ct.c_void_p

    def fn(n, args, result=ct.c_int):
        f = getattr(lib, n)
        f.argtypes = args
        f.restype = result
        return f
    get = fn('acl_get_file', [ct.c_char_p, ct.c_int], arg)
    txt = fn('acl_to_text', [arg, ct.POINTER(ct.c_ssize_t)], arg)
    parse = fn('acl_from_text', [ct.c_char_p], arg)
    free = fn('acl_free', [arg])
    calc = fn('acl_calc_mask', [ct.POINTER(arg)])
    put = fn('acl_set_file', [ct.c_char_p, ct.c_int, arg])
    typ = 32768
    p = os.fsencode(path)
    old = get(p, typ)
    if not old:
        raise OSError(ct.get_errno(), 'ACL read', str(path))
    buf = txt(old, None)
    if not buf:
        free(old)
        raise OSError(ct.get_errno(), 'ACL text', str(path))
    try:
        lines = [line.split('#', 1)[0].strip() for line in ct.string_at(buf).decode().splitlines()]
    finally:
        free(buf)
        free(old)
    uid = str(pwd.getpwnam(account).pw_uid)
    mask = next((x.split(':')[2] for x in lines if x.startswith('mask::')), 'rwx')
    entries = []
    for line in lines:
        if not line:
            continue
        kind, name, perm = line.split(':')
        if kind == 'mask' or (kind == 'user' and name in (account, uid)):
            continue
        if kind == 'group' or (kind == 'user' and name):
            perm = ''.join((a if a == b else '-' for a, b in zip(perm, mask)))
        entries.append(':'.join((kind, name, perm)))
    entries.append('user:' + uid + ':' + mode)
    acl = arg(parse(','.join(entries).encode()))
    if not acl:
        raise OSError(ct.get_errno(), 'ACL parse', str(path))
    try:
        if calc(ct.byref(acl)) != 0 or put(p, typ, acl) != 0:
            raise OSError(ct.get_errno(), 'ACL write', str(path))
    finally:
        free(acl)
    if not allowed(path, mode):
        raise RuntimeError('service access unavailable ' + str(path))

def prepare():
    """Prepare the installed Rockchip tools and reuse the native Ocean conference relay."""
    deps = set()
    for binary in paths:
        check = sp.run(['ldd', str(binary)], env=env, stderr=sp.STDOUT, stdout=sp.PIPE, text=True)
        lines = check.stdout
        if 'not found' in lines or (check.returncode and 'not a dynamic executable' not in lines and ('statically linked' not in lines)):
            raise RuntimeError('native library missing')
        deps.update((Path(m) for m in re.findall('(?:^|\\s)(/opt/[^\\s]+)', lines, re.M)))
    targets = {}
    for f, mode in [(p, 'r-x') for p in paths] + [(p, 'r--') for p in deps]:
        for p in (f, f.resolve(strict=True)):
            for parent in p.parents:
                if str(parent).startswith('/opt/'):
                    targets[str(parent)] = '--x'
            if p.is_file():
                targets[str(p)] = mode
    for path in sorted(targets, key=lambda x: (x.count('/'), x)):
        p = Path(path)
        if p.stat().st_uid != 0 and (not allowed(p, targets[path])):
            raise RuntimeError('unexpected native file owner ' + str(p))
        grant(p, targets[path])
    compatible = Path('/proc/device-tree/compatible')
    if compatible.is_file() and b'rockchip,rk3576' in compatible.read_bytes().split(b'\x00'):
        for p in devices:
            if not stat.S_ISCHR(p.stat().st_mode):
                raise RuntimeError('hardware node missing')
            grant(p, 'rw-')
    if ready():
        return
    run = Path('/tmp/rtsp_roi_lan_preview/rtsp_relay')
    for d in (run.parent, run):
        d.mkdir(mode=493, exist_ok=True)
        st = d.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 18:
            raise RuntimeError('unexpected native relay directory')
    for name in ('mediamtx.pid', 'mediamtx.log', 'mediamtx.yml'):
        p = run / name
        if p.exists() or p.is_symlink():
            st = p.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1 or st.st_mode & 18:
                raise RuntimeError('unsafe relay state file')
    pidfile = run / 'mediamtx.pid'
    if pidfile.exists():
        pid = pidfile.read_text().strip()
        if pid.isdigit() and Path('/proc', pid).exists():
            if os.path.realpath('/proc/' + pid + '/exe') != str(binaries / 'mediamtx'):
                pidfile.unlink()
            else:
                for _ in range(16):
                    if ready():
                        return
                    time.sleep(0.25)
                raise RuntimeError('existing relay did not become ready')
    script = Path('/opt/rtsp_roi/app/scripts/ensure_conference_media_gateway.sh')
    if script.stat().st_uid or script.stat().st_mode & 18:
        raise RuntimeError('unexpected native relay helper owner')
    sp.run(['/bin/bash', str(script)], check=True, timeout=25, stdout=sp.DEVNULL)
    for _ in range(20):
        if ready():
            return
        time.sleep(0.25)
    raise RuntimeError('native meeting relay unavailable')
if __name__ == '__main__':
    prepare()
